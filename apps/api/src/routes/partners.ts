import { Router } from 'express';
import type { Knex } from 'knex';
import { z } from '../zod.js';
import { ulid } from 'ulid';
import { TABLES, type ApiKeyRow, type CommissionSubRule, type PartnerRow, type SessionRow } from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth, requirePartnerOrAdmin, scopedKeyLacks } from '../auth.js';
import { issueMagicLink } from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { buildMagicLinkUrl, partnerInviteEmail, partnerRevokedEmail } from '../email-templates.js';
import { cursorTimestamp, decodeCursor, takePage, whereAfterCursor } from '../pagination.js';
import { linkTenantOf } from '../portal-url.js';
import { afterCommit, getTenancyMode, tenantOf } from '../tenancy.js';
import { db as platformDb } from '../db.js';
import { checkCountryAccess, countryCodeSchema, recordLocationDeclaration } from '../country-access.js';
import {
  grantNetworkConsent,
  isNetworkFederationCall,
  syncPartnerRevokeToNetwork,
  syncPartnerToNetwork,
} from '../network-consent.js';
import { autoMintCouponsForGrants } from './coupons.js';
import { dispatchEvent } from '../webhook-dispatcher.js';
import { onCommit } from '../on-commit.js';
import type { WebhookPayload } from '../openapi/webhook-events.js';
import { commissionSlabFields, currencyCodeSchema, refineCommissionSubRule } from '../commission-rule-schema.js';
import { vetApprovalSnapshot } from '../commission-slabs.js';
import { isPendingReview } from '../partner-review.js';
import { findPartnerCommission, legacyRuleColumns, upsertPartnerCommission } from '../partner-commission.js';
import { endPortalAccess, readPartnerAccessSettings } from '../partner-portal-access.js';

// Admin-set commission terms for a partner: the body of both override
// PUTs (partner-wide and program-scoped) and of each POST /partners
// `programCommissions` entry. Used for the "VIP gets 30%" case where a
// brand wants to give a specific partner a different rate than the
// program default.
export const overrideSchema = z.object({
  commissionType: z.enum(['percent', 'fixed']),
  commissionValue: z.number().nonnegative(),
  recurring: z.boolean().optional(),
  holdbackDays: z.number().int().nonnegative().nullable().optional(),
  /** Optional compound-rule override. When omitted, the override is a
   *  pure single-rule amendment and any prior compound rules attached
   *  to this partner are cleared (set to NULL) so the engine doesn't
   *  silently keep using stale sub-rules. Each sub-rule passes the same
   *  cross-field checks as a program's terms (first/subsequent need an
   *  eventType, recurringMonths needs recurring); values stay
   *  nonnegative here so a 0% override remains expressible. */
  commissionRules: z
    .array(
      z
        .object({
          trigger: z.enum(['every', 'first', 'subsequent']),
          eventType: z.string().min(1).max(80).optional(),
          type: z.enum(['percent', 'fixed']),
          value: z.number().nonnegative(),
          currency: currencyCodeSchema.optional(),
          recurring: z.boolean().optional(),
          recurringMonths: z.number().int().positive().max(600).optional(),
          ...commissionSlabFields,
        })
        .superRefine(refineCommissionSubRule),
    )
    .min(1)
    .max(10)
    .optional(),
});

