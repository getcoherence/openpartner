/**
 * Fails a test file that leaves database state behind for the files after it.
 *
 * The API test files share one Postgres and run one at a time, in an order
 * that differs between machines and CI. A file that wipes tables in
 * beforeEach but not in afterAll hands its last test's rows to whichever
 * file runs next: a leftover network_membership Config row 400s a later
 * POST /programs, a leftover Identity blocks a later Click wipe on its FK
 * (#131). Those failures land on the innocent file, and only in some
 * orders. This guard pins them on the file that leaked, in every order.
 *
 * It snapshots every table's row count, the Config keys and the default
 * tenant's row before the file, and compares after it. Installed from
 * setup-env.ts, so under the "stack" hook order vitest.config.ts pins, its
 * afterAll runs after the file's own — on a pool of its own, because test
 * files destroy the shared one.
 */
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll } from 'vitest';
import type { Knex } from 'knex';
import { createDb, DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

// Rows a file may leave behind: magic-link tokens are random, have no FKs,
// and no file reads another's.
const MAY_GROW = new Set<string>([TABLES.MagicLinkToken]);

interface Snapshot {
  counts: Map<string, number>;
  configKeys: Set<string>;
  tenant: Record<string, unknown> | undefined;
}

async function snapshot(db: Knex): Promise<Snapshot> {
  const tables: string[] = await db('information_schema.tables')
    .where({ table_schema: 'public', table_type: 'BASE TABLE' })
    .andWhereNot('table_name', 'like', 'knex%')
    .pluck('table_name');
  const { rows } = await db.raw<{ rows: Array<{ t: string; n: number }> }>(
    tables.map(() => 'select ?::text as t, count(*)::int as n from ??').join(' union all '),
    tables.flatMap((t) => [t, t]),
  );
  const config: Array<{ tenantId: string; key: string }> = await db(TABLES.Config).select('tenantId', 'key');
  return {
    counts: new Map(rows.map((r) => [r.t, r.n])),
    configKeys: new Set(config.map((c) => `${c.tenantId}:${c.key}`)),
    tenant: await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first(),
  };
}

function leaks(before: Snapshot, after: Snapshot, ignoreTenantColumns: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const [table, n] of after.counts) {
    const was = before.counts.get(table) ?? 0;
    if (n <= was || MAY_GROW.has(table)) continue;
    const added =
      table === TABLES.Config ? [...after.configKeys].filter((k) => !before.configKeys.has(k)) : [];
    found.push(`${table}: ${was} → ${n} rows${added.length ? ` (${added.join(', ')})` : ''}`);
  }
  for (const [column, value] of Object.entries(after.tenant ?? {})) {
    if (ignoreTenantColumns.has(column)) continue;
    const was = before.tenant?.[column];
    if (!isDeepStrictEqual(was, value)) {
      found.push(`Tenant ${DEFAULT_TENANT_ID} ${column}: ${JSON.stringify(was)} → ${JSON.stringify(value)}`);
    }
  }
  return found;
}

/**
 * Register the guard for the current test file. `ignoreTenantColumns` are
 * default-tenant columns setup-env resets before every file anyway, so a
 * file changing them can't reach the next one.
 */
export function installLeakGuard(connectionString: string, ignoreTenantColumns: Iterable<string>): void {
  const ignore = new Set(['updatedAt', ...ignoreTenantColumns]);
  let db: Knex | undefined;
  let before: Snapshot | null = null;

  beforeAll(async () => {
    db = await createDb({ connectionString, bypassRls: true });
    // Unreachable DB: setup-env already warned, and DB-backed files self-skip.
    before = await snapshot(db).catch(() => null);
  });

  afterAll(async () => {
    if (!db) return;
    try {
      if (!before) return;
      const found = leaks(before, await snapshot(db), ignore);
      if (found.length) {
        throw new Error(
          `[leak-guard] this file left state behind for later test files — clean it up in its afterAll:\n  ${found.join('\n  ')}`,
        );
      }
    } finally {
      await db.destroy();
    }
  });
}
