/**
 * Coupon-code attribution.
 *
 *   GET  /partners/:id/coupons                 list a partner's coupons
 *   POST   /partners/:id/coupons                  mint a coupon
 *                                                 body: { programId, code? }
 *                                                 code defaults to <handle><rand4>
 *                                                 admin always; federation
 *                                                 (partners:write scope) only
 *                                                 when program.partnersMayCustomizeCode
 *   DELETE /partners/:id/coupons/:couponId        deactivate a coupon (same auth)
 *   POST   /coupons/redeem                        brand-side conversion path
 *                                              body: { code, eventType, value?,
 *                                                       currency?, externalEventId,
 *                                                       userId, ts? }
 *                                              writes Click + Identity + Event so
 *                                              the existing attribution engine
 *                                              processes the redemption identically
 *                                              to a clicked share-link conversion.
 *
 * Append-only: a partner can have multiple ACTIVE coupons per program
 * (capped — see ACTIVE_CODES_PER_PROGRAM_CAP). A "rename" is
 * client-side: POST a new code, then DELETE the old one. Old codes
 * stay redeemable until explicitly deactivated, so links/posts the
 * partner already shared don't break the moment they iterate.
 *
 * The auto-mint on PartnerCampaign insert (autoMintCouponsForGrants
 * below) skips when an active coupon already exists for the pair —
 * pre-existing manual mints aren't overwritten.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { randomBytes } from 'node:crypto';
import {
  TABLES,
  type ProgramRow,
  type ClickRow,
  type CouponRow,
  type CustomerReward,
  type EventRow,
  type IdentityRow,
  type PartnerRow,
} from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { getTenancyMode, tenantOf } from '../tenancy.js';
import { getMode } from '../stripe.js';
import { attributeEvent } from '../attribution.js';
import { sameConversion } from '../conversion-ingest.js';
import { codeExistsInStripe, deactivateCustomerReward, provisionCustomerReward } from '../customer-rewards.js';

export const couponsRouter = Router();

// ---------- List + create per partner ----------

couponsRouter.get('/partners/:id/coupons', requireAuth, requirePartnerOrAdmin('id'), async (req, res) => {
  const { db } = tenantOf(req);
  const rows = await db<CouponRow>(TABLES.Coupon)
    .where({ partnerId: req.params.id })
    .orderBy('createdAt', 'asc');
  if (rows.length === 0) return res.json({ coupons: [] });

  // canEdit per coupon = the coupon's program permits partner-side
  // customization. Surfaced so the creator portal (federated through
  // /creators/me/partnerships) knows whether to show a rename action
  // without making a second round-trip per coupon.
  const programIds = Array.from(new Set(rows.map((r) => r.programId)));
  const programs = (await db<ProgramRow>(TABLES.Program)
    .whereIn('id', programIds)
    .select('id', 'partnersMayCustomizeCode')) as Array<Pick<ProgramRow, 'id' | 'partnersMayCustomizeCode'>>;
  const canEditByProgram = new Map(programs.map((p) => [p.id, p.partnersMayCustomizeCode]));

  // 90-day redemption stats per coupon. Coupon-driven Clicks are
  // identifiable by landingUrl='coupon://<code>'. Two batched queries
  // (one for click counts, one for revenue) keep this O(1) regardless
  // of how many coupons the partner has.
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const landingUrls = rows.map((r) => `coupon://${r.code}`);

  const clickCounts = (await db(TABLES.Click)
    .where({ partnerId: req.params.id })
    .whereIn('landingUrl', landingUrls)
    .andWhere('ts', '>=', since)
    .groupBy('landingUrl')
    .select('landingUrl')
    .count<{ landingUrl: string; count: string }[]>({ count: '*' })) as Array<{ landingUrl: string; count: string }>;

  const revenue = (await db(TABLES.Click)
    .join(TABLES.Attribution, `${TABLES.Attribution}.clickId`, `${TABLES.Click}.id`)
    .join(TABLES.Event, `${TABLES.Event}.id`, `${TABLES.Attribution}.eventId`)
    .where(`${TABLES.Click}.partnerId`, req.params.id)
    .whereIn(`${TABLES.Click}.landingUrl`, landingUrls)
    .andWhere(`${TABLES.Attribution}.computedAt`, '>=', since)
    .groupBy(`${TABLES.Click}.landingUrl`)
    .select(`${TABLES.Click}.landingUrl as landingUrl`)
    .select(db.raw(`COALESCE(SUM("Event".value * "Attribution".weight), 0) as revenue`))) as Array<{ landingUrl: string; revenue: string }>;

  const countByUrl = new Map(clickCounts.map((r) => [r.landingUrl, Number(r.count)]));
  const revenueByUrl = new Map(revenue.map((r) => [r.landingUrl, Number(r.revenue)]));

  res.json({
    coupons: rows.map((r) => {
      const url = `coupon://${r.code}`;
      return {
        ...r,
        redemptions90d: countByUrl.get(url) ?? 0,
        revenue90d: revenueByUrl.get(url) ?? 0,
        canEdit: canEditByProgram.get(r.programId) ?? false,
      };
    }),
  });
});

export const createSchema = z.object({
  programId: z.string().min(1),
  code: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[A-Z0-9-]+$/, 'code must be uppercase alphanumeric (with optional hyphens)')
    .optional(),
});

/** Free-trial threshold: a brand can mint up to this many coupons
 *  manually before we require integration verification. Auto-mint on
 *  PartnerCampaign grant doesn't trip the gate (system action, not
 *  admin intent). */
