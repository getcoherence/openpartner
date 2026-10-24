import { Router } from 'express';
import { utcDateTime, z } from '../zod.js';
import { ulid } from 'ulid';
import {
  PROGRAM_CATEGORY_SLUGS,
  TABLES,
  parseVideoUrl,
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
import { customerRewardDelivery } from '../customer-rewards.js';
import { getStorage } from '../storage.js';
import { commissionSlabFields, currencyCodeSchema, refineCommissionSubRule } from '../commission-rule-schema.js';
import { destinationUrlSchema, destinationWarnings } from '../destination-url.js';
import { tenantDefaultCurrency } from '../currency.js';
import { programStats } from '../reporting.js';

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
    /** Optional slab table — rate by event value (bands) or by the
     *  partner's attributed performance (tiers). `value` below stays the
     *  base rate. See docs/commission-slabs.md. */
    ...commissionSlabFields,
  }),
  z.discriminatedUnion('type', [
    // A percent rule's currency is the currency of its slab thresholds.
    z.object({ type: z.literal('percent'), value: z.number().positive(), currency: currencyCodeSchema.optional() }),
    z.object({ type: z.literal('fixed'), value: z.number().positive(), currency: currencyCodeSchema.optional() }),
  ]),
).superRefine(refineCommissionSubRule);

const legacyRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent'), value: z.number().positive(), recurring: z.boolean().optional() }),
  z.object({
    type: z.literal('fixed'),
    value: z.number().positive(),
    currency: z.string().length(3).optional(),
    recurring: z.boolean().optional(),
  }),
]);

const ruleArraySchema = z.array(subRuleSchema).min(1).max(10);
const legacyAsArraySchema = legacyRuleSchema.transform((legacy) => [{
  trigger: 'every' as const,
  type: legacy.type,
  value: legacy.value,
  ...('currency' in legacy && legacy.currency ? { currency: legacy.currency } : {}),
  ...(legacy.recurring ? { recurring: legacy.recurring } : {}),
}]);

/** Would zod 3 have abandoned the array form over this issue? It gave up
 *  on a value of the wrong type or option, and carried on past failed
 *  checks (a non-integer, a size limit, a refinement). */
function zod3Abandons(issue: z.core.$ZodIssue): boolean {
  if (issue.code === 'invalid_type') return issue.expected !== 'int';
  return issue.code === 'invalid_value' || issue.code === 'invalid_union' || issue.code === 'invalid_key';
}

// The legacy object shape predates slabs and its schema strips unknown
// keys, so `{type, value, bands}` used to save as a flat rule — the brand
// asked for slabs and silently got none. Refuse it and point at the array
// form instead. (Checked before parsing either form: by then the strip has
// already happened.)
//
// The input's shape picks the form. This was a zod 3 union, which said
// "Invalid input" for any bad legacy object and for an array it abandoned,
// and gave an array's own errors otherwise. zod 4's union abandons more (a
// non-integer, an over-long slab table), so the choice is made here.
const commissionRuleSchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && ('bands' in raw || 'tiers' in raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bands and tiers need the array form of commissionRule',
      });
    }
  })
  .transform((raw, ctx) => {
    const form = Array.isArray(raw) ? ruleArraySchema.safeParse(raw) : legacyAsArraySchema.safeParse(raw);
    if (form.success) return form.data;
    if (!Array.isArray(raw) || form.error.issues.some(zod3Abandons)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid input' });
    } else {
      for (const issue of form.error.issues) ctx.addIssue(issue as z.core.$ZodRawIssue);
    }
    return z.NEVER;
  });

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

/** YouTube / Vimeo / Loom link, stored as its canonical share URL. Same
 *  parser the Network uses, so anything accepted here also syncs. */
const marketplaceVideoUrlSchema = z
  .string()
  .max(500)
  .transform((s, ctx) => {
    const video = parseVideoUrl(s);
    if (!video) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use a YouTube, Vimeo or Loom link' });
      return z.NEVER;
    }
    return video.url;
  });

