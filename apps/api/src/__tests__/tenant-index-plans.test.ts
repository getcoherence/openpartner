/**
 * Hot paths name tenantId themselves instead of leaving tenant scope to RLS.
 *
 * RLS alone doesn't get a lookup onto a tenant-leading index. While a tenant
 * policy reads
 *   "tenantId" = app.tenant_id OR app.platform_admin = 'on'
 * Postgres can't use the index for the policy's half of the predicate, so a
 * lookup that leaves tenantId to RLS reads every tenant's rows: a seq scan
 * of Link per server-side click, of Partner and Event per hourly heartbeat,
 * of Commission per payout run. And under RLS Postgres never puts a
 * non-leakproof function like lower() into an index condition, whatever the
 * policy says. On a pool that bypasses RLS an unscoped query also reads
 * other tenants' rows.
 *
 * Each test captures the SQL a hot path actually runs and EXPLAINs it under
 * the RLS app role, asserting an index condition on tenantId (or another
 * index that answers the lookup alone). Each also checks the path stays in
 * its own tenant on this suite's pool, which bypasses RLS. Most of these
 * paths were scoped by #147; this file guards the plans as well.
 *
 * Skipped if DATABASE_URL isn't set. The plan assertions also need the
 * openpartner_app role.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_tenant_index_plans_0123456789abcd';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const { db, appDb } = await import('../db.js');
const { createApp } = await import('../app.js');
const { findCouponByCode } = await import('../routes/coupons.js');
const { drainOutbox, sendHeartbeat } = await import('../network-client.js');
const { runPayouts } = await import('../payouts.js');
const { encryptSecret } = await import('../crypto.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const OTHER_TENANT = '01J0000000INDEXPLANSOTHERTNT';
const TENANTS = [DEFAULT_TENANT_ID, OTHER_TENANT];

interface Statement {
  sql: string;
  bindings: unknown[];
}

let hasAppRole = false;
let network: Server | undefined;
let networkUrl = '';

async function cleanup(): Promise<void> {
  for (const t of [
    TABLES.NetworkOutbox,
    TABLES.Commission,
    TABLES.Bonus,
    TABLES.Attribution,
    TABLES.Event,
    TABLES.Click,
    TABLES.Link,
    TABLES.Coupon,
    TABLES.Payout,
    TABLES.PartnerProgram,
    TABLES.Partner,
    TABLES.Program,
  ]) {
    await db(t).whereIn('tenantId', TENANTS).del();
  }
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).del();
}

beforeAll(async () => {
  if (skipIntegration) return;
  const role = (await db.raw(`select 1 from pg_roles where rolname = 'openpartner_app'`)) as { rows: unknown[] };
  hasAppRole = role.rows.length > 0;
  await db(TABLES.Tenant)
    .insert({ id: OTHER_TENANT, slug: 'index-plans-other', displayName: 'Other', status: 'active', approvalStatus: 'approved' })
    .onConflict('id')
    .ignore();
  // Stands in for the Network: the heartbeat posts here.
  network = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
  await new Promise<void>((resolve) => network!.listen(0, '127.0.0.1', resolve));
  networkUrl = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (skipIntegration) return;
  await cleanup();
});

afterAll(async () => {
  if (!skipIntegration) {
    await cleanup();
    await db(TABLES.Tenant).where({ id: OTHER_TENANT }).del();
  }
  await new Promise((resolve) => (network ? network.close(resolve) : resolve(undefined)));
  await db.destroy();
  await appDb.destroy();
});

/** Every statement either pool runs while `fn` does. */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; statements: Statement[] }> {
  const statements: Statement[] = [];
  const listener = (q: { sql: string; bindings?: unknown[] }) => statements.push({ sql: q.sql, bindings: q.bindings ?? [] });
  db.on('query', listener);
  appDb.on('query', listener);
  try {
    return { result: await fn(), statements };
  } finally {
    db.off('query', listener);
    appDb.off('query', listener);
  }
}

function only(statements: Statement[], pattern: RegExp): Statement {
  const matching = statements.filter((s) => pattern.test(s.sql));
  expect(matching, `one statement matching ${pattern}`).toHaveLength(1);
  return matching[0]!;
}

/**
 * `stmt`'s plan under the RLS app role, or null without that role. Seq
 * scans are switched off: on tables this small one is always cheapest, so
 * with it off the planner shows which index the query can use at all. The
 * tables are analyzed first, so the plan reflects this test's rows rather
 * than whatever an earlier file left in the stats.
 */