const COUPON_VERIFICATION_THRESHOLD = 5;

/** Active-codes cap per (partner, program). Prevents a partner from
 *  filling the brand's Stripe dashboard with thousands of codes via the
 *  self-service create endpoint. Five gives a partner room for a few
 *  iterations + a couple of audience-specific codes (TIKTOK15, IG15)
 *  while keeping the cleanup story simple. Counts only non-deactivated
 *  rows — partners can deactivate then re-add freely. */
const ACTIVE_CODES_PER_PROGRAM_CAP = 5;

/** Rolling 24h creation cap per (partner, program) for self-service mints
 *  (partners + federated creators). The active-codes cap alone doesn't bound
 *  churn: create/deactivate loops each mint a fresh Stripe Coupon +
 *  PromotionCode on self-host. Counts deactivated rows too. Admins bypass. */
const CREATIONS_PER_DAY_CAP = 10;

/** 409 detail for the verification gate. Only a single-tenant self-host
 *  can offer the Stripe webhook as an alternative: /webhooks/stripe
 *  verifies OpenPartner's own signing secrets and resolves tenants from
 *  platform or connected-account objects, so checkout and invoice
 *  events from a hosted brand's own Stripe account never arrive there.
 *  Everywhere else POST /coupons/redeem is the only coupon path. */
export function couponVerificationDetail(existing: number): string {
  const howTo =
    getMode() === 'selfhost' && getTenancyMode() === 'single'
      ? 'Wire up POST /coupons/redeem on your checkout — or set up a Stripe webhook pointing at /webhooks/stripe — and process one test redemption'
      : 'Wire up POST /coupons/redeem on your checkout and process one test redemption';
  return `You have ${existing} coupons but no successful redemption yet. ${howTo} to unlock further mints. This protects creators from sharing codes that don't actually attribute.`;
}

