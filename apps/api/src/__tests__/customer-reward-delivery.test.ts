/**
 * customerRewardDelivery() decides what the admin reward editor promises.
 * Only a single-tenant self-host with a Stripe key may claim the discount
 * "applies automatically" — on hosted / multi-tenant deployments the key
 * is OpenPartner's own, never the brand's.
 *
 * stripe.ts reads STRIPE_SECRET_KEY at import, so each case re-imports the
 * module graph after setting env. db.js is stubbed (tenancy.ts imports it)
 * so the matrix runs without Postgres.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ db: {}, appDb: {} }));

const ENV_KEYS = ['OPENPARTNER_MODE', 'OPENPARTNER_TENANCY', 'STRIPE_SECRET_KEY'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function deliveryFor(mode: string, tenancy: string, stripeKey: string) {
  setEnv('OPENPARTNER_MODE', mode);
  setEnv('OPENPARTNER_TENANCY', tenancy);
  // '' rather than unset: a developer's .env can't backfill an empty var.
  setEnv('STRIPE_SECRET_KEY', stripeKey);
  vi.resetModules();
  const { customerRewardDelivery } = await import('../customer-rewards.js');
  return customerRewardDelivery();
}

afterAll(() => {
  for (const k of ENV_KEYS) setEnv(k, saved[k]);
  vi.resetModules();
});

describe('customerRewardDelivery', () => {
  it.each([
    ['selfhost', 'single', 'sk_test_brand', 'stripe'],
    ['selfhost', 'single', '', 'unconfigured'],
    ['flat', 'single', 'sk_test_platform', 'brand'],
    ['flat', 'multi', 'sk_test_platform', 'brand'],
    ['revshare', 'multi', 'sk_test_platform', 'brand'],
    ['selfhost', 'multi', 'sk_test_shared', 'brand'],
    // Hosted without a key is still the brand's job, not "configure Stripe".
    ['flat', 'multi', '', 'brand'],
  ])('%s + %s tenancy, key "%s" → %s', async (mode, tenancy, key, expected) => {
    expect(await deliveryFor(mode, tenancy, key)).toBe(expected);
  });
});
