/**
 * Program-scoped partner commission terms (PartnerCommission.programId).
 *
 * A partner's terms used to be one row per partner, so an override set for
 * one program priced every program the partner was in. Now a row with a
 * programId applies to that program only, and every reader resolves
 * program-specific → partner-wide → Program rule:
 *
 *   - accrual (attribution.ts resolveCommissionRule) — whole-row precedence
 *   - holdback, in the auto-approve job, the review queue and manual
 *     approve — first non-null holdbackDays in the same order
 *
 * Also covers the endpoints, POST /partners scoping (the Network approval
 * path), the backfill, and RLS on the reshaped table.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import type { Knex } from 'knex';
import { DEFAULT_TENANT_ID, TABLES, type EventRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_program_scope_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { attributeEvent } = await import('../attribution.js');
const { autoApproveMatureCommissions } = await import('../commission-auto-approve.js');
const { backfillCommissionSnapshots } = await import('../backfill-commission-snapshots.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const T = DEFAULT_TENANT_ID;
const DAY_MS = 24 * 60 * 60 * 1000;

const TABLES_TO_CLEAN = [
  TABLES.PartnerCommission,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.Partner,
];

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) await db(t).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
});

// -------- seed helpers --------

async function program(opts: { percent: number; holdbackDays?: number | null; tenantId?: string }): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId: opts.tenantId ?? T,
    name: `Program ${opts.percent}%`,
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: opts.percent }]),
    destinationUrl: 'https://example.com',
    holdbackDays: opts.holdbackDays ?? null,
  });
  return id;
}

async function partner(tenantId: string = T): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({ id, tenantId, name: 'P', email: `p-${id}@x.test` });
  return id;
}

async function grant(partnerId: string, programId: string): Promise<void> {
  await db(TABLES.PartnerProgram).insert({ id: `pc_${ulid()}`, tenantId: T, partnerId, programId, source: 'admin' });
}

/** A PartnerCommission row. `percent` writes the rules array; `legacyPercent`
 *  writes only the pre-compound single-rule columns. */
async function terms(
  partnerId: string,
  programId: string | null,
  opts: { percent?: number; legacyPercent?: number; holdbackDays?: number | null; tenantId?: string },
): Promise<string> {
  const id = `pcm_${ulid()}`;
  const value = opts.percent ?? opts.legacyPercent ?? 0;
  await db(TABLES.PartnerCommission).insert({
    id,
    partnerId,
    tenantId: opts.tenantId ?? T,
    programId,
    commissionType: 'percent',
    commissionValue: value.toFixed(4),
    recurring: false,
    commissionRules:
      opts.percent != null ? JSON.stringify([{ trigger: 'every', type: 'percent', value: opts.percent }]) : null,
    holdbackDays: opts.holdbackDays ?? null,
    source: 'amendment',
  });
  return id;
}

/** Link → click → identity → $100 invoice_paid for a fresh user, attributed
 *  to `partnerId` on `programId`. Returns the attribution id. */
async function convert(partnerId: string, programId: string): Promise<string> {
  const linkId = ulid();
  const clickId = ulid();
  const eventId = ulid();
  const userId = `u-${eventId}`;
  await db(TABLES.Link).insert({ id: linkId, tenantId: T, partnerId, programId, linkKey: `lk-${linkId}`, destinationUrl: 'https://example.com' });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: T,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://example.com/l',
    ts: new Date(Date.now() - 60_000),
  });
  await db(TABLES.Identity).insert({ id: ulid(), tenantId: T, clickId, userId });
  await db(TABLES.Event).insert({
    id: eventId,
    tenantId: T,
    userId,
    type: 'invoice_paid',
    value: '100.00',
    currency: 'USD',
    externalEventId: `evt_${eventId}`,
    metadata: {},
    ts: new Date(),
  });
  const event = (await db(TABLES.Event).where({ id: eventId }).first()) as EventRow;
  const result = await attributeEvent(db, event);
  expect(result.status).toBe('attributed');
  return result.touches![0]!.attributionId;
}

/** Commission accrued on a $100 conversion. */
async function accrueOn(partnerId: string, programId: string): Promise<number> {
  const attributionId = await convert(partnerId, programId);
  const rows = (await db(TABLES.Commission).where({ attributionId })) as Array<{ amount: string }>;
  return rows.reduce((sum, r) => sum + Number(r.amount), 0);
}