couponsRouter.post('/partners/:id/coupons', requireAuth, async (req, res) => {
  // Authorization:
  //   - admin → always allowed.
  //   - scoped key with 'partners:write' → allowed only when the bound
  //     program's partnersMayCustomizeCode flag is true. Network proxies
  //     a creator's "Add another code" through this path.
  //   - local partner → own codes only, with program access and customization enabled.
  //   - everything else → 403.
  const principal = req.principal;
  const isAdmin = principal?.role === 'admin';
  const isFederated = principal?.role === 'scoped' && principal.scopes.includes('partners:write');
  const isPartner = principal?.role === 'partner' && principal.partnerId === req.params.id;
  if (!isAdmin && !isFederated && !isPartner) return res.status(403).json({ error: 'forbidden' });

  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });

  const program = await db<ProgramRow>(TABLES.Program).where({ id: body.data.programId }).first();
  if (!program) return res.status(404).json({ error: 'program_not_found' });

  // Federated callers must clear the program-level toggle. Admin
  // always bypasses — they own the program and can mint whatever they
  // want regardless of the partner-self-service setting.
  if (!isAdmin && !program.partnersMayCustomizeCode) {
    return res.status(403).json({ error: 'partner_customization_disabled' });
  }

  if (isPartner) {
    const grant = await db(TABLES.PartnerProgram).where({ partnerId: partner.id, programId: program.id }).first();
    if (!grant) return res.status(403).json({ error: 'campaign_not_granted' });
    const { campaignAcceptsNewActivity } = await import('../campaign-lifecycle.js');
    if (!campaignAcceptsNewActivity(program)) return res.status(409).json({ error: 'campaign_not_active' });
  }

  // Verification gate: past N coupons without a successful redemption
  // ever recorded, refuse new manual mints. Forces the brand to
  // actually wire up /coupons/redeem (or, on a single-tenant self-host,
  // the Stripe webhook auto-redemption path) before they hand more
  // codes to creators that won't attribute. Runs after the access checks
  // so a caller who can't mint here never learns the brand's coupon
  // count or integration state.
  const tenant = (await db('Tenant').where({ id: tenantId }).first(['couponIntegrationVerifiedAt'])) as
    | { couponIntegrationVerifiedAt: Date | null }
    | undefined;
  if (!tenant?.couponIntegrationVerifiedAt) {
    const countRow = (await db(TABLES.Coupon).count<{ count: string }[]>({ count: '*' })) as Array<{ count: string }>;
    const existing = Number(countRow[0]?.count ?? 0);
    if (existing >= COUPON_VERIFICATION_THRESHOLD) {
      if (!isAdmin) {
        return res.status(409).json({
          error: 'verification_required',
          detail: "This brand hasn't finished setting up coupon tracking yet, so new codes are paused. Ask the brand to complete their coupon integration.",
        });
      }
      return res.status(409).json({
        error: 'verification_required',
        detail: couponVerificationDetail(existing),
        threshold: COUPON_VERIFICATION_THRESHOLD,
        existing,
      });
    }
  }

  // Active-codes cap. Counts only non-deactivated rows so a partner who
  // deactivates an old code can immediately add a replacement. Admins
  // bypass — they may legitimately need to bulk-mint for a campaign with
  // many audience-specific codes. (The brand-level verification gate
  // above is a separate, system-wide guard.)
  if (!isAdmin) {
    const activeCount = (await db(TABLES.Coupon)
      .where({ partnerId: partner.id, programId: program.id })
      .whereNull('deactivatedAt')
      .count<{ count: string }[]>({ count: '*' })) as Array<{ count: string }>;
    if (Number(activeCount[0]?.count ?? 0) >= ACTIVE_CODES_PER_PROGRAM_CAP) {
      return res.status(409).json({
        error: 'active_codes_cap_reached',
        detail: `You already have ${ACTIVE_CODES_PER_PROGRAM_CAP} active codes for this program. Deactivate one before adding another.`,
        cap: ACTIVE_CODES_PER_PROGRAM_CAP,
      });
    }
    const createdToday = (await db(TABLES.Coupon)
      .where({ partnerId: partner.id, programId: program.id })
      .where('createdAt', '>', new Date(Date.now() - 24 * 60 * 60 * 1000))
      .count<{ count: string }[]>({ count: '*' })) as Array<{ count: string }>;
    if (Number(createdToday[0]?.count ?? 0) >= CREATIONS_PER_DAY_CAP) {
      return res.status(429).json({
        error: 'daily_code_limit_reached',
        detail: `You've created ${CREATIONS_PER_DAY_CAP} codes for this program in the last 24 hours. Try again tomorrow.`,
        cap: CREATIONS_PER_DAY_CAP,
      });
    }
  }

  const code = body.data.code ?? defaultCode(partner.email);

  // A code the brand's admin typed is theirs to pick — including mapping
  // a promo that already exists in their Stripe onto a partner. Any other
  // code (a partner's choice, or a generated one) must not shadow an
  // existing promotion code / coupon id there: redemption matches on the
  // string, so a partner holding WELCOME10 would be credited with every
  // order using the brand's own sitewide promo. Fail closed when Stripe
  // can't answer.
  const adminChosen = isAdmin && body.data.code !== undefined;
  if (!adminChosen) {
    let shadowsStripe: boolean;
    try {
      shadowsStripe = await codeExistsInStripe(code);
    } catch (err) {
      console.error('[coupons] Stripe code check failed', { code, err });
      return res.status(503).json({
        error: 'code_check_unavailable',
        detail: "Couldn't confirm the code is free in Stripe. Try again shortly.",
      });
    }
    if (shadowsStripe) return res.status(409).json({ error: 'code_taken' });
  }

  // Provision the Stripe customer-side discount BEFORE writing our row
  // so a Stripe failure doesn't leave a dangling Coupon with stale
  // stripeCouponId fields. provisionCustomerReward returns null on
  // any failure (Stripe not configured, API error, malformed reward) —
  // the row is still inserted, just without the auto-applied discount.
  const reward = (program.customerReward as CustomerReward | null) ?? null;
  const provisioned = reward
    ? await provisionCustomerReward(reward, code, program.name)
    : null;

  try {
    const id = `cpn_${ulid()}`;
    await db<CouponRow>(TABLES.Coupon).insert({
      id,
      tenantId,
      partnerId: partner.id,
      programId: program.id,
      code,
      stripeCouponId: provisioned?.stripeCouponId ?? null,
      stripePromotionCodeId: provisioned?.stripePromotionCodeId ?? null,
    });
    const row = await db<CouponRow>(TABLES.Coupon).where({ id }).first();
    return res.status(201).json({ ...row, canEdit: program.partnersMayCustomizeCode });
  } catch (err) {
    // No row owns the promo we just provisioned — release it so the code
    // doesn't keep discounting at checkout with nothing to attribute to.
    if (provisioned) await deactivateCustomerReward(provisioned.stripePromotionCodeId);
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      // Per-tenant code uniqueness only — the (partner, program) unique
      // is gone after the append-only migration.
      return res.status(409).json({ error: 'code_taken' });
    }
    throw err;
  }
});