export const createSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Admin can opt out of the invite email (e.g. federation creating a
  // Partner row on behalf of an external creator network). Default is
  // "invite them" since that's the intent of the admin UI.
  sendInvite: z.boolean().optional(),
  /** May the partner sign in to the partner portal? false = no magic
   *  links, no sessions, no portal email (partner-portal-access.ts), for a
   *  headless program whose own app is the partner's only view. An invite
   *  needs it, so `false` requires `sendInvite: false`. Omitted: true for
   *  an invited partner (and one the OpenPartner Network provisions), the
   *  tenant's default (`GET /config/partner-access`) for anyone else. */
  portalAccess: z.boolean().optional(),
  /** Programs (campaigns) this partner can create share-links for.
   *  Omitted = grant access to ALL current campaigns (preserves the
   *  pre-PartnerCampaign behavior). Empty array = grant nothing
   *  (rare; admin can add later). */
  programIds: z.array(z.string()).optional(),
  /** @deprecated Pre-rename spelling of `programIds` (Campaign → Program,
   *  May 2026). Network deployments still send it on approve; without
   *  this alias zod strips it and the handler falls through to the
   *  grant-ALL-programs default, over-granting every federated creator.
   *  `programIds` wins when both are sent. */
  campaignIds: z.array(z.string()).optional(),
  /** Where the grants come from. 'offering' is what the Network
   *  federation sends so we can tell admin assignments apart from
   *  Network-driven ones in the audit log + UI. */
  campaignGrantSource: z.enum(['admin', 'offering']).optional(),
  /** Snapshot of the offering's commission terms at approval time.
   *  Sent by the Network federation when provisioning a Partner from
   *  an approved PartnershipRequest. Persisted as a PartnerCommission
   *  row so future commission accruals use these values instead of
   *  the live Campaign rule — preserves the rate the partner was
   *  approved under even if the brand later edits the Campaign.
   *
   *  `commissionRules` (array form) is the post-compound-rules wire
   *  shape; `commissionType`/`commissionValue`/`recurring` are the
   *  legacy single-rule shape, still accepted so older Network
   *  deployments don't have to upgrade in lockstep. When both are
   *  sent, `commissionRules` wins.
   *
   *  Scope: when the request names exactly ONE program (`programIds`,
   *  or the `campaignIds` alias) the snapshot is stamped for that
   *  program only — the Network's approve flow always sends
   *  `[offering.vendorProgramId]`, and the offering's terms describe
   *  that program, not whatever the brand grants the partner later.
   *  Any other request (several programs, or none = all) stamps a
   *  partner-wide snapshot, as before. */
  commissionSnapshot: z
    .object({
      commissionType: z.enum(['percent', 'fixed']).optional(),
      commissionValue: z.number().nonnegative().optional(),
      recurring: z.boolean().optional(),
      holdbackDays: z.number().int().nonnegative().optional(),
      commissionRules: z
        .array(
          z.object({
            trigger: z.enum(['every', 'first', 'subsequent']),
            eventType: z.string().min(1).max(80).optional(),
            type: z.enum(['percent', 'fixed']),
            value: z.number().nonnegative(),
            currency: z.string().length(3).optional(),
            recurring: z.boolean().optional(),
            recurringMonths: z.number().int().positive().max(600).optional(),
            // Kept, not stripped: a tiered offering's snapshot must pay
            // its tiers, not its base rate. Accepted as-is here and vetted
            // by vetApprovalSnapshot below, so a bad slab table drops the
            // snapshot instead of failing the whole approval.
            bands: z.unknown().optional(),
            tiers: z.unknown().optional(),
          }),
        )
        .min(1)
        .max(10)
        .optional(),
    })
    .optional(),
  /** Per-program terms to stamp at creation, one entry per program. Each
   *  program must be among the ones this request grants. Same body as
   *  PUT /partners/:id/programs/:programId/commission. */
  programCommissions: z
    .array(overrideSchema.extend({ programId: z.string().min(1) }))
    .max(100)
    .optional(),
  /** Where the partner is based (ISO 3166-1 alpha-2). The hosted platform
   *  doesn't serve some countries (country-access.ts): a blocked one is
   *  refused, and an accepted one is recorded, which lets payouts be held
   *  if the country is blocked later. Self-host ignores it. */
  country: countryCodeSchema().optional(),
  /** With `country: "UA"`: the partner is outside the Russian-occupied
   *  regions of Ukraine, which no country code covers. */
  outsideOccupiedRegions: z.boolean().optional(),
});

export const partnersRouter = Router();

/** What `partners:create` may not do on POST /partners, which needs
 *  `partners:write`: send the invite (the default!) or set commission
 *  terms. That's what makes it safe as an in-app integration's runtime
 *  key: it can't email anyone, and a leak can't mint a 100% partner. */
function beyondCreateScope(body: z.infer<typeof createSchema>): string | null {
  if (body.sendInvite !== false) return 'A partners:create key creates partners without an invite: send "sendInvite": false.';
  if (body.commissionSnapshot || body.programCommissions) {
    return 'A partners:create key cannot set commission terms (commissionSnapshot, programCommissions).';
  }
  return null;
}

/**
 * Create a partner and, by default, send them an invite magic link. The
 * partner starts with `activatedAt = null`; when they click the link,
 * verify flips that to now() and issues a session. Admin never sees a
 * partner-facing credential.
 *
 * `partners:create` reaches this too, limited by beyondCreateScope.
 */
