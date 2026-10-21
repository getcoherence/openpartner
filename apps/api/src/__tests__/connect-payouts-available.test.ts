/**
 * GET /config/program `connectPayoutsAvailable`: whether the brand can pay
 * partners through Stripe Connect, which the partner portal keys its
 * Stripe Connect page and prompts on. It has to agree with runPayouts:
 * a hosted tenant's Connect transfer goes through payout funding or not
 * at all, and the manual rail never uses Connect. Offering Connect where
 * neither holds leaves a partner's commissions approved and unpaid.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type TenantRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_connect_available_0123456789abcd';
process.env.ADMIN_API_KEY = ADMIN_KEY;

// Stripe configured or not, per test: `stripe` is a module-level client.
const stripeState = vi.hoisted(() => ({ configured: true }));
vi.mock('../stripe.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../stripe.js')>();
  return {
    ...original,
    get stripe() {
      return stripeState.configured ? ({} as never) : null;
    },
  };
});

import { db } from '../db.js';
import { createApp } from '../app.js';
import { createSession } from '../auth-sessions.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;
const app = createApp();
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };

const ENV_KEYS = ['OPENPARTNER_MODE', 'HOSTED_FUNDING_ENABLED', 'OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS'] as const;
const envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let tenantBefore: Pick<TenantRow, 'billingPlan' | 'payoutRailPreference'> | undefined;
let partnerId = '';
let partnerCookie = '';

async function available(headers: Record<string, string> = admin): Promise<boolean> {
  const res = await request(app).get('/config/program').set(headers);
  expect(res.status).toBe(200);
  return res.body.connectPayoutsAvailable;
}

/** A hosted tenant: a paid plan makes its billing mode 'flat'. */
async function hosted(): Promise<void> {
  await db(TABLES.Tenant).where({ id: TENANT }).update({ billingPlan: 'flex' });
}

async function authorizeFunding(): Promise<void> {
  await db(TABLES.HostedFundingAuthorization).insert({
    id: ulid(),
    tenantId: TENANT,
    adminId: null,
    termsVersion: 'test',
    stripePaymentMethodId: 'pm_x',
    paymentMethodType: 'us_bank_account',
    acceptedAt: new Date(),
    revokedAt: null,
  });
}

beforeAll(async () => {
  if (skipIntegration) return;
  tenantBefore = await db<TenantRow>(TABLES.Tenant).where({ id: TENANT }).first(['billingPlan', 'payoutRailPreference']);
  partnerId = ulid();
  await db(TABLES.Partner).insert({
    id: partnerId,
    tenantId: TENANT,
    email: 'connect-available@example.test',
    name: 'Pat Partner',
    activatedAt: new Date(),
  });
  const session = await createSession(db, { tenantId: TENANT, principalKind: 'partner', principalId: partnerId });
  partnerCookie = `op_session=${session.plaintext}`;
});

beforeEach(async () => {
  stripeState.configured = true;
  process.env.OPENPARTNER_MODE = 'selfhost';
  delete process.env.HOSTED_FUNDING_ENABLED;
  delete process.env.OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS;
  if (skipIntegration) return;
  await db(TABLES.HostedFundingAuthorization).where({ tenantId: TENANT }).del();
  await db(TABLES.Tenant).where({ id: TENANT }).update({ billingPlan: null, payoutRailPreference: null });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
});

afterAll(async () => {
  if (!skipIntegration) {
    await db(TABLES.HostedFundingAuthorization).where({ tenantId: TENANT }).del();
    await db(TABLES.Session).where({ tenantId: TENANT, principalId: partnerId }).del();
    await db(TABLES.Partner).where({ id: partnerId }).del();
    await db(TABLES.Tenant)
      .where({ id: TENANT })
      .update({ billingPlan: tenantBefore?.billingPlan ?? null, payoutRailPreference: tenantBefore?.payoutRailPreference ?? null });
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('GET /config/program connectPayoutsAvailable', () => {
  it('self-host: yes on the auto and stripe_connect rails, no on manual', async () => {
    expect(await available()).toBe(true);
    await db(TABLES.Tenant).where({ id: TENANT }).update({ payoutRailPreference: 'stripe_connect' });
    expect(await available()).toBe(true);
    await db(TABLES.Tenant).where({ id: TENANT }).update({ payoutRailPreference: 'manual' });
    expect(await available()).toBe(false);
  });

  it('self-host without Stripe configured: no', async () => {
    stripeState.configured = false;
    expect(await available()).toBe(false);
  });

  it('hosted: no while payout funding is off, the way prod runs today', async () => {
    await hosted();
    await authorizeFunding();
    expect(await available()).toBe(false);
  });

  it('hosted with funding on: only once the brand has authorized funding', async () => {
    await hosted();
    process.env.HOSTED_FUNDING_ENABLED = '1';
    expect(await available()).toBe(false);
    await authorizeFunding();
    expect(await available()).toBe(true);
    // Revoked is the same as never authorized.
    await db(TABLES.HostedFundingAuthorization).where({ tenantId: TENANT }).update({ revokedAt: new Date() });
    expect(await available()).toBe(false);
  });

  it('hosted with funding authorized but the manual rail: no', async () => {
    await hosted();
    process.env.HOSTED_FUNDING_ENABLED = '1';
    await authorizeFunding();
    await db(TABLES.Tenant).where({ id: TENANT }).update({ payoutRailPreference: 'manual' });
    expect(await available()).toBe(false);
  });

  it('hosted with the operator override for unfunded Connect: yes', async () => {
    await hosted();
    process.env.OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS = '1';
    expect(await available()).toBe(true);
  });

  it('a partner reads the same answer as the admin', async () => {
    expect(await available({ Cookie: partnerCookie })).toBe(true);
    await hosted();
    expect(await available({ Cookie: partnerCookie })).toBe(false);
  });
});
