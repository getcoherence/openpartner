/**
 * Coupon-code attribution.
 *
 *   GET  /partners/:id/coupons                 list a partner's coupons
 *   POST /partners/:id/coupons                 mint a coupon (admin only)
 *                                              body: { campaignId, code? }
 *                                              code defaults to <handle><rand4>
 *   POST /coupons/redeem                       brand-side conversion path
 *                                              body: { code, eventType, value?,
 *                                                       currency?, externalEventId,
 *                                                       userId, ts? }
 *                                              writes Click + Identity + Event so
 *                                              the existing attribution engine
 *                                              processes the redemption identically
 *                                              to a clicked share-link conversion.
 *
 * Scope: one Coupon per (partner, campaign). The auto-mint on
 * PartnerCampaign insert is wired in routes/partners.ts + the
 * partner-campaigns add path so coupons appear without admin action.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { randomBytes } from 'node:crypto';
import {
  TABLES,
  type CampaignRow,
  type ClickRow,
  type CouponRow,
  type EventRow,
  type IdentityRow,
  type PartnerRow,
} from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { attributeEvent } from '../attribution.js';

export const couponsRouter = Router();

// ---------- List + create per partner ----------

couponsRouter.get('/partners/:id/coupons', requireAuth, requirePartnerOrAdmin('id'), async (req, res) => {
  const { db } = tenantOf(req);
  const rows = await db<CouponRow>(TABLES.Coupon)
    .where({ partnerId: req.params.id })
    .orderBy('createdAt', 'asc');
  res.json({ coupons: rows });
});

const createSchema = z.object({
  campaignId: z.string().min(1),
  code: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[A-Z0-9-]+$/, 'code must be uppercase alphanumeric (with optional hyphens)')
    .optional(),
});

couponsRouter.post('/partners/:id/coupons', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });

  const campaign = await db<CampaignRow>(TABLES.Campaign).where({ id: body.data.campaignId }).first();
  if (!campaign) return res.status(404).json({ error: 'campaign_not_found' });

  const code = body.data.code ?? defaultCode(partner.email);
  try {
    const id = `cpn_${ulid()}`;
    await db<CouponRow>(TABLES.Coupon).insert({
      id,
      tenantId,
      partnerId: partner.id,
      campaignId: campaign.id,
      code,
    });
    const row = await db<CouponRow>(TABLES.Coupon).where({ id }).first();
    return res.status(201).json(row);
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'code_taken_or_partner_already_has_one_for_this_campaign' });
    }
    throw err;
  }
});

// ---------- Redeem ----------
//
// Brand calls this from checkout when a customer enters a coupon code.
// We resolve the code → (partnerId, campaignId), then synthesize the
// click → identity → event chain so the existing attribution engine
// processes the redemption identically to a real clicked conversion.
//
// The synthetic Click has landingUrl=coupon://<code>, ipHash=null,
// userAgent='OpenPartner-CouponRedeem/1' so coupon-driven attribution
// is identifiable in the Click table for analytics + audit.
//
// Idempotent on Event.externalEventId — re-sending the same redemption
// (e.g. from a webhook retry) doesn't double-attribute.

const redeemSchema = z.object({
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

couponsRouter.post('/coupons/redeem', requireAuth, grantScope('events:write'), async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = redeemSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  // Case-insensitive lookup so customers entering keithf15a2x or
  // KEITHF15A2X both resolve. Storage stays whatever the partner set.
  const coupon = await db<CouponRow>(TABLES.Coupon)
    .whereRaw('lower("code") = ?', [body.data.code.toLowerCase()])
    .first();
  if (!coupon) return res.status(404).json({ error: 'coupon_not_found' });

  // Idempotency: same externalEventId already processed → 200 + replayed flag.
  const existingEvent = await db<EventRow>(TABLES.Event)
    .where({ externalEventId: body.data.externalEventId, type: body.data.eventType })
    .first();
  if (existingEvent) {
    return res.status(200).json({ ok: true, replayed: true, eventId: existingEvent.id });
  }

  const ts = body.data.ts ? new Date(body.data.ts) : new Date();

  // Synthesize Click + Identity + Event in one trx so the attribution
  // engine sees a consistent picture.
  const result = await db.transaction(async (trx) => {
    await ensureCouponClickAndIdentity(trx, tenantId, coupon, body.data.userId, ts);

    const eventId = ulid();
    const [eventRow] = (await trx<EventRow>(TABLES.Event)
      .insert({
        id: eventId,
        tenantId,
        userId: body.data.userId,
        type: body.data.eventType,
        value: body.data.value != null ? String(body.data.value) : null,
        currency: body.data.currency ?? null,
        externalEventId: body.data.externalEventId,
        metadata: { source: 'coupon', code: coupon.code },
        ts,
      })
      .returning('*')) as EventRow[];
    return eventRow!;
  });

  // Attribution + commission run outside the trx — same pattern as the
  // /events route. If they fail, the event still exists and a backlog
  // run can catch it.
  await attributeEvent(db, result);

  res.status(201).json({ ok: true, eventId: result.id, partnerId: coupon.partnerId });
});

/**
 * Lookup a Coupon by code (case-insensitive) within the current tenant.
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
    campaignId: coupon.campaignId,
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

/**
 * Best-effort coupon mint after a PartnerCampaign grant. Used by:
 *   - POST /partners (auto-grants all current campaigns by default)
 *   - PUT /partners/:id/campaigns/:campaignId (admin grant)
 *   - Federation Network → /partners with campaignIds (offering approval)
 *
 * Idempotent: skips silently if a coupon already exists for the
 * (partnerId, campaignId) pair (admin may have minted one already).
 * On code collision (rare, since email-derived suffixes are usually
 * unique), retries once with a fresh suffix.
 */
export async function autoMintCouponsForGrants(
  db: import('knex').Knex,
  tenantId: string,
  partner: { id: string; email: string },
  campaignIds: string[],
): Promise<void> {
  if (campaignIds.length === 0) return;
  for (const campaignId of campaignIds) {
    let attempts = 0;
    while (attempts < 2) {
      attempts += 1;
      const code = defaultCode(partner.email);
      try {
        await db<CouponRow>(TABLES.Coupon)
          .insert({
            id: `cpn_${ulid()}`,
            tenantId,
            partnerId: partner.id,
            campaignId,
            code,
          })
          .onConflict(['tenantId', 'partnerId', 'campaignId'])
          .ignore(); // already exists for this (partner, campaign) — admin minted manually
        break;
      } catch (err) {
        // Code collision (the (tenantId, code) unique constraint
        // fired). Retry once with a fresh random suffix; defaultCode
        // re-rolls 16 bits each call. If it still collides, drop on
        // the floor — better to skip auto-mint than to fail the
        // partner-grant operation.
        if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505' && attempts < 2) {
          continue;
        }
        console.error('[coupons] auto-mint failed', { partnerId: partner.id, campaignId, err });
        break;
      }
    }
  }
}