partnersRouter.post('/partners', requireAuth, grantScope('partners:write', 'partners:create'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  if (scopedKeyLacks(req, 'partners:write')) {
    const detail = beyondCreateScope(body.data);
    if (detail) return res.status(403).json({ error: 'forbidden_scope', required: 'partners:write', detail });
  }

  const sendInvite = body.data.sendInvite !== false;
  // The invite is a sign-in link, so it can't go to a partner who may not
  // sign in.
  if (sendInvite && body.data.portalAccess === false) {
    return res.status(400).json({ error: 'invite_requires_portal_access' });
  }
  const email = body.data.email.toLowerCase();
  const id = ulid();

  // Countries the hosted platform doesn't serve. Only the declared
  // country: the request comes from the brand's server, not the partner,
  // so its IP says nothing about where the partner is. The privileged
  // pool, because PlatformSetting is a platform table.
  const hosted = getTenancyMode() === 'multi';
  if (hosted && body.data.country) {
    const location = await checkCountryAccess(platformDb, {
      declared: body.data.country,
      outsideOccupiedRegions: body.data.outsideOccupiedRegions,
    });
    if (!location.ok) return res.status(422).json({ error: location.error });
  }

  // Duplicate-email pre-check — we'd rather 409 with a clean error than
  // let Postgres throw a unique-constraint violation that would surface
  // to the admin as a generic 500. Race between the check + insert is
  // caught below via the unique-violation path. Email is unique per tenant.
  //
  // Every query here filters on tenantId explicitly rather than leaning on
  // RLS alone: on a pool that bypasses RLS, these read and granted every
  // tenant's partners and programs (Oct 2026 verification).
  const existing = await db<PartnerRow>(TABLES.Partner).where({ email, tenantId }).first();
  if (existing) return res.status(409).json({ error: 'email_taken' });

  // Resolve program (campaign) grants before inserting the Partner so a
  // rejected list doesn't leave an orphan row behind — a Network retry
  // would then 409 on email_taken forever. Default = all current
  // campaigns when caller didn't specify, matching the
  // pre-PartnerCampaign behavior so existing flows don't change shape.
  const requestedProgramIds = body.data.programIds ?? body.data.campaignIds;
  let programIds: string[];
  if (requestedProgramIds) {
    // Explicit list — validate that each ID exists in this tenant.
    // Without this, a stale ID (e.g. Network Offering still references
    // a Campaign deleted on the vendor side) hits the FK constraint
    // and surfaces to the caller as an opaque 500. Federation flows
    // need a clean error message back instead.
    const known = (await db(TABLES.Program)
      .where({ tenantId })
      .whereIn('id', requestedProgramIds)
      .select('id')) as Array<{ id: string }>;
    const knownIds = new Set(known.map((c) => c.id));
    const missing = requestedProgramIds.filter((cid) => !knownIds.has(cid));
    if (missing.length > 0) {
      return res.status(400).json({ error: 'unknown_campaign_ids', missing });
    }
    programIds = requestedProgramIds;
  } else {
    programIds = ((await db(TABLES.Program).where({ tenantId }).select('id')) as Array<{ id: string }>).map((c) => c.id);
  }

  // Commission terms, also checked before the insert for the same
  // orphan-row reason. The snapshot is program-scoped when exactly one
  // program was named (see commissionSnapshot); programCommissions
  // entries must target granted programs, at most one entry each, and
  // not the program the snapshot already covers.
  let snap = body.data.commissionSnapshot;
  const hasSnapshot =
    (snap?.commissionRules != null && snap.commissionRules.length > 0) ||
    (snap?.commissionType != null && snap.commissionValue != null);
  const namedPrograms = requestedProgramIds ? [...new Set(requestedProgramIds)] : [];
  const snapshotProgramId = namedPrograms.length === 1 ? namedPrograms[0]! : null;
  const programTerms = body.data.programCommissions ?? [];
  const granted = new Set(programIds);
  const termed = new Set<string>(hasSnapshot && snapshotProgramId ? [snapshotProgramId] : []);
  for (const t of programTerms) {
    if (!granted.has(t.programId)) {
      return res.status(400).json({ error: 'program_commission_not_granted', programId: t.programId });
    }
    if (termed.has(t.programId)) {
      return res.status(400).json({ error: 'duplicate_program_commission', programId: t.programId });
    }
    termed.add(t.programId);
  }

  // Portal access when the caller didn't say. An invited partner is going
  // to sign in. So is a creator the Network provisions: they're a Network
  // member, not a brand's in-app customer. Anyone else created without an
  // invite gets the tenant's default (partner-portal-access.ts).
  const fromNetwork = await isNetworkFederationCall(db, tenantId, req.principal, body.data.metadata);
  const portalAccess =
    body.data.portalAccess ??
    (sendInvite || fromNetwork ? true : (await readPartnerAccessSettings(db, tenantId)).uninvitedPortalAccess);

  let partner;
  try {
    [partner] = await db<PartnerRow>(TABLES.Partner)
      .insert({
        id,
        tenantId,
        email,
        name: body.data.name,
        metadata: body.data.metadata ?? {},
        // sendInvite=false means the caller is responsible for activating
        // (federation client, admin seeding, etc); skip the pending state.
        activatedAt: sendInvite ? null : new Date(),
        portalAccess,
      })
      .returning('*');
  } catch (err) {
    // Race: two concurrent POSTs with the same email both pass the
    // pre-check and try to insert. The second one hits the unique
    // constraint on Partner.email.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'email_taken' });
    }
    throw err;
  }

  // The declaration is a platform record (no FK), written once this
  // request has committed so a rolled-back create leaves none behind.
  if (hosted && body.data.country) {
    const declared = body.data.country;
    const outsideOccupiedRegions = body.data.outsideOccupiedRegions ?? null;
    onCommit(db, 'partner location declaration', () =>
      recordLocationDeclaration(platformDb, {
        subjectKind: 'partner',
        subjectId: id,
        tenantId,
        country: declared,
        outsideOccupiedRegions,
        ipCountry: null,
        source: 'api',
        declaredByEmail: null,
      }),
    );
  }

  // Grant program (campaign) access resolved above.
  if (programIds.length > 0) {
    const grantSource = body.data.campaignGrantSource ?? 'admin';
    await db(TABLES.PartnerProgram)
      .insert(
        programIds.map((cid) => ({
          id: `pc_${ulid()}`,
          tenantId,
          partnerId: id,
          programId: cid,
          source: grantSource,
        })),
      )
      .onConflict(['tenantId', 'partnerId', 'programId'])
      .ignore();
    // Auto-mint a default coupon per granted campaign so creators have
    // both attribution paths (link + code) available without admin
    // explicit action. ON CONFLICT IGNORE inside the helper means
    // re-grants don't error.
    await autoMintCouponsForGrants(db, tenantId, { id, email }, programIds);
  }

  // Persist the commission snapshot if the federation push carried one.
  // Two accepted shapes:
  //   - commissionRules (compound array) — preferred, written verbatim
  //   - commissionType + commissionValue (legacy single rule) — accepted
  //     for older Network deployments; legacy columns get filled, no
  //     compound array stored
  //
  // When commissionRules is present, the legacy NOT NULL columns are
  // populated from the first 'every' sub-rule (or the first sub-rule)
  // as a best-effort summary; the resolver always prefers commissionRules.
  //
  // Without enough info to write either shape we fall back to the live
  // Campaign rule rather than silently mis-pricing.
  // Same fallback for a snapshot that can't price the partner the way the
  // program does — a granted program's rule with its slabs stripped by a
  // Network that predates them, or a slab table that fails a program's own
  // checks. A snapshot outranks the live rule for good, so it isn't stored;
  // the partner accrues on the live rule. See vetApprovalSnapshot. A
  // program-scoped snapshot (one program named) is only compared with that
  // program's rule — it never prices the partner anywhere else.
  if (snap) {
    const verdict = await vetApprovalSnapshot(db, snap, snapshotProgramId ? [snapshotProgramId] : programIds);
    if (!verdict.store) {
      console.warn(`[partners] approval snapshot for ${id} not stored: ${verdict.reason}; accruing on the live program rule`);
      snap = undefined;
    } else if (verdict.commissionRules) {
      snap = { ...snap, commissionRules: verdict.commissionRules as NonNullable<typeof snap.commissionRules> };
    }
  }
  if (snap?.commissionRules && snap.commissionRules.length > 0) {
    await upsertPartnerCommission(db, {
      partnerId: id,
      tenantId,
      programId: snapshotProgramId,
      // Vetted above: any slab table has been parsed (vetApprovalSnapshot),
      // and the legacy columns only read type/value/recurring anyway.
      ...legacyRuleColumns(snap.commissionRules as readonly CommissionSubRule[]),
      commissionRules: JSON.stringify(snap.commissionRules),
      holdbackDays: snap.holdbackDays ?? null,
      source: 'approval',
      snapshottedAt: new Date(),
    });
  } else if (snap?.commissionType != null && snap.commissionValue != null) {
    await upsertPartnerCommission(db, {
      partnerId: id,
      tenantId,
      programId: snapshotProgramId,
      commissionType: snap.commissionType,
      commissionValue: snap.commissionValue.toFixed(4),
      recurring: snap.recurring ?? false,
      holdbackDays: snap.holdbackDays ?? null,
      source: 'approval',
      snapshottedAt: new Date(),
    });
  }
  for (const { programId, ...terms } of programTerms) {
    await writeCommissionOverride(db, tenantId, id, programId, terms);
  }

  if (sendInvite) {
    const issued = await issueMagicLink(db, {
      tenantId,
      email,
      purpose: 'partner_invite',
      principalKind: 'partner',
      principalId: id,
    });
    const { resolveBrandName } = await import('../brand-name.js');
    const brandName = await resolveBrandName(db, tenantId);
    const tmpl = partnerInviteEmail(body.data.name, buildMagicLinkUrl(issued.plaintext, linkTenantOf(req)), brandName);
    await getMailer().send({ db, tenantId }, {
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'partner_invite',
      metadata: { purpose: 'partner_invite', partnerId: id },
    });
  }

  // Network: a partner the brand recruited directly is NOT pushed — they
  // decide for themselves in the portal (network-consent.ts), and a
  // headless program's partners may never see it. Only a partner the
  // Network itself provisioned (its approve federation, on the brand's
  // registered federation key) is already a member, so it counts as
  // consented and syncs back — once this request has committed. A Network
  // outage queues the push in NetworkOutbox.
  if (fromNetwork) {
    await grantNetworkConsent(db, tenantId, id, 'network_offering');
    afterCommit(req, 'network federation push', (trx) => syncPartnerToNetwork(trx, tenantId, partner as PartnerRow));
  }

  // Webhook fan-out. partner.created always; partnership.approved
  // only when this Partner was created via Network federation
  // (metadata.source === 'openpartner_network' set by the Network's
  // approve flow). Subscribers like Zapier / ActivePieces use these
  // to drive Slack notifications, CRM contact creation, welcome
  // sequences, etc. Async — failures don't block the response. After
  // COMMIT: a receiver may fetch the partner straight away, and a
  // rolled-back request must announce nothing (on-commit.ts).
  const partnerRow = partner as PartnerRow;
  const createdPayload = {
    partnerId: id,
    email,
    name: body.data.name,
    activatedAt: partnerRow.activatedAt ? partnerRow.activatedAt.toISOString() : null,
    invited: sendInvite,
    portalAccess,
    programIds,
    source: 'api',
  } satisfies WebhookPayload<'partner.created'>;
  onCommit(db, 'partner.created webhook', () => dispatchEvent(tenantId, 'partner.created', createdPayload));
  // A partner created without an invite is active now, so this is their
  // activation; an invited partner's comes from magic-link verify when
  // they accept. Either way it fires once. Subscribers that greet new
  // partners can tell the two apart by `invited`. After COMMIT, like
  // partner.created.
  if (partnerRow.activatedAt) {
    const activatedPayload = {
      partnerId: id,
      email,
      name: body.data.name,
      activatedAt: partnerRow.activatedAt.toISOString(),
      invited: false,
      source: 'api',
    } satisfies WebhookPayload<'partner.activated'>;
    onCommit(db, 'partner.activated webhook', () => dispatchEvent(tenantId, 'partner.activated', activatedPayload));
  }
  if ((body.data.metadata as Record<string, unknown> | undefined)?.source === 'openpartner_network') {
    const approvedPayload = {
      partnerId: id,
      email,
      name: body.data.name,
      networkCreatorId: (body.data.metadata as Record<string, unknown>).networkCreatorId,
      programIds,
    } satisfies WebhookPayload<'partnership.approved'>;
    onCommit(db, 'partnership.approved webhook', () => dispatchEvent(tenantId, 'partnership.approved', approvedPayload));
  }

  res.status(201).json({ ...partner, invited: sendInvite });
});

