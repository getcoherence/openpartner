/**
 * Funding authorization gate — spec §10/§12. The /complete endpoint is the
 * security-sensitive one: the session id arrives via redirect query param,
 * so it must be verified against the live Stripe session (tenant match,
 * completed, SetupIntent succeeded) before an authorization row is written.
 *
 * And none of it is offered while HOSTED_FUNDING_ENABLED is off: no card,
 * no setup, no completion, unless the tenant already has an authorization
 * or batches, which stay visible and revocable.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const fundingFlagBefore = process.env.HOSTED_FUNDING_ENABLED;

beforeEach(async () => {
  process.env.HOSTED_FUNDING_ENABLED = '1';
  if (skipIntegration) return;
  sessionsRetrieve.mockReset();
  await db(TABLES.HostedFundingAuthorization).del();
  await db(TABLES.Tenant)
    .where({ id: TENANT })
    .update({ stripeCustomerId: 'cus_test', stripeSubscriptionId: 'sub_test', billingPlan: 'flex' });
});

afterEach(() => {
  if (fundingFlagBefore === undefined) delete process.env.HOSTED_FUNDING_ENABLED;
  else process.env.HOSTED_FUNDING_ENABLED = fundingFlagBefore;
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

describe.skipIf(skipIntegration)('funding authorization while HOSTED_FUNDING_ENABLED is off', () => {
  beforeEach(async () => {
    delete process.env.HOSTED_FUNDING_ENABLED;
    // Other funding suites leave batches behind, and any history keeps the
    // card visible. Same FK-safe order they clean in.
    for (const t of [
      TABLES.PayoutReversal,
      TABLES.CommissionAdjustment,
      TABLES.HostedFundingTransfer,
      TABLES.HostedFundingAllocation,
      TABLES.HostedFundingBatch,
    ]) {
      await db(t).del();
    }
  });

  const admin = () => ({ Authorization: `Bearer ${ADMIN_KEY}` });

  it('GET /billing/funding hides the card for a tenant with no funding history', async () => {
    const res = await request(app).get('/billing/funding').set(admin());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, reason: 'not_enabled' });
  });

  it('setup and completion refuse, and nothing reaches Stripe or the database', async () => {
    const setup = await request(app)
      .post('/billing/funding/setup')
      .set(admin())
      .send({ successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no', termsVersion: FUNDING_TERMS_VERSION });
    expect(setup.status).toBe(409);
    expect(setup.body.error).toBe('funding_not_enabled');

    // A setup started before the flag was pulled.
    sessionsRetrieve.mockResolvedValueOnce({
      status: 'complete',
      metadata: { openpartner_tenant_id: TENANT, openpartner_funding_terms: FUNDING_TERMS_VERSION },
      setup_intent: { status: 'succeeded', payment_method: 'pm_bank_123' },
    });
    const complete = await request(app).post('/billing/funding/complete').set(admin()).send({ sessionId: 'cs_late' });
    expect(complete.status).toBe(409);
    expect(complete.body.error).toBe('funding_not_enabled');
    expect(sessionsRetrieve).not.toHaveBeenCalled();
    expect(await db(TABLES.HostedFundingAuthorization).first()).toBeUndefined();
  });

  it('an existing authorization stays visible, flagged as not switched on, and can be revoked', async () => {
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
    const status = await request(app).get('/billing/funding').set(admin());
    expect(status.body).toMatchObject({ available: true, enabled: false });
    expect(status.body.authorization).not.toBeNull();

    const revoke = await request(app).post('/billing/funding/revoke').set(admin()).send({});
    expect(revoke.status).toBe(200);
    const after = await request(app).get('/billing/funding').set(admin());
    expect(after.body).toEqual({ available: false, reason: 'not_enabled' });
  });
});
