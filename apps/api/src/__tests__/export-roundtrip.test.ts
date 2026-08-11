/**
 * Export portability round-trip (audit #8).
 *
 * The promise in CLAUDE.md/README: everything in the bundle exports to
 * CSV + JSON + SQL, and the self-hosted build re-imports what the hosted
 * one produced. These tests seed one row in every exportable table, wipe
 * the database, restore, and compare — once through the JSON path and
 * once through the SQL dump actually executed against Postgres.
 *
 * Tables NOT in the bundle are listed in docs/data-portability.md; this
 * suite deliberately does not assert anything about them.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import {
  EXPORT_TABLES,
  SCHEMA_VERSION,
  buildSqlDump,
  exportAll,
  exportColumnTypes,
  importBundle,
  isSafeTenantId,
  primaryKeyOf,
} from '../export.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;

interface Seeded {
  partnerId: string;
  programId: string;
  linkId: string;
  clickId: string;
  eventId: string;
  attributionId: string;
  commissionId: string;
  payoutId: string;
  couponId: string;
}

/** One row in every exportable table, with the FK chain intact. */
async function seedEverything(): Promise<Seeded> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  const identityId = ulid();
  const eventId = ulid();
  const attributionId = ulid();
  const commissionId = ulid();
  const payoutId = ulid();
  const couponId = ulid();

  await db(TABLES.Partner).insert({
    id: partnerId,
    tenantId: TENANT,
    email: `p${partnerId}@x.test`,
    name: "O'Hara & Co", // apostrophe + ampersand: exercises SQL escaping
    metadata: { source: 'seed', note: 'has "double" quotes' },
  });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: TENANT,
    name: 'Program',
    // jsonb holding an ARRAY, and a real text[] alongside it — the pair
    // that used to break the round-trip (a JS array is ambiguous unless
    // the exporter reads the column type).
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    categories: ['saas', 'devtools'],
    destinationUrl: 'https://x.test/landing',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  await db(TABLES.PartnerProgram).insert({
    id: ulid(),
    tenantId: TENANT,
    partnerId,
    programId,
    source: 'admin',
  });
  await db(TABLES.PartnerCommission).insert({
    partnerId,
    tenantId: TENANT,
    commissionType: 'percent',
    commissionValue: '20.0000',
    recurring: true,
    holdbackDays: 30,
    source: 'approval',
  });
  await db(TABLES.Coupon).insert({
    id: couponId,
    tenantId: TENANT,
    partnerId,
    programId,
    code: 'CREATOR15',
  });
  await db(TABLES.Link).insert({
    id: linkId,
    tenantId: TENANT,
    linkKey: `k${linkId.slice(0, 8)}`,
    partnerId,
    programId,
    destinationUrl: 'https://x.test/landing',
  });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: TENANT,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://x.test/landing',
    ts: new Date(),
  });
  await db(TABLES.Identity).insert({
    id: identityId,
    tenantId: TENANT,
    clickId,
    userId: `u-${clickId}`,
  });
  await db(TABLES.Event).insert({
    id: eventId,
    tenantId: TENANT,
    userId: `u-${clickId}`,
    type: 'invoice_paid',
    value: '200.00',
    currency: 'USD',
    ts: new Date(),
  });
  await db(TABLES.Attribution).insert({
    id: attributionId,
    tenantId: TENANT,
    eventId,
    clickId,
    partnerId,
    programId,
    model: 'last_click',
    weight: '1',
    computedAt: new Date(),
  });
  await db(TABLES.Commission).insert({
    id: commissionId,
    tenantId: TENANT,
    partnerId,
    attributionId,
    amount: '40.00',
    currency: 'USD',
    status: 'approved',
  });
  await db(TABLES.Payout).insert({
    id: payoutId,
    tenantId: TENANT,
    partnerId,
    amount: '40.00',
    currency: 'USD',
    method: 'manual',
    status: 'pending',
    metadata: { runId: 'seed', platformFee: 0 },
  });
  await db(TABLES.PortalCustomDomain).insert({
    id: ulid(),
    tenantId: TENANT,
    domain: `partners-${partnerId.slice(0, 8).toLowerCase()}.example.test`,
    verificationToken: 'tok',
    status: 'pending',
    edgeKind: 'do_native',
  });
  await db(TABLES.CommissionAdjustment).insert({
    id: ulid(),
    tenantId: TENANT,
    commissionId,
    amount: '-5.00',
    currency: 'USD',
    reason: 'admin_correction',
    metadata: {},
  });

  return {
    partnerId,
    programId,
    linkId,
    clickId,
    eventId,
    attributionId,
    commissionId,
    payoutId,
    couponId,
  };
}

