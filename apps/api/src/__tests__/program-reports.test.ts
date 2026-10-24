/**
 * Per-program reporting: GET /admin/overview?programId= and
 * GET /programs/stats (apps/api/src/reporting.ts).
 *
 *   - The filter scopes totals and the partner ranking to one program.
 *     A bonus's commission belongs to Bonus.programId; a bonus with no
 *     program counts toward the tenant only.
 *   - A program's partners are those enrolled in it plus anyone active in
 *     it during the window, so a partner removed after earning still shows.
 *   - Another tenant's rows never count, including rows that (wrongly)
 *     carry this tenant's program id: every query names tenantId, and this
 *     suite's pool bypasses RLS.
 *   - Amounts stay per currency.
 *   - Each program's stats match the overview filtered to it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_admin_key_program_reports_0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const OTHER_TENANT_ID = 'program-reports-test-tenant-b';
const TENANTS = [DEFAULT_TENANT_ID, OTHER_TENANT_ID];
const DAY = 24 * 60 * 60 * 1000;

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Bonus,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Click,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.Partner,
];

let defaultCurrencyBefore: string | null = null;

async function cleanup(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).whereIn('tenantId', TENANTS).del();
}

beforeAll(async () => {
  if (skipIntegration) return;
  const row = (await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first('defaultCurrency')) as
    | { defaultCurrency: string | null }
    | undefined;
  defaultCurrencyBefore = row?.defaultCurrency ?? null;
  await db(TABLES.Tenant)
    .insert({ id: OTHER_TENANT_ID, slug: 'program-reports-b', displayName: 'B', status: 'active' })
    .onConflict('id')
    .ignore();
});

afterAll(async () => {
  if (!skipIntegration) {
    await cleanup();
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ defaultCurrency: defaultCurrencyBefore });
    await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  await cleanup();
  await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ defaultCurrency: 'USD' });
});

function admin(path: string) {
  return request(app).get(path).set('Authorization', `Bearer ${ADMIN_KEY}`);
}

async function createProgram(name: string, tenantId: string = DEFAULT_TENANT_ID, createdAt = new Date()): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId,
    name,
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 10 },
    destinationUrl: 'https://example.com',
    createdAt,
  });
  return id;
}

async function createPartner(name: string, tenantId: string = DEFAULT_TENANT_ID): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({ id, tenantId, email: `${id.toLowerCase()}@example.com`, name });
  return id;
}

async function enroll(partnerId: string, programId: string, tenantId: string = DEFAULT_TENANT_ID) {
  await db(TABLES.PartnerProgram).insert({ id: `pc_${ulid()}`, tenantId, partnerId, programId, source: 'admin' });
}

/** One click → event → attribution → commission chain. */
async function sale(opts: {
  tenantId?: string;
  partnerId: string;
  programId: string;
  revenue: number;
  commission: number;
  currency?: string;
  status?: 'accrued' | 'approved' | 'paid' | 'reversed';
  at?: Date;
}) {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const currency = opts.currency ?? 'USD';
  const at = opts.at ?? new Date();
  const clickId = ulid();
  const eventId = ulid();
  const attributionId = ulid();
  await db(TABLES.Click).insert({
    id: clickId, tenantId, linkId: null, partnerId: opts.partnerId, programId: opts.programId,
    landingUrl: 'https://example.com/l', ipHash: 'h', ts: at,
  });
  await db(TABLES.Event).insert({
    id: eventId, tenantId, userId: `u-${eventId}`, type: 'invoice_paid',
    value: opts.revenue.toFixed(2), currency, ts: at,
  });
  await db(TABLES.Attribution).insert({
    id: attributionId, tenantId, eventId, partnerId: opts.partnerId, programId: opts.programId,
    clickId, model: 'last_click', weight: '1', computedAt: at,
  });
  await db(TABLES.Commission).insert({
    id: ulid(), tenantId, attributionId, partnerId: opts.partnerId,
    amount: opts.commission.toFixed(2), currency, status: opts.status ?? 'accrued', accruedAt: at,
  });
}

async function click(partnerId: string, programId: string, tenantId: string = DEFAULT_TENANT_ID) {
  await db(TABLES.Click).insert({
    id: ulid(), tenantId, linkId: null, partnerId, programId, landingUrl: 'https://example.com/l', ipHash: 'h',
  });
}