/**
 * Re-send an invite for a partner who hasn't accepted yet. Admin only.
 * Idempotent: multiple sends are fine; the partner can click any one
 * (they all expire in 15 minutes).
 *
 * For an applicant held for review (partner-review.ts) this is also the
 * approval: it's recorded before the link is issued, so the link can
 * activate them. The approval stands even if the email then fails (422
 * commits), and a later call just re-sends.
 */
partnersRouter.post('/partners/:id/invite', requireAuth, grantScope('partners:write'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
  if (!partner) return res.status(404).json({ error: 'not_found' });
  if (partner.activatedAt) return res.status(409).json({ error: 'already_activated' });
  // The invite is a sign-in link: turn portal access on first
  // (PATCH /partners/:id). Checked before the approval below, so a refused
  // call approves nobody.
  if (!partner.portalAccess) return res.status(409).json({ error: 'portal_access_disabled' });

  const approved = isPendingReview(partner);
  if (approved) {
    await db<PartnerRow>(TABLES.Partner)
      .where({ id: partner.id })
      .update({
        metadata: db.raw(`jsonb_set("metadata", '{review}', ("metadata"->'review') || ?::jsonb, true)`, [
          JSON.stringify({ status: 'approved', approvedAt: new Date().toISOString() }),
        ]),
        updatedAt: new Date(),
      });
  }

  const issued = await issueMagicLink(db, {
    tenantId,
    email: partner.email,
    purpose: 'partner_invite',
    principalKind: 'partner',
    principalId: partner.id,
  });
  const { resolveBrandName } = await import('../brand-name.js');
  const brandName = await resolveBrandName(db, tenantId);
  const tmpl = partnerInviteEmail(partner.name, buildMagicLinkUrl(issued.plaintext, linkTenantOf(req)), brandName);
  // Mail-send failures here mean the partner literally can't get the
  // magic link — the invite genuinely didn't go out. But surface as
  // 422 mail_send_failed (not 500) so the caller can distinguish
  // "partner uncontactable" from a real server error and react
  // accordingly (Postmark suppression list, bad address, etc.).
  try {
    await getMailer().send({ db, tenantId }, {
      to: partner.email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'partner_invite',
      metadata: { purpose: 'partner_invite', partnerId: partner.id, resend: true },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[partners/invite] mail send failed', { partnerId: partner.id, detail });
    return res.status(422).json({ error: 'mail_send_failed', detail, approved });
  }
  res.json({ ok: true, approved });
});

export const revokeSchema = z.object({
  reason: z.string().max(500).optional(),
  // Default: notify a partner who has portal access (the industry-standard
  // partner-program norm); admin unchecks for fraud cases where tipping
  // the partner off is counterproductive. A partner without portal access
  // is a headless program's customer who has never heard from OpenPartner,
  // so a suspension email from us would come out of nowhere: they're only
  // told when the caller asks for it.
  notify: z.boolean().optional(),
});

/**
 * Suspend a partner. Flips revokedAt, revokes all of their sessions so
 * they're kicked out mid-request, leaves historical commissions
 * untouched. Future attribution skips them; router flags clicks on their
 * links as 'revoked'. Sends a notification email unless notify=false (or,
 * for a partner without portal access, unless notify=true).
 */
partnersRouter.post('/partners/:id/revoke', requireAuth, grantScope('partners:write'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = revokeSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
  if (!partner) return res.status(404).json({ error: 'not_found' });
  if (partner.revokedAt) return res.status(409).json({ error: 'already_revoked' });

  const now = new Date();
  const reason = body.data.reason ?? null;
  // The request is already in a transaction (per-request via tenantMiddleware);
  // operate on req.db directly without a nested trx.
  await db<PartnerRow>(TABLES.Partner)
    .where({ id: partner.id })
    .update({ revokedAt: now, revokeReason: reason, updatedAt: now });
  // Kill every authentication channel they hold: web sessions AND
  // their partner-scoped API keys. Leaving ApiKey rows live meant a
  // revoked partner retained programmatic access even though their
  // dashboard cookie was killed.
  await db<SessionRow>(TABLES.Session)
    .where({ principalKind: 'partner', principalId: partner.id })
    .whereNull('revokedAt')
    .update({ revokedAt: now });
  await db<ApiKeyRow>(TABLES.ApiKey)
    .where({ partnerId: partner.id })
    .whereNull('revokedAt')
    .update({ revokedAt: now });

  // Notification is best-effort. The revoke itself already
  // succeeded above (DB updates are committed); a failed mail send
  // — Postmark suppression list, SMTP outage, bounce — shouldn't
  // bubble as a 500 and make the caller think the revoke didn't
  // happen. Log + continue. The response indicates whether we
  // managed to send so the caller can surface a follow-up to the
  // admin if they care.
  let notified = false;
  let notifyError: string | null = null;
  if (body.data.notify ?? partner.portalAccess) {
    try {
      const tmpl = partnerRevokedEmail(partner.name, reason);
      await getMailer().send({ db, tenantId }, {
        to: partner.email,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag: 'partner_revoked',
        metadata: { purpose: 'partner_revoked', partnerId: partner.id },
      });
      notified = true;
    } catch (err) {
      notifyError = err instanceof Error ? err.message : String(err);
      console.error('[partners/revoke] notify failed', { partnerId: partner.id, err: notifyError });
    }
  }

  // The Network gets the revoke too, if it has this partner — i.e. they
  // consented. Not gated on the brand offering the Network: a creator the
  // Network thinks is active shouldn't keep getting matched after the
  // vendor cuts them off. A partner who never opted in is never sent,
  // revoke included. Sent once the revoke has committed.
  afterCommit(req, 'network revoke push', (trx) => syncPartnerRevokeToNetwork(trx, tenantId, partner));

  res.json({ ok: true, revokedAt: now, notified, notifyError });
});

/** Undo revoke — partner regains dashboard access and future attribution. */
partnersRouter.post('/partners/:id/reinstate', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
  if (!partner) return res.status(404).json({ error: 'not_found' });
  if (!partner.revokedAt) return res.status(409).json({ error: 'not_revoked' });

  await db<PartnerRow>(TABLES.Partner)
    .where({ id: partner.id })
    .update({ revokedAt: null, revokeReason: null, updatedAt: new Date() });
  res.json({ ok: true });
});

/**
 * List partners. Supports:
 *   - ?email=foo@bar.com  — exact-match filter (Zapier "find by email")
 *   - ?q=ada              — case-insensitive substring match on name or
 *                           email (the admin search box; blank = no filter)
 *   - ?limit=N            — page size (1-200, default 100)
 *   - ?cursor=...         — opaque cursor returned by the previous page
 *
 * Returns { partners, nextCursor }. nextCursor is null when no more
 * pages. Cursor is opaque base64url(`createdAt|id`) at microsecond
 * precision — see pagination.ts for why millisecond cursors skipped rows.
 *
 * Stable ordering: createdAt DESC, id DESC as tiebreaker (id is
 * lexicographically increasing for ULIDs but not for legacy partners,
 * so we explicitly tie-break). Filters narrow the rows but never change
 * the order, so a search pages with the same cursor scheme.
 */
export const listQuerySchema = z.object({
  email: z.string().trim().email().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  cursor: z.string().optional(),
});

/** `%term%` for ILIKE, with the term's own LIKE metacharacters escaped so
 *  a search for "50%" or "a_b" matches literally. */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
partnersRouter.get('/partners', requireAuth, grantScope('partners:read'), requireAdmin, async (req, res) => {
  const q = listQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });
  const { db, tenantId } = tenantOf(req);
  // tenantId spelled out, not left to RLS: it keeps the (tenantId, email)
  // index on a pool that bypasses RLS, and it did under the policy's old
  // platform-admin OR (dropped by 20261017100000_rls_plain_tenant_policies).
  const query = db<PartnerRow>(TABLES.Partner)
    .where({ tenantId })
    .select('*', cursorTimestamp(db, 'createdAt'))
    .orderBy([
      { column: 'createdAt', order: 'desc' },
      { column: 'id', order: 'desc' },
    ]);
  if (q.data.email) query.where('email', q.data.email.toLowerCase());
  if (q.data.q) {
    const pattern = containsPattern(q.data.q);
    query.where((w) => w.whereILike('name', pattern).orWhereILike('email', pattern));
  }
  if (q.data.cursor) {
    const decoded = decodeCursor(q.data.cursor);
    if (!decoded) return res.status(400).json({ error: 'invalid_cursor' });
    // Strict inequality on the composite key — the row at the cursor
    // itself was already returned in the previous page.
    whereAfterCursor(query, 'createdAt', 'id', decoded);
  }
  const { page, nextCursor } = takePage(await query.limit(q.data.limit + 1), q.data.limit);
  res.json({ partners: page, nextCursor });
});

