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
import { hasActivePlan, invoiceOverdue } from '../billing-plan.js';
import type { TenantBillingState } from '../billing-plan.js';
import { isPlanRequiredRoute, isTrialGatedRoute } from '../middleware/trial-gate.js';

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
    subscriptionStatus: null,
    collectionMethod: null,
    invoiceOverdue: null,
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

  // HostedBillingState mirror upgrade (payout-funding spec §4 finding 13):
  // a subscription id alone no longer proves service eligibility.
  it('mirror: past_due keeps service (Stripe still dunning); unpaid/paused/canceled lose it', () => {
    const base = { plan: 'flex' as const, stripeSubscriptionId: 'sub_1' };
    expect(hasActivePlan(billing({ ...base, subscriptionStatus: 'active' }))).toBe(true);
    expect(hasActivePlan(billing({ ...base, subscriptionStatus: 'trialing' }))).toBe(true);
    expect(hasActivePlan(billing({ ...base, subscriptionStatus: 'past_due' }))).toBe(true);
    expect(hasActivePlan(billing({ ...base, subscriptionStatus: 'unpaid' }))).toBe(false);
    expect(hasActivePlan(billing({ ...base, subscriptionStatus: 'paused' }))).toBe(false);
    expect(hasActivePlan(billing({ ...base, subscriptionStatus: 'canceled' }))).toBe(false);
  });

  it('mirror: no mirror row grandfathers legacy tenants on the id check', () => {
    expect(hasActivePlan(billing({ plan: 'flex', stripeSubscriptionId: 'sub_1', subscriptionStatus: null }))).toBe(true);
  });
});

// Pay-by-invoice (docs/invoice-billing.md): the subscription is past_due
// from the day an invoice passes its due date, and Stripe may leave it
// there. Service continues through the grace, then onboarding pauses.
describe('hasActivePlan with a pay-by-invoice subscription', () => {
  const DAY = 86_400_000;
  const now = new Date('2026-11-20T00:00:00Z');
  const mirror = (overrides: Partial<Parameters<typeof invoiceOverdue>[0] & object> = {}) => ({
    subscriptionStatus: 'past_due' as const,
    collectionMethod: 'send_invoice' as const,
    pastDueSince: new Date(now.getTime() - 5 * DAY),
    graceDays: null,
    ...overrides,
  });
  const invoiced = (m: ReturnType<typeof mirror>) =>
    billing({
      plan: 'flex',
      stripeSubscriptionId: 'sub_inv',
      subscriptionStatus: m.subscriptionStatus,
      collectionMethod: m.collectionMethod,
      invoiceOverdue: invoiceOverdue(m, now),
    });

  it('an open invoice not yet due is plain active', () => {
    const m = mirror({ subscriptionStatus: 'active' as never, pastDueSince: null });
    expect(invoiceOverdue(m, now)).toBeNull();
    expect(hasActivePlan(invoiced(m))).toBe(true);
  });

  it('keeps service on day 1 of overdue and through the default 30-day grace', () => {
    const day1 = mirror({ pastDueSince: new Date(now.getTime() - DAY) });
    expect(invoiceOverdue(day1, now)).toMatchObject({ graceExpired: false });
    expect(hasActivePlan(invoiced(day1))).toBe(true);
    const day29 = mirror({ pastDueSince: new Date(now.getTime() - 29 * DAY) });
    expect(hasActivePlan(invoiced(day29))).toBe(true);
    expect(invoiceOverdue(day29, now)!.graceEndsAt).toEqual(new Date(now.getTime() + DAY));
  });

  it('pauses onboarding once the grace runs out', () => {
    const day30 = mirror({ pastDueSince: new Date(now.getTime() - 30 * DAY) });
    expect(invoiceOverdue(day30, now)).toMatchObject({ graceExpired: true });
    expect(hasActivePlan(invoiced(day30))).toBe(false);
  });

  it('honours a per-tenant grace from ops', () => {
    const m = mirror({ pastDueSince: new Date(now.getTime() - 40 * DAY), graceDays: 60 });
    expect(hasActivePlan(invoiced(m))).toBe(true);
    const none = mirror({ pastDueSince: new Date(now.getTime() - 1), graceDays: 0 });
    expect(hasActivePlan(invoiced(none))).toBe(false);
  });

  it('an untimed stretch (mirrored before pastDueSince existed) starts now, not expired', () => {
    const m = mirror({ pastDueSince: null });
    expect(invoiceOverdue(m, now)).toMatchObject({ since: now, graceExpired: false });
  });

  it('card subscriptions keep the old rule: past_due is left to Stripe dunning', () => {
    const m = mirror({ collectionMethod: 'charge_automatically' as never, pastDueSince: new Date(now.getTime() - 90 * DAY) });
    expect(invoiceOverdue(m, now)).toBeNull();
    expect(hasActivePlan(invoiced(m))).toBe(true);
  });
});

describe('plan-required route matching', () => {
  it('gates every partner-onboarding entry point — including public self-signup', () => {
    expect(isPlanRequiredRoute('POST', '/partners')).toBe(true);
    // Without this, a brand with auto_approve on could grow its roster via
    // creator self-signup without ever activating a plan.
    expect(isPlanRequiredRoute('POST', '/partner-signup')).toBe(true);
    expect(isPlanRequiredRoute('POST', '/admin/network/requests/abc123/approve')).toBe(true);
  });

  it('leaves attribution ingest and reads open (never lose data)', () => {
    expect(isPlanRequiredRoute('POST', '/attribution/events')).toBe(false);
    expect(isPlanRequiredRoute('POST', '/coupons/redeem')).toBe(false);
    expect(isPlanRequiredRoute('GET', '/partners')).toBe(false);
    expect(isPlanRequiredRoute('POST', '/auth/signin')).toBe(false);
  });

  it('cannot be bypassed with case or a trailing slash (Express routes both)', () => {
    expect(isPlanRequiredRoute('POST', '/Partners/')).toBe(true);
    expect(isPlanRequiredRoute('POST', '/PARTNER-SIGNUP')).toBe(true);
    expect(isPlanRequiredRoute('POST', '/admin/network/requests/REQ_1/Approve/')).toBe(true);
  });
});

describe('trial-gated route matching', () => {
  it('gates every program-expansion action', () => {
    expect(isTrialGatedRoute('POST', '/programs')).toBe(true);
    expect(isTrialGatedRoute('POST', '/partners/p_1/coupons')).toBe(true);
    // Granting programs to a partner. This was `/partners/:id/campaigns`
    // until the Campaign → Program rename moved the route, which left
    // grants open after the trial lapsed.
    expect(isTrialGatedRoute('POST', '/partners/p_1/programs')).toBe(true);
    expect(isTrialGatedRoute('POST', '/import/partners-csv')).toBe(true);
    expect(isTrialGatedRoute('POST', '/admin/network/offerings')).toBe(true);
  });

  it('cannot be bypassed with case or a trailing slash (Express routes both)', () => {
    expect(isTrialGatedRoute('POST', '/Partners/p_1/Programs/')).toBe(true);
    expect(isTrialGatedRoute('POST', '/PROGRAMS')).toBe(true);
    expect(isTrialGatedRoute('POST', '/partners/p_1/coupons//')).toBe(true);
  });

  it('leaves reads and revocations open', () => {
    expect(isTrialGatedRoute('GET', '/partners/p_1/programs')).toBe(false);
    expect(isTrialGatedRoute('DELETE', '/partners/p_1/programs/prog_1')).toBe(false);
    expect(isTrialGatedRoute('POST', '/attribution/events')).toBe(false);
  });
});