/** Where this tenant's program covers are stored. A cover must be one we
 *  stored (POST /uploads/program-cover) — never an arbitrary third-party
 *  image hotlinked onto the public marketplace. */
function programCoverPrefix(tenantId: string): string {
  return getStorage().publicUrl(`tenants/${tenantId}/program-covers/`);
}

function coverUrlProblem(tenantId: string, url: string | null | undefined) {
  if (!url || url.startsWith(programCoverPrefix(tenantId))) return null;
  return {
    error: 'invalid_body',
    detail: { fieldErrors: { marketplaceCoverUrl: ['upload the cover via POST /uploads/program-cover'] } },
  };
}

/** Event types that correct a conversion (refunds, chargebacks, disputes,
 *  failed payments): never revenue, whatever a program declares. */
const CORRECTIVE_TYPES = new Set(['refund', 'chargeback', 'dispute_created', 'invoice_payment_failed']);

/** Event types the brand declares are sales in this program: their value is
 *  partner-attributed revenue for the hosted platform fee
 *  (docs/platform-fee.md). invoice_paid and subscription_created always
 *  are, so they needn't be listed. */
const revenueEventTypesSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((t) => !CORRECTIVE_TYPES.has(t), { message: 'a refund, chargeback, dispute or failed payment is never revenue' }),
  )
  .max(20);

/** Two-tier commissions (recruiter-commissions.ts): the share of a
 *  recruit's commission their recruiter earns, as a percent (10 = 10%).
 *  Above 0, at most 50, two decimal places. Null = off. */
const recruiterCommissionPercentSchema = z
  .number()
  .gt(0)
  .max(50)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, { message: 'at most two decimal places' });

/** How many months after the recruitment the recruiter keeps earning.
 *  Null = for as long as the recruit earns. */
const recruiterCommissionMonthsSchema = z.number().int().min(1).max(120);

/** Stored form: unique, without the two types that are always revenue. */
function normalizeRevenueEventTypes(types: string[]): string[] {
  return [...new Set(types)].filter((t) => t !== 'invoice_paid' && t !== 'subscription_created');
}

export const createSchema = z.object({
  name: z.string().min(1),
  commissionRule: commissionRuleSchema,
  /** Days a click can win a customer's first conversion of an event
   *  type. Default 60. With renewalsStayWithPartner, it doesn't limit
   *  renewals. */
  attributionWindowDays: z.number().int().min(1).max(365).optional(),
  attributionModel: z.enum(['last_click', 'first_click', 'linear', 'position']).optional(),
  /** Default true: a repeat event (a type the customer already converted
   *  on, e.g. the 13th invoice_paid) keeps that first conversion's
   *  partners and weights, whatever the click's age; past the window only
   *  recurring sub-rules pay on it, up to recurringMonths. False: every
   *  event is attributed on its own within the window. */
  renewalsStayWithPartner: z.boolean().optional(),
  /** Link clicks beat this program's coupon codes. Default false. */
  couponsYieldToLinks: z.boolean().optional(),
  /** Where partner links send visitors. May carry the {click_id} macro
   *  (e.g. a Stripe Payment Link's ?client_reference_id={click_id}); the
   *  router substitutes the click id there instead of appending cref. */
  destinationUrl: destinationUrlSchema,
  /** Comma-separated host allowlist for partner deep-linking. Null/omitted
   *  means partners can't override the destination. */
  deepLinkAllowedDomains: z.string().max(1000).optional(),
  /** Holdback before commissions become approvable. Used to align
   *  payouts with refund / trial windows. 0 / omitted = no holdback. */
  holdbackDays: z.number().int().min(0).max(365).optional(),
  startsAt: utcDateTime().nullable().optional(),
  endsAt: utcDateTime().nullable().optional(),
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
  /** Banner for the marketplace card + detail page; must be this brand's
   *  upload from POST /uploads/program-cover. */
  marketplaceCoverUrl: z.string().trim().max(1000).nullable().optional(),
  /** YouTube / Vimeo / Loom link shown on the marketplace detail page. */
  marketplaceVideoUrl: marketplaceVideoUrlSchema.nullable().optional(),
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
  /** Event types that are sales in this program beyond invoice_paid and
   *  subscription_created — e.g. `order_paid` paid with fixed bounties.
   *  Their value counts as partner-attributed revenue for the hosted
   *  platform fee. Omitted = none. */
  revenueEventTypes: revenueEventTypesSchema.optional(),
  /** Two-tier: a partner's recruiter earns this percent of each commission
   *  the partner earns in this program. Omitted/null = off. */
  recruiterCommissionPercent: recruiterCommissionPercentSchema.nullable().optional(),
  /** Months after the recruitment the recruiter keeps earning it. Omitted/
   *  null = no limit. */
  recruiterCommissionMonths: recruiterCommissionMonthsSchema.nullable().optional(),
  /** When true, after creating the campaign, also grant every existing
   *  non-revoked partner access to it (source='admin'). Defaults to
   *  false so VIP / scoped campaigns stay private unless the brand opts
   *  in. New partners invited later still need to be granted explicitly
   *  at invite time — this only covers the existing roster. */
  grantToAllPartners: z.boolean().optional(),
});

