/**
 * Trial gate over the real HTTP surface.
 *
 * The gate matches route strings, so it can drift from the routers it
 * fences: the Campaign → Program rename moved the partner-grant route to
 * POST /partners/:id/programs while the gate still matched
 * /partners/:id/campaigns, so a lapsed-trial brand could keep granting
 * programs. These cases go through createApp() so the gate sees the path
 * Express actually routes (tenant prefix stripped, any case, trailing slash).
 *
 * Skipped when DATABASE_URL is unset, like the rest of the integration suite.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type TenantRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_trialgate_0123456789abcdef012345';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'multi';
delete process.env.NETWORK_URL; // no auto-enroll side calls
// The grant auto-mints coupons, which checks each code against Stripe when a
// key is configured. Keep that off the network.
delete process.env.STRIPE_SECRET_KEY;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const DAY_MS = 24 * 60 * 60 * 1000;
const createdTenantIds: string[] = [];

/** A hosted (Flex) brand that took its 14-day trial, with one partner and
 *  one program to grant. */
async function seedBrand(billing: { trialEndsAt: Date; stripeSubscriptionId: string | null }) {
  const tenantId = ulid();
  const slug = `trial${ulid().slice(-8).toLowerCase()}`;
  createdTenantIds.push(tenantId);
  await db<TenantRow>(TABLES.Tenant).insert({
    id: tenantId,
    slug,
    displayName: 'Trial Gate Brand',
    status: 'active',
    approvalStatus: 'approved',
    billingPlan: 'flex',
    trialEndsAt: billing.trialEndsAt,
    firstTrialActivatedAt: new Date(billing.trialEndsAt.getTime() - 14 * DAY_MS),
    stripeSubscriptionId: billing.stripeSubscriptionId,
  });
  const partnerId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId, email: `p-${partnerId}@example.test`, name: 'P' });
  const programId = ulid();
  await db(TABLES.Program).insert({
    id: programId,
    tenantId,
    name: 'Test Program',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl: 'https://brand.example.test',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  return { slug, partnerId, programId };
}

function grant(slug: string, path: string, programId: string) {
  return request(app)
    .post(`/t/${slug}${path}`)
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({ programIds: [programId] });
}

async function grantsFor(partnerId: string): Promise<unknown[]> {
  return db(TABLES.PartnerProgram).where({ partnerId });
}

afterEach(async () => {
  if (skipIntegration) return;
  const ids = createdTenantIds.splice(0);
  if (ids.length === 0) return;
  // FK order: children before Tenant.
  for (const table of [TABLES.Coupon, TABLES.PartnerProgram, TABLES.Link, TABLES.Partner, TABLES.Program]) {
    await db(table).whereIn('tenantId', ids).del();
  }
  await db(TABLES.Tenant).whereIn('id', ids).del();
});

afterAll(async () => {
  await db.destroy();
});

describe.skipIf(skipIntegration)('trial gate — POST /partners/:id/programs', () => {
  it('402s a program grant once a hosted trial lapses without a subscription', async () => {
    const { slug, partnerId, programId } = await seedBrand({
      trialEndsAt: new Date(Date.now() - DAY_MS),
      stripeSubscriptionId: null,
    });

    // Express routes the case/trailing-slash variant to the same handler,
    // so the gate must catch it too.
    for (const path of [`/partners/${partnerId}/programs`, `/Partners/${partnerId}/Programs/`]) {
      const res = await grant(slug, path, programId);
      expect(res.status).toBe(402);
      expect(res.body.error).toBe('trial_expired');
    }
    expect(await grantsFor(partnerId)).toHaveLength(0);
  });

  it('lets the grant through once the brand has an active plan', async () => {
    const { slug, partnerId, programId } = await seedBrand({
      trialEndsAt: new Date(Date.now() - DAY_MS),
      stripeSubscriptionId: 'sub_trialgate_test',
    });

    const res = await grant(slug, `/partners/${partnerId}/programs`, programId);
    expect(res.status).toBe(201);
    expect(res.body.added).toEqual([programId]);
    expect(await grantsFor(partnerId)).toHaveLength(1);
  });

  it('leaves grants open while the trial is still running', async () => {
    const { slug, partnerId, programId } = await seedBrand({
      trialEndsAt: new Date(Date.now() + 7 * DAY_MS),
      stripeSubscriptionId: null,
    });

    const res = await grant(slug, `/partners/${partnerId}/programs`, programId);
    expect(res.status).toBe(201);
    expect(await grantsFor(partnerId)).toHaveLength(1);
  });
});
