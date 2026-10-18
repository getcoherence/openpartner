/**
 * POST /import/partners-csv — what it writes, and the shape that keeps a
 * large roster fast under RLS: one tenant-scoped email lookup per chunk of
 * the file and batched inserts, instead of an email-only lookup per row
 * (which the RLS policy's platform-admin OR turned into a scan of the
 * whole roster, once per row).
 *
 * Skipped if DATABASE_URL isn't set.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_import_partners_0123456789abcdef01';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const { db, appDb } = await import('../db.js');
const { createApp } = await import('../app.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const OTHER_TENANT = '01J0000000IMPORTOTHERTENANT';
const TENANTS = [DEFAULT_TENANT_ID, OTHER_TENANT];

interface RowReport {
  row: number;
  email: string;
  status: string;
  partnerId?: string;
}

async function cleanup(): Promise<void> {
  for (const t of [TABLES.PartnerProgram, TABLES.Partner, TABLES.Program]) {
    await db(t).whereIn('tenantId', TENANTS).del();
  }
}

beforeEach(async () => {
  if (skipIntegration) return;
  await cleanup();
});

afterAll(async () => {
  if (!skipIntegration) {
    await cleanup();
    await db(TABLES.Tenant).where({ id: OTHER_TENANT }).del();
  }
  await db.destroy();
});

function csvOf(rows: Array<[string, string]>): string {
  return ['email,name', ...rows.map(([email, name]) => `${email},${name}`)].join('\n');
}

async function importCsv(csv: string, opts: { dryRun?: boolean } = {}) {
  return request(app)
    .post(`/import/partners-csv${opts.dryRun ? '?dryRun=true' : ''}`)
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .set('content-type', 'text/csv')
    .send(csv);
}

async function seedPrograms(n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => ulid());
  await db(TABLES.Program).insert(
    ids.map((id, i) => ({
      id,
      tenantId: DEFAULT_TENANT_ID,
      name: `Program ${i}`,
      commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 10 }]),
      destinationUrl: 'https://x.test/',
      attributionWindowDays: 60,
      attributionModel: 'last_click',
    })),
  );
  return ids;
}

const many = (n: number, tag: string): Array<[string, string]> =>
  Array.from({ length: n }, (_, i) => [`${tag}${i}@example.test`, `${tag} ${i}`]);

describe.skipIf(skipIntegration)('POST /import/partners-csv', () => {
  it('creates every row and grants every program, across write batches', async () => {
    const programs = await seedPrograms(2);
    const res = await importCsv(csvOf(many(2500, 'bulk')));
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 2500, created: 2500, skipped: 0, invalid: 0 });

    const count = async (q: ReturnType<typeof db>) => Number(((await q.count({ n: '*' })) as Array<{ n: string }>)[0]?.n);
    expect(await count(db(TABLES.Partner).where({ tenantId: DEFAULT_TENANT_ID }))).toBe(2500);
    for (const programId of programs) {
      expect(await count(db(TABLES.PartnerProgram).where({ programId, source: 'admin' }))).toBe(2500);
    }
    // The report's ids are the rows' ids.
    const last = (res.body.report as RowReport[]).at(-1)!;
    expect((await db(TABLES.Partner).where({ id: last.partnerId }).first()).email).toBe('bulk2499@example.test');
  }, 60_000);

  it('skips emails already on the roster and repeats within the file — in a dry run too', async () => {
    const existingId = ulid();
    await db(TABLES.Partner).insert({ id: existingId, tenantId: DEFAULT_TENANT_ID, email: 'taken@example.test', name: 'Taken' });
    const csv = csvOf([
      ['taken@example.test', 'Again'],
      ['fresh@example.test', 'Fresh'],
      ['FRESH@example.test', 'Fresh twice'],
      ['not-an-email', 'Nobody'],
    ]);

    for (const dryRun of [true, false]) {
      const res = await importCsv(csv, { dryRun });
      expect(res.status).toBe(200);
      const report = res.body.report as RowReport[];
      expect(report.map((r) => r.status)).toEqual(['skipped_email_taken', 'created', 'skipped_email_taken', 'invalid']);
      expect(report[0]!.partnerId).toBe(existingId);
      expect(report[2]!.partnerId).toBe(report[1]!.partnerId);
      const fresh = await db(TABLES.Partner).where({ email: 'fresh@example.test' });
      expect(fresh, dryRun ? 'a dry run writes nothing' : 'written once').toHaveLength(dryRun ? 0 : 1);
    }
    // Re-running is a no-op.
    const again = await importCsv(csv);
    expect(again.body.summary).toMatchObject({ created: 0, skipped: 3, invalid: 1 });
  });

  it("another tenant's partner with the same email doesn't count as taken", async () => {
    await db(TABLES.Tenant)
      .insert({ id: OTHER_TENANT, slug: 'import-other', displayName: 'Other', status: 'active', approvalStatus: 'approved' })
      .onConflict('id')
      .ignore();
    await db(TABLES.Partner).insert({ id: ulid(), tenantId: OTHER_TENANT, email: 'shared@example.test', name: 'Theirs' });

    const res = await importCsv(csvOf([['shared@example.test', 'Ours']]));
    expect(res.body.summary).toMatchObject({ created: 1, skipped: 0 });
    expect(await db(TABLES.Partner).where({ tenantId: DEFAULT_TENANT_ID, email: 'shared@example.test' })).toHaveLength(1);
  });

  it('looks emails up by tenant, a chunk at a time — never once per row', async () => {
    await seedPrograms(1);
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const listener = (q: { sql: string; bindings?: unknown[] }) => statements.push({ sql: q.sql, bindings: q.bindings ?? [] });
    appDb.on('query', listener);
    try {
      const res = await importCsv(csvOf(many(2500, 'counted')));
      expect(res.body.summary.created).toBe(2500);
    } finally {
      appDb.off('query', listener);
    }

    const lookups = statements.filter((s) => /^select .* from "Partner"/i.test(s.sql));
    expect(lookups).toHaveLength(3); // 2,500 emails in chunks of 1,000
    for (const l of lookups) expect(l.sql).toMatch(/"tenantId" = /);
    // Everything else is batched too: no statement count that grows per row.
    expect(statements.length).toBeLessThan(20);

    // And under the RLS role that lookup gets an index condition on
    // tenantId. The email-only lookup it replaced could not use any index:
    // the policy's platform-admin OR hides tenantId from the planner.
    const role = (await db.raw(`select 1 from pg_roles where rolname = 'openpartner_app'`)) as { rows: unknown[] };
    if (role.rows.length === 0) return;
    const plan = async (sql: string, bindings: unknown[]) =>
      db.transaction(async (trx) => {
        await trx.raw('set local row_security = on');
        await trx.raw('set local role openpartner_app');
        await trx.raw(`set local app.tenant_id = '${DEFAULT_TENANT_ID}'`);
        await trx.raw('set local enable_seqscan = off');
        const out = (await trx.raw(`explain ${sql.replace(/\$\d+/g, '?')}`, bindings as never)) as { rows: Array<{ 'QUERY PLAN': string }> };
        return out.rows.map((r) => r['QUERY PLAN']).filter((l) => l.includes('Index Cond')).join('\n');
      });
    expect(await plan(lookups[0]!.sql, lookups[0]!.bindings)).toMatch(/"tenantId"/);
    // At best it walks the whole (tenantId, email) index for the email.
    expect(await plan('select "id" from "Partner" where "email" = ?', ['counted1@example.test'])).not.toMatch(/"tenantId"/);
  }, 60_000);
});