export const updateSchema = z.object({
  name: z.string().min(1).optional(),
  commissionRule: commissionRuleSchema.optional(),
  attributionWindowDays: z.number().int().min(1).max(365).optional(),
  attributionModel: z.enum(['last_click', 'first_click', 'linear', 'position']).optional(),
  /** Not retroactive: decides events attributed from now on. */
  renewalsStayWithPartner: z.boolean().optional(),
  /** Link clicks beat this program's coupon codes. Default false. */
  couponsYieldToLinks: z.boolean().optional(),
  destinationUrl: destinationUrlSchema.optional(),
  deepLinkAllowedDomains: z.string().max(1000).nullable().optional(),
  holdbackDays: z.number().int().min(0).max(365).nullable().optional(),
  startsAt: utcDateTime().nullable().optional(),
  endsAt: utcDateTime().nullable().optional(),
  customerReward: customerRewardSchema.nullable().optional(),
  shareOnNetwork: z.boolean().optional(),
  marketplaceDescription: z.string().max(4000).nullable().optional(),
  marketplaceCoverUrl: z.string().trim().max(1000).nullable().optional(),
  marketplaceVideoUrl: marketplaceVideoUrlSchema.nullable().optional(),
  categories: z
    .array(z.string().refine((s) => PROGRAM_CATEGORY_SLUGS.has(s), { message: 'unknown category' }))
    .max(5)
    .optional(),
  partnersMayCustomizeCode: z.boolean().optional(),
  revenueEventTypes: revenueEventTypesSchema.optional(),
  /** Not retroactive: pays on commissions accrued from now on. */
  recruiterCommissionPercent: recruiterCommissionPercentSchema.nullable().optional(),
  recruiterCommissionMonths: recruiterCommissionMonthsSchema.nullable().optional(),
});

export const programsRouter = Router();

programsRouter.get('/programs', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const campaigns = await db<ProgramRow>(TABLES.Program).where({ tenantId }).orderBy('createdAt', 'desc');
  // Per deployment, and on hosted per Stripe App connection. The reward
  // editor is the only reader and it already loads this list — saves the
  // portal a round trip.
  res.json({ programs: campaigns, customerRewardDelivery: await customerRewardDelivery(tenantId) });
});

export const programStatsQuerySchema = z.object({
  since: utcDateTime().optional(),
  until: utcDateTime().optional(),
});

/**
 * Each program's clicks, partners, conversions, attributed revenue and
 * commission by status over [since, until), default the last 30 days.
 * The same numbers GET /admin/overview?programId= reports (reporting.ts),
 * amounts per currency and never converted.
 */
