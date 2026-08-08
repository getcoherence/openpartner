/**
 * Webhook secret-family enforcement (spec review #11): a signing secret bound
 * to one Stripe "Event destination" must not authorize an event type from the
 * other. Platform secret → platform events; Connect secret → connected-account
 * events. Cross-family events are rejected (secret_family_mismatch) before any
 * tenant/funding processing, closing the confused-deputy.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import Stripe from 'stripe';

const STRIPE_SECRET = 'sk_test_dummy_for_family_tests';
const PLATFORM_SECRET = 'whsec_platform_family_test';
const CONNECT_SECRET = 'whsec_connect_family_test';

process.env.STRIPE_SECRET_KEY = STRIPE_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_PLATFORM = PLATFORM_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_CONNECT = CONNECT_SECRET;
delete process.env.STRIPE_WEBHOOK_SECRET; // ensure the legacy permissive path is off
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

vi.mock('stripe', async () => {
  const actual = await vi.importActual<typeof import('stripe')>('stripe');
  const Real = actual.default;
  function MockedStripe(this: unknown, key: string, opts?: Stripe.StripeConfig) {
    const instance = new Real(key, opts) as Stripe;
    (instance as unknown as { customers: unknown }).customers = {
      update: vi.fn().mockResolvedValue({ id: 'cus_mock' }),
      retrieve: vi.fn().mockResolvedValue({ id: 'cus_mock', metadata: {}, deleted: false }),
    };
    return instance;
  }
  (MockedStripe as unknown as { webhooks: unknown }).webhooks = (Real as unknown as { webhooks: unknown }).webhooks;
  return { default: MockedStripe };
});

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { TABLES, DEFAULT_TENANT_ID } = await import('@openpartner/db');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const signer = new Stripe(STRIPE_SECRET);

function post(eventPayload: object, secret: string) {
  const body = JSON.stringify(eventPayload);
  const sig = signer.webhooks.generateTestHeaderString({ payload: body, secret });
  return request(app)
    .post('/webhooks/stripe')
    .set('content-type', 'application/json')
    .set('stripe-signature', sig)
    .send(body);
}

function evt(type: string, object: Record<string, unknown>) {
  return { id: `evt_${ulid()}`, type, created: Math.floor(Date.now() / 1000), data: { object } };
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});
afterAll(async () => {
  await db.destroy();
});

describe.skipIf(skipIntegration)('stripe webhook — secret-family enforcement', () => {
  it('rejects a platform event type signed with the CONNECT secret', async () => {
    const res = await post(
      evt('checkout.session.completed', { id: `cs_${ulid()}`, mode: 'subscription', customer: `cus_${ulid()}`, subscription: `sub_${ulid()}` }),
      CONNECT_SECRET,
    );
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('secret_family_mismatch');
  });

  it('rejects a connect event type signed with the PLATFORM secret', async () => {
    const res = await post(evt('account.updated', { id: `acct_${ulid()}`, object: 'account', metadata: {} }), PLATFORM_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('secret_family_mismatch');
  });

  it('accepts a platform event on the platform secret (passes the family gate)', async () => {
    const res = await post(
      evt('invoice.payment_failed', { id: `in_${ulid()}`, object: 'invoice', customer: `cus_${ulid()}`, amount_due: 100, currency: 'usd', attempt_count: 1 }),
      PLATFORM_SECRET,
    );
    expect(res.status).toBe(200);
    // Not a family rejection — unresolved tenant (no matching customer) is fine.
    expect(res.body.reason).not.toBe('secret_family_mismatch');
  });

  it('accepts a connect event on the connect secret (passes the family gate)', async () => {
    const res = await post(evt('account.updated', { id: `acct_${ulid()}`, object: 'account', metadata: {} }), CONNECT_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.reason).not.toBe('secret_family_mismatch');
  });

  it('treats transfer.* as PLATFORM family (platform secret passes, connect secret rejects)', async () => {
    // We create Connect transfers with the platform key, so transfer.* fire
    // on the platform account and arrive on Destination A.
    const onPlatform = await post(evt('transfer.reversed', { id: `tr_${ulid()}`, object: 'transfer', metadata: {} }), PLATFORM_SECRET);
    expect(onPlatform.status).toBe(200);
    expect(onPlatform.body.reason).not.toBe('secret_family_mismatch');

    const onConnect = await post(evt('transfer.reversed', { id: `tr_${ulid()}`, object: 'transfer', metadata: {} }), CONNECT_SECRET);
    expect(onConnect.status).toBe(200);
    expect(onConnect.body.reason).toBe('secret_family_mismatch');
  });

  it('rejects a signature made with an unknown secret', async () => {
    const res = await post(evt('invoice.paid', { id: `in_${ulid()}`, customer: `cus_${ulid()}` }), 'whsec_not_configured');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_signature');
  });

  it('account.updated does NOT let forged metadata re-point another partner (payout hijack)', async () => {
    const acctA = `acct_${ulid()}`;
    const acctB = `acct_${ulid()}`;
    const partnerA = ulid();
    const partnerB = ulid();
    await db(TABLES.Partner).insert([
      { id: partnerA, tenantId: DEFAULT_TENANT_ID, name: 'A', email: `a-${partnerA}@x.com`, stripeConnectAccountId: acctA },
      { id: partnerB, tenantId: DEFAULT_TENANT_ID, name: 'B', email: `b-${partnerB}@x.com`, stripeConnectAccountId: acctB },
    ]);
    try {
      // account.updated for A's account, but metadata forged to claim B.
      const res = await post(
        evt('account.updated', { id: acctA, object: 'account', metadata: { openpartner_partner_id: partnerB }, charges_enabled: true, payouts_enabled: true, details_submitted: true }),
        CONNECT_SECRET,
      );
      expect(res.status).toBe(200);
      // Resolved by account id → updated A (not B).
      expect(res.body.connect).toBe('account_updated');
      const b = await db(TABLES.Partner).where({ id: partnerB }).first();
      expect(b.stripeConnectAccountId).toBe(acctB); // untouched — not hijacked
      const a = await db(TABLES.Partner).where({ id: partnerA }).first();
      expect(a.stripeConnectAccountId).toBe(acctA);
    } finally {
      await db(TABLES.Partner).whereIn('id', [partnerA, partnerB]).del();
    }
  });
});