// partners:read also covers the single-record read: GET /partners already
// returns these same rows to that scope, so this exposes nothing new to a
// scoped integration key — it just saves a headless integration paging
// the list to look one partner up.
partnersRouter.get('/partners/:id', requireAuth, grantScope('partners:read'), requirePartnerOrAdmin('id'), async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
  if (!partner) return res.status(404).json({ error: 'not_found' });
  res.json(partner);
});

/** Fields an admin can change on an existing partner. Strict, so a field
 *  that isn't editable here is a 400 rather than silently ignored. */
export const updateSchema = z
  .object({
    /** See createSchema.portalAccess. Turning it off ends the partner's
     *  sessions and unused sign-in links at once; turning it on sends
     *  nothing (an active partner can then request a link at sign-in, a
     *  pending one needs POST /partners/:id/invite). */
    portalAccess: z.boolean().optional(),
  })
  .strict();

partnersRouter.patch('/partners/:id', requireAuth, grantScope('partners:write'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = updateSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'not_found' });

  let updated = partner;
  if (body.data.portalAccess !== undefined && body.data.portalAccess !== partner.portalAccess) {
    const rows = (await db<PartnerRow>(TABLES.Partner)
      .where({ id: partner.id })
      .update({ portalAccess: body.data.portalAccess, updatedAt: new Date() })
      .returning('*')) as PartnerRow[];
    updated = rows[0] ?? partner;
  }
  // Also when it was already off: whatever slipped in since (a link sent
  // a moment before, a session from a direct DB edit) ends here too.
  if (body.data.portalAccess === false) await endPortalAccess(db, tenantId, partner.id);
  res.json(updated);
});