programsRouter.get('/programs/stats', requireAuth, requireAdmin, async (req, res) => {
  const q = programStatsQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });
  const until = q.data.until ? new Date(q.data.until) : new Date();
  const since = q.data.since ? new Date(q.data.since) : new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (since >= until) return res.status(400).json({ error: 'invalid_window', detail: 'since must be before until' });
  const { db, tenantId } = tenantOf(req);
  res.json({
    since: since.toISOString(),
    until: until.toISOString(),
    currency: await tenantDefaultCurrency(db, tenantId),
    programs: await programStats(db, { tenantId, since, until }),
  });
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
  const { db, tenantId } = tenantOf(req);

  if (p.role === 'admin') {
    const campaigns = (await db<ProgramRow>(TABLES.Program)
      .where({ tenantId })
      .select('id', 'name', 'destinationUrl', 'deepLinkAllowedDomains', 'startsAt', 'endsAt', 'partnersMayCustomizeCode', 'customerReward')
      .orderBy('createdAt', 'desc')) as Array<
        Pick<ProgramRow, 'id' | 'name' | 'destinationUrl' | 'deepLinkAllowedDomains' | 'startsAt' | 'endsAt' | 'partnersMayCustomizeCode' | 'customerReward'>
      >;
    return res.json({ programs: campaigns });
  }

  // Partner: filter through PartnerCampaign join. Hide scheduled (not
  // yet started) and ended campaigns — partners shouldn't be picking
  // those when they create a Link. Admins see them all so they can
  // edit dates.
  const rows = (await db(TABLES.Program)
    .join(TABLES.PartnerProgram, `${TABLES.PartnerProgram}.programId`, `${TABLES.Program}.id`)
    .where(`${TABLES.Program}.tenantId`, tenantId)
    .where(`${TABLES.PartnerProgram}.partnerId`, p.partnerId!)
    .select(
      `${TABLES.Program}.id`,
      `${TABLES.Program}.name`,
      `${TABLES.Program}.destinationUrl`,
      `${TABLES.Program}.deepLinkAllowedDomains`,
      `${TABLES.Program}.partnersMayCustomizeCode`,
      `${TABLES.Program}.customerReward`,
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
      partnersMayCustomizeCode: boolean;
      customerReward: CustomerReward | null;
      source: 'admin' | 'offering';
    }>;
  const campaigns = rows.filter((r) => campaignAcceptsNewActivity(r));
  res.json({ programs: campaigns });
});

programsRouter.post('/programs', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const coverProblem = coverUrlProblem(tenantId, body.data.marketplaceCoverUrl);
  if (coverProblem) return res.status(400).json(coverProblem);

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
      renewalsStayWithPartner: body.data.renewalsStayWithPartner ?? true,
      couponsYieldToLinks: body.data.couponsYieldToLinks ?? false,
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
      marketplaceCoverUrl: body.data.marketplaceCoverUrl || null,
      marketplaceVideoUrl: body.data.marketplaceVideoUrl ?? null,
      categories: body.data.categories ?? [],
      partnersMayCustomizeCode: body.data.partnersMayCustomizeCode ?? false,
      revenueEventTypes: normalizeRevenueEventTypes(body.data.revenueEventTypes ?? []),
      recruiterCommissionPercent: body.data.recruiterCommissionPercent?.toFixed(2) ?? null,
      recruiterCommissionMonths: body.data.recruiterCommissionMonths ?? null,
    })
    .returning('*');

  // Optional bulk-grant to existing non-revoked partners. Mirrors the
  // invite-time snapshot semantics (revokedAt is the only filter — we
  // include not-yet-activated invitees so a freshly-sent invite still
  // gets the new program).
  if (body.data.grantToAllPartners) {
    const partners = (await db(TABLES.Partner)
      .where({ tenantId })
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
    await tenantDefaultCurrency(db, tenantId),
  );
  const offeringId = await syncCampaignToMarketplace(db, tenantId, campaign as ProgramRow, summary);
  if (offeringId && offeringId !== (campaign as ProgramRow).networkOfferingId) {
    await persistNetworkOfferingId(db, id, offeringId);
    (campaign as ProgramRow).networkOfferingId = offeringId;
  }

  res.status(201).json({ ...campaign, ...destinationWarnings((campaign as ProgramRow).destinationUrl) });
});