/** An accrued commission on `programId`, `daysAgo` old. */
async function accruedCommission(partnerId: string, programId: string, daysAgo: number): Promise<string> {
  const attributionId = await convert(partnerId, programId);
  const row = (await db(TABLES.Commission).where({ attributionId }).first()) as { id: string };
  await db(TABLES.Commission).where({ id: row.id }).update({ accruedAt: new Date(Date.now() - daysAgo * DAY_MS) });
  return row.id;
}

async function statusOf(id: string): Promise<string> {
  return ((await db(TABLES.Commission).where({ id }).first()) as { status: string }).status;
}

function admin(method: 'get' | 'put' | 'post' | 'delete', path: string) {
  return request(app)[method](path).set('Authorization', `Bearer ${ADMIN_KEY}`);
}

async function rowsFor(partnerId: string) {
  return (await db(TABLES.PartnerCommission).where({ partnerId })) as Array<{
    id: string;
    programId: string | null;
    commissionValue: string;
    holdbackDays: number | null;
    source: string;
    commissionRules: unknown;
  }>;
}

// -------- accrual --------

describe.skipIf(skipIntegration)('accrual precedence: program-specific → partner-wide → program rule', () => {
  it('each tier takes over from the one below it, on its own program only', async () => {
    const a = await program({ percent: 10 });
    const b = await program({ percent: 10 });
    const p = await partner();

    expect(await accrueOn(p, a)).toBe(10); // program rule
    await terms(p, null, { percent: 30 });
    expect(await accrueOn(p, a)).toBe(30); // partner-wide
    await terms(p, a, { percent: 50 });
    expect(await accrueOn(p, a)).toBe(50); // program-specific
    expect(await accrueOn(p, b)).toBe(30); // b has no terms of its own
  });

  it("a program-scoped row alone leaves the partner's other programs on their own rules", async () => {
    // The over-grant bug in miniature: terms agreed for one program must
    // not price a program granted later.
    const a = await program({ percent: 10 });
    const b = await program({ percent: 15 });
    const p = await partner();
    await terms(p, a, { percent: 50 });

    expect(await accrueOn(p, a)).toBe(50);
    expect(await accrueOn(p, b)).toBe(15);
  });

  it("whole-row precedence: a program row's legacy columns win over partner-wide rules", async () => {
    const a = await program({ percent: 10 });
    const p = await partner();
    await terms(p, null, { percent: 30 });
    await terms(p, a, { legacyPercent: 40 }); // no rules array

    expect(await accrueOn(p, a)).toBe(40);
  });

  it("another partner's program terms never apply", async () => {
    const a = await program({ percent: 10 });
    const vip = await partner();
    const other = await partner();
    await terms(vip, a, { percent: 50 });

    expect(await accrueOn(other, a)).toBe(10);
  });
});

// -------- holdback --------

describe.skipIf(skipIntegration)('holdback precedence', () => {
  /**
   * Programs a, b, c all hold back 30 days. Commissions are 20 days old.
   *   p: partner-wide 10d; a scoped 60d; c scoped with holdback unset
   *   q: no partner-wide; a scoped 5d
   */
  async function setup() {
    const a = await program({ percent: 10, holdbackDays: 30 });
    const b = await program({ percent: 10, holdbackDays: 30 });
    const c = await program({ percent: 10, holdbackDays: 30 });
    const p = await partner();
    const q = await partner();
    await terms(p, null, { percent: 20, holdbackDays: 10 });
    await terms(p, a, { percent: 20, holdbackDays: 60 });
    await terms(p, c, { percent: 20, holdbackDays: null });
    await terms(q, a, { percent: 20, holdbackDays: 5 });
    return {
      pa: await accruedCommission(p, a, 20), // 60 → not yet
      pb: await accruedCommission(p, b, 20), // partner-wide 10 → mature
      pc: await accruedCommission(p, c, 20), // unset → partner-wide 10 → mature
      qa: await accruedCommission(q, a, 20), // 5 → mature
      qb: await accruedCommission(q, b, 20), // program 30 → not yet
    };
  }

  it('auto-approve takes the first holdback set: program-scoped, partner-wide, program', async () => {
    const c = await setup();
    const res = await autoApproveMatureCommissions(db, T);

    expect(res.approved.map((r) => r.id).sort()).toEqual([c.pb, c.pc, c.qa].sort());
    expect(await statusOf(c.pa)).toBe('accrued');
    expect(await statusOf(c.qb)).toBe('accrued');
  });

  it('the review queue and manual approve read the same effective holdback', async () => {
    const c = await setup();
    const list = await admin('get', '/commissions');
    expect(list.status).toBe(200);
    const holdback = Object.fromEntries(
      (list.body.commissions as Array<{ id: string; holdbackDays: number | null }>).map((r) => [r.id, r.holdbackDays]),
    );
    expect(holdback).toEqual({ [c.pa]: 60, [c.pb]: 10, [c.pc]: 10, [c.qa]: 5, [c.qb]: 30 });

    const early = await admin('post', `/commissions/${c.pa}/approve`);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ error: 'holdback_active', holdbackDays: 60 });
    expect((await admin('post', `/commissions/${c.pb}/approve`)).status).toBe(200);
    expect((await admin('post', `/commissions/${c.qa}/approve`)).status).toBe(200);
    expect((await admin('post', `/commissions/${c.qb}/approve`)).status).toBe(409);
  });
});

