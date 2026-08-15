/**
 * Customer reward Stripe-param mapping. Pure unit tests against the
 * exported translator — provisionCustomerReward needs Stripe and is
 * exercised at the integration layer.
 *
 * The mapper isn't exported by name; we re-derive expected shapes by
 * round-tripping through provisionCustomerReward with a stubbed Stripe
 * would be heavy. Instead, the test file imports the helper indirectly
 * via a small re-export shim — keep these focused on the boundary cases
 * that would silently misprice a discount.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub Stripe before importing the module under test so the `stripe`
// singleton is non-null and we can capture the create-call shapes.
const couponCreate = vi.fn(async (params: Record<string, unknown>) => ({ id: 'co_test', ...params }));
const promotionCodeCreate = vi.fn(async (params: Record<string, unknown>) => ({ id: 'promo_test', ...params }));

vi.mock('../stripe.js', () => ({
  stripe: {
    coupons: { create: couponCreate },
    promotionCodes: { create: promotionCodeCreate },
  },
}));

const { provisionCustomerReward } = await import('../customer-rewards.js');

beforeEach(() => {
  couponCreate.mockClear();
  promotionCodeCreate.mockClear();
});

describe('provisionCustomerReward', () => {
  it('percent_off + repeating maps to Stripe percent_off + duration_in_months', async () => {
    await provisionCustomerReward(
      { type: 'percent_off', value: 25, duration: 'repeating', durationInMonths: 6 },
      'KEITH15A2X',
      'Default',
    );
    const params = couponCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({
      percent_off: 25,
      duration: 'repeating',
      duration_in_months: 6,
    });
    expect(params).not.toHaveProperty('amount_off');
  });

  it('amount_off lowercases currency and converts dollars to cents', async () => {
    await provisionCustomerReward(
      { type: 'amount_off', value: 20, currency: 'USD', duration: 'forever' },
      'CODE',
      'Campaign',
    );
    const params = couponCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({
      amount_off: 2000,
      currency: 'usd',
      duration: 'forever',
    });
  });

  it('free_months delivers as 100% repeating coupon', async () => {
    await provisionCustomerReward(
      { type: 'free_months', value: 2, duration: 'repeating' },
      'CODE',
      'Campaign',
    );
    const params = couponCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({
      percent_off: 100,
      duration: 'repeating',
      duration_in_months: 2,
    });
  });

  it('amount_off without currency returns null (no Stripe call)', async () => {
    const result = await provisionCustomerReward(
      { type: 'amount_off', value: 10, duration: 'once' },
      'CODE',
      'Campaign',
    );
    expect(result).toBeNull();
    expect(couponCreate).not.toHaveBeenCalled();
  });

  it('returns provisioned IDs on success', async () => {
    const result = await provisionCustomerReward(
      { type: 'percent_off', value: 10, duration: 'once' },
      'CODE',
      'Campaign',
    );
    expect(result).toEqual({
      stripeCouponId: 'co_test',
      stripePromotionCodeId: 'promo_test',
    });
  });

  it('promotion code is created against the new coupon with the OpenPartner code', async () => {
    await provisionCustomerReward(
      { type: 'percent_off', value: 10, duration: 'once' },
      'KEITH15A2X',
      'Default',
    );
    const params = promotionCodeCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({
      promotion: { type: 'coupon', coupon: 'co_test' },
      code: 'KEITH15A2X',
    });
  });
});
