/**
 * What the admin Commissions and Payouts pages read, in words a brand
 * admin can use: each commission names its partner and the event it was
 * earned on, a payout run names every partner it paid, carried over or
 * held, and GET /payouts lists every partner's payouts, tenant-scoped,
 * a page at a time.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';

const ADMIN_KEY = 'op_test_admin_lists_admin_key_0123456789ab';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const OTHER_TENANT_ID = `t_lists_${ulid().toLowerCase()}`;

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Bonus,
  // After Commission (Commission.payoutId), before Partner (Payout.partnerId).
  TABLES.Payout,
  TABLES.Attribution,
  TABLES.Event,
  // Before Click (Identity.clickId) — other files can leave stitched clicks.
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Program,
  TABLES.Partner,
];

async function wipe() {
  for (const t of TABLES_TO_CLEAN) await db(t).del();
}

const admin = {
  get: (path: string) => request(app).get(path).set('authorization', `Bearer ${ADMIN_KEY}`),
  post: (path: string) => request(app).post(path).set('authorization', `Bearer ${ADMIN_KEY}`),
};

let tenantBefore: Record<string, unknown> | undefined;
const maya = ulid();
const leo = ulid();
let programId = '';
let clickId = '';

/** An approved commission on an attributed `type` event. */
async function attributed(partnerId: string, type: string, amount: string, accruedAt: Date): Promise<string> {
  const eventId = ulid();
  const attributionId = ulid();
  const commissionId = ulid();
  await db(TABLES.Event).insert({
    id: eventId, tenantId: DEFAULT_TENANT_ID, userId: `u-${eventId}`,
    type, value: null, currency: 'USD', ts: accruedAt,
  });
  await db(TABLES.Attribution).insert({
    id: attributionId, tenantId: DEFAULT_TENANT_ID, eventId, partnerId, programId,
    clickId, model: 'last_click', weight: '1', computedAt: accruedAt,
  });
  await db(TABLES.Commission).insert({
    id: commissionId, tenantId: DEFAULT_TENANT_ID, attributionId, partnerId,
    amount, currency: 'USD', status: 'approved', accruedAt,
  });
  return commissionId;
}

