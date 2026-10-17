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
 *
 * Also covers which deployments may reach Stripe at all (rewardStripe)
 * and the brand-promo collision lookup (codeExistsInStripe).
 */

import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';

// Stub Stripe before importing the module under test so the `stripe`
// singleton is non-null and we can capture the create-call shapes.
const couponCreate = vi.fn(async (params: Record<string, unknown>) => ({ id: 'co_test', ...params }));
const couponRetrieve = vi.fn(async (id: string): Promise<{ id: string }> => {
  throw Object.assign(new Error(`No such coupon: '${id}'`), { code: 'resource_missing' });
});
const promotionCodeCreate = vi.fn(async (params: Record<string, unknown>) => ({ id: 'promo_test', ...params }));
const promotionCodeList = vi.fn(async (_params: Record<string, unknown>): Promise<{ data: unknown[] }> => ({ data: [] }));
const promotionCodeUpdate = vi.fn(async (id: string, params: Record<string, unknown>) => ({ id, ...params }));

vi.mock('../stripe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stripe.js')>()),
  stripe: {
    coupons: { create: couponCreate, retrieve: couponRetrieve },
    promotionCodes: { create: promotionCodeCreate, list: promotionCodeList, update: promotionCodeUpdate },
  },
}));

const { codeExistsInStripe, deactivateCustomerReward, provisionCustomerReward } = await import(
  '../customer-rewards.js'
);

const originalMode = process.env.OPENPARTNER_MODE;
const originalTenancy = process.env.OPENPARTNER_TENANCY;

beforeEach(() => {
  // The only deployment shape where STRIPE_SECRET_KEY is the brand's own.
  process.env.OPENPARTNER_MODE = 'selfhost';
  process.env.OPENPARTNER_TENANCY = 'single';
  for (const fn of [couponCreate, couponRetrieve, promotionCodeCreate, promotionCodeList, promotionCodeUpdate]) {
    fn.mockClear();
  }
});

afterAll(() => {
  process.env.OPENPARTNER_MODE = originalMode;
  if (originalTenancy === undefined) delete process.env.OPENPARTNER_TENANCY;
  else process.env.OPENPARTNER_TENANCY = originalTenancy;
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

  it("amount_off is in Stripe's integer form for the currency: ¥500 is 500, KWD 1.50 is 1500", async () => {
    await provisionCustomerReward(
      { type: 'amount_off', value: 500, currency: 'JPY', duration: 'once' },
      'CODE',
      'Campaign',
    );
    expect(couponCreate.mock.calls[0]![0]).toMatchObject({ amount_off: 500, currency: 'jpy' });

    await provisionCustomerReward(
      { type: 'amount_off', value: 1.5, currency: 'KWD', duration: 'once' },
      'CODE2',
      'Campaign',
    );
    expect(couponCreate.mock.calls[1]![0]).toMatchObject({ amount_off: 1500, currency: 'kwd' });
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

// On hosted deployments STRIPE_SECRET_KEY is OpenPartner's own billing
// account, whose plan Checkout accepts promotion codes. A reward minted
// there would be a working discount on OpenPartner's plans.
describe.each([
  { label: 'hosted flat', mode: 'flat', tenancy: 'multi' },
  { label: 'hosted revshare', mode: 'revshare', tenancy: 'multi' },
  { label: 'hosted flat, single tenancy', mode: 'flat', tenancy: 'single' },
  { label: 'multi-tenant self-host', mode: 'selfhost', tenancy: 'multi' },
])('$label: never touches the deployment Stripe account', ({ mode, tenancy }) => {
  beforeEach(() => {
    process.env.OPENPARTNER_MODE = mode;
    process.env.OPENPARTNER_TENANCY = tenancy;
  });

  it('provisionCustomerReward skips, even for a 100% free_months reward', async () => {
    const result = await provisionCustomerReward(
      { type: 'free_months', value: 12, duration: 'repeating' },
      'FREEYEAR',
      'Campaign',
    );
    expect(result).toBeNull();
    expect(couponCreate).not.toHaveBeenCalled();
    expect(promotionCodeCreate).not.toHaveBeenCalled();
  });

  it('deactivateCustomerReward is a no-op', async () => {
    await deactivateCustomerReward('promo_platform_legacy');
    expect(promotionCodeUpdate).not.toHaveBeenCalled();
  });

  it('codeExistsInStripe has nothing to look in', async () => {
    await expect(codeExistsInStripe('WELCOME10')).resolves.toBe(false);
    expect(promotionCodeList).not.toHaveBeenCalled();
    expect(couponRetrieve).not.toHaveBeenCalled();
  });
});

describe('codeExistsInStripe (single-tenant self-host)', () => {
  it('true when a promotion code with that string exists, active or not', async () => {
    promotionCodeList.mockResolvedValueOnce({ data: [{ id: 'promo_brand', code: 'WELCOME10', active: false }] });
    await expect(codeExistsInStripe('WELCOME10')).resolves.toBe(true);
    // No `active` filter: an inactive promo still rides on live
    // subscriptions' invoices, which the webhook auto-redeems by code.
    expect(promotionCodeList).toHaveBeenCalledWith({ code: 'WELCOME10', limit: 1 });
  });

  it('true when a coupon id matches the code as given or lowercased', async () => {
    couponRetrieve.mockImplementation(async (id: string) => {
      if (id === 'spring25') return { id };
      throw Object.assign(new Error('missing'), { code: 'resource_missing' });
    });
    try {
      await expect(codeExistsInStripe('SPRING25')).resolves.toBe(true);
      expect(couponRetrieve.mock.calls.map((c) => c[0])).toEqual(['SPRING25', 'spring25']);
    } finally {
      couponRetrieve.mockReset();
      couponRetrieve.mockImplementation(async (id: string) => {
        throw Object.assign(new Error(`No such coupon: '${id}'`), { code: 'resource_missing' });
      });
    }
  });

  it('false when neither a promotion code nor a coupon id matches', async () => {
    await expect(codeExistsInStripe('KEITH15A2X')).resolves.toBe(false);
  });

  it('propagates Stripe errors other than resource_missing', async () => {
    couponRetrieve.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { code: 'rate_limit' }));
    await expect(codeExistsInStripe('KEITH15A2X')).rejects.toThrow('rate limited');
  });
});