/** Reverse of IMPORT_ORDER so foreign keys never block the delete. */
async function wipe(): Promise<void> {
  for (const { table } of [...EXPORT_TABLES].reverse()) {
    await db(table).del();
  }
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { table } of EXPORT_TABLES) {
    const [row] = (await db(table).count({ n: '*' })) as Array<{ n: string }>;
    out[table] = Number(row?.n ?? 0);
  }
  return out;
}

/**
 * Run a multi-statement script the way psql would — straight to the pg
 * connection, so knex never tries to parse `?` as a binding.
 */
async function runSql(sql: string): Promise<void> {
  const conn = (await db.client.acquireConnection()) as { query: (q: string) => Promise<unknown> };
  try {
    await conn.query(sql);
  } finally {
    await db.client.releaseConnection(conn);
  }
}

/** What psql does with `-v tenant_id=<id>`: substitute, then drop its own
 *  meta-commands (which never reach the server). */
function asPsqlWould(dump: string, tenantId: string): string {
  return dump
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n')
    .replace(/:'tenant_id'/g, `'${tenantId}'`);
}

/** What psql does with NO `-v` at all: the file's own `\set` fallback
 *  supplies the value. Exercises the default restore path, which is the
 *  one the docs tell operators to use. */
function asPsqlWouldWithoutVar(dump: string): string {
  const fallback = /^\\set tenant_id '([^']*)'$/m.exec(dump);
  if (!fallback) throw new Error('dump has no \\set tenant_id fallback');
  return asPsqlWould(dump, fallback[1]!);
}

beforeEach(async () => {
  if (skipIntegration) return;
  await wipe();
});

afterAll(async () => {
  if (!skipIntegration) await wipe();
  await db.destroy();
});

describe.skipIf(skipIntegration)('export coverage', () => {
  it('covers every table the attribution → payout chain needs', async () => {
    const names = EXPORT_TABLES.map((s) => s.table);
    // The three the audit found missing: grants, coupon attribution, and
    // the snapshotted commission terms.
    expect(names).toContain(TABLES.PartnerProgram);
    expect(names).toContain(TABLES.Coupon);
    expect(names).toContain(TABLES.PartnerCommission);
  });

  it('knows each table real primary key — not just `id`', () => {
    expect(primaryKeyOf(TABLES.PartnerCommission)).toBe('partnerId');
    expect(primaryKeyOf(TABLES.Commission)).toBe('id');
  });

  it('orders tables so foreign keys resolve top to bottom', () => {
    const at = (t: string) => EXPORT_TABLES.findIndex((s) => s.table === t);
    expect(at(TABLES.Partner)).toBeLessThan(at(TABLES.PartnerProgram));
    expect(at(TABLES.Program)).toBeLessThan(at(TABLES.PartnerProgram));
    expect(at(TABLES.Partner)).toBeLessThan(at(TABLES.PartnerCommission));
    expect(at(TABLES.Program)).toBeLessThan(at(TABLES.Coupon));
    expect(at(TABLES.Link)).toBeLessThan(at(TABLES.Click));
    expect(at(TABLES.Click)).toBeLessThan(at(TABLES.Identity));
    expect(at(TABLES.Event)).toBeLessThan(at(TABLES.Attribution));
    expect(at(TABLES.Attribution)).toBeLessThan(at(TABLES.Commission));
    expect(at(TABLES.Commission)).toBeLessThan(at(TABLES.CommissionAdjustment));
  });
});

