import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  PROGRAM_CATEGORY_SLUGS,
  TABLES,
  renderCommissionSummary,
  type ProgramRow,
  type CommissionRule,
  type CommissionSubRuleLike,
  type CustomerReward,
  type CustomerRewardLike,
} from '@openpartner/db';
import {
  syncCampaignToMarketplace,
  defaultShareOnNetwork,
  persistNetworkOfferingId,
} from '../campaign-marketplace-sync.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { campaignAcceptsNewActivity } from '../campaign-lifecycle.js';
import { getWhiteLabelState } from '../white-label.js';

/**
 * Commission rule schema. The wire format is an array of triggered sub-rules.
 *
 * We also accept the legacy single-object shape and normalize it to a
 * 1-element array so older clients (the OSS partner SDK <0.4, scripted
 * imports, etc.) keep working without an immediate upgrade. The normalization
 * happens here at the API boundary so storage is always the new shape.
 */
const subRuleSchema = z.intersection(
  z.object({
    trigger: z.enum(['every', 'first', 'subsequent']),
    eventType: z.string().min(1).max(80).optional(),
    recurring: z.boolean().optional(),
    /** Months to keep firing a recurring rule (counting from the first
     *  attributed event of this type for the partner+user). Null/omitted
     *  = no cap. Capped at 600 (50 years) to keep the cap a sane integer. */
    recurringMonths: z.number().int().positive().max(600).optional(),
  }),
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('percent'), value: z.number().positive() }),
    z.object({ type: z.literal('fixed'), value: z.number().positive(), currency: z.string().length(3).optional() }),
  ]),
).superRefine((sub, ctx) => {
  // `first` and `subsequent` triggers need an eventType — "first/subsequent
  // sale of WHAT" is otherwise ambiguous. `every` without an eventType means
  // "every event with a value" (the legacy single-rule behavior).
  if ((sub.trigger === 'first' || sub.trigger === 'subsequent') && !sub.eventType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${sub.trigger}-trigger sub-rules require an eventType`,
      path: ['eventType'],
    });
  }
  // recurringMonths only makes sense on recurring rules. Permit it to be
  // present on non-recurring rules but warn loudly via validation rather
  // than silently ignore.
  if (sub.recurringMonths != null && !sub.recurring) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'recurringMonths requires recurring: true',
      path: ['recurringMonths'],
    });
  }
});

const legacyRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent'), value: z.number().positive(), recurring: z.boolean().optional() }),
  z.object({
    type: z.literal('fixed'),
    value: z.number().positive(),
    currency: z.string().length(3).optional(),
    recurring: z.boolean().optional(),
  }),
]);

const commissionRuleSchema = z.union([
  z.array(subRuleSchema).min(1).max(10),
  legacyRuleSchema.transform((legacy) => [{
    trigger: 'every' as const,
    type: legacy.type,
    value: legacy.value,
    ...('currency' in legacy && legacy.currency ? { currency: legacy.currency } : {}),
    ...(legacy.recurring ? { recurring: legacy.recurring } : {}),
  }]),
]);

/**
 * Customer-side reward (dual-sided). Validated by reward type:
 *   amount_off requires currency
 *   repeating duration requires durationInMonths
 *   free_months ignores duration entirely (always treated as repeating)
 */
const customerRewardSchema = z
  .object({
    type: z.enum(['percent_off', 'amount_off', 'free_months']),
    value: z.number().positive(),
    currency: z.string().length(3).optional(),
    duration: z.enum(['once', 'forever', 'repeating']),
    durationInMonths: z.number().int().positive().max(120).optional(),
  })
  .superRefine((reward, ctx) => {
    if (reward.type === 'amount_off' && !reward.currency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'amount_off rewards require a currency',
        path: ['currency'],
      });
    }
    if (reward.type === 'percent_off' && reward.value > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'percent_off cannot exceed 100',
        path: ['value'],
      });
    }
    if (reward.duration === 'repeating' && !reward.durationInMonths && reward.type !== 'free_months') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duration='repeating' requires durationInMonths",
        path: ['durationInMonths'],
      });
    }
  });

const createSchema = z.object({
  name: z.string().min(1),
  commissionRule: commissionRuleSchema,
  attributionWindowDays: z.number().int().min(1).max(365).optional(),
  attributionModel: z.enum(['last_click', 'first_click', 'linear', 'position']).optional(),
  destinationUrl: z.string().url(),
  /** Comma-separated host allowlist for partner deep-linking. Null/omitted
   *  means partners can't override the destination. */
  deepLinkAllowedDomains: z.string().max(1000).optional(),
  /** Holdback before commissions become approvable. Used to align
   *  payouts with refund / trial windows. 0 / omitted = no holdback. */
  holdbackDays: z.number().int().min(0).max(365).optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  /** Customer-side reward provisioned as a Stripe Coupon + PromotionCode
   *  on every auto-minted Coupon for this campaign. Null/omitted = no
   *  customer-side reward (partner-only program). */
  customerReward: customerRewardSchema.nullable().optional(),
  /** Publish this campaign as a Network marketplace listing. Omitted =
   *  default to true if the brand has a Network membership configured,
   *  false otherwise. Brand can opt out per-campaign for VIP / private
   *  programs by passing false explicitly. */
  shareOnNetwork: z.boolean().optional(),
  /** Public-facing description for the marketplace card. Optional —
   *  the card renders without a description block when null. */
  marketplaceDescription: z.string().max(4000).nullable().optional(),
  /** Curated category slugs (see PROGRAM_CATEGORIES). Validated against
   *  the curated list — unknown slugs are rejected so a typo doesn't
   *  silently leak through. Empty array allowed (uncategorized). Capped
   *  at 5 so a brand can't tag every category and dilute filtering. */
  categories: z
    .array(z.string().refine((s) => PROGRAM_CATEGORY_SLUGS.has(s), { message: 'unknown category' }))
    .max(5)
    .optional(),
  /** When true, partners may rename their own coupon code via the
   *  creator portal (federation-allowed PATCH on the coupon row).
   *  Defaults to false — admin keeps full control of code strings. */
  partnersMayCustomizeCode: z.boolean().optional(),
  /** When true, after creating the campaign, also grant every existing
   *  non-revoked partner access to it (source='admin'). Defaults to
   *  false so VIP / scoped campaigns stay private unless the brand opts
   *  in. New partners invited later still need to be granted explicitly
   *  at invite time — this only covers the existing roster. */
  grantToAllPartners: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  commissionRule: commissionRuleSchema.optional(),
  attributionWindowDays: z.number().int().min(1).max(365).optional(),
  attributionModel: z.enum(['last_click', 'first_click', 'linear', 'position']).optional(),
  destinationUrl: z.string().url().optional(),
  deepLinkAllowedDomains: z.string().max(1000).nullable().optional(),
  holdbackDays: z.number().int().min(0).max(365).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  customerReward: customerRewardSchema.nullable().optional(),
  shareOnNetwork: z.boolean().optional(),
  marketplaceDescription: z.string().max(4000).nullable().optional(),
  categories: z
    .array(z.string().refine((s) => PROGRAM_CATEGORY_SLUGS.has(s), { message: 'unknown category' }))
    .max(5)
    .optional(),
  partnersMayCustomizeCode: z.boolean().optional(),
});

export const programsRouter = Router();

programsRouter.get('/programs', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const campaigns = await db<ProgramRow>(TABLES.Program).orderBy('createdAt', 'desc');
  res.json({ programs: campaigns });
});

/**
 * Partner-facing campaign list — only the Programs the calling partner
 * was granted access to (via admin assignment or Network-offering
 * approval). Admins see all campaigns in their tenant.
 *
 * Fields are limited to what a partner needs to create a Link
 * (id, name, destinationUrl, deepLinkAllowedDomains, source).
 * Commission rules + attribution settings are admin-only and stay out
 * of the response.
 */
programsRouter.get('/me/programs', requireAuth, async (req, res) => {
  const p = req.principal;
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  if (p.role !== 'partner' && p.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { db } = tenantOf(req);

  if (p.role === 'admin') {
    const campaigns = (await db<ProgramRow>(TABLES.Program)
      .select('id', 'name', 'destinationUrl', 'deepLinkAllowedDomains', 'startsAt', 'endsAt')
      .orderBy('createdAt', 'desc')) as Array<
        Pick<ProgramRow, 'id' | 'name' | 'destinationUrl' | 'deepLinkAllowedDomains' | 'startsAt' | 'endsAt'>
      >;
    return res.json({ programs: campaigns });
  }

  // Partner: filter through PartnerCampaign join. Hide scheduled (not
  // yet started) and ended campaigns — partners shouldn't be picking
  // those when they create a Link. Admins see them all so they can
  // edit dates.
  const rows = (await db(TABLES.Program)
    .join(TABLES.PartnerProgram, `${TABLES.PartnerProgram}.programId`, `${TABLES.Program}.id`)
    .where(`${TABLES.PartnerProgram}.partnerId`, p.partnerId!)
    .select(
      `${TABLES.Program}.id`,
      `${TABLES.Program}.name`,
      `${TABLES.Program}.destinationUrl`,
      `${TABLES.Program}.deepLinkAllowedDomains`,
      `${TABLES.Program}.startsAt as startsAt`,
      `${TABLES.Program}.endsAt as endsAt`,
      `${TABLES.PartnerProgram}.source as source`,
    )
    .orderBy(`${TABLES.Program}.createdAt`, 'desc')) as Array<{
      id: string;
      name: string;
      destinationUrl: string;
      deepLinkAllowedDomains: string | null;
      startsAt: Date | null;
      endsAt: Date | null;
      source: 'admin' | 'offering';
    }>;
  const campaigns = rows.filter((r) => campaignAcceptsNewActivity(r));
  res.json({ programs: campaigns });
});

programsRouter.post('/programs', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  // Smart default: shareOnNetwork=true when the brand is on the Network so
  // the common case is "create campaign, immediately listed." Brand can opt
  // out per-campaign by passing false explicitly (VIP / private programs).
  // White-label tenants are isolated from the marketplace: force false even
  // when a (stale) client sends true, and before the marketplace-description
  // requirement below — otherwise it's an invisible 400 for a surface their
  // UI correctly hides.
  const whiteLabelEffective = (await getWhiteLabelState(db, tenantId)).effective;
  const shareOnNetwork = whiteLabelEffective
    ? false
    : (body.data.shareOnNetwork ?? (await defaultShareOnNetwork(db, tenantId)));

  // Marketplace description is required when shareOnNetwork=true. The
  // public marketplace card is the brand's only sales surface for cold
  // creator traffic; an empty card is a missed conversion. Reject 400
  // rather than render a blank card.
  if (shareOnNetwork && !body.data.marketplaceDescription?.trim()) {
    return res.status(400).json({
      error: 'invalid_body',
      detail: { fieldErrors: { marketplaceDescription: ['required when shareOnNetwork is true'] } },
    });
  }

  const id = ulid();
  const [campaign] = await db<ProgramRow>(TABLES.Program)
    .insert({
      id,
      tenantId,
      name: body.data.name,
      // JSON.stringify the array explicitly. Knex's pg driver auto-serializes
      // plain objects into jsonb but treats arrays as Postgres arrays, which
      // collides with the jsonb column type.
      commissionRule: JSON.stringify(body.data.commissionRule) as unknown as CommissionRule,
      attributionWindowDays: body.data.attributionWindowDays ?? 60,
      attributionModel: body.data.attributionModel ?? 'last_click',
      destinationUrl: body.data.destinationUrl,
      deepLinkAllowedDomains: body.data.deepLinkAllowedDomains ?? null,
      holdbackDays: body.data.holdbackDays ?? null,
      startsAt: body.data.startsAt ? new Date(body.data.startsAt) : null,
      endsAt: body.data.endsAt ? new Date(body.data.endsAt) : null,
      customerReward: body.data.customerReward
        ? (JSON.stringify(body.data.customerReward) as unknown as CustomerReward)
        : null,
      shareOnNetwork,
      marketplaceDescription: body.data.marketplaceDescription ?? null,
      categories: body.data.categories ?? [],
      partnersMayCustomizeCode: body.data.partnersMayCustomizeCode ?? false,
    })
    .returning('*');

  // Optional bulk-grant to existing non-revoked partners. Mirrors the
  // invite-time snapshot semantics (revokedAt is the only filter — we
  // include not-yet-activated invitees so a freshly-sent invite still
  // gets the new program).
  if (body.data.grantToAllPartners) {
    const partners = (await db(TABLES.Partner)
      .whereNull('revokedAt')
      .select('id')) as Array<{ id: string }>;
    if (partners.length > 0) {
      await db(TABLES.PartnerProgram)
        .insert(
          partners.map((p) => ({
            id: `pc_${ulid()}`,
            tenantId,
            partnerId: p.id,
            programId: id,
            source: 'admin',
          })),
        )
        .onConflict(['tenantId', 'partnerId', 'programId'])
        .ignore();
    }
  }

  // Push the marketplace listing if applicable. Best-effort — failures
  // log + continue, the brand can re-save to retry. Captures the
  // Network's offering id back onto the row so later edits PATCH the
  // same listing instead of creating duplicates.
  const summary = renderCommissionSummary(
    body.data.commissionRule as CommissionSubRuleLike[],
    (body.data.customerReward ?? null) as CustomerRewardLike | null,
  );
  const offeringId = await syncCampaignToMarketplace(db, tenantId, campaign as ProgramRow, summary);
  if (offeringId && offeringId !== (campaign as ProgramRow).networkOfferingId) {
    await persistNetworkOfferingId(db, id, offeringId);
    (campaign as ProgramRow).networkOfferingId = offeringId;
  }

  res.status(201).json(campaign);
});

programsRouter.patch('/programs/:id', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = updateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const existing = await db<ProgramRow>(TABLES.Program).where({ id: req.params.id }).first();
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const patch: Partial<ProgramRow> = {};
  if (body.data.name !== undefined) patch.name = body.data.name;
  if (body.data.commissionRule !== undefined) {
    patch.commissionRule = JSON.stringify(body.data.commissionRule) as unknown as CommissionRule;
  }
  if (body.data.attributionWindowDays !== undefined) patch.attributionWindowDays = body.data.attributionWindowDays;
  if (body.data.attributionModel !== undefined) patch.attributionModel = body.data.attributionModel;
  if (body.data.destinationUrl !== undefined) patch.destinationUrl = body.data.destinationUrl;
  if (body.data.deepLinkAllowedDomains !== undefined) patch.deepLinkAllowedDomains = body.data.deepLinkAllowedDomains;
  if (body.data.holdbackDays !== undefined) patch.holdbackDays = body.data.holdbackDays;
  if (body.data.startsAt !== undefined) patch.startsAt = body.data.startsAt ? new Date(body.data.startsAt) : null;
  if (body.data.endsAt !== undefined) patch.endsAt = body.data.endsAt ? new Date(body.data.endsAt) : null;
  if (body.data.customerReward !== undefined) {
    patch.customerReward = body.data.customerReward
      ? (JSON.stringify(body.data.customerReward) as unknown as CustomerReward)
      : null;
  }
  if (body.data.shareOnNetwork !== undefined) patch.shareOnNetwork = body.data.shareOnNetwork;
  if (body.data.marketplaceDescription !== undefined) {
    patch.marketplaceDescription = body.data.marketplaceDescription;
  }
  if (body.data.categories !== undefined) patch.categories = body.data.categories;
  if (body.data.partnersMayCustomizeCode !== undefined) {
    patch.partnersMayCustomizeCode = body.data.partnersMayCustomizeCode;
  }

  // White-label tenants are isolated from the marketplace — pin the flag
  // false on every edit (also normalizes pre-white-label rows still
  // carrying true, so a lapsed add-on can't resurrect a stale listing) and
  // skip the marketplace-description requirement their UI can't satisfy.
  if ((await getWhiteLabelState(db, tenantId)).effective) {
    patch.shareOnNetwork = false;
  }

  // Marketplace description is required when shareOnNetwork=true.
  // Compute the post-update state by merging body fields over existing,
  // then reject if the listing would render with no description.
  const finalShareOnNetwork = patch.shareOnNetwork ?? existing.shareOnNetwork;
  const finalDescription =
    'marketplaceDescription' in patch ? patch.marketplaceDescription : existing.marketplaceDescription;
  if (finalShareOnNetwork && !finalDescription?.trim()) {
    return res.status(400).json({
      error: 'invalid_body',
      detail: { fieldErrors: { marketplaceDescription: ['required when shareOnNetwork is true'] } },
    });
  }

  await db<ProgramRow>(TABLES.Program).where({ id: req.params.id }).update(patch);
  const updated = (await db<ProgramRow>(TABLES.Program).where({ id: req.params.id }).first()) as ProgramRow;

  // Sync to the marketplace whenever the saved row could affect the
  // listing. We sync unconditionally (vs. diffing fields) — the helper
  // is idempotent and the cost is one HTTP call per save, well below
  // the noise floor of an admin-initiated request.
  const summary = renderCommissionSummary(
    updated.commissionRule as unknown as CommissionSubRuleLike[],
    updated.customerReward as CustomerRewardLike | null,
  );
  const offeringId = await syncCampaignToMarketplace(db, tenantId, updated, summary);
  if (offeringId && offeringId !== updated.networkOfferingId) {
    await persistNetworkOfferingId(db, updated.id, offeringId);
    updated.networkOfferingId = offeringId;
  }

  res.json(updated);
});
