/**
 * Nightly billing reconciliation: for tenants that locally claim an active
 * plan subscription, poll Stripe and heal the drift a missed webhook left
 * behind (the Jul 2026 incident: cancellation events never subscribed on
 * the prod endpoint → white-label + custom domain stayed live after the
 * customer cancelled).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.PLATFORM_OPS_EMAIL = 'ops@openpartner.test';

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { __setMailerForTests } = await import('../mailer.js');
const { reconcileTenantSubscriptions } = await import('../billing-lifecycle.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const TENANT_SUB = 'sub_reconcile_test';

interface SentMail {
  to: string;
  subject: string;
  tag?: string;
}

function fakeStripe(retrieveImpl: (id: string) => Promise<unknown>) {
  return {
    subscriptions: { retrieve: vi.fn(retrieveImpl) },
  } as unknown as Parameters<typeof reconcileTenantSubscriptions>[1];
}

function liveSub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TENANT_SUB,
    object: 'subscription',
    status: 'active',
    cancel_at_period_end: false,
    items: { data: [] },
    ...overrides,
  };
}

describe.skipIf(skipIntegration)('billing-subscription-reconcile', () => {
  const sentMail: SentMail[] = [];

  beforeAll(async () => {
    await db.raw('select 1');
  });

  afterAll(async () => {
    __setMailerForTests(null);
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      whiteLabel: false,
    });
    await db.destroy();
  });

  beforeEach(async () => {
    sentMail.length = 0;
    __setMailerForTests({
      send: async (_ctx, msg) => {
        sentMail.push({ to: msg.to, subject: msg.subject, tag: msg.tag });
      },
    });
    await db(TABLES.Config).del();
    await db(TABLES.HostedBillingState).del();
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({
      stripeCustomerId: 'cus_reconcile_test',
      stripeSubscriptionId: TENANT_SUB,
      whiteLabel: true,
    });
  });

  it('a subscription Stripe says is canceled heals exactly like the deleted webhook', async () => {
    const stripe = fakeStripe(async () => liveSub({ status: 'canceled' }));
    const result = await reconcileTenantSubscriptions(db, stripe);

    expect(result).toMatchObject({ checked: 1 });
    expect((result as { ended: string[] }).ended).toHaveLength(1);
    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    expect(tenant!.stripeSubscriptionId).toBeNull();
    expect(tenant!.whiteLabel).toBe(false);
    const mirror = await db(TABLES.HostedBillingState).where({ tenantId: DEFAULT_TENANT_ID }).first();
    expect(mirror!.subscriptionStatus).toBe('canceled');
    const endedMail = sentMail.find((m) => m.tag === 'ops_tenant_subscription_ended');
    expect(endedMail).toBeTruthy();

    // Second run: the pointer is gone, nothing left to check.
    const again = await reconcileTenantSubscriptions(db, stripe);
    expect(again).toMatchObject({ checked: 0 });
  });

  it('resource_missing (pruned/bad id) heals the same way', async () => {
    const stripe = fakeStripe(async () => {
      throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
    });
    const result = await reconcileTenantSubscriptions(db, stripe);

    expect((result as { ended: string[] }).ended).toHaveLength(1);
    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    expect(tenant!.stripeSubscriptionId).toBeNull();
  });

  it('a newly discovered cancel_at_period_end notifies ops once, not nightly', async () => {
    const stripe = fakeStripe(async () =>
      liveSub({ cancel_at_period_end: true, cancel_at: Math.floor(Date.now() / 1000) + 7 * 86400 }),
    );

    const first = await reconcileTenantSubscriptions(db, stripe);
    expect((first as { cancelScheduled: string[] }).cancelScheduled).toHaveLength(1);
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_cancellation_scheduled')).toHaveLength(1);

    const second = await reconcileTenantSubscriptions(db, stripe);
    expect((second as { cancelScheduled: string[] }).cancelScheduled).toHaveLength(0);
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_cancellation_scheduled')).toHaveLength(1);
  });

  it('an un-scheduled cancellation clears the marker so a future cancellation re-notifies', async () => {
    const cancelling = fakeStripe(async () =>
      liveSub({ cancel_at_period_end: true, cancel_at: Math.floor(Date.now() / 1000) + 7 * 86400 }),
    );
    await reconcileTenantSubscriptions(db, cancelling);
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_cancellation_scheduled')).toHaveLength(1);

    const resumed = fakeStripe(async () => liveSub());
    await reconcileTenantSubscriptions(db, resumed);

    await reconcileTenantSubscriptions(db, cancelling);
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_cancellation_scheduled')).toHaveLength(2);
  });

  it('a live subscription refreshes the status mirror without mailing anyone', async () => {
    const stripe = fakeStripe(async () => liveSub({ status: 'past_due' }));
    const result = await reconcileTenantSubscriptions(db, stripe);

    expect(result).toMatchObject({ checked: 1, ended: [], cancelScheduled: [] });
    const mirror = await db(TABLES.HostedBillingState).where({ tenantId: DEFAULT_TENANT_ID }).first();
    expect(mirror!.subscriptionStatus).toBe('past_due');
    expect(sentMail).toHaveLength(0);
  });

  it('a Stripe error on one tenant is reported, not thrown', async () => {
    const stripe = fakeStripe(async () => {
      throw new Error('rate limited');
    });
    const result = await reconcileTenantSubscriptions(db, stripe);
    expect((result as { errors: string[] }).errors).toHaveLength(1);
    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    expect(tenant!.stripeSubscriptionId).toBe(TENANT_SUB);
  });
});
