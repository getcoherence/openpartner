/**
 * Coupon minting vs. Stripe, end to end through the routes:
 *
 *   - Hosted deployments never provision (or look up, or deactivate) in
 *     the deployment's Stripe account — that's OpenPartner's own billing
 *     account, where a 100%-off promo would work on OpenPartner's plans.
 *   - Single-tenant self-host still provisions in the brand's account.
 *   - A partner-chosen or generated code may not shadow an existing
 *     promotion code / coupon id in the brand's Stripe (admin-chosen may).
 *   - A promo whose Coupon row then fails to insert is deactivated.
 *   - Deactivated codes stop matching redemptions.
 *
 * Stripe is an in-memory fake. Requires DATABASE_URL like the other
 * DB-backed suites; skipped without it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type CouponRow, type CustomerReward } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { autoMintCouponsForGrants, findCouponByCode } from '../routes/coupons.js';

const fake = vi.hoisted(() => {
  let seq = 0;
  const state = {
    /** Lowercased promotion codes that already exist in the fake account. */
    promoCodes: new Set<string>(),
    /** Coupon ids that already exist (case-sensitive, like Stripe). */
    couponIds: new Set<string>(),
    everyCodeTaken: false,
    listError: null as Error | null,
    onPromoCreate: null as null | ((code: string) => Promise<void>),
  };
  const client = {
    coupons: {
      create: vi.fn(async (_params: Record<string, unknown>) => ({ id: `co_fake_${++seq}` })),
      retrieve: vi.fn(async (id: string) => {
        if (state.couponIds.has(id)) return { id };
        throw Object.assign(new Error(`No such coupon: '${id}'`), { code: 'resource_missing' });
      }),
    },
    promotionCodes: {
      list: vi.fn(async ({ code }: { code: string }) => {
        if (state.listError) throw state.listError;
        const hit = state.everyCodeTaken || state.promoCodes.has(code.toLowerCase());
        return { data: hit ? [{ id: 'promo_brand_owned', code }] : [] };
      }),
      create: vi.fn(async ({ code }: { code: string }) => {
        await state.onPromoCreate?.(code);
        return { id: `promo_fake_${++seq}`, code };
      }),
      update: vi.fn(async (id: string, params: Record<string, unknown>) => ({ id, ...params })),
    },
  };
  return { state, client };
});

vi.mock('../stripe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stripe.js')>()),
  stripe: fake.client,
}));

const ADMIN_KEY = 'op_test_admin_key_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.Payout,
  TABLES.Program,
  TABLES.ApiKey,
  TABLES.Partner,
];

const FREE_YEAR: CustomerReward = { type: 'free_months', value: 12, duration: 'repeating' };

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
let verifiedAtBefore: Date | null = null;

async function clean(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) {
    await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
  }
}

beforeAll(async () => {
  if (skipIntegration) return;
  // Mark the coupon integration verified so the mint route's verification
  // gate (which counts Coupon rows other files may have left behind) stays
  // out of these tests. Restored in afterAll so later files see the tenant
  // as they would have.
  const t = (await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first('couponIntegrationVerifiedAt')) as
    | { couponIntegrationVerifiedAt: Date | null }
    | undefined;
  verifiedAtBefore = t?.couponIntegrationVerifiedAt ?? null;
  await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ couponIntegrationVerifiedAt: new Date() });
});

afterAll(async () => {
  if (!skipIntegration) {
    await clean();
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ couponIntegrationVerifiedAt: verifiedAtBefore });
  }
  process.env.OPENPARTNER_MODE = 'selfhost';
  await db.destroy();
});

beforeEach(async () => {
  process.env.OPENPARTNER_MODE = 'selfhost';
  process.env.OPENPARTNER_TENANCY = 'single';
  fake.state.promoCodes.clear();
  fake.state.couponIds.clear();
  fake.state.everyCodeTaken = false;
  fake.state.listError = null;
  fake.state.onPromoCreate = null;
  for (const group of [fake.client.coupons, fake.client.promotionCodes]) {
    for (const fn of Object.values(group)) fn.mockClear();
  }
  if (!skipIntegration) await clean();
});