// -------- endpoints --------

describe.skipIf(skipIntegration)('program-scoped terms endpoints', () => {
  const body = (value: number, holdbackDays: number | null = null) => ({
    commissionType: 'percent',
    commissionValue: value,
    holdbackDays,
    commissionRules: [{ trigger: 'every', type: 'percent', value }],
  });

  it('PUT/GET/DELETE address one program; the partner-wide endpoints see only the partner-wide row', async () => {
    const a = await program({ percent: 10 });
    const b = await program({ percent: 10 });
    const p = await partner();
    await grant(p, a);

    const put = await admin('put', `/partners/${p}/programs/${a}/commission`).send(body(40, 5));
    expect(put.status).toBe(200);
    expect(put.body.snapshot).toMatchObject({ partnerId: p, programId: a, source: 'amendment', holdbackDays: 5 });
    expect((await admin('get', `/partners/${p}/commission-snapshot`)).body.snapshot).toBeNull();

    const wide = await admin('put', `/partners/${p}/commission-snapshot`).send(body(30));
    expect(wide.body.snapshot).toMatchObject({ programId: null, commissionValue: '30.0000' });
    expect((await admin('get', `/partners/${p}/programs/${a}/commission`)).body.snapshot.commissionValue).toBe('40.0000');

    // A second PUT replaces the terms in place: same row, same id.
    const again = await admin('put', `/partners/${p}/programs/${a}/commission`).send(body(45));
    expect(again.body.snapshot.id).toBe(put.body.snapshot.id);
    expect(again.body.snapshot).toMatchObject({ commissionValue: '45.0000', holdbackDays: null });
    expect(await rowsFor(p)).toHaveLength(2);

    // The grants list carries each program's scoped terms for the portal.
    const programs = (await admin('get', `/partners/${p}/programs`)).body.programs as Array<{
      id: string;
      commission: { commissionValue: string } | null;
      commissionRule: unknown;
    }>;
    expect(programs.find((x) => x.id === a)!.commission!.commissionValue).toBe('45.0000');
    expect(programs.find((x) => x.id === b)!.commission).toBeNull();
    expect(programs.find((x) => x.id === b)!.commissionRule).toEqual([{ trigger: 'every', type: 'percent', value: 10 }]);

    // Each DELETE clears its own scope only.
    expect((await admin('delete', `/partners/${p}/programs/${a}/commission`)).status).toBe(200);
    expect((await admin('get', `/partners/${p}/programs/${a}/commission`)).body.snapshot).toBeNull();
    expect((await admin('get', `/partners/${p}/commission-snapshot`)).body.snapshot).not.toBeNull();
    await admin('put', `/partners/${p}/programs/${a}/commission`).send(body(40));
    expect((await admin('delete', `/partners/${p}/commission-snapshot`)).status).toBe(200);
    expect((await rowsFor(p)).map((r) => r.programId)).toEqual([a]);
  });

  it('404s an unknown partner or program', async () => {
    const a = await program({ percent: 10 });
    const p = await partner();
    const noProgram = await admin('put', `/partners/${p}/programs/nope/commission`).send(body(40));
    expect(noProgram.status).toBe(404);
    expect(noProgram.body.error).toBe('program_not_found');
    const noPartner = await admin('put', `/partners/nope/programs/${a}/commission`).send(body(40));
    expect(noPartner.status).toBe(404);
    expect(noPartner.body.error).toBe('partner_not_found');
    expect(await rowsFor(p)).toHaveLength(0);
  });

  it('rejects the same sub-rules the partner-wide PUT rejects', async () => {
    const a = await program({ percent: 10 });
    const p = await partner();
    const res = await admin('put', `/partners/${p}/programs/${a}/commission`).send({
      commissionType: 'fixed',
      commissionValue: 100,
      commissionRules: [{ trigger: 'first', type: 'fixed', value: 100 }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.detail)).toContain('first-trigger sub-rules require an eventType');
  });

  it('allows one row per scope: a second partner-wide or same-program row is refused', async () => {
    const a = await program({ percent: 10 });
    const p = await partner();
    await terms(p, null, { percent: 30 });
    await terms(p, a, { percent: 40 });
    await expect(terms(p, null, { percent: 31 })).rejects.toMatchObject({ code: '23505' });
    await expect(terms(p, a, { percent: 41 })).rejects.toMatchObject({ code: '23505' });
  });
});

// -------- POST /partners --------

describe.skipIf(skipIntegration)('POST /partners commission scoping', () => {
  const snapshot = {
    commissionType: 'percent',
    commissionValue: 25,
    holdbackDays: 14,
    commissionRules: [{ trigger: 'every', type: 'percent', value: 25 }],
  };
  const create = (extra: Record<string, unknown>) =>
    admin('post', '/partners').send({ email: `c-${ulid()}@x.test`, name: 'Creator', sendInvite: false, ...extra });

  it('a Network approval (one program + commissionSnapshot) stamps terms for that program only', async () => {
    const a = await program({ percent: 10 });
    const b = await program({ percent: 15 });
    // The body the Network's approve flow sends (openpartner-network
    // createPartnerOnVendor): both program keys, offering grant source.
    const res = await create({
      metadata: { source: 'openpartner_network', networkCreatorId: 'crt_test' },
      programIds: [a],
      campaignIds: [a],
      campaignGrantSource: 'offering',
      commissionSnapshot: snapshot,
    });
    expect(res.status).toBe(201);
    const p = res.body.id as string;
    expect(await rowsFor(p)).toMatchObject([{ programId: a, source: 'approval', holdbackDays: 14 }]);

    // Granted a second program later, the creator earns that program's
    // rate, not the offering's.
    expect((await admin('post', `/partners/${p}/programs`).send({ programIds: [b] })).status).toBe(201);
    expect(await accrueOn(p, a)).toBe(25);
    expect(await accrueOn(p, b)).toBe(15);
  });

  it('the legacy campaignIds alias alone scopes the snapshot too', async () => {
    const a = await program({ percent: 10 });
    const res = await create({ campaignIds: [a], commissionSnapshot: { commissionType: 'fixed', commissionValue: 50 } });
    expect(res.status).toBe(201);
    expect(await rowsFor(res.body.id)).toMatchObject([{ programId: a, commissionValue: '50.0000', commissionRules: null }]);
  });

  it('several programs, or none (= all), keeps the snapshot partner-wide', async () => {
    const a = await program({ percent: 10 });
    const b = await program({ percent: 10 });
    const several = await create({ programIds: [a, b], commissionSnapshot: snapshot });
    expect(await rowsFor(several.body.id)).toMatchObject([{ programId: null }]);
    const all = await create({ commissionSnapshot: snapshot });
    expect(await rowsFor(all.body.id)).toMatchObject([{ programId: null }]);
    // Duplicates of one id still name one program.
    const dup = await create({ programIds: [a, a], commissionSnapshot: snapshot });
    expect(await rowsFor(dup.body.id)).toMatchObject([{ programId: a }]);
  });

  it('programCommissions stamps per-program terms at creation', async () => {
    const a = await program({ percent: 10 });
    const b = await program({ percent: 15 });
    const res = await create({
      programIds: [a, b],
      commissionSnapshot: snapshot,
      programCommissions: [{ programId: a, commissionType: 'fixed', commissionValue: 75, holdbackDays: 3 }],
    });
    expect(res.status).toBe(201);
    const rows = await rowsFor(res.body.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.programId === a)).toMatchObject({ commissionValue: '75.0000', holdbackDays: 3, source: 'amendment' });
    expect(rows.find((r) => r.programId === null)).toMatchObject({ commissionValue: '25.0000', source: 'approval' });
  });

  it('refuses programCommissions for a program it does not grant, before creating anything', async () => {
    const a = await program({ percent: 10 });
    const b = await program({ percent: 10 });
    const email = `c-${ulid()}@x.test`;
    const res = await admin('post', '/partners').send({
      email,
      name: 'Creator',
      sendInvite: false,
      programIds: [a],
      programCommissions: [{ programId: b, commissionType: 'percent', commissionValue: 50 }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'program_commission_not_granted', programId: b });
    expect(await db(TABLES.Partner).where({ email }).first()).toBeUndefined();
  });

  it('refuses two sets of terms for one program', async () => {
    const a = await program({ percent: 10 });
    const b = await program({ percent: 10 });
    const withSnapshot = await create({
      programIds: [a],
      commissionSnapshot: snapshot,
      programCommissions: [{ programId: a, commissionType: 'percent', commissionValue: 50 }],
    });
    expect(withSnapshot.status).toBe(400);
    expect(withSnapshot.body.error).toBe('duplicate_program_commission');
    const twice = await create({
      programIds: [a, b],
      programCommissions: [
        { programId: a, commissionType: 'percent', commissionValue: 50 },
        { programId: a, commissionType: 'percent', commissionValue: 60 },
      ],
    });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toBe('duplicate_program_commission');
  });
});

// -------- backfill --------

describe.skipIf(skipIntegration)('backfillCommissionSnapshots', () => {
  it("writes one program-scoped row per grant from that program's own rule", async () => {
    const a = await program({ percent: 10, holdbackDays: 7 });
    const b = await program({ percent: 15 });
    const p = await partner();
    await grant(p, a);
    await grant(p, b);

    const result = await backfillCommissionSnapshots(db, T);
    expect(result).toMatchObject({ scanned: 1, inserted: 2, coveredByPartnerWide: 0, alreadyHadSnapshot: 0 });
    const rows = await rowsFor(p);
    expect(rows.find((r) => r.programId === a)).toMatchObject({ source: 'backfill', holdbackDays: 7, commissionValue: '10.0000' });
    expect(rows.find((r) => r.programId === b)).toMatchObject({ source: 'backfill', holdbackDays: null, commissionValue: '15.0000' });

    // Frozen: editing the program afterwards doesn't re-price the partner.
    await db(TABLES.Program)
      .where({ id: a })
      .update({ commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 99 }]) });
    expect(await accrueOn(p, a)).toBe(10);
  });

  it('skips partners already priced partner-wide, grants that already have terms, and partners with no grants', async () => {
    const a = await program({ percent: 10 });
    const b = await program({ percent: 15 });
    const wide = await partner();
    await grant(wide, a);
    await grant(wide, b);
    await terms(wide, null, { percent: 30 });
    const half = await partner();
    await grant(half, a);
    await grant(half, b);
    await terms(half, a, { percent: 50 });
    await partner(); // no grants

    const result = await backfillCommissionSnapshots(db, T);
    expect(result).toEqual({
      scanned: 3,
      inserted: 1,
      coveredByPartnerWide: 1,
      alreadyHadSnapshot: 1,
      noGrants: 1,
      noCampaignRule: 0,
    });
    expect((await rowsFor(wide)).map((r) => r.programId)).toEqual([null]);
    expect((await rowsFor(half)).find((r) => r.programId === b)).toMatchObject({ source: 'backfill' });
    // The partner-wide partner still earns their override everywhere.
    expect(await accrueOn(wide, b)).toBe(30);

    expect((await backfillCommissionSnapshots(db, T)).inserted).toBe(0); // idempotent
  });
});

