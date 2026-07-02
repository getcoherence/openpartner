/**
 * Partner-onboarding plan gate (§13). Pure logic — no DB — so it runs in
 * the unit tier.
 *
 * The load-bearing case is the last two: a plan picked but never checked
 * out (no Stripe subscription), and a live free trial, both count as NO
 * active plan — so a brand can't onboard partners until it actually
 * activates a plan. That's the per-brand billing leak this closes.
 */

import { describe, expect, it } from 'vitest';
import { hasActivePlan } from '../billing-plan.js';
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

describe('hasActivePlan (partner-onboarding gate)', () => {
  it('is true for self-host (no billing relationship)', () => {
    expect(hasActivePlan(billing({ mode: 'selfhost', plan: null }))).toBe(true);
  });

  it('is true for enterprise (billed out of band)', () => {
    expect(hasActivePlan(billing({ plan: 'enterprise' }))).toBe(true);
  });

  it('is true for Flex with an active subscription', () => {
    expect(hasActivePlan(billing({ plan: 'flex', stripeSubscriptionId: 'sub_1' }))).toBe(true);
  });

  it('is true for RevShare once the metered subscription exists', () => {
    expect(hasActivePlan(billing({ plan: 'revshare', stripeSubscriptionId: 'sub_2' }))).toBe(true);
  });

  it('is FALSE when a plan is picked but never checked out (the loophole)', () => {
    expect(hasActivePlan(billing({ plan: 'revshare', stripeSubscriptionId: null }))).toBe(false);
    expect(hasActivePlan(billing({ plan: 'flex', stripeSubscriptionId: null }))).toBe(false);
  });

  it('is FALSE during a free trial with no subscription', () => {
    expect(hasActivePlan(billing({ plan: 'flex', inTrial: true, stripeSubscriptionId: null }))).toBe(false);
  });
});