describe.skipIf(skipIntegration)('JSON round-trip', () => {
  it('export → wipe → import restores every table', async () => {
    const seeded = await seedEverything();
    const bundle = await exportAll(db);
    const before = await counts();
    for (const { table } of EXPORT_TABLES) {
      expect(before[table], `${table} should have been seeded`).toBe(1);
    }

    await wipe();
    const report = await importBundle(db, TENANT, bundle);

    expect(await counts()).toEqual(before);
    for (const { table } of EXPORT_TABLES) {
      expect(report.inserted[table], `${table} should have been imported`).toBe(1);
    }

    // Spot-check the three that used not to round-trip.
    const grant = await db(TABLES.PartnerProgram).first();
    expect(grant.partnerId).toBe(seeded.partnerId);
    expect(grant.programId).toBe(seeded.programId);
    const terms = await db(TABLES.PartnerCommission).where({ partnerId: seeded.partnerId }).first();
    expect(terms.commissionType).toBe('percent');
    expect(Number(terms.commissionValue)).toBe(20);
    expect(terms.recurring).toBe(true);
    expect(terms.holdbackDays).toBe(30);
    const coupon = await db(TABLES.Coupon).where({ id: seeded.couponId }).first();
    expect(coupon.code).toBe('CREATOR15');
    // jsonb array + text[] both survive with their own shapes.
    const program = await db(TABLES.Program).where({ id: seeded.programId }).first();
    expect(program.commissionRule).toEqual([{ trigger: 'every', type: 'percent', value: 20 }]);
    expect(program.categories).toEqual(['saas', 'devtools']);
    // …and that the money ledger survived with its shape intact.
    const commission = await db(TABLES.Commission).where({ id: seeded.commissionId }).first();
    expect(commission.amount).toBe('40.00');
    expect(commission.status).toBe('approved');
  }, 30_000);

  it('is idempotent — importing the same bundle twice inserts nothing new', async () => {
    await seedEverything();
    const bundle = await exportAll(db);
    await wipe();

    await importBundle(db, TENANT, bundle);
    const second = await importBundle(db, TENANT, bundle);

    // PartnerCommission is the one keyed on partnerId: with the old
    // hardcoded `id` conflict target this threw instead of skipping.
    for (const { table } of EXPORT_TABLES) {
      expect(second.inserted[table] ?? 0, `${table} should not re-insert`).toBe(0);
      expect(second.skipped[table] ?? 0, `${table} should be skipped`).toBe(1);
    }
    expect((await counts())[TABLES.PartnerCommission]).toBe(1);
  }, 30_000);

  it('accepts a v1 bundle — older exports keep working', async () => {
    await seedEverything();
    const full = await exportAll(db);
    const v1: Record<string, unknown[]> = { ...full };
    // v1 didn't know about these three.
    delete v1[TABLES.PartnerProgram];
    delete v1[TABLES.PartnerCommission];
    delete v1[TABLES.Coupon];
    await wipe();

    const report = await importBundle(db, TENANT, v1);
    expect(report.inserted[TABLES.Partner]).toBe(1);
    expect(report.inserted[TABLES.PartnerProgram]).toBeUndefined();
    expect((await counts())[TABLES.Commission]).toBe(1);
  }, 30_000);
});

