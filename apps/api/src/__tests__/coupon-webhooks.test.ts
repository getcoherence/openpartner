/**
 * coupon.registered / coupon.deactivated webhooks (coupon-events.ts).
 *
 *   - a code minted by an admin or by the partner fires coupon.registered
 *     with who minted it
 *   - a partner created with programs gets a default code, which fires
 *     coupon.registered (source program_grant), as does a later grant
 *   - deactivating (the portal's "delete") fires coupon.deactivated once;
 *     re-deactivating sends nothing
 *   - revoking a program grant retires the partner's codes on it and fires
 *     coupon.deactivated (grant_revoked) for each
 *   - coupon.registered carries what the code is worth: the commission the
 *     partner earns on the program, by the engine's precedence (their terms
 *     on the program, then partner-wide, then the program's rule), read
 *     after commit, and the customer's discount
 *
 * dispatchEvent is mocked so the assertions read exact payloads. The
 * delivered shapes are checked against the catalogue by
 * openapi-contract.test.ts. Skipped if DATABASE_URL isn't set.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_coupon_webhooks_0123456789abcdef01';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';
// No Stripe: minted codes would otherwise be checked against it.
process.env.STRIPE_SECRET_KEY = '';

vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn() };
});

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { dispatchEvent } = await import('../webhook-dispatcher.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };

const TABLES_TO_CLEAN = [
  TABLES.Coupon,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.ApiKey,
  TABLES.Program,
  TABLES.Partner,
];

async function clean(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
}

function dispatched(event: string): Array<Record<string, unknown>> {
  return vi
    .mocked(dispatchEvent)
    .mock.calls.filter(([, e]) => e === event)
    .map(([, , payload]) => payload as Record<string, unknown>);
}

/** onCommit jobs run once the request transaction has committed, which
 *  can be just after supertest sees the response. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

const PROGRAM_RULE = [{ trigger: 'every', type: 'percent', value: 10, recurring: true }];
const PROGRAM_TERMS = { source: 'program', summary: expect.stringContaining('10%'), rules: PROGRAM_RULE };

async function seedProgram(partnersMayCustomizeCode = true, extra: Record<string, unknown> = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Coupon webhooks',
    commissionRule: JSON.stringify(PROGRAM_RULE),
    ...extra,
    destinationUrl: 'https://x.test/landing',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
    partnersMayCustomizeCode,
  });
  return id;
}

async function seedPartner(): Promise<{ id: string; email: string }> {
  const id = ulid();
  const email = `p${id.toLowerCase()}@x.test`;
  await db(TABLES.Partner).insert({ id, tenantId: DEFAULT_TENANT_ID, email, name: 'Partner', activatedAt: new Date() });
  return { id, email };
}

const shape = (extra: Record<string, unknown>) => ({
  couponId: expect.stringMatching(/^cpn_/),
  partnerId: expect.any(String),
  programId: expect.any(String),
  code: expect.any(String),
  customerDiscount: false,
  brandChosen: expect.any(Boolean),
  createdAt: expect.any(String),
  ...extra,
});

beforeEach(async () => {
  vi.mocked(dispatchEvent).mockClear();
  if (!skipIntegration) await clean();
});

afterAll(async () => {
  if (!skipIntegration) await clean();
  await db.destroy();
});

describe.skipIf(skipIntegration)('coupon webhooks', () => {
  it('an admin mint fires coupon.registered (admin); deactivating it fires coupon.deactivated once', async () => {
    const programId = await seedProgram();
    const partner = await seedPartner();

    const minted = await request(app).post(`/partners/${partner.id}/coupons`).set(admin).send({ programId, code: 'BRAND15' });
    expect(minted.status).toBe(201);
    await settle();
    expect(dispatched('coupon.registered')).toEqual([
      shape({
        couponId: minted.body.id,
        partnerId: partner.id,
        programId,
        code: 'BRAND15',
        brandChosen: true,
        source: 'admin',
        commission: PROGRAM_TERMS,
        customerReward: null,
      }),
    ]);

    const del = await request(app).delete(`/partners/${partner.id}/coupons/${minted.body.id}`).set(admin);
    expect(del.status).toBe(200);
    await settle();
    expect(dispatched('coupon.deactivated')).toEqual([
      shape({
        couponId: minted.body.id,
        code: 'BRAND15',
        brandChosen: true,
        deactivatedAt: new Date(del.body.deactivatedAt).toISOString(),
        source: 'admin',
      }),
    ]);

    // Already inactive: 200, no second event.
    expect((await request(app).delete(`/partners/${partner.id}/coupons/${minted.body.id}`).set(admin)).status).toBe(200);
    await settle();
    expect(dispatched('coupon.deactivated')).toHaveLength(1);
  });

  it("a partner's own mint and deactivation carry source partner", async () => {
    const programId = await seedProgram();
    const partner = await seedPartner();
    await db(TABLES.PartnerProgram).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, partnerId: partner.id, programId, source: 'admin' });
    const key = (await request(app).post(`/partners/${partner.id}/api-keys`).set(admin).send({})).body.plaintext as string;
    const asPartner = { Authorization: `Bearer ${key}` };

    const minted = await request(app).post(`/partners/${partner.id}/coupons`).set(asPartner).send({ programId });
    expect(minted.status).toBe(201);
    const del = await request(app).delete(`/partners/${partner.id}/coupons/${minted.body.id}`).set(asPartner);
    expect(del.status).toBe(200);
    await settle();

    expect(dispatched('coupon.registered')).toEqual([
      shape({ couponId: minted.body.id, brandChosen: false, source: 'partner', commission: PROGRAM_TERMS, customerReward: null }),
    ]);
    expect(dispatched('coupon.deactivated')).toEqual([
      shape({ couponId: minted.body.id, deactivatedAt: expect.any(String), source: 'partner' }),
    ]);
  });

  it("a partner created with programs fires coupon.registered for each default code, as does a later grant", async () => {
    const first = await seedProgram(false);
    const second = await seedProgram(false);
    const created = await request(app)
      .post('/partners')
      .set(admin)
      .send({ email: 'new-partner@x.test', name: 'New Partner', programIds: [first], sendInvite: false });
    expect(created.status).toBe(201);
    await settle();

    const coupons = await db(TABLES.Coupon).where({ tenantId: DEFAULT_TENANT_ID, partnerId: created.body.id });
    expect(coupons).toHaveLength(1);
    expect(dispatched('coupon.registered')).toEqual([
      shape({
        couponId: coupons[0].id,
        partnerId: created.body.id,
        programId: first,
        code: coupons[0].code,
        brandChosen: false,
        source: 'program_grant',
        commission: PROGRAM_TERMS,
        customerReward: null,
      }),
    ]);

    const granted = await request(app).post(`/partners/${created.body.id}/programs`).set(admin).send({ programIds: [second] });
    expect(granted.status).toBe(201);
    await settle();
    expect(dispatched('coupon.registered').map((p) => [p.programId, p.source])).toEqual([
      [first, 'program_grant'],
      [second, 'program_grant'],
    ]);
  });

  it("revoking a program grant fires coupon.deactivated (grant_revoked) for each active code on it", async () => {
    const programId = await seedProgram();
    const partner = await seedPartner();
    await db(TABLES.PartnerProgram).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, partnerId: partner.id, programId, source: 'admin' });
    const a = await request(app).post(`/partners/${partner.id}/coupons`).set(admin).send({ programId, code: 'CODEA' });
    const b = await request(app).post(`/partners/${partner.id}/coupons`).set(admin).send({ programId, code: 'CODEB' });
    // Already retired: not reported again.
    await request(app).delete(`/partners/${partner.id}/coupons/${b.body.id}`).set(admin);
    const c = await request(app).post(`/partners/${partner.id}/coupons`).set(admin).send({ programId, code: 'CODEC' });
    await settle();
    vi.mocked(dispatchEvent).mockClear();

    const revoked = await request(app).delete(`/partners/${partner.id}/programs/${programId}`).set(admin);
    expect(revoked.status).toBe(200);
    await settle();
    expect(
      dispatched('coupon.deactivated')
        .map((p) => [p.couponId, p.source])
        .sort(),
    ).toEqual(
      [
        [a.body.id, 'grant_revoked'],
        [c.body.id, 'grant_revoked'],
      ].sort(),
    );
  });

  it("reports the program's rule and customer discount", async () => {
    const reward = { type: 'percent_off', value: 15, duration: 'once' };
    const programId = await seedProgram(false, {
      commissionRule: JSON.stringify([
        { trigger: 'first', eventType: 'signup', type: 'fixed', value: 25, currency: 'USD' },
        { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 20, recurring: true, recurringMonths: 12 },
      ]),
      customerReward: JSON.stringify(reward),
    });
    const partner = await seedPartner();
    expect((await request(app).post(`/partners/${partner.id}/coupons`).set(admin).send({ programId, code: 'WORTH20' })).status).toBe(201);
    await settle();

    const [payload] = dispatched('coupon.registered');
    expect(payload!.customerReward).toEqual(reward);
    expect(payload!.commission).toEqual({
      source: 'program',
      summary: expect.any(String),
      rules: [
        { trigger: 'first', eventType: 'signup', type: 'fixed', value: 25, currency: 'USD' },
        { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 20, recurring: true, recurringMonths: 12 },
      ],
    });
    const summary = (payload!.commission as { summary: string }).summary;
    expect(summary).toContain('$25');
    expect(summary).toContain('20%');
  });

  it('a partner created with their own rate on the program reports that rate, not the program rule', async () => {
    // POST /partners mints the default code before it writes the partner's
    // terms, so this only holds because the terms are read after commit.
    const programId = await seedProgram(false);
    const created = await request(app)
      .post('/partners')
      .set(admin)
      .send({
        email: 'vip@x.test',
        name: 'VIP',
        programIds: [programId],
        sendInvite: false,
        programCommissions: [{ programId, commissionType: 'percent', commissionValue: 30, recurring: true }],
      });
    expect(created.status).toBe(201);
    await settle();

    expect(dispatched('coupon.registered').map((p) => p.commission)).toEqual([
      {
        source: 'partner_program',
        summary: expect.stringContaining('30%'),
        rules: [{ trigger: 'every', type: 'percent', value: 30, recurring: true }],
      },
    ]);
  });

  it("a partner-wide override applies when there are no terms for the program", async () => {
    const programId = await seedProgram(false);
    const partner = await seedPartner();
    await db(TABLES.PartnerCommission).insert({
      id: `pcm_${ulid()}`,
      tenantId: DEFAULT_TENANT_ID,
      partnerId: partner.id,
      programId: null,
      commissionType: 'fixed',
      commissionValue: '40.00',
      recurring: false,
      source: 'amendment',
    });
    expect((await request(app).post(`/partners/${partner.id}/coupons`).set(admin).send({ programId, code: 'WIDE40' })).status).toBe(201);
    await settle();

    expect(dispatched('coupon.registered').map((p) => p.commission)).toEqual([
      { source: 'partner', summary: expect.stringContaining('40'), rules: [{ trigger: 'every', type: 'fixed', value: 40, recurring: false }] },
    ]);
  });
});
