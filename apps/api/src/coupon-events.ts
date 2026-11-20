/**
 * coupon.registered / coupon.deactivated webhooks.
 *
 * A coupon is never hard-deleted (a used code keeps its attributions), so
 * "delete" anywhere in the product is a deactivation: Coupon.deactivatedAt
 * is set and the Stripe PromotionCode disabled. One event covers both.
 *
 * Every place a Coupon row is written or retired calls these:
 *   - POST   /partners/:id/coupons             registered (admin / partner / api_key)
 *   - autoMintCouponsForGrants                  registered (program_grant): the
 *     default code minted when a partner is created with programs, approved
 *     from the Network, or granted a program later
 *   - DELETE /partners/:id/coupons/:couponId   deactivated (admin / partner / api_key)
 *   - DELETE /partners/:id/programs/:programId deactivated (grant_revoked)
 *
 * Queued with onCommit, so a receiver that fetches the coupon finds it, and
 * a write that rolls back sends nothing.
 *
 * coupon.registered also says what the code is worth: the commission terms
 * the partner earns on its program, and the customer's discount. Those are
 * read once the write has committed, not when the code is minted: POST
 * /partners mints the default code before it writes the partner's own
 * terms, so a read at mint time would report the program's rate to a
 * partner who was just given a custom one.
 */

import type { Knex } from 'knex';
import {
  TABLES,
  renderCommissionSummary,
  type CouponRow,
  type CustomerReward,
  type PartnerCommissionRow,
  type ProgramRow,
} from '@openpartner/db';
import { db as privilegedDb } from './db.js';
import { rulesFor } from './attribution.js';
import { tenantDefaultCurrency } from './currency.js';
import { dispatchEvent } from './webhook-dispatcher.js';
import { onCommit } from './on-commit.js';
import type {
  COUPON_DEACTIVATED_SOURCES,
  COUPON_REGISTERED_SOURCES,
  WebhookPayload,
} from './openapi/webhook-events.js';

export type CouponRegisteredSource = (typeof COUPON_REGISTERED_SOURCES)[number];
export type CouponDeactivatedSource = (typeof COUPON_DEACTIVATED_SOURCES)[number];

type CouponFields = Pick<
  CouponRow,
  'id' | 'partnerId' | 'programId' | 'code' | 'stripePromotionCodeId' | 'brandChosen' | 'createdAt'
>;

function base(row: CouponFields) {
  return {
    couponId: row.id,
    partnerId: row.partnerId,
    programId: row.programId,
    code: row.code,
    customerDiscount: row.stripePromotionCodeId != null,
    brandChosen: row.brandChosen,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

type CouponTerms = Pick<WebhookPayload<'coupon.registered'>, 'commission' | 'customerReward'>;

/**
 * What the partner earns on the coupon's program, by the engine's own
 * precedence (attribution.ts rulesFor): their terms on that program, else
 * their partner-wide terms, else the program's rule. Runs after commit, on
 * the privileged handle like the dispatcher, so every query names the
 * tenant. Empty when the program can't be read; the event still goes.
 */
export async function couponTerms(tenantId: string, partnerId: string, programId: string): Promise<CouponTerms> {
  try {
    const program = (await privilegedDb<ProgramRow>(TABLES.Program)
      .where({ id: programId, tenantId })
      .first('commissionRule', 'customerReward')) as Pick<ProgramRow, 'commissionRule' | 'customerReward'> | undefined;
    if (!program) return {};
    const override = (await privilegedDb<PartnerCommissionRow>(TABLES.PartnerCommission)
      .where({ tenantId, partnerId })
      .andWhere((q) => q.where({ programId }).orWhereNull('programId'))
      .orderByRaw('"programId" is null') // program-scoped first
      .first('programId', 'commissionType', 'commissionValue', 'recurring', 'commissionRules')) as
      | Pick<PartnerCommissionRow, 'programId' | 'commissionType' | 'commissionValue' | 'recurring' | 'commissionRules'>
      | undefined;
    const rules = rulesFor(override, program.commissionRule);
    const currency = await tenantDefaultCurrency(privilegedDb, tenantId);
    return {
      commission: {
        source: !override ? 'program' : override.programId ? 'partner_program' : 'partner',
        summary: renderCommissionSummary(rules, null, currency),
        rules,
      },
      customerReward: (program.customerReward as CustomerReward | null) ?? null,
    };
  } catch (err) {
    console.error('[coupon-events] commission terms lookup failed', { tenantId, partnerId, programId, err });
    return {};
  }
}

export function couponRegisteredPayload(row: CouponFields, source: CouponRegisteredSource, terms: CouponTerms = {}) {
  return { ...base(row), ...terms, source } satisfies WebhookPayload<'coupon.registered'>;
}

export function couponDeactivatedPayload(
  row: CouponFields & { deactivatedAt: Date | null },
  source: CouponDeactivatedSource,
) {
  return {
    ...base(row),
    deactivatedAt: new Date(row.deactivatedAt ?? Date.now()).toISOString(),
    source,
  } satisfies WebhookPayload<'coupon.deactivated'>;
}

export function emitCouponRegistered(db: Knex, tenantId: string, row: CouponFields, source: CouponRegisteredSource): void {
  onCommit(db, 'coupon.registered webhook', async () => {
    const terms = await couponTerms(tenantId, row.partnerId, row.programId);
    dispatchEvent(tenantId, 'coupon.registered', couponRegisteredPayload(row, source, terms));
  });
}

export function emitCouponDeactivated(
  db: Knex,
  tenantId: string,
  row: CouponFields & { deactivatedAt: Date | null },
  source: CouponDeactivatedSource,
): void {
  const payload = couponDeactivatedPayload(row, source);
  onCommit(db, 'coupon.deactivated webhook', () => dispatchEvent(tenantId, 'coupon.deactivated', payload));
}

/** The caller of a coupon route, as a webhook source. The routes admit
 *  admins, the partner themselves, and scoped keys holding partners:write.
 *  A scoped key is `api_key` whoever holds it: the brand's own integration
 *  or the key it issued the OpenPartner Network. Key labels are free text,
 *  so they can't tell the two apart. */
export function couponActor(role: string | undefined): 'admin' | 'partner' | 'api_key' {
  if (role === 'admin') return 'admin';
  if (role === 'partner') return 'partner';
  return 'api_key';
}