// -------- RLS --------

describe.skipIf(skipIntegration)('PartnerCommission RLS isolation', () => {
  const TENANT_A = `01TESTPCA${ulid().slice(9)}`;
  const TENANT_B = `01TESTPCB${ulid().slice(9)}`;
  let appRoleAvailable = false;

  beforeAll(async () => {
    const role = (await db.raw(
      `select 1 from pg_roles where rolname = 'openpartner_app' and rolcanlogin and not rolbypassrls`,
    )) as { rows: unknown[] };
    appRoleAvailable = role.rows.length > 0;
    await db(TABLES.Tenant).insert([
      { id: TENANT_A, slug: `pc-a-${TENANT_A.slice(-6).toLowerCase()}`, displayName: 'A', status: 'active' },
      { id: TENANT_B, slug: `pc-b-${TENANT_B.slice(-6).toLowerCase()}`, displayName: 'B', status: 'active' },
    ]);
  });

  afterAll(async () => {
    for (const t of TABLES_TO_CLEAN) await db(t).whereIn('tenantId', [TENANT_A, TENANT_B]).del();
    await db(TABLES.Tenant).whereIn('id', [TENANT_A, TENANT_B]).del();
  });

  // Seeded per test: the file-level beforeEach wipes these tables.
  let partnerA: string;
  beforeEach(async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      const prog = await program({ percent: 10, tenantId });
      const p = await partner(tenantId);
      await terms(p, null, { percent: 20, tenantId });
      await terms(p, prog, { percent: 30, tenantId });
      if (tenantId === TENANT_A) partnerA = p;
    }
  });

  /** Same SET ROLE dance as multi-tenant.test.ts: drop to the RLS-subject
   *  app role with the given GUCs for one transaction. */
  async function asAppRole<R>(
    gucs: { tenantId?: string; platformAdmin?: boolean },
    fn: (trx: Knex.Transaction) => Promise<R>,
  ): Promise<R> {
    return db.transaction(async (trx) => {
      await trx.raw(`set local row_security = on`);
      await trx.raw(`set local role openpartner_app`);
      if (gucs.tenantId) await trx.raw(`select set_config('app.tenant_id', ?, true)`, [gucs.tenantId]);
      if (gucs.platformAdmin) await trx.raw(`set local app.platform_admin = 'on'`);
      return fn(trx);
    });
  }

  const scopedTo = (rows: Array<{ tenantId: string }>, tenantId: string) =>
    rows.length > 0 && rows.every((r) => r.tenantId === tenantId);

  it('a tenant sees only its own rows, of both scopes', async () => {
    if (!appRoleAvailable) return;
    const rows = await asAppRole({ tenantId: TENANT_A }, (trx) =>
      trx(TABLES.PartnerCommission).select('tenantId', 'programId'),
    );
    expect(rows).toHaveLength(2);
    expect(scopedTo(rows, TENANT_A)).toBe(true);
    expect(rows.filter((r) => r.programId === null)).toHaveLength(1);
  });

  it('no GUC sees nothing; the platform_admin GUC sees both tenants', async () => {
    if (!appRoleAvailable) return;
    expect(await asAppRole({}, (trx) => trx(TABLES.PartnerCommission).select('id'))).toHaveLength(0);
    const all = await asAppRole({ platformAdmin: true }, (trx) =>
      trx(TABLES.PartnerCommission).whereIn('tenantId', [TENANT_A, TENANT_B]).select('tenantId'),
    );
    expect(all).toHaveLength(4);
  });

  it("WITH CHECK refuses a row stamped for another tenant, and B can't touch A's rows", async () => {
    if (!appRoleAvailable) return;
    await expect(
      asAppRole({ tenantId: TENANT_B }, (trx) =>
        trx(TABLES.PartnerCommission).insert({
          id: `pcm_${ulid()}`,
          partnerId: partnerA,
          tenantId: TENANT_A,
          programId: null,
          commissionType: 'percent',
          commissionValue: '99',
          recurring: false,
          source: 'amendment',
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);

    const touched = await asAppRole({ tenantId: TENANT_B }, async (trx) => ({
      updated: await trx(TABLES.PartnerCommission).where({ partnerId: partnerA }).update({ commissionValue: '99' }),
      deleted: await trx(TABLES.PartnerCommission).where({ partnerId: partnerA }).del(),
    }));
    expect(touched).toEqual({ updated: 0, deleted: 0 });
    expect(await rowsFor(partnerA)).toHaveLength(2);
  });
});