describe.skipIf(skipIntegration)('admin commission + payout lists', () => {
  beforeAll(async () => {
    await wipe();
    tenantBefore = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    // Manual rail; totals under $50 carry over.
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ payoutRailPreference: 'manual', payoutThresholdCents: 5000, payoutCadence: null });
    await db(TABLES.Tenant).insert({ id: OTHER_TENANT_ID, slug: OTHER_TENANT_ID, displayName: 'Other', status: 'active' });

    programId = ulid();
    const linkId = ulid();
    clickId = ulid();
    await db(TABLES.Partner).insert([
      { id: maya, tenantId: DEFAULT_TENANT_ID, name: 'Maya Chen', email: `maya-${maya}@x.com` },
      { id: leo, tenantId: DEFAULT_TENANT_ID, name: 'Leo Park', email: `leo-${leo}@x.com` },
    ]);
    await db(TABLES.Program).insert({
      id: programId, tenantId: DEFAULT_TENANT_ID, name: 'Kestrel Partners',
      attributionModel: 'last_click', attributionWindowDays: 60,
      commissionRule: { type: 'fixed', value: 10 }, destinationUrl: 'https://example.com',
    });
    await db(TABLES.Link).insert({
      id: linkId, tenantId: DEFAULT_TENANT_ID, partnerId: maya, programId,
      linkKey: `lk-${linkId}`, destinationUrl: 'https://example.com',
    });
    await db(TABLES.Click).insert({
      id: clickId, tenantId: DEFAULT_TENANT_ID, linkId, partnerId: maya, programId,
      landingUrl: 'https://example.com/l', ipHash: 'h', ts: new Date(),
    });
  });

  afterAll(async () => {
    // Restore the tenant first: if a wipe below throws, later payout runs
    // must not inherit the manual rail or the threshold.
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({
      payoutRailPreference: tenantBefore?.payoutRailPreference ?? null,
      payoutThresholdCents: tenantBefore?.payoutThresholdCents ?? null,
      payoutCadence: tenantBefore?.payoutCadence ?? null,
    });
    await wipe();
    await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).del();
    await db.destroy();
  });

  it('names the partner and the event behind each commission, and none for a bonus', async () => {
    const trial = await attributed(maya, 'trial_started', '10.00', new Date(Date.now() - 3 * 60_000));
    const invoice = await attributed(maya, 'invoice_paid', '45.00', new Date(Date.now() - 2 * 60_000));
    const small = await attributed(leo, 'demo_booked', '20.00', new Date(Date.now() - 60_000));
    const bonusId = ulid();
    const bonusCommission = ulid();
    await db(TABLES.Bonus).insert({
      id: bonusId, tenantId: DEFAULT_TENANT_ID, partnerId: maya, programId,
      amount: '5.00', currency: 'USD', source: 'manual', note: 'Launch week',
    });
    await db(TABLES.Commission).insert({
      id: bonusCommission, tenantId: DEFAULT_TENANT_ID, bonusId, partnerId: maya,
      amount: '5.00', currency: 'USD', status: 'approved', accruedAt: new Date(),
    });

    const res = await admin.get('/commissions');
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.commissions as Array<{ id: string; partnerName: string | null; eventType: string | null; source: string }>).map((c) => [c.id, c]),
    );
    expect(byId.get(trial)).toMatchObject({ partnerName: 'Maya Chen', source: 'attribution', eventType: 'trial_started' });
    expect(byId.get(invoice)).toMatchObject({ partnerName: 'Maya Chen', eventType: 'invoice_paid' });
    expect(byId.get(small)).toMatchObject({ partnerName: 'Leo Park', eventType: 'demo_booked' });
    expect(byId.get(bonusCommission)).toMatchObject({ partnerName: 'Maya Chen', source: 'bonus', eventType: null });

    // The partner-scoped list is the same query.
    const own = await admin.get(`/partners/${leo}/commissions`);
    expect(own.body.commissions).toEqual([expect.objectContaining({ id: small, partnerName: 'Leo Park', eventType: 'demo_booked' })]);
  });

  it('names every partner a payout run paid or carried over', async () => {
    const res = await admin.post('/payouts/run');
    expect(res.status).toBe(200);
    expect(res.body.payouts).toEqual([
      expect.objectContaining({ partnerId: maya, partnerName: 'Maya Chen', amount: 60, method: 'manual', status: 'pending' }),
    ]);
    expect(res.body.skippedBelowThreshold).toEqual([{ partnerId: leo, partnerName: 'Leo Park', currency: 'USD', amount: 20 }]);
  });

  it("lists every partner's payouts newest first, a page at a time, in this tenant only", async () => {
    const [run] = await db(TABLES.Payout).where({ tenantId: DEFAULT_TENANT_ID, partnerId: maya });
    const older = ulid();
    const orphan = ulid();
    await db(TABLES.Payout).insert([
      {
        id: older, tenantId: DEFAULT_TENANT_ID, partnerId: leo, amount: '80.00', currency: 'USD',
        method: 'manual', status: 'paid', createdAt: new Date(Date.now() - 2 * 86_400_000), completedAt: new Date(),
      },
      // No foreign key holds a payout's partner: one whose partner is gone lists unnamed.
      {
        id: orphan, tenantId: DEFAULT_TENANT_ID, partnerId: ulid(), amount: '1.00', currency: 'USD',
        method: 'manual', status: 'paid', createdAt: new Date(Date.now() - 3 * 86_400_000),
      },
      // Another brand's, newer than all of them.
      {
        id: ulid(), tenantId: OTHER_TENANT_ID, partnerId: maya, amount: '99.00', currency: 'USD',
        method: 'manual', status: 'pending', createdAt: new Date(Date.now() + 60_000),
      },
    ]);

    const all = await admin.get('/payouts');
    expect(all.status).toBe(200);
    expect(all.body.nextCursor).toBeNull();
    expect(all.body.payouts.map((p: { id: string; partnerName: string | null }) => [p.id, p.partnerName])).toEqual([
      [run.id, 'Maya Chen'],
      [older, 'Leo Park'],
      [orphan, null],
    ]);

    const first = await admin.get('/payouts?limit=2');
    expect(first.body.payouts.map((p: { id: string }) => p.id)).toEqual([run.id, older]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await admin.get(`/payouts?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body).toEqual({ payouts: [expect.objectContaining({ id: orphan })], nextCursor: null });

    const paid = await admin.get('/payouts?status=paid');
    expect(paid.body.payouts.map((p: { id: string }) => p.id)).toEqual([older, orphan]);

    expect((await admin.get('/payouts?cursor=bm9wZQ')).status).toBe(400);
    expect((await admin.get('/payouts?status=sent')).status).toBe(400);
    expect((await admin.get('/payouts?limit=500')).status).toBe(400);
  });
});