describe.skipIf(skipIntegration)('SQL dump', () => {
  it('restores a wiped database when run as plain SQL', async () => {
    await seedEverything();
    const bundle = await exportAll(db);
    const before = await counts();
    const dump = buildSqlDump(bundle, { tenantId: TENANT, columnTypes: await exportColumnTypes(db) });

    await wipe();
    await runSql(dump);

    expect(await counts()).toEqual(before);
    const program = await db(TABLES.Program).first();
    expect(program.commissionRule).toEqual([{ trigger: 'every', type: 'percent', value: 20 }]);
    expect(program.categories).toEqual(['saas', 'devtools']);
  }, 30_000);

  it('the portable form restores under whatever tenant psql is given', async () => {
    await seedEverything();
    const bundle = await exportAll(db);
    const before = await counts();
    const dump = buildSqlDump(bundle, { sourceTenantId: 'acme', columnTypes: await exportColumnTypes(db) });

    // Portable form carries the psql preamble and no baked tenant id.
    expect(dump).toContain(`\\set tenant_id '${DEFAULT_TENANT_ID}'`);
    expect(dump).toContain(":'tenant_id'");

    await wipe();
    await runSql(asPsqlWould(dump, TENANT));

    expect(await counts()).toEqual(before);
    const partner = await db(TABLES.Partner).first();
    expect(partner.tenantId).toBe(TENANT); // rewritten, not 'acme'
  }, 30_000);

  it('is idempotent — re-running the dump inserts nothing new', async () => {
    await seedEverything();
    const dump = buildSqlDump(await exportAll(db), { tenantId: TENANT, columnTypes: await exportColumnTypes(db) });
    const before = await counts();

    await runSql(dump); // rows already exist
    expect(await counts()).toEqual(before);
  }, 30_000);

  it('escapes quotes, json, decimals and nulls', async () => {
    await seedEverything();
    const dump = buildSqlDump(await exportAll(db), { tenantId: TENANT, columnTypes: await exportColumnTypes(db) });
    expect(dump).toContain(`'O''Hara & Co'`); // doubled quote
    // jsonb → a JSON literal; text[] → a Postgres array literal. Same JS
    // array shape, two different renderings — that's the whole point.
    // (jsonb doesn't preserve key order, so match on the shape, not the string)
    expect(dump).toMatch(/'\[\{[^']*"type":"percent"[^']*\}\]'/);
    expect(dump).toContain(`'{"saas","devtools"}'`);
    expect(dump).toContain('NULL');
    expect(dump).toContain(`ON CONFLICT ("partnerId") DO NOTHING;`); // PartnerCommission
    expect(dump).toContain(`-- OpenPartner export — schemaVersion ${SCHEMA_VERSION}`);
  });

  it('emits a header and a no-rows marker for empty tables', () => {
    const dump = buildSqlDump({}, { tenantId: TENANT, exportedAt: '2026-08-09T00:00:00.000Z' });
    expect(dump).toContain('-- exported 2026-08-09T00:00:00.000Z');
    expect(dump).toContain(`-- ${TABLES.Partner}: no rows`);
    expect(dump).toContain('BEGIN;');
    expect(dump.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});

// ---- Restore safety (Codex review, 2026-08-09) -----------------------------

describe.skipIf(skipIntegration)('SQL dump restore safety', () => {
  it('the no -v path works: the built-in fallback is the tenant PRIMARY KEY', async () => {
    // Regression: the fallback used to be the tenant SLUG ('default'), so
    // the documented `psql -f dump.sql` restore failed the tenantId → Tenant.id
    // foreign key on the very first row.
    await seedEverything();
    const before = await counts();
    const dump = buildSqlDump(await exportAll(db), { columnTypes: await exportColumnTypes(db) });
    expect(dump).toContain(`\\set tenant_id '${TENANT}'`);

    await wipe();
    await runSql(asPsqlWouldWithoutVar(dump));

    expect(await counts()).toEqual(before);
    expect((await db(TABLES.Partner).first()).tenantId).toBe(TENANT);
  }, 30_000);

  it('pins the string-literal mode its escaping assumes', async () => {
    const dump = buildSqlDump({}, { tenantId: TENANT });
    expect(dump).toContain('SET LOCAL standard_conforming_strings = on;');
  });

  it('refuses a tenant id that could carry a psql meta-command', () => {
    // `\!` at the start of a line makes psql run a shell command on the
    // machine doing the restore. The value lands in a header comment of a
    // file psql executes, so it is validated rather than escaped.
    expect(isSafeTenantId(TENANT)).toBe(true);
    expect(isSafeTenantId("x\n\\! rm -rf /\n--")).toBe(false);
    expect(isSafeTenantId("x'; drop table \"Partner\"; --")).toBe(false);
    expect(isSafeTenantId('')).toBe(false);
    expect(isSafeTenantId('a'.repeat(65))).toBe(false);
    expect(() => buildSqlDump({}, { tenantId: "x\n\\! calc" })).toThrow(/invalid tenant id/);
  });

  it('never lets a header comment be broken out of', () => {
    const dump = buildSqlDump({}, { tenantId: TENANT, sourceTenantId: 'acme\n\\! calc\n--' });
    for (const line of dump.split('\n')) {
      // Every line before BEGIN; is either a comment, a psql meta-command
      // the generator itself emitted, or blank.
      if (line.startsWith('BEGIN;')) break;
      const isOwnMetaCommand =
        line === '\\if :{?tenant_id}' ||
        line === '\\else' ||
        line === '\\endif' ||
        line.startsWith('\\set tenant_id ');
      expect(line === '' || line.startsWith('--') || isOwnMetaCommand).toBe(true);
    }
  });

  it('backslashes and quotes in row data survive the SQL round-trip', async () => {
    const { partnerId } = await seedEverything();
    await db(TABLES.Partner)
      .where({ id: partnerId })
      .update({ name: `back\\slash '; select pg_sleep(0); -- and "quotes"` });
    const before = await counts();
    const dump = buildSqlDump(await exportAll(db), {
      tenantId: TENANT,
      columnTypes: await exportColumnTypes(db),
    });

    await wipe();
    await runSql(dump);

    expect(await counts()).toEqual(before);
    const partner = await db(TABLES.Partner).where({ id: partnerId }).first();
    expect(partner.name).toBe(`back\\slash '; select pg_sleep(0); -- and "quotes"`);
  }, 30_000);

  it('text that merely looks like a timestamp stays text', async () => {
    // normalizeRow used to revive ANY ISO-shaped string as a Date.
    const { partnerId } = await seedEverything();
    await db(TABLES.Partner).where({ id: partnerId }).update({ name: '2026-08-09T00:00:00' });
    const bundle = await exportAll(db);
    await wipe();
    await importBundle(db, TENANT, bundle);

    const partner = await db(TABLES.Partner).where({ id: partnerId }).first();
    expect(partner.name).toBe('2026-08-09T00:00:00');
  }, 30_000);
});

describe.skipIf(skipIntegration)('SQL route validation', () => {
  const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';

  it('400s a malformed tenantId rather than quietly ignoring it', async () => {
    const app = createApp();
    // A repeated parameter parses as an array. Treating "present but not a
    // string" as absent returned a portable 200 dump instead of the 400
    // the contract promises.
    const repeated = await request(app)
      .get('/export.sql?tenantId=a&tenantId=b')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(repeated.status).toBe(400);

    const newline = await request(app)
      .get(`/export.sql?tenantId=${encodeURIComponent('x\n\\! whoami')}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(newline.status).toBe(400);

    expect(repeated.body.error).toBe('invalid_tenant_id');

    // …and a well-formed one is actually HONOURED, not just accepted. A
    // 200 alone would also pass if the parameter were ignored and a
    // portable dump returned.
    const ok = await request(app)
      .get(`/export.sql?tenantId=${TENANT}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain(`'${TENANT}'`);
    expect(ok.text).not.toContain(":'tenant_id'");
    expect(ok.text).not.toContain('\\set tenant_id');
  });

  it('validates on the per-table SQL route too', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/export/Partner.sql?tenantId=a&tenantId=b')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_tenant_id');
  });
});

describe.skipIf(skipIntegration)('cross-tenant restore', () => {
  const OTHER_TENANT = '01J0000000OTHERTENANT00000';

  afterAll(async () => {
    if (skipIntegration) return;
    for (const { table } of [...EXPORT_TABLES].reverse()) {
      await db(table).where({ tenantId: OTHER_TENANT }).del();
    }
    await db(TABLES.Tenant).where({ id: OTHER_TENANT }).del();
  });

  it('rewrites tenantId on import — the whole point of hosted → self-host', async () => {
    // Every other round-trip test exports and imports under the SAME
    // tenant, so they would all pass with the rewrite deleted. This one
    // restores into a different tenant, which is the actual promise:
    // a hosted export lands in a self-host instance under ITS tenant id.
    await db(TABLES.Tenant)
      .insert({
        id: OTHER_TENANT,
        slug: 'other-restore-target',
        displayName: 'Restore Target',
        status: 'active',
        approvalStatus: 'approved',
      })
      .onConflict('id')
      .ignore();

    const seeded = await seedEverything();
    const bundle = await exportAll(db);
    const sourceCounts = await counts();

    // Wipe first: primary keys are GLOBAL, not per-tenant, so importing a
    // bundle alongside its source in the same database is a no-op —
    // `onConflict(pk).ignore()` sees the original rows. The real scenario
    // is a different database (hosted → self-host), which this models.
    await wipe();
    const report = await importBundle(db, OTHER_TENANT, bundle);
    expect(report.inserted[TABLES.Partner]).toBe(1);

    for (const { table } of EXPORT_TABLES) {
      const [row] = (await db(table).where({ tenantId: OTHER_TENANT }).count({ n: '*' })) as Array<{
        n: string;
      }>;
      expect(Number(row?.n ?? 0), `${table} should have landed in the target tenant`).toBe(
        sourceCounts[table],
      );
    }

    // The rows really moved tenant, ids and all.
    const moved = await db(TABLES.Commission).where({ id: seeded.commissionId }).first();
    expect(moved.tenantId).toBe(OTHER_TENANT);
  }, 30_000);
});
