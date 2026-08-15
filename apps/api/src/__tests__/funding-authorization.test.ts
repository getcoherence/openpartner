/**
 * Funding authorization gate — spec §10/§12. The /complete endpoint is the
 * security-sensitive one: the session id arrives via redirect query param,
 * so it must be verified against the live Stripe session (tenant match,
 * completed, SetupIntent succeeded) before an authorization row is written.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';

const ADMIN_KEY = 'op_test_admin_key_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;

import { db } from '../db.js';
import { createApp } from '../app.js';
import { FUNDING_TERMS_VERSION } from '../funding/state.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;
const app = createApp();

// The routes call requireStripe() — mock the module-level client.
const sessionsRetrieve = vi.fn();
vi.mock('../stripe.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../stripe.js')>();
  return {
    ...original,
    requireStripe: () => ({
      checkout: {
        sessions: {
          create: vi.fn(async () => ({ url: 'https://checkout.stripe.test/s' })),
          retrieve: sessionsRetrieve,
        },
      },
    }),
  };
});

beforeEach(async () => {
  if (skipIntegration) return;
  sessionsRetrieve.mockReset();
  await db(TABLES.HostedFundingAuthorization).del();
  await db(TABLES.Tenant)
    .where({ id: TENANT })
    .update({ stripeCustomerId: 'cus_test', stripeSubscriptionId: 'sub_test', billingPlan: 'flex' });
});

afterAll(async () => {
  if (!skipIntegration) {
    await db(TABLES.HostedFundingAuthorization).del();
    await db(TABLES.Tenant)
      .where({ id: TENANT })
      .update({ stripeCustomerId: null, stripeSubscriptionId: null, billingPlan: null });
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('funding authorization gate', () => {
  it('GET /billing/funding reports no authorization + current terms version', async () => {
    const res = await request(app)
      .get('/billing/funding')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.authorization).toBeNull();
    expect(res.body.termsVersion).toBe(FUNDING_TERMS_VERSION);
  });

  it('setup requires an active subscription and the CURRENT terms version', async () => {
    const stale = await request(app)
      .post('/billing/funding/setup')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no', termsVersion: 'funding-terms-old' });
    expect(stale.status).toBe(400);

    await db(TABLES.Tenant).where({ id: TENANT }).update({ stripeSubscriptionId: null });
    const nosub = await request(app)
      .post('/billing/funding/setup')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no', termsVersion: FUNDING_TERMS_VERSION });
    expect(nosub.status).toBe(409);
    expect(nosub.body.error).toBe('subscription_required');

    await db(TABLES.Tenant).where({ id: TENANT }).update({ stripeSubscriptionId: 'sub_test' });
    const ok = await request(app)
      .post('/billing/funding/setup')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no', termsVersion: FUNDING_TERMS_VERSION });
    expect(ok.status).toBe(200);
    expect(ok.body.url).toContain('checkout.stripe.test');
  });

  it('complete verifies the live session: tenant match, completed, SetupIntent succeeded', async () => {
    // Wrong tenant on the session → 403, nothing written.
    sessionsRetrieve.mockResolvedValueOnce({
      status: 'complete',
      metadata: { openpartner_tenant_id: 'someone_else' },
      setup_intent: { status: 'succeeded', payment_method: 'pm_x' },
    });
    const wrongTenant = await request(app)
      .post('/billing/funding/complete')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ sessionId: 'cs_1' });
    expect(wrongTenant.status).toBe(403);

    // Incomplete SetupIntent → 409.
    sessionsRetrieve.mockResolvedValueOnce({
      status: 'complete',
      metadata: { openpartner_tenant_id: TENANT },
      setup_intent: { status: 'requires_action', payment_method: null },
    });
    const incomplete = await request(app)
      .post('/billing/funding/complete')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ sessionId: 'cs_2' });
    expect(incomplete.status).toBe(409);
    expect(await db(TABLES.HostedFundingAuthorization).first()).toBeUndefined();

    // Valid session → authorization row.
    sessionsRetrieve.mockResolvedValueOnce({
      status: 'complete',
      metadata: {
        openpartner_tenant_id: TENANT,
        openpartner_admin_id: 'adm_1',
        openpartner_funding_terms: FUNDING_TERMS_VERSION,
      },
      setup_intent: { status: 'succeeded', payment_method: 'pm_bank_123' },
    });
    const ok = await request(app)
      .post('/billing/funding/complete')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ sessionId: 'cs_3' });
    expect(ok.status).toBe(200);
    const auth = await db(TABLES.HostedFundingAuthorization).where({ tenantId: TENANT }).first();
    expect(auth.stripePaymentMethodId).toBe('pm_bank_123');
    expect(auth.termsVersion).toBe(FUNDING_TERMS_VERSION);
    // 'adm_1' has no Admin row — the route re-verifies rather than
    // trusting round-tripped metadata into the FK, and stores null.
    expect(auth.adminId).toBeNull();
    expect(auth.revokedAt).toBeNull();
  });

  it('revoke stamps revokedAt; second revoke 404s; GET reflects it', async () => {
    await db(TABLES.HostedFundingAuthorization).insert({
      id: ulid(),
      tenantId: TENANT,
      adminId: null,
      termsVersion: FUNDING_TERMS_VERSION,
      stripePaymentMethodId: 'pm_x',
      paymentMethodType: 'us_bank_account',
      acceptedAt: new Date(),
      revokedAt: null,
    });
    const first = await request(app)
      .post('/billing/funding/revoke')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({});
    expect(first.status).toBe(200);
    const second = await request(app)
      .post('/billing/funding/revoke')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({});
    expect(second.status).toBe(404);
    const status = await request(app)
      .get('/billing/funding')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(status.body.authorization).toBeNull();
  });
});
