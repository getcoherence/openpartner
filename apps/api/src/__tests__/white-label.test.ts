/**
 * White-label entitlement gate. Pure logic — no DB — so it runs in the
 * unit tier (no DATABASE_URL needed).
 *
 * The load-bearing case is the LAST one: a tenant whose trial lapsed
 * without ever subscribing must NOT keep white-label, even though the
 * provisioned flag is still true. That's the "free white-label after a
 * lapsed trial" gap the spec review flagged.
 */

import { describe, expect, it } from 'vitest';
import { isWhiteLabelEntitled } from '../white-label.js';
import type { TenantBillingState } from '../billing-plan.js';

function billing(overrides: Partial<TenantBillingState> = {}): TenantBillingState {
  return {
    plan: 'flex',
    mode: 'flat',
    trialEndsAt: null,
    inTrial: false,
    hasUsedTrial: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    trialExpiredWithoutSubscription: false,
    ...overrides,
  };
}

describe('isWhiteLabelEntitled', () => {
  it('is false when the add-on is not provisioned', () => {
    expect(
      isWhiteLabelEntitled({ whiteLabel: false, status: 'active' }, billing({ stripeSubscriptionId: 'sub_1' })),
    ).toBe(false);
  });

  it('is false when the tenant is not active, even if provisioned + paying', () => {
    expect(
      isWhiteLabelEntitled({ whiteLabel: true, status: 'suspended' }, billing({ stripeSubscriptionId: 'sub_1' })),
    ).toBe(false);
  });

  it('is true for a self-host install (no billing relationship to gate on)', () => {
    expect(
      isWhiteLabelEntitled({ whiteLabel: true, status: 'active' }, billing({ mode: 'selfhost', plan: null })),
    ).toBe(true);
  });

  it('is true for an enterprise (sales-led) plan', () => {
    expect(
      isWhiteLabelEntitled({ whiteLabel: true, status: 'active' }, billing({ plan: 'enterprise' })),
    ).toBe(true);
  });

  it('is true with an active subscription', () => {
    expect(
      isWhiteLabelEntitled({ whiteLabel: true, status: 'active' }, billing({ stripeSubscriptionId: 'sub_1' })),
    ).toBe(true);
  });

  it('is true while in trial', () => {
    expect(
      isWhiteLabelEntitled({ whiteLabel: true, status: 'active' }, billing({ inTrial: true })),
    ).toBe(true);
  });

  it('is FALSE after a trial lapses without a subscription (the free-white-label gap)', () => {
    expect(
      isWhiteLabelEntitled(
        { whiteLabel: true, status: 'active' },
        billing({
          plan: 'flex',
          inTrial: false,
          hasUsedTrial: true,
          stripeSubscriptionId: null,
          trialExpiredWithoutSubscription: true,
        }),
      ),
    ).toBe(false);
  });
});