// ---------- Deactivate (partner self-service or admin) ----------
//
// Sets Coupon.deactivatedAt and disables the Stripe PromotionCode so
// new redemptions of the old string fail at checkout. Historical
// attributions stay attached to this row — we never delete a Coupon
// once it's been used.
//
// Authorization mirrors POST: admin always; federated only when the
// program's partnersMayCustomizeCode is on. Partners can only
// deactivate their own coupons (the route already scopes to :id).

couponsRouter.delete('/partners/:id/coupons/:couponId', requireAuth, async (req, res) => {
  const principal = req.principal;
  const isAdmin = principal?.role === 'admin';
  const isFederated = principal?.role === 'scoped' && principal.scopes.includes('partners:write');
  const isPartner = principal?.role === 'partner' && principal.partnerId === req.params.id;
  if (!isAdmin && !isFederated && !isPartner) return res.status(403).json({ error: 'forbidden' });

  const { db } = tenantOf(req);
  const coupon = await db<CouponRow>(TABLES.Coupon)
    .where({ id: req.params.couponId, partnerId: req.params.id })
    .first();
  if (!coupon) return res.status(404).json({ error: 'coupon_not_found' });

  const program = await db<ProgramRow>(TABLES.Program).where({ id: coupon.programId }).first();
  if (!program) return res.status(404).json({ error: 'program_not_found' });

  if (!isAdmin && !program.partnersMayCustomizeCode) {
    return res.status(403).json({ error: 'partner_customization_disabled' });
  }

  if (isPartner) {
    const grant = await db(TABLES.PartnerProgram).where({ partnerId: req.params.id, programId: program.id }).first();
    if (!grant) return res.status(403).json({ error: 'campaign_not_granted' });
  }

  // Idempotent: re-deactivating a deactivated coupon is a no-op +
  // returns 200 so a UI retry doesn't surface as an error.
  if (coupon.deactivatedAt) {
    return res.json({ ...coupon, canEdit: program.partnersMayCustomizeCode });
  }

  // Disable the Stripe PromotionCode (best-effort). If Stripe is down
  // or the code was never provisioned, we still flip our own flag —
  // the OpenPartner attribution path is the source of truth for "is
  // this code redeemable in OpenPartner," and a stale active Stripe
  // code without a matching active OpenPartner Coupon would just
  // discount the customer without attributing.
  if (coupon.stripePromotionCodeId) {
    await deactivateCustomerReward(coupon.stripePromotionCodeId);
  }

  await db<CouponRow>(TABLES.Coupon)
    .where({ id: coupon.id })
    .update({ deactivatedAt: new Date() });

  const updated = await db<CouponRow>(TABLES.Coupon).where({ id: coupon.id }).first();
  return res.json({ ...updated, canEdit: program.partnersMayCustomizeCode });
});