/** A bonus and its commission (no attribution). */
async function bonus(opts: {
  tenantId?: string;
  partnerId: string;
  programId: string | null;
  amount: number;
  currency?: string;
  status?: 'accrued' | 'approved' | 'paid' | 'reversed';
}) {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const currency = opts.currency ?? 'USD';
  const bonusId = ulid();
  await db(TABLES.Bonus).insert({
    id: bonusId, tenantId, partnerId: opts.partnerId, programId: opts.programId,
    amount: opts.amount.toFixed(2), currency, source: 'manual',
  });
  await db(TABLES.Commission).insert({
    id: ulid(), tenantId, attributionId: null, bonusId, partnerId: opts.partnerId,
    amount: opts.amount.toFixed(2), currency, status: opts.status ?? 'accrued',
  });
}

interface OverviewPartner {
  id: string;
  clicks: number;
  revenue: number;
  revenueByCurrency: Record<string, number>;
  events: number;
  commission: Record<string, number>;
  commissionByCurrency: Record<string, Record<string, number>>;
}

/**
 * India and US programs in this tenant:
 *   riya    — India only: 2 sales (one approved), 1 India bonus
 *   sam     — US only: 1 sale, 1 US bonus
 *   both    — both: a sale in each, plus a bonus with no program
 *   gone    — removed from India after a sale in it (no grant)
 *   idle    — enrolled in India, no activity
 */
async function seedTwoPrograms() {
  const india = await createProgram('India', DEFAULT_TENANT_ID, new Date(Date.now() - 2 * DAY));
  const us = await createProgram('US', DEFAULT_TENANT_ID, new Date(Date.now() - DAY));
  const riya = await createPartner('Riya');
  const sam = await createPartner('Sam');
  const both = await createPartner('Both');
  const gone = await createPartner('Gone');
  const idle = await createPartner('Idle');
  await enroll(riya, india);
  await enroll(sam, us);
  await enroll(both, india);
  await enroll(both, us);
  await enroll(idle, india);

  await sale({ partnerId: riya, programId: india, revenue: 100, commission: 10 });
  await sale({ partnerId: riya, programId: india, revenue: 50, commission: 5, status: 'approved' });
  await bonus({ partnerId: riya, programId: india, amount: 25 });
  await sale({ partnerId: sam, programId: us, revenue: 400, commission: 40, status: 'paid' });
  await bonus({ partnerId: sam, programId: us, amount: 7 });
  await sale({ partnerId: both, programId: india, revenue: 30, commission: 3 });
  await sale({ partnerId: both, programId: us, revenue: 70, commission: 7 });
  await bonus({ partnerId: both, programId: null, amount: 1000 });
  await sale({ partnerId: gone, programId: india, revenue: 20, commission: 2 });
  await click(riya, india);
  return { india, us, riya, sam, both, gone, idle };
}