afterEach(() => {
  process.env.OPENPARTNER_MODE = 'selfhost';
});

async function seed(opts: { customerReward?: CustomerReward | null } = {}) {
  const partnerId = ulid();
  const programId = ulid();
  await db(TABLES.Partner).insert({
    id: partnerId,
    tenantId: DEFAULT_TENANT_ID,
    email: `p${partnerId.toLowerCase()}@x.test`,
    name: 'Partner',
  });
  const reward = opts.customerReward === undefined ? FREE_YEAR : opts.customerReward;
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Launch',
    commissionRule: JSON.stringify({ type: 'percent', value: 20 }),
    destinationUrl: 'https://x.test/landing',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
    customerReward: reward ? JSON.stringify(reward) : null,
    partnersMayCustomizeCode: true,
  });
  return { partnerId, programId };
}

/** A Network-style federated key: partners:write, the partner-self-service path. */
async function federatedKey(): Promise<string> {
  const res = await request(app)
    .post('/api-keys/scoped')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({ scopes: ['partners:write'], label: 'coupon-scoping-test' });
  expect(res.status).toBe(201);
  return res.body.plaintext as string;
}

function mint(key: string, partnerId: string, body: Record<string, unknown>) {
  return request(app).post(`/partners/${partnerId}/coupons`).set('Authorization', `Bearer ${key}`).send(body);
}

async function couponsFor(partnerId: string): Promise<CouponRow[]> {
  return db<CouponRow>(TABLES.Coupon).where({ partnerId }).orderBy('createdAt', 'asc');
}

function stripeCallCount(): number {
  return [...Object.values(fake.client.coupons), ...Object.values(fake.client.promotionCodes)].reduce(
    (n, fn) => n + fn.mock.calls.length,
    0,
  );
}