// ---------- Redeem ----------
//
// Brand calls this from checkout when a customer enters a coupon code.
// We resolve the code → (partnerId, programId), then synthesize the
// click → identity → event chain so the existing attribution engine
// processes the redemption identically to a real clicked conversion.
//
// The synthetic Click has landingUrl=coupon://<code>, ipHash=null,
// userAgent='OpenPartner-CouponRedeem/1' so coupon-driven attribution
// is identifiable in the Click table for analytics + audit.
//
// Idempotent on Event.externalEventId — re-sending the same redemption
// (e.g. from a webhook retry) replays instead of double-attributing, and
// reusing the key for a different redemption 409s. The key namespace is
// per tenant, shared with /attribution/events and Stripe event ids.

export const redeemSchema = z.object({
  code: z.string().trim().min(3).max(40),
  /** What kind of event the redemption represents. Same enum the
   *  existing /events route accepts — signup, trial_started,
   *  subscription_created, invoice_paid, etc. */
  eventType: z.string().min(1).max(80),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  /** Required so we can dedup retries. Use the brand's checkout-session
   *  ID, order ID, or whatever's stable. */
  externalEventId: z.string().min(1).max(120),
  /** The brand's internal user ID. Identity row links userId ↔
   *  synthetic clickId so subsequent events from the same user
   *  attribute via the standard path. */
  userId: z.string().min(1).max(120),
  ts: z.string().datetime().optional(),
});

// Server-to-server coupon redemption → synthesizes Click+Identity+Event and
// runs attribution, so it mints commissions. Same gate as /attribution/events:
// admin, or a scoped `events:write` key (grantScope rewrites to admin).
// requireAdmin is load-bearing — without it a PARTNER (session or partner key)
// passes requireAuth, falls through grantScope unchanged, and could forge
// conversions crediting themselves.
couponsRouter.post('/coupons/redeem', requireAuth, grantScope('events:write'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = redeemSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const coupon = await findCouponByCode(db, body.data.code);
  if (!coupon) return res.status(404).json({ error: 'coupon_not_found' });

  const { userId, eventType, value, currency, externalEventId } = body.data;
  const ts = body.data.ts ? new Date(body.data.ts) : new Date();
  const row = {
    id: ulid(),
    tenantId,
    userId,
    type: eventType,
    value: value != null ? value.toFixed(2) : null,
    currency: currency ?? null,
    externalEventId,
    metadata: { source: 'coupon', code: coupon.code },
    ts,
  };

  // The Event goes in FIRST, with the (tenantId, externalEventId) unique
  // constraint as the idempotency arbiter (same as /attribution/events). A
  // replay or a conflict then returns before anything else is written — the
  // request transaction commits on 4xx, so a synthetic Click + Identity made
  // ahead of the insert would outlive a 409. A concurrent duplicate's INSERT
  // blocks on the first request's uncommitted row and no-ops once it commits.
  const [event] = (await db<EventRow>(TABLES.Event)
    .insert(row)
    .onConflict(['tenantId', 'externalEventId'])
    .ignore()
    .returning('*')) as EventRow[];

  if (!event) {
    const existing = await db<EventRow>(TABLES.Event).where({ tenantId, externalEventId }).first();
    if (!existing) throw new Error(`externalEventId conflict with no visible Event row (${externalEventId})`);
    if (!sameConversion(existing, row) || !isRedemptionOf(existing, coupon)) {
      return res.status(409).json({
        error: 'external_event_id_conflict',
        eventId: existing.id,
        detail:
          'externalEventId was already used for a different event: another userId, eventType, value, currency or coupon code, or a non-coupon event',
      });
    }
    return res.status(200).json({ ok: true, replayed: true, eventId: existing.id });
  }

  // Same transaction as the Event, so attributeEvent sees the touchpoint; any
  // failure from here 500s and rolls back the Event with it.
  await ensureCouponClickAndIdentity(db, tenantId, coupon, userId, ts);
  await attributeEvent(db, event);

  res.status(201).json({ ok: true, eventId: event.id, partnerId: coupon.partnerId });
});