describe.skipIf(skipIntegration)('GET /admin/overview?programId=', () => {
  it('scopes totals to the program, bonuses by Bonus.programId', async () => {
    const { india, us } = await seedTwoPrograms();

    const res = await admin(`/admin/overview?programId=${india}`);
    expect(res.status).toBe(200);
    expect(res.body.programId).toBe(india);
    expect(res.body.totals).toEqual({
      partners: 4, // riya, both, idle (enrolled) + gone (active, no grant)
      clicks: 5, // four sales + one bare click
      currency: 'USD',
      attributedRevenue: 200,
      attributedRevenueByCurrency: { USD: 200 },
      attributedEvents: 4,
      // 10 + 3 + 2 from sales, + 25 India bonus; the program-less 1000 is out.
      commissionAccrued: 40,
      commissionApproved: 5,
      commissionPaid: 0,
      commissionByCurrency: { USD: { accrued: 40, approved: 5 } },
    });

    const usRes = await admin(`/admin/overview?programId=${us}`);
    expect(usRes.body.totals).toMatchObject({
      partners: 2,
      clicks: 2,
      attributedRevenueByCurrency: { USD: 470 },
      attributedEvents: 2,
      commissionByCurrency: { USD: { accrued: 14, paid: 40 } },
    });

    // Unfiltered: everything, the program-less bonus included.
    const all = await admin('/admin/overview');
    expect(all.body.programId).toBeNull();
    expect(all.body.totals).toMatchObject({
      partners: 5,
      clicks: 7,
      attributedRevenueByCurrency: { USD: 670 },
      commissionByCurrency: { USD: { accrued: 1054, approved: 5, paid: 40 } },
    });
  });

  it("ranks the program's partners only, with in-program amounts", async () => {
    const { india, riya, both, gone, idle } = await seedTwoPrograms();
    const res = await admin(`/admin/overview?programId=${india}&sort=commission`);
    expect(res.status).toBe(200);
    const rows = res.body.partners as OverviewPartner[];
    expect(rows.map((r) => r.id)).toEqual([riya, both, gone, idle]);

    const [r, b, g, i] = rows;
    expect(r).toMatchObject({
      clicks: 3,
      revenue: 150,
      events: 2,
      commission: { accrued: 35, approved: 5, paid: 0, reversed: 0 },
      commissionByCurrency: { USD: { accrued: 35, approved: 5 } },
    });
    // Both's US sale and program-less bonus stay out of the India view.
    expect(b).toMatchObject({
      clicks: 1,
      revenue: 30,
      revenueByCurrency: { USD: 30 },
      events: 1,
      commission: { accrued: 3, approved: 0, paid: 0, reversed: 0 },
      commissionByCurrency: { USD: { accrued: 3 } },
    });
    expect(g).toMatchObject({ revenue: 20, commission: { accrued: 2, approved: 0, paid: 0, reversed: 0 } });
    expect(i).toMatchObject({ clicks: 0, revenue: 0, events: 0, revenueByCurrency: {}, commissionByCurrency: {} });
  });

  it('pages the program ranking with the cursor', async () => {
    const { india, riya, both, gone, idle } = await seedTwoPrograms();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ programId: india, sort: 'revenue', limit: '1' });
      if (cursor) qs.set('cursor', cursor);
      const res = await admin(`/admin/overview?${qs}`);
      expect(res.status).toBe(200);
      expect(res.body.totals.partners).toBe(4);
      seen.push(...(res.body.partners as OverviewPartner[]).map((p) => p.id));
      cursor = res.body.nextCursor;
      expect(++pages).toBeLessThan(10);
    } while (cursor);
    expect(seen).toEqual([riya, both, gone, idle]);
  });

  it('still counts the partners when a cursor lands past the end', async () => {
    const { india } = await seedTwoPrograms();
    // A cursor below every row, as one minted before the rows moved can be.
    const cursor = Buffer.from(JSON.stringify({ s: 'revenue', v: '-1', id: '0' })).toString('base64url');
    const res = await admin(`/admin/overview?programId=${india}&cursor=${cursor}`);
    expect(res.status).toBe(200);
    expect(res.body.partners).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.totals.partners).toBe(4);
  });

  it("404s a program that isn't this tenant's", async () => {
    const otherProgram = await createProgram('Elsewhere', OTHER_TENANT_ID);
    for (const id of [otherProgram, 'nope']) {
      const res = await admin(`/admin/overview?programId=${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('program_not_found');
    }
    expect((await admin('/admin/overview?programId=')).status).toBe(400);
  });

  it("never counts another tenant's rows, even ones carrying this tenant's program id", async () => {
    const { india } = await seedTwoPrograms();
    const before = (await admin(`/admin/overview?programId=${india}`)).body;
    const beforeStats = (await admin('/programs/stats')).body;

    // Tenant B: its own program, and rows that point at India's id.
    const otherProgram = await createProgram('B program', OTHER_TENANT_ID);
    const intruder = await createPartner('Intruder', OTHER_TENANT_ID);
    await enroll(intruder, india, OTHER_TENANT_ID);
    await enroll(intruder, otherProgram, OTHER_TENANT_ID);
    for (const programId of [india, otherProgram]) {
      await sale({ tenantId: OTHER_TENANT_ID, partnerId: intruder, programId, revenue: 9999, commission: 999, currency: 'INR' });
      await bonus({ tenantId: OTHER_TENANT_ID, partnerId: intruder, programId, amount: 99 });
    }

    const after = (await admin(`/admin/overview?programId=${india}`)).body;
    expect(after.totals).toEqual(before.totals);
    expect(after.partners).toEqual(before.partners);
    expect((await admin('/programs/stats')).body).toEqual({
      ...beforeStats,
      since: expect.any(String),
      until: expect.any(String),
    });
  });

  it('keeps currencies apart in totals and rows', async () => {
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ defaultCurrency: 'INR' });
    const india = await createProgram('India');
    const riya = await createPartner('Riya');
    await enroll(riya, india);
    await sale({ partnerId: riya, programId: india, revenue: 1000, commission: 100, currency: 'INR' });
    await sale({ partnerId: riya, programId: india, revenue: 12, commission: 1.2, currency: 'USD' });
    await bonus({ partnerId: riya, programId: india, amount: 50, currency: 'INR', status: 'approved' });
    await bonus({ partnerId: riya, programId: india, amount: 3, currency: 'EUR' });

    const res = await admin(`/admin/overview?programId=${india}`);
    expect(res.body.totals).toMatchObject({
      currency: 'INR',
      attributedRevenue: 1000,
      attributedRevenueByCurrency: { INR: 1000, USD: 12 },
      commissionAccrued: 100,
      commissionApproved: 50,
      commissionByCurrency: { INR: { accrued: 100, approved: 50 }, USD: { accrued: 1.2 }, EUR: { accrued: 3 } },
    });
    const [row] = res.body.partners as OverviewPartner[];
    // The scalar `revenue` ranks in the default currency only.
    expect(row).toMatchObject({
      revenue: 1000,
      revenueByCurrency: { INR: 1000, USD: 12 },
      commission: { accrued: 100, approved: 50, paid: 0, reversed: 0 },
      commissionByCurrency: { INR: { accrued: 100, approved: 50 }, USD: { accrued: 1.2 }, EUR: { accrued: 3 } },
    });

    const stats = (await admin('/programs/stats')).body;
    expect(stats.currency).toBe('INR');
    expect(stats.programs[0]).toMatchObject({
      attributedRevenueByCurrency: { INR: 1000, USD: 12 },
      commissionByCurrency: { INR: { accrued: 100, approved: 50 }, USD: { accrued: 1.2 }, EUR: { accrued: 3 } },
    });
  });
});

describe.skipIf(skipIntegration)('GET /programs/stats', () => {
  it("lists every program, newest first, matching the overview filtered to it", async () => {
    const { india, us } = await seedTwoPrograms();
    const quiet = await createProgram('Quiet');

    const res = await admin('/programs/stats');
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('USD');
    expect(new Date(res.body.until).getTime() - new Date(res.body.since).getTime()).toBe(30 * DAY);
    const programs = res.body.programs as Array<Record<string, unknown>>;
    expect(programs.map((p) => p.programId)).toEqual([quiet, us, india]);
    expect(programs[0]).toEqual({
      programId: quiet,
      name: 'Quiet',
      partners: 0,
      clicks: 0,
      attributedEvents: 0,
      attributedRevenueByCurrency: {},
      commissionByCurrency: {},
    });

    for (const programId of [india, us]) {
      const { totals } = (await admin(`/admin/overview?programId=${programId}`)).body;
      expect(programs.find((p) => p.programId === programId)).toEqual({
        programId,
        name: programId === india ? 'India' : 'US',
        partners: totals.partners,
        clicks: totals.clicks,
        attributedEvents: totals.attributedEvents,
        attributedRevenueByCurrency: totals.attributedRevenueByCurrency,
        commissionByCurrency: totals.commissionByCurrency,
      });
    }
  });

  it('counts only activity inside [since, until)', async () => {
    const india = await createProgram('India');
    const riya = await createPartner('Riya');
    const old = new Date(Date.now() - 45 * DAY);
    await sale({ partnerId: riya, programId: india, revenue: 80, commission: 8, at: old });
    await sale({ partnerId: riya, programId: india, revenue: 20, commission: 2 });

    const recent = (await admin('/programs/stats')).body.programs[0];
    expect(recent).toMatchObject({ partners: 1, clicks: 1, attributedEvents: 1, attributedRevenueByCurrency: { USD: 20 } });

    const qs = new URLSearchParams({
      since: new Date(old.getTime() - DAY).toISOString(),
      until: new Date(old.getTime() + DAY).toISOString(),
    });
    const then = (await admin(`/programs/stats?${qs}`)).body.programs[0];
    expect(then).toMatchObject({
      partners: 1, // active in the window; not enrolled
      clicks: 1,
      attributedEvents: 1,
      attributedRevenueByCurrency: { USD: 80 },
      commissionByCurrency: { USD: { accrued: 8 } },
    });
  });

  it('rejects a bad window, and is admin-only', async () => {
    const now = new Date().toISOString();
    const inverted = await admin(`/programs/stats?since=${now}&until=${new Date(Date.now() - DAY).toISOString()}`);
    expect(inverted.status).toBe(400);
    expect(inverted.body.error).toBe('invalid_window');
    const garbage = await admin('/programs/stats?since=yesterday');
    expect(garbage.status).toBe(400);
    expect(garbage.body.error).toBe('invalid_query');
    // As before zod 4: a timestamp without seconds is still a timestamp.
    expect((await admin('/programs/stats?since=2026-10-01T10:00Z')).status).toBe(200);
    expect((await request(app).get('/programs/stats')).status).toBe(401);
  });
});