async function plan(stmt: Statement): Promise<string[] | null> {
  if (!hasAppRole) return null;
  return db.transaction(async (trx) => {
    for (const m of stmt.sql.matchAll(/(?:from|join) "(\w+)"/gi)) await trx.raw('analyze ??', [m[1]!]);
    await trx.raw('set local row_security = on');
    await trx.raw('set local role openpartner_app');
    await trx.raw(`set local app.tenant_id = '${DEFAULT_TENANT_ID}'`);
    await trx.raw('set local enable_seqscan = off');
    const out = (await trx.raw(`explain ${stmt.sql.replace(/\$\d+/g, '?')}`, stmt.bindings as never)) as {
      rows: Array<{ 'QUERY PLAN': string }>;
    };
    return out.rows.map((r) => r['QUERY PLAN']);
  });
}

/** The plan's index conditions for `stmt`, or null without the app role. */
async function indexConds(stmt: Statement): Promise<string | null> {
  const lines = await plan(stmt);
  return lines && lines.filter((l) => l.includes('Index Cond')).join('\n');
}

/** Scans in `stmt`'s plan that read a table without an index condition: a
 *  seq scan, or an index walked end to end. Null without the app role. */
async function unconditionedScans(stmt: Statement): Promise<string[] | null> {
  const lines = await plan(stmt);
  if (!lines) return null;
  const loose: string[] = [];
  lines.forEach((line, i) => {
    const node = line.replace(/^\s*(->\s*)?/, '');
    if (node.startsWith('Seq Scan')) loose.push(node);
    if (!/^(Index Scan|Index Only Scan|Bitmap Index Scan)/.test(node)) return;
    // The node's own detail lines run until the next node.
    let j = i + 1;
    while (j < lines.length && !/^\s*->/.test(lines[j]!) && !lines[j]!.includes('Index Cond')) j++;
    if (j === lines.length || /^\s*->/.test(lines[j]!)) loose.push(node);
  });
  return loose;
}

/** `stmt` names tenantId, and under RLS an index condition covers one of
 *  `columns`: tenantId, unless another index can answer the lookup alone. */
async function expectIndexed(stmt: Statement, columns = ['"tenantId"']): Promise<void> {
  expect(stmt.sql).toMatch(/"tenantId" = /);
  const conds = await indexConds(stmt);
  if (conds === null) return;
  expect(columns.some((c) => conds.includes(c)), `index condition on ${columns.join(' or ')}:\n${conds}`).toBe(true);
}

/** A program + partner in `tenantId`; the ids are suffixed so both tenants
 *  can seed the same shape. */
async function seedPartner(tenantId: string, tag: string): Promise<{ programId: string; partnerId: string }> {
  const programId = `prog_${tag}_${ulid()}`;
  const partnerId = `ptr_${tag}_${ulid()}`;
  await db(TABLES.Program).insert({
    id: programId,
    tenantId,
    name: `Program ${tag}`,
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 10 }]),
    destinationUrl: 'https://x.test/',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  await db(TABLES.Partner).insert({ id: partnerId, tenantId, email: `${tag}@index-plans.test`, name: tag, activatedAt: new Date() });
  return { programId, partnerId };
}

async function configureNetwork(): Promise<void> {
  const value = {
    enabled: true,
    networkUrl,
    vendorTokenCiphertext: encryptSecret('vntok_index_plans'),
    scopedKeyId: null,
    autoEnroll: true,
  };
  await db(TABLES.Config).insert({
    tenantId: DEFAULT_TENANT_ID,
    key: 'network_membership',
    value: value as unknown as never,
    updatedAt: new Date(),
  });
}