/**
 * A coupon replay must also be a redemption of the same code. A key first
 * used by /attribution/events or a Stripe event, or by another code's
 * redemption, would otherwise replay and silently drop this request's coupon
 * touchpoint — so it 409s like any other mismatched reuse.
 */
function isRedemptionOf(event: EventRow, coupon: CouponRow): boolean {
  const meta = (event.metadata ?? {}) as { source?: unknown; code?: unknown };
  return meta.source === 'coupon' && typeof meta.code === 'string' && meta.code.toLowerCase() === coupon.code.toLowerCase();
}

/**
 * Lookup an ACTIVE Coupon by code within the current tenant. Case-
 * insensitive so customers entering keithf15a2x or KEITHF15A2X both
 * resolve; storage stays whatever the partner set. Deactivated codes
 * don't match — retiring a code stops new redemptions from attributing,
 * while users it already stitched keep attributing via their Identity.
 * Used by both the /coupons/redeem route and the Stripe webhook auto-
 * redemption path. Returns null when the code doesn't match anything in
 * this tenant — letting the caller no-op rather than 404.
 */
export async function findCouponByCode(
  db: import('knex').Knex,
  code: string,
): Promise<CouponRow | null> {
  const row = await db<CouponRow>(TABLES.Coupon)
    .whereRaw('lower("code") = ?', [code.toLowerCase()])
    .whereNull('deactivatedAt')
    .first();
  return row ?? null;
}

/**
 * Ensure a synthetic coupon Click + Identity exists for the given
 * (coupon, userId). If the user already has an Identity for any
 * Click on this coupon's partner, no-op (the user is already
 * attributed). Otherwise insert a fresh Click + Identity so the
 * attribution engine credits this partner on the next Event for
 * this user.
 *
 * The check is "any click for this partner" not "this exact coupon"
 * — re-redemptions of the same code by the same user shouldn't add
 * a new touchpoint, but a click on partner A's link followed by a
 * coupon for partner B should add a second touch (multi-touch).
 */
export async function ensureCouponClickAndIdentity(
  trx: import('knex').Knex,
  tenantId: string,
  coupon: CouponRow,
  userId: string,
  ts: Date,
): Promise<{ clickId: string; reused: boolean }> {
  // Has the user already been linked (via any Click) to this partner?
  // If so, no-op — they're already attributed and adding another
  // synthetic click would shift multi-touch weights unfairly.
  const existing = await trx<IdentityRow>(TABLES.Identity)
    .join(TABLES.Click, `${TABLES.Click}.id`, `${TABLES.Identity}.clickId`)
    .where(`${TABLES.Identity}.userId`, userId)
    .andWhere(`${TABLES.Click}.partnerId`, coupon.partnerId)
    .first(`${TABLES.Identity}.clickId as clickId`) as { clickId: string } | undefined;
  if (existing) return { clickId: existing.clickId, reused: true };

  const clickId = ulid();
  await trx<ClickRow>(TABLES.Click).insert({
    id: clickId,
    tenantId,
    linkId: null, // no Link — coupon path doesn't have one
    partnerId: coupon.partnerId,
    programId: coupon.programId,
    landingUrl: `coupon://${coupon.code}`,
    ipHash: null,
    userAgent: 'OpenPartner-CouponRedeem/1',
    referer: null,
    fraudFlag: null,
    ts,
  });
  await trx<IdentityRow>(TABLES.Identity)
    .insert({ id: ulid(), tenantId, clickId, userId })
    .onConflict(['clickId', 'userId'])
    .ignore();

  // Stamp the tenant's "coupon integration is verified" flag on the
  // FIRST successful redemption ever. COALESCE preserves the original
  // verification date on subsequent redemptions. Cross-tenant write,
  // which means the privileged db (not RLS-scoped trx) — but we
  // already know the tenantId came from a verified Coupon lookup.
  await trx('Tenant')
    .where({ id: tenantId })
    .update({
      couponIntegrationVerifiedAt: trx.raw('COALESCE("couponIntegrationVerifiedAt", NOW())'),
    });

  return { clickId, reused: false };
}

// ---------- Helpers ----------