// Per-partner commission snapshot: the PARTNER-WIDE PartnerCommission row
// (programId null), if any. Program-scoped rows have their own endpoints
// below. Surfaced separately because the partner detail page wants to show
// "Approved under: 20% recurring, 30d holdback (since 2026-04-15)"
// and the snapshot is a sidecar table — keeps the GET /partners/:id
// shape unchanged.
partnersRouter.get('/partners/:id/commission-snapshot', requireAuth, requirePartnerOrAdmin('id'), async (req, res) => {
  const { db } = tenantOf(req);
  const snapshot = await findPartnerCommission(db, req.params.id!, null);
  res.json({ snapshot: snapshot ?? null });
});

/** Write an admin override for one scope (programId null = partner-wide).
 *  Stamped with source='amendment' so it's distinguishable from the
 *  regular approval-time + backfill snapshots in audit + reporting. PUT
 *  semantics — replaces any existing row for that scope in full. */
async function writeCommissionOverride(
  db: Knex,
  tenantId: string,
  partnerId: string,
  programId: string | null,
  terms: z.infer<typeof overrideSchema>,
): Promise<void> {
  await upsertPartnerCommission(db, {
    partnerId,
    tenantId,
    programId,
    commissionType: terms.commissionType,
    commissionValue: terms.commissionValue.toFixed(4),
    recurring: terms.recurring ?? false,
    commissionRules: terms.commissionRules ? JSON.stringify(terms.commissionRules) : null,
    holdbackDays: terms.holdbackDays ?? null,
    source: 'amendment',
    snapshottedAt: new Date(),
  });
}

