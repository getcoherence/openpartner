/**
 * White-label add-on billing plumbing (spec §8.2) — DB-free tier.
 *
 * Pins: add-on detection is exact-price-ID match; checkout line items only
 * include the add-on when explicitly requested AND configured (a missing
 * price env must throw loudly, not silently drop the paid add-on).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { subscriptionHasWhiteLabel, whiteLabelPriceId } from '../white-label-billing.js';
import { priceIdsForPlan } from '../billing-plan.js';

const ENV_KEYS = [
  'STRIPE_WHITELABEL_ADD_ON_PRICE_ID',
  'STRIPE_FLAT_PRICE_ID',
  'STRIPE_FLAT_USAGE_PRICE_ID',
  'STRIPE_REVSHARE_USAGE_PRICE_ID',
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.STRIPE_FLAT_PRICE_ID = 'price_flat';
  process.env.STRIPE_FLAT_USAGE_PRICE_ID = 'price_flat_usage';
  process.env.STRIPE_REVSHARE_USAGE_PRICE_ID = 'price_rev';
  process.env.STRIPE_WHITELABEL_ADD_ON_PRICE_ID = 'price_wl';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('subscriptionHasWhiteLabel', () => {
  it('detects the add-on price among subscription items', () => {
    expect(subscriptionHasWhiteLabel(['price_flat', 'price_wl'])).toBe(true);
    expect(subscriptionHasWhiteLabel(['price_flat', 'price_flat_usage'])).toBe(false);
  });

  it('never matches when the price env is unset (manual/enterprise deployments)', () => {
    delete process.env.STRIPE_WHITELABEL_ADD_ON_PRICE_ID;
    expect(whiteLabelPriceId()).toBeNull();
    expect(subscriptionHasWhiteLabel(['price_wl'])).toBe(false);
  });
});

describe('priceIdsForPlan with the white-label add-on', () => {
  it('appends the add-on to flex and revshare line items when requested', () => {
    expect(priceIdsForPlan('flex', { whiteLabel: true })).toEqual([
      { price: 'price_flat', quantity: 1 },
      { price: 'price_flat_usage' },
      { price: 'price_wl', quantity: 1 },
    ]);
    expect(priceIdsForPlan('revshare', { whiteLabel: true })).toEqual([
      { price: 'price_rev' },
      { price: 'price_wl', quantity: 1 },
    ]);
  });

  it('omits the add-on by default (existing checkouts unchanged)', () => {
    expect(priceIdsForPlan('flex')).toEqual([
      { price: 'price_flat', quantity: 1 },
      { price: 'price_flat_usage' },
    ]);
  });

  it('throws loudly when the add-on is requested but not configured', () => {
    delete process.env.STRIPE_WHITELABEL_ADD_ON_PRICE_ID;
    expect(() => priceIdsForPlan('flex', { whiteLabel: true })).toThrow(
      /STRIPE_WHITELABEL_ADD_ON_PRICE_ID/,
    );
  });

  it('enterprise stays sales-led — null even with the add-on requested', () => {
    expect(priceIdsForPlan('enterprise', { whiteLabel: true })).toBeNull();
  });
});
