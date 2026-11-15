/**
 * coupon.registered / coupon.deactivated webhooks.
 *
 * A coupon is never hard-deleted (a used code keeps its attributions), so
 * "delete" anywhere in the product is a deactivation: Coupon.deactivatedAt
 * is set and the Stripe PromotionCode disabled. One event covers both.
 *
 * Every place a Coupon row is written or retired calls these:
 *   - POST   /partners/:id/coupons             registered (admin / partner / network)
 *   - autoMintCouponsForGrants                  registered (program_grant): the
 *     default code minted when a partner is created with programs, approved
 *     from the Network, or granted a program later
 *   - DELETE /partners/:id/coupons/:couponId   deactivated (admin / partner / network)
 *   - DELETE /partners/:id/programs/:programId deactivated (grant_revoked)
 *
 * Queued with onCommit, so a receiver that fetches the coupon finds it, and
 * a write that rolls back sends nothing.
 */

import type { Knex } from 'knex';
import type { CouponRow } from '@openpartner/db';
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

export function couponRegisteredPayload(row: CouponFields, source: CouponRegisteredSource) {
  return { ...base(row), source } satisfies WebhookPayload<'coupon.registered'>;
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
  const payload = couponRegisteredPayload(row, source);
  onCommit(db, 'coupon.registered webhook', () => dispatchEvent(tenantId, 'coupon.registered', payload));
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

/** The caller of a coupon route, as a webhook source. */
export function couponActor(role: string | undefined): 'admin' | 'partner' | 'network' {
  if (role === 'admin') return 'admin';
  if (role === 'partner') return 'partner';
  return 'network';
}
