/**
 * Coupon verification gate: POST /partners/:id/coupons refuses manual
 * mints with 409 verification_required once a brand has N coupons and no
 * successful redemption. The detail tells the brand how to unlock more
 * mints, and the Stripe-webhook alternative only exists on a single-tenant
 * self-host — /webhooks/stripe never sees events from a hosted brand's own
 * Stripe account, so hosted and multi-tenant deployments must be pointed
 * at POST /coupons/redeem alone.
 *
 * The mode matrix needs no database. The route checks need a migrated
 * Postgres and skip when DATABASE_URL isn't set.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { couponVerificationDetail } from '../routes/coupons.js';

const ADMIN_KEY = 'op_test_admin_key_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

function restoreDeployment(): void {
  process.env.OPENPARTNER_MODE = 'selfhost';
  process.env.OPENPARTNER_TENANCY = 'single';
}

afterAll(async () => {
  await db.destroy();
});

describe('couponVerificationDetail', () => {
  afterEach(restoreDeployment);

  it('offers the Stripe webhook on a single-tenant self-host', () => {
    const detail = couponVerificationDetail(5);
    expect(detail).toMatch(/^You have 5 coupons but no successful redemption yet\./);
    expect(detail).toContain('POST /coupons/redeem');
    expect(detail).toContain('/webhooks/stripe');
  });

  it.each([
    ['flat', 'single'],
    ['revshare', 'single'],
    ['flat', 'multi'],
    ['revshare', 'multi'],
    ['selfhost', 'multi'],
  ])('points a %s/%s deployment at POST /coupons/redeem only', (mode, tenancy) => {
    process.env.OPENPARTNER_MODE = mode;
    process.env.OPENPARTNER_TENANCY = tenancy;
    const detail = couponVerificationDetail(5);
    expect(detail).toBe(
      "You have 5 coupons but no successful redemption yet. Wire up POST /coupons/redeem on your checkout and process one test redemption to unlock further mints. This protects creators from sharing codes that don't actually attribute.",
    );
    expect(detail).not.toMatch(/webhook/i);
  });
});

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

describe.skipIf(skipIntegration)('POST /partners/:id/coupons verification gate', () => {
  const partnerId = ulid();
  const programId = ulid();
  let priorVerifiedAt: Date | null = null;

  beforeAll(async () => {
    const tenant = (await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .first(['couponIntegrationVerifiedAt'])) as { couponIntegrationVerifiedAt: Date | null } | undefined;
    priorVerifiedAt = tenant?.couponIntegrationVerifiedAt ?? null;
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ couponIntegrationVerifiedAt: null });

    await db(TABLES.Partner).insert({
      id: partnerId,
      tenantId: DEFAULT_TENANT_ID,
      email: `gate-${partnerId}@x.test`,
      name: 'Gate Partner',
    });
    await db(TABLES.Program).insert({
      id: programId,
      tenantId: DEFAULT_TENANT_ID,
      name: 'Gate Program',
      commissionRule: JSON.stringify({ type: 'percent', value: 20 }),
      destinationUrl: 'https://x.test/landing',
    });
    // Enough coupons to reach the threshold, none ever redeemed.
    await db(TABLES.Coupon).insert(
      Array.from({ length: 5 }, (_, i) => ({
        id: ulid(),
        tenantId: DEFAULT_TENANT_ID,
        partnerId,
        programId,
        code: `GATE${i}${partnerId.slice(-6)}`,
      })),
    );
  });

  afterAll(async () => {
    restoreDeployment();
    await db(TABLES.Coupon).where({ partnerId }).del();
    await db(TABLES.Program).where({ id: programId }).del();
    await db(TABLES.Partner).where({ id: partnerId }).del();
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ couponIntegrationVerifiedAt: priorVerifiedAt });
  });

  afterEach(restoreDeployment);

  async function mint() {
    return request(app)
      .post(`/partners/${partnerId}/coupons`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ programId });
  }

  it('mentions the Stripe webhook on a single-tenant self-host', async () => {
    const res = await mint();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('verification_required');
    expect(res.body.detail).toBe(couponVerificationDetail(res.body.existing));
    expect(res.body.detail).toContain('/webhooks/stripe');
  });

  it('points a hosted brand at POST /coupons/redeem only', async () => {
    process.env.OPENPARTNER_MODE = 'flat';
    const res = await mint();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('verification_required');
    expect(res.body.detail).toContain('POST /coupons/redeem');
    expect(res.body.detail).not.toMatch(/webhook/i);
  });
});