// Admin override: set or replace a partner's partner-wide commission
// snapshot. Program-scoped rows still win on their own programs.
partnersRouter.put('/partners/:id/commission-snapshot', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = overrideSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });
  await writeCommissionOverride(db, tenantId, partner.id, null, body.data);
  res.json({ snapshot: await findPartnerCommission(db, partner.id, null) });
});

// Admin: clear a partner's partner-wide override. Drops that
// PartnerCommission row, which means future commissions fall back to
// the live Campaign rule again (program-scoped rows are left alone).
// Useful for unwinding a VIP rate when a partnership downgrades.
partnersRouter.delete('/partners/:id/commission-snapshot', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });
  await db(TABLES.PartnerCommission).where({ partnerId: partner.id }).whereNull('programId').del();
  res.json({ ok: true });
});

// Program-scoped commission terms: the same body and semantics as the
// partner-wide snapshot above, for one program. On that program this row
// beats the partner-wide one (attribution.ts resolveCommissionRule), and
// it sets the holdback too (blank = the program's own, not the partner-wide one).
partnersRouter.get(
  '/partners/:id/programs/:programId/commission',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db } = tenantOf(req);
    const snapshot = await findPartnerCommission(db, req.params.id!, req.params.programId!);
    res.json({ snapshot: snapshot ?? null });
  },
);