describe.skipIf(skipIntegration)('hot-path lookups use tenant-leading indexes', () => {
  it('POST /clicks resolves the link key in its own tenant, on an index', async () => {
    const theirs = await seedPartner(OTHER_TENANT, 'theirs');
    const ours = await seedPartner(DEFAULT_TENANT_ID, 'ours');
    // Same key in both tenants, theirs written first.
    for (const [tenantId, p] of [
      [OTHER_TENANT, theirs],
      [DEFAULT_TENANT_ID, ours],
    ] as const) {
      await db(TABLES.Link).insert({ id: ulid(), tenantId, linkKey: 'shared-key', partnerId: p.partnerId, programId: p.programId });
    }

    const clickId = ulid();
    const { result: res, statements } = await capture(() =>
      request(app)
        .post('/clicks')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ id: clickId, linkKey: 'shared-key', landingUrl: 'https://x.test/', ts: new Date().toISOString() }),
    );
    expect(res.status).toBe(201);
    expect((await db(TABLES.Click).where({ id: clickId }).first()).partnerId).toBe(ours.partnerId);

    // A tenant index, or the router's (linkKey): either way not a scan.
    await expectIndexed(only(statements, /from "Link"/), ['"tenantId"', '"linkKey"']);
  });

  it('a coupon code resolves on a tenant index, case-insensitively and in its own tenant', async () => {
    const ours = await seedPartner(DEFAULT_TENANT_ID, 'coupon-ours');
    const theirs = await seedPartner(OTHER_TENANT, 'coupon-theirs');
    const coupon = (tenantId: string, p: { partnerId: string; programId: string }, code: string) => ({
      id: `cpn_${ulid()}`,
      tenantId,
      partnerId: p.partnerId,
      programId: p.programId,
      code,
    });
    await db(TABLES.Coupon).insert([
      coupon(DEFAULT_TENANT_ID, ours, 'SAVE-ABC'),
      // Older codes predate the upper-case rule.
      coupon(DEFAULT_TENANT_ID, ours, 'Legacy15'),
      coupon(DEFAULT_TENANT_ID, ours, 'STRASSE1'),
      coupon(OTHER_TENANT, theirs, 'OTHER-ONE'),
    ]);

    // The common case: one lookup of the upper-cased code. No lower() in
    // it: RLS keeps a non-leakproof function out of index conditions, so
    // the case-insensitive match can only ever filter the tenant's rows.
    const { result: found, statements } = await capture(() => findCouponByCode(db, DEFAULT_TENANT_ID, 'save-abc'));
    expect(found?.code).toBe('SAVE-ABC');
    const lookup = only(statements, /from "Coupon"/);
    expect(lookup.sql).not.toMatch(/lower\(/i);
    await expectIndexed(lookup);

    // A mixed-case code still matches, through the case-insensitive fallback.
    expect((await findCouponByCode(db, DEFAULT_TENANT_ID, 'LEGACY15'))?.code).toBe('Legacy15');
    // Another tenant's code is not ours.
    expect(await findCouponByCode(db, DEFAULT_TENANT_ID, 'other-one')).toBeNull();
    // 'straße1'.toUpperCase() is 'STRASSE1', which lower() would never match.
    expect(await findCouponByCode(db, DEFAULT_TENANT_ID, 'straße1')).toBeNull();
  });

  it("the outbox drain reads its own tenant's queue, on (tenantId, status, nextAttemptAt)", async () => {
    await configureNetwork();
    const theirs = await seedPartner(OTHER_TENANT, 'outbox-theirs');
    const queuedId = ulid();
    await db(TABLES.NetworkOutbox).insert({
      id: queuedId,
      tenantId: OTHER_TENANT,
      op: 'partner_upsert',
      payload: JSON.stringify({ vendorPartnerId: theirs.partnerId }),
      status: 'pending',
      nextAttemptAt: new Date(Date.now() - 60_000),
    });

    const { result, statements } = await capture(() => drainOutbox(db, DEFAULT_TENANT_ID));
    expect(result).toEqual({ drained: 0, succeeded: 0, dead: 0 });
    // Unscoped, this tenant's sweep dropped the other tenant's push (its
    // partner has no consent here).
    expect(await db(TABLES.NetworkOutbox).where({ id: queuedId }).first()).toBeTruthy();

    await expectIndexed(only(statements, /from "NetworkOutbox"/));
  });

  it("the heartbeat counts its own tenant's partners and events, on tenant indexes", async () => {
    await configureNetwork();
    await seedPartner(DEFAULT_TENANT_ID, 'beat-ours');
    await seedPartner(OTHER_TENANT, 'beat-theirs-1');
    await seedPartner(OTHER_TENANT, 'beat-theirs-2');

    const { result, statements } = await capture(() => sendHeartbeat(db, DEFAULT_TENANT_ID));
    expect(result).toEqual({ sent: true, partnerCount: 1 });

    await expectIndexed(only(statements, /from "Partner"/));
    await expectIndexed(only(statements, /from "Event"/));
  });

  it("a payout run groups its own tenant's approved commissions, on the tenant index", async () => {
    // The other tenant has a backlog of approved, unclaimed commissions —
    // enough that the planner's choice reflects a shared table, where
    // status = 'approved' alone is not selective and tenantId is.
    const theirs = await seedPartner(OTHER_TENANT, 'payout-theirs');
    await db.raw(
      `insert into "Event" (id, "tenantId", "userId", type, value, currency)
         select 'ev_plans_' || n, ?, 'u' || n, 'invoice_paid', 100, 'usd' from generate_series(1, 500) n`,
      [OTHER_TENANT],
    );
    await db.raw(
      `insert into "Attribution" (id, "tenantId", "eventId", "partnerId", "programId", "clickId", model, weight)
         select 'at_plans_' || n, ?, 'ev_plans_' || n, ?, ?, 'ck_plans_' || n, 'last_click', 1 from generate_series(1, 500) n`,
      [OTHER_TENANT, theirs.partnerId, theirs.programId],
    );
    await db.raw(
      `insert into "Commission" (id, "tenantId", "attributionId", "partnerId", amount, currency, status)
         select 'cm_plans_' || n, ?, 'at_plans_' || n, ?, 10, 'usd', 'approved' from generate_series(1, 500) n`,
      [OTHER_TENANT, theirs.partnerId],
    );
    const theirApproved = () =>
      db(TABLES.Commission).where({ tenantId: OTHER_TENANT, status: 'approved' }).whereNull('payoutId').count({ n: '*' });

    const { result, statements } = await capture(() => runPayouts(db, DEFAULT_TENANT_ID));
    // Unscoped, this tenant's run paid the other tenant's partner.
    expect(result.payouts).toEqual([]);
    expect(Number((await theirApproved())[0]!.n)).toBe(500);

    await expectIndexed(only(statements, /from "Commission" .*group by/i));
  });

  it('per-program reporting reads its own tenant, every table through an index condition', async () => {
    // A sale and a bonus in each tenant's program.
    const seeded: Array<{ programId: string; partnerId: string }> = [];
    for (const [tenantId, tag] of [
      [DEFAULT_TENANT_ID, 'report-ours'],
      [OTHER_TENANT, 'report-theirs'],
    ] as const) {
      const p = await seedPartner(tenantId, tag);
      seeded.push(p);
      const [clickId, eventId, attributionId, bonusId] = [ulid(), ulid(), ulid(), ulid()];
      await db(TABLES.PartnerProgram).insert({ id: `pc_${ulid()}`, tenantId, partnerId: p.partnerId, programId: p.programId, source: 'admin' });
      await db(TABLES.Click).insert({ id: clickId, tenantId, partnerId: p.partnerId, programId: p.programId, landingUrl: 'https://x.test/' });
      await db(TABLES.Event).insert({ id: eventId, tenantId, userId: `u-${tag}`, type: 'invoice_paid', value: 100, currency: 'USD' });
      await db(TABLES.Attribution).insert({
        id: attributionId, tenantId, eventId, partnerId: p.partnerId, programId: p.programId, clickId, model: 'last_click', weight: 1,
      });
      await db(TABLES.Bonus).insert({ id: bonusId, tenantId, partnerId: p.partnerId, programId: p.programId, amount: 5, currency: 'USD', source: 'manual' });
      await db(TABLES.Commission).insert([
        { id: ulid(), tenantId, attributionId, partnerId: p.partnerId, amount: 10, currency: 'USD', status: 'accrued' },
        { id: ulid(), tenantId, bonusId, partnerId: p.partnerId, amount: 5, currency: 'USD', status: 'accrued' },
      ]);
    }
    const [ours] = seeded;
    const get = (path: string) => capture(() => request(app).get(path).set('Authorization', `Bearer ${ADMIN_KEY}`));

    const overview = await get(`/admin/overview?programId=${ours!.programId}`);
    expect(overview.result.status).toBe(200);
    expect(overview.result.body.totals).toMatchObject({ partners: 1, clicks: 1, commissionByCurrency: { USD: { accrued: 15 } } });
    const stats = await get('/programs/stats');
    expect(stats.result.status).toBe(200);
    expect(stats.result.body.programs).toMatchObject([{ programId: ours!.programId, partners: 1, clicks: 1 }]);

    const reads = [...overview.statements, ...stats.statements].filter((s) =>
      /"(Partner|PartnerProgram|Program|Click|Attribution|Commission|Bonus)"/.test(s.sql),
    );
    expect(reads.length).toBeGreaterThan(5);
    for (const stmt of reads) {
      expect(stmt.sql).toMatch(/"tenantId" = /);
      const loose = await unconditionedScans(stmt);
      if (loose) expect(loose, stmt.sql).toEqual([]);
    }
  });
});