programsRouter.patch('/programs/:id', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = updateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const existing = await db<ProgramRow>(TABLES.Program).where({ id: req.params.id, tenantId }).first();
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const patch: Partial<ProgramRow> = {};
  if (body.data.name !== undefined) patch.name = body.data.name;
  if (body.data.commissionRule !== undefined) {
    patch.commissionRule = JSON.stringify(body.data.commissionRule) as unknown as CommissionRule;
  }
  if (body.data.attributionWindowDays !== undefined) patch.attributionWindowDays = body.data.attributionWindowDays;
  if (body.data.attributionModel !== undefined) patch.attributionModel = body.data.attributionModel;
  if (body.data.renewalsStayWithPartner !== undefined) {
    patch.renewalsStayWithPartner = body.data.renewalsStayWithPartner;
  }
  if (body.data.couponsYieldToLinks !== undefined) {
    patch.couponsYieldToLinks = body.data.couponsYieldToLinks;
  }
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
  if (body.data.marketplaceCoverUrl !== undefined) {
    const cover = body.data.marketplaceCoverUrl || null;
    // Only a changed cover is checked, so an existing one stays saveable
    // even if the storage backend's public base has since moved.
    if (cover !== existing.marketplaceCoverUrl) {
      const coverProblem = coverUrlProblem(tenantId, cover);
      if (coverProblem) return res.status(400).json(coverProblem);
    }
    patch.marketplaceCoverUrl = cover;
  }
  if (body.data.marketplaceVideoUrl !== undefined) patch.marketplaceVideoUrl = body.data.marketplaceVideoUrl;
  if (body.data.categories !== undefined) patch.categories = body.data.categories;
  if (body.data.partnersMayCustomizeCode !== undefined) {
    patch.partnersMayCustomizeCode = body.data.partnersMayCustomizeCode;
  }
  if (body.data.revenueEventTypes !== undefined) {
    patch.revenueEventTypes = normalizeRevenueEventTypes(body.data.revenueEventTypes);
  }
  if (body.data.recruiterCommissionPercent !== undefined) {
    patch.recruiterCommissionPercent = body.data.recruiterCommissionPercent?.toFixed(2) ?? null;
  }
  if (body.data.recruiterCommissionMonths !== undefined) {
    patch.recruiterCommissionMonths = body.data.recruiterCommissionMonths;
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

  await db<ProgramRow>(TABLES.Program).where({ id: req.params.id, tenantId }).update(patch);
  const updated = (await db<ProgramRow>(TABLES.Program).where({ id: req.params.id, tenantId }).first()) as ProgramRow;

  // Sync to the marketplace whenever the saved row could affect the
  // listing. We sync unconditionally (vs. diffing fields) — the helper
  // is idempotent and the cost is one HTTP call per save, well below
  // the noise floor of an admin-initiated request.
  const summary = renderCommissionSummary(
    updated.commissionRule as unknown as CommissionSubRuleLike[],
    updated.customerReward as CustomerRewardLike | null,
    await tenantDefaultCurrency(db, tenantId),
  );
  const offeringId = await syncCampaignToMarketplace(db, tenantId, updated, summary);
  if (offeringId && offeringId !== updated.networkOfferingId) {
    await persistNetworkOfferingId(db, updated.id, offeringId);
    updated.networkOfferingId = offeringId;
  }

  res.json({ ...updated, ...destinationWarnings(updated.destinationUrl) });
});