// Doesn't require a grant on the program: an admin can agree terms before
// granting access, and terms outlive a revoked grant so links that keep
// attributing after the revoke are still paid what was agreed.
partnersRouter.put('/partners/:id/programs/:programId/commission', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = overrideSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });
  const program = await db(TABLES.Program).where({ id: req.params.programId, tenantId }).first('id');
  if (!program) return res.status(404).json({ error: 'program_not_found' });
  await writeCommissionOverride(db, tenantId, partner.id, program.id as string, body.data);
  res.json({ snapshot: await findPartnerCommission(db, partner.id, program.id as string) });
});

// Clears the program-scoped row only. Commissions on the program then
// fall back to the partner-wide snapshot, or the program rule.
partnersRouter.delete('/partners/:id/programs/:programId/commission', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });
  await db(TABLES.PartnerCommission).where({ partnerId: partner.id, programId: req.params.programId }).del();
  res.json({ ok: true });
});

// One-shot backfill of PartnerCommission for partners that predate
// snapshot federation: one program-scoped row per grant. Idempotent —
// can be run multiple times. See backfillCommissionSnapshots for what
// it skips.
partnersRouter.post('/partners/backfill-commission-snapshots', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const { backfillCommissionSnapshots } = await import('../backfill-commission-snapshots.js');
  const result = await backfillCommissionSnapshots(db, tenantId);
  res.json(result);
});