function defaultCode(email: string): string {
  // <local-part-stripped-of-symbols-uppercased> + 4 random chars.
  // Example: ada.lovelace+test@example.com → ADALOVELACE + 4F2A
  const local = email.split('@')[0] ?? 'partner';
  const slug = local.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12) || 'PARTNER';
  const rand = randomBytes(2).toString('hex').toUpperCase();
  return `${slug}${rand}`;
}

/** Auto-mint's use of codeExistsInStripe. A generated code is a random
 *  draw rather than anyone's choice, so a Stripe outage shouldn't block
 *  the grant: fail open and log. (The POST route fails closed.) */
async function generatedCodeShadowsStripe(code: string): Promise<boolean> {
  try {
    return await codeExistsInStripe(code);
  } catch (err) {
    console.error('[coupons] auto-mint Stripe code check failed; proceeding', { code, err });
    return false;
  }
}

/**
 * Best-effort coupon mint after a PartnerCampaign grant. Used by:
 *   - POST /partners (auto-grants all current campaigns by default)
 *   - PUT /partners/:id/programs/:programId (admin grant)
 *   - Federation Network → /partners with programIds (offering approval)
 *
 * Idempotent: skips silently if a coupon already exists for the
 * (partnerId, programId) pair (admin may have minted one already).
 * On code collision (rare, since email-derived suffixes are usually
 * unique), retries once with a fresh suffix.
 */
export async function autoMintCouponsForGrants(
  db: import('knex').Knex,
  tenantId: string,
  partner: { id: string; email: string },
  programIds: string[],
): Promise<void> {
  if (programIds.length === 0) return;

  // Pre-load campaigns so we know which need a Stripe-side reward without
  // a SELECT per code-collision retry.
  const campaigns = (await db<ProgramRow>(TABLES.Program)
    .whereIn('id', programIds)
    .select('id', 'name', 'customerReward')) as Array<{
      id: string;
      name: string;
      customerReward: CustomerReward | null;
    }>;
  const campaignsById = new Map(campaigns.map((c) => [c.id, c]));

  for (const programId of programIds) {
    const campaign = campaignsById.get(programId);
    if (!campaign) continue;

    // Pre-check: skip if this partner already has an ACTIVE coupon for
    // this program. Append-only model means deactivated coupons don't
    // block a fresh auto-mint — partner cleared the slot, the system
    // re-mints. (Pre-migration coupons all have deactivatedAt=null so
    // they continue to block as before.)
    const existing = await db<CouponRow>(TABLES.Coupon)
      .where({ tenantId, partnerId: partner.id, programId })
      .whereNull('deactivatedAt')
      .first('id');
    if (existing) continue;

    // Two draws: defaultCode re-rolls 16 bits each call. A draw is
    // discarded when it shadows a promo in the brand's Stripe, or when it
    // collides with an existing code in this tenant. If both draws fail,
    // drop on the floor — better to skip auto-mint than to fail the
    // partner-grant operation.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const code = defaultCode(partner.email);
      if (await generatedCodeShadowsStripe(code)) continue;

      const provisioned = campaign.customerReward
        ? await provisionCustomerReward(campaign.customerReward, code, campaign.name)
        : null;

      let inserted: Array<Pick<CouponRow, 'id'>>;
      try {
        inserted = (await db<CouponRow>(TABLES.Coupon)
          .insert({
            id: `cpn_${ulid()}`,
            tenantId,
            partnerId: partner.id,
            programId,
            code,
            stripeCouponId: provisioned?.stripeCouponId ?? null,
            stripePromotionCodeId: provisioned?.stripePromotionCodeId ?? null,
          })
          // (partner, program) is no longer unique on Coupon — the only
          // surviving conflict here is (tenantId, code) when the random
          // suffix collides with an existing code. DO NOTHING rather than
          // a caught 23505 so the collision can't abort the caller's
          // transaction; an empty RETURNING is the collision signal.
          .onConflict(['tenantId', 'code'])
          .ignore()
          .returning('id')) as Array<Pick<CouponRow, 'id'>>;
      } catch (err) {
        if (provisioned) await deactivateCustomerReward(provisioned.stripePromotionCodeId);
        console.error('[coupons] auto-mint failed', { partnerId: partner.id, programId, err });
        break;
      }
      if (inserted.length > 0) break;
      // Collided: no row owns the promo provisioned for this draw.
      if (provisioned) await deactivateCustomerReward(provisioned.stripePromotionCodeId);
    }
  }
}