describe.skipIf(skipIntegration)('coupon reward scoping', () => {
  describe('hosted deployment (OPENPARTNER_MODE=flat): the platform Stripe is never touched', () => {
    beforeEach(() => {
      process.env.OPENPARTNER_MODE = 'flat';
    });

    it('admin mints a code on a 12-free-months program: row written, no Stripe objects', async () => {
      const { partnerId, programId } = await seed();
      const res = await mint(ADMIN_KEY, partnerId, { programId, code: 'FREEYEAR' });
      expect(res.status).toBe(201);
      expect(res.body.stripeCouponId).toBeNull();
      expect(res.body.stripePromotionCodeId).toBeNull();
      expect(stripeCallCount()).toBe(0);
    });

    it('federated partner mint: no collision lookup against the platform account either', async () => {
      const { partnerId, programId } = await seed();
      const key = await federatedKey();
      const res = await mint(key, partnerId, { programId, code: 'PARTNER20' });
      expect(res.status).toBe(201);
      expect(stripeCallCount()).toBe(0);
    });

    it('auto-mint on grant writes the coupon without Stripe', async () => {
      const { partnerId, programId } = await seed();
      const partner = await db(TABLES.Partner).where({ id: partnerId }).first();
      await autoMintCouponsForGrants(db, DEFAULT_TENANT_ID, { id: partnerId, email: partner.email }, [programId]);
      const rows = await couponsFor(partnerId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stripePromotionCodeId).toBeNull();
      expect(stripeCallCount()).toBe(0);
    });

    it('deactivating a row that carries a pre-fix platform promo id makes no Stripe call', async () => {
      const { partnerId, programId } = await seed();
      const id = `cpn_${ulid()}`;
      await db(TABLES.Coupon).insert({
        id,
        tenantId: DEFAULT_TENANT_ID,
        partnerId,
        programId,
        code: 'LEGACY10',
        stripeCouponId: 'co_platform_legacy',
        stripePromotionCodeId: 'promo_platform_legacy',
      });
      const res = await request(app)
        .delete(`/partners/${partnerId}/coupons/${id}`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`);
      expect(res.status).toBe(200);
      expect(res.body.deactivatedAt).not.toBeNull();
      expect(stripeCallCount()).toBe(0);
    });
  });

  describe('single-tenant self-host: provisions in the brand account', () => {
    it('admin mint creates the Stripe coupon + promotion code and stores their ids', async () => {
      const { partnerId, programId } = await seed();
      const res = await mint(ADMIN_KEY, partnerId, { programId, code: 'KEITHFREE' });
      expect(res.status).toBe(201);
      expect(fake.client.coupons.create).toHaveBeenCalledTimes(1);
      expect(fake.client.coupons.create.mock.calls[0]![0]).toMatchObject({
        percent_off: 100,
        duration: 'repeating',
        duration_in_months: 12,
      });
      expect(fake.client.promotionCodes.create.mock.calls[0]![0]).toMatchObject({ code: 'KEITHFREE' });
      expect(res.body.stripeCouponId).toMatch(/^co_fake_/);
      expect(res.body.stripePromotionCodeId).toMatch(/^promo_fake_/);
    });
  });

  describe('codes that shadow an existing promo in the brand Stripe', () => {
    it("partner-chosen code equal to the brand's own promotion code → 409, nothing minted", async () => {
      fake.state.promoCodes.add('welcome10');
      const { partnerId, programId } = await seed();
      const key = await federatedKey();
      const res = await mint(key, partnerId, { programId, code: 'WELCOME10' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('code_taken');
      expect(fake.client.coupons.create).not.toHaveBeenCalled();
      expect(fake.client.promotionCodes.create).not.toHaveBeenCalled();
      expect(await couponsFor(partnerId)).toHaveLength(0);
    });

    it('partner-chosen code equal to an existing coupon id (lowercase) → 409', async () => {
      fake.state.couponIds.add('spring25');
      const { partnerId, programId } = await seed();
      const key = await federatedKey();
      const res = await mint(key, partnerId, { programId, code: 'SPRING25' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('code_taken');
      expect(await couponsFor(partnerId)).toHaveLength(0);
    });

    it('a generated code (none supplied) is checked too, even when an admin asks', async () => {
      fake.state.everyCodeTaken = true;
      const { partnerId, programId } = await seed();
      const res = await mint(ADMIN_KEY, partnerId, { programId });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('code_taken');
      expect(await couponsFor(partnerId)).toHaveLength(0);
    });

    it('an admin-chosen code may deliberately map an existing promo', async () => {
      fake.state.promoCodes.add('welcome10');
      const { partnerId, programId } = await seed({ customerReward: null });
      const res = await mint(ADMIN_KEY, partnerId, { programId, code: 'WELCOME10' });
      expect(res.status).toBe(201);
      expect(fake.client.promotionCodes.list).not.toHaveBeenCalled();
      // Recorded, so the Stripe webhook credits the partner for that promo.
      expect(res.body.brandChosen).toBe(true);
    });

    it("a code the admin didn't type isn't marked as the brand's choice", async () => {
      const { partnerId, programId } = await seed({ customerReward: null });
      const generated = await mint(ADMIN_KEY, partnerId, { programId });
      expect(generated.status).toBe(201);
      expect(generated.body.brandChosen).toBe(false);
      const partnerChosen = await mint(await federatedKey(), partnerId, { programId, code: 'PARTNER20' });
      expect(partnerChosen.status).toBe(201);
      expect(partnerChosen.body.brandChosen).toBe(false);
    });

    it('Stripe unreachable during the check → 503 for a partner-chosen code, nothing minted', async () => {
      fake.state.listError = Object.assign(new Error('connection reset'), { type: 'StripeConnectionError' });
      const { partnerId, programId } = await seed();
      const key = await federatedKey();
      const res = await mint(key, partnerId, { programId, code: 'PARTNER20' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('code_check_unavailable');
      expect(fake.client.coupons.create).not.toHaveBeenCalled();
      expect(await couponsFor(partnerId)).toHaveLength(0);
    });

    it('auto-mint discards generated codes that shadow a promo, giving up after two draws', async () => {
      fake.state.everyCodeTaken = true;
      const { partnerId, programId } = await seed();
      await autoMintCouponsForGrants(db, DEFAULT_TENANT_ID, { id: partnerId, email: 'ada@x.test' }, [programId]);
      expect(fake.client.promotionCodes.list).toHaveBeenCalledTimes(2);
      expect(fake.client.coupons.create).not.toHaveBeenCalled();
      expect(await couponsFor(partnerId)).toHaveLength(0);
    });
  });

  describe('a promo whose Coupon row fails to insert is released', () => {
    it('POST: code_taken after provisioning deactivates the promo it just created', async () => {
      const { partnerId, programId } = await seed();
      const other = await seed({ customerReward: null });
      // Same string already held in this tenant by a row with no Stripe
      // promo (e.g. minted while Stripe was unset), so the Stripe check
      // passes and only the (tenantId, code) unique catches it.
      await db(TABLES.Coupon).insert({
        id: `cpn_${ulid()}`,
        tenantId: DEFAULT_TENANT_ID,
        partnerId: other.partnerId,
        programId: other.programId,
        code: 'TAKEN10',
      });

      const res = await mint(ADMIN_KEY, partnerId, { programId, code: 'TAKEN10' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('code_taken');

      const created = await fake.client.promotionCodes.create.mock.results[0]!.value;
      expect(fake.client.promotionCodes.update).toHaveBeenCalledTimes(1);
      expect(fake.client.promotionCodes.update).toHaveBeenCalledWith(created.id, { active: false });
      expect(await couponsFor(partnerId)).toHaveLength(0);
    });

    it('auto-mint: a draw that collides releases its promo, and the next draw lands with its own', async () => {
      const { partnerId, programId } = await seed();
      const other = await seed({ customerReward: null });
      // Simulate a concurrent mint taking the first draw's code between
      // the Stripe check and our insert.
      let raced = false;
      fake.state.onPromoCreate = async (code) => {
        if (raced) return;
        raced = true;
        await db(TABLES.Coupon).insert({
          id: `cpn_${ulid()}`,
          tenantId: DEFAULT_TENANT_ID,
          partnerId: other.partnerId,
          programId: other.programId,
          code,
        });
      };

      await autoMintCouponsForGrants(db, DEFAULT_TENANT_ID, { id: partnerId, email: 'ada@x.test' }, [programId]);

      expect(fake.client.promotionCodes.create).toHaveBeenCalledTimes(2);
      const first = await fake.client.promotionCodes.create.mock.results[0]!.value;
      const second = await fake.client.promotionCodes.create.mock.results[1]!.value;
      expect(fake.client.promotionCodes.update).toHaveBeenCalledTimes(1);
      expect(fake.client.promotionCodes.update).toHaveBeenCalledWith(first.id, { active: false });

      const rows = await couponsFor(partnerId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.code).toBe(second.code);
      expect(rows[0]!.stripePromotionCodeId).toBe(second.id);
    });
  });

  describe('deactivated codes stop attributing', () => {
    async function seedCoupons() {
      const { partnerId, programId } = await seed({ customerReward: null });
      await db(TABLES.Coupon).insert([
        {
          id: `cpn_${ulid()}`,
          tenantId: DEFAULT_TENANT_ID,
          partnerId,
          programId,
          code: 'RETIRED15',
          deactivatedAt: new Date(),
        },
        { id: `cpn_${ulid()}`, tenantId: DEFAULT_TENANT_ID, partnerId, programId, code: 'LIVE15' },
      ]);
      return { partnerId };
    }

    it('POST /coupons/redeem: retired code → 404; live code still redeems', async () => {
      const { partnerId } = await seedCoupons();
      const redeem = (code: string) =>
        request(app)
          .post('/coupons/redeem')
          .set('Authorization', `Bearer ${ADMIN_KEY}`)
          .send({ code, eventType: 'signup', externalEventId: `ord_${ulid()}`, userId: `usr_${ulid()}` });

      const retired = await redeem('retired15');
      expect(retired.status).toBe(404);
      expect(retired.body.error).toBe('coupon_not_found');
      expect(await db(TABLES.Click).where({ partnerId })).toHaveLength(0);

      const live = await redeem('live15');
      expect(live.status).toBe(201);
      expect(live.body.partnerId).toBe(partnerId);
    });

    it('findCouponByCode (the Stripe webhook auto-redeem lookup) skips retired codes', async () => {
      await seedCoupons();
      expect(await findCouponByCode(db, DEFAULT_TENANT_ID, 'RETIRED15')).toBeNull();
      expect((await findCouponByCode(db, DEFAULT_TENANT_ID, 'live15'))?.code).toBe('LIVE15');
    });
  });
});

describe.skipIf(skipIntegration)('revoking a program grant', () => {
  const auth = { Authorization: `Bearer ${ADMIN_KEY}` };

  it("retires the partner's code on that program, Stripe promotion code included; re-granting mints a fresh one", async () => {
    const { partnerId, programId } = await seed();
    const otherProgramId = ulid();
    await db(TABLES.Program).insert({
      id: otherProgramId,
      tenantId: DEFAULT_TENANT_ID,
      name: 'Other',
      commissionRule: JSON.stringify({ type: 'percent', value: 10 }),
      destinationUrl: 'https://x.test/other',
      attributionWindowDays: 60,
      attributionModel: 'last_click',
      customerReward: JSON.stringify(FREE_YEAR),
      partnersMayCustomizeCode: true,
    });
    await db(TABLES.PartnerProgram).insert([
      { id: `pc_${ulid()}`, tenantId: DEFAULT_TENANT_ID, partnerId, programId, source: 'offering' },
      { id: `pc_${ulid()}`, tenantId: DEFAULT_TENANT_ID, partnerId, programId: otherProgramId, source: 'admin' },
    ]);
    const partner = (await db(TABLES.Partner).where({ id: partnerId }).first()) as { email: string };
    await autoMintCouponsForGrants(db, DEFAULT_TENANT_ID, { id: partnerId, email: partner.email }, [
      programId,
      otherProgramId,
    ]);
    const revoked = (await couponsFor(partnerId)).find((c) => c.programId === programId)!;
    expect(revoked.stripePromotionCodeId).toBeTruthy();

    const res = await request(app).delete(`/partners/${partnerId}/programs/${programId}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.retiredCoupons).toEqual([revoked.code]);
    expect(fake.client.promotionCodes.update).toHaveBeenCalledWith(revoked.stripePromotionCodeId, { active: false });
    expect(await findCouponByCode(db, DEFAULT_TENANT_ID, revoked.code)).toBeNull();
    // The code on the program that's still granted keeps working.
    const kept = (await couponsFor(partnerId)).find((c) => c.programId === otherProgramId)!;
    expect(kept.deactivatedAt).toBeNull();

    const regrant = await request(app)
      .post(`/partners/${partnerId}/programs`)
      .set(auth)
      .send({ programIds: [programId] });
    expect(regrant.status).toBe(201);
    const active = (await couponsFor(partnerId)).filter((c) => c.programId === programId && !c.deactivatedAt);
    expect(active).toHaveLength(1);
    expect(active[0]!.code).not.toBe(revoked.code);
  });

  it('revoking a grant whose partner has no code on it still succeeds', async () => {
    const { partnerId, programId } = await seed({ customerReward: null });
    await db(TABLES.PartnerProgram).insert({
      id: `pc_${ulid()}`,
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      programId,
      source: 'admin',
    });
    const res = await request(app).delete(`/partners/${partnerId}/programs/${programId}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, retiredCoupons: [] });
    expect(fake.client.promotionCodes.update).not.toHaveBeenCalled();
  });
});
