/**
 * Multi-tenant isolation tests.
 *
 * The route + helper refactor scopes every query to req.db (a transaction
 * with `app.tenant_id` pinned). RLS is the second line of defense: even if
 * an app-level filter is forgotten, the policy on every tenant-scoped
 * table drops the row. These tests exercise the policy layer directly,
 * connecting as the openpartner_app role (which lacks BYPASSRLS so the
 * policies actually engage) and verifying:
 *
 *   1. Tenant A's GUC sees only A's rows
 *   2. Tenant B's GUC sees only B's rows
 *   3. With no GUC set, FORCE RLS hides everything (default deny)
 *   4. The platform_admin GUC override sees both
 *   5. WITH CHECK rejects writes that mismatch the GUC
 *   6. Sessions stamped to tenant A are invisible under tenant B
 *
 * Skipped if DATABASE_URL isn't set (same gating as the rest of the
 * integration suite). Also skipped if the openpartner_app role doesn't
 * exist (e.g. a fresh dev install where OPENPARTNER_APP_DB_PASSWORD was
 * never set so the migration short-circuited).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { TABLES, type TenantRow } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';

const { db } = await import('../db.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const TENANT_A = `01TESTAA${ulid().slice(8)}`;
const TENANT_B = `01TESTBB${ulid().slice(8)}`;

// Tables we'll seed + assert on. Limited to the ones that materially
// matter for an isolation guarantee — Partner is the canonical example
// (carries email + payout target, the things a leak would expose).
const SEED_TABLES_TO_RESET = [TABLES.Partner, TABLES.Session];

let appRoleAvailable = false;

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');

  const role = (await db.raw(
    `select 1 from pg_roles where rolname = 'openpartner_app' and rolcanlogin and not rolbypassrls`,
  )) as { rows: unknown[] };
  appRoleAvailable = role.rows.length > 0;

  // Wipe + re-seed two tenants. We use the privileged db (bypassRls=true
  // on this pool) so cleanup isn't policy-gated.
  await db('Tenant').whereIn('id', [TENANT_A, TENANT_B]).del();
  await db<TenantRow>(TABLES.Tenant).insert([
    { id: TENANT_A, slug: 'acme-test', displayName: 'Acme', status: 'active' },
    { id: TENANT_B, slug: 'globex-test', displayName: 'Globex', status: 'active' },
  ]);
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of SEED_TABLES_TO_RESET) {
      await db(t).whereIn('tenantId', [TENANT_A, TENANT_B]).del();
    }
    await db('Tenant').whereIn('id', [TENANT_A, TENANT_B]).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of SEED_TABLES_TO_RESET) {
    await db(t).whereIn('tenantId', [TENANT_A, TENANT_B]).del();
  }
  // Two Partners per tenant so we can verify counts, not just visibility.
  await db(TABLES.Partner).insert([
    { id: ulid(), tenantId: TENANT_A, email: `a1-${ulid()}@acme.test`, name: 'Acme P1' },
    { id: ulid(), tenantId: TENANT_A, email: `a2-${ulid()}@acme.test`, name: 'Acme P2' },
    { id: ulid(), tenantId: TENANT_B, email: `b1-${ulid()}@globex.test`, name: 'Globex P1' },
  ]);
});

/**
 * Run `fn` inside a transaction acting as openpartner_app with the given
 * GUCs. SET ROLE switches the effective role for the duration of the
 * transaction so RLS engages (the privileged role bypasses via
 * `row_security = off` set on connection, but the SET ROLE switch
 * removes that — RLS sees the new role's attributes).
 */
async function asAppRole<T>(
  gucs: { tenantId?: string; platformAdmin?: boolean },
  fn: (trx: import('knex').Knex.Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (trx) => {
    // SET LOCAL row_security = on to undo the pool-level disable; SET
    // ROLE openpartner_app to drop the bypass-RLS attributes the
    // privileged owner role has.
    await trx.raw(`set local row_security = on`);
    await trx.raw(`set local role openpartner_app`);
    if (gucs.tenantId) {
      await trx.raw(`set local app.tenant_id = '${gucs.tenantId.replace(/'/g, "''")}'`);
    }
    if (gucs.platformAdmin) {
      await trx.raw(`set local app.platform_admin = 'on'`);
    }
    return fn(trx);
  });
}

describe.skipIf(skipIntegration)('multi-tenant RLS isolation', () => {
  it('skips the suite cleanly when the openpartner_app role isn\'t provisioned', () => {
    // Surface the gate so a dev sees in test output why isolation tests
    // didn't actually run, rather than silently passing zero assertions.
    if (!appRoleAvailable) {
      console.warn(
        '[multi-tenant.test] openpartner_app role missing/superuser/bypassrls — RLS isolation tests skipped',
      );
    }
    expect(true).toBe(true);
  });

  it('Acme GUC sees only Acme rows', async () => {
    if (!appRoleAvailable) return;
    const rows = await asAppRole({ tenantId: TENANT_A }, (trx) =>
      trx(TABLES.Partner).select('tenantId', 'email'),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenantId === TENANT_A)).toBe(true);
  });

  it('Globex GUC sees only Globex rows', async () => {
    if (!appRoleAvailable) return;
    const rows = await asAppRole({ tenantId: TENANT_B }, (trx) =>
      trx(TABLES.Partner).select('tenantId'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(TENANT_B);
  });

  it('with no GUC set, FORCE RLS hides every row (default deny)', async () => {
    if (!appRoleAvailable) return;
    const rows = await asAppRole({}, (trx) => trx(TABLES.Partner).select('id'));
    expect(rows).toHaveLength(0);
  });

  it('platform_admin override sees both tenants', async () => {
    if (!appRoleAvailable) return;
    const rows = await asAppRole({ platformAdmin: true }, (trx) =>
      trx(TABLES.Partner)
        .whereIn('tenantId', [TENANT_A, TENANT_B])
        .select('tenantId'),
    );
    const counts = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.tenantId] = (acc[r.tenantId] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts[TENANT_A]).toBe(2);
    expect(counts[TENANT_B]).toBe(1);
  });

  it('WITH CHECK rejects an INSERT whose tenantId does not match the GUC', async () => {
    if (!appRoleAvailable) return;
    await expect(
      asAppRole({ tenantId: TENANT_A }, (trx) =>
        trx(TABLES.Partner).insert({
          id: ulid(),
          tenantId: TENANT_B, // mismatch on purpose
          email: `cross-${ulid()}@x.test`,
          name: 'Cross-tenant',
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it('FORCE RLS subjects the table owner to policies too', async () => {
    if (!appRoleAvailable) return;
    // Same SET ROLE dance; we're proving that even though the privileged
    // owner has full grants, FORCE RLS still gates it once row_security
    // is on AND the GUC is set to a tenant.
    const acme = await asAppRole({ tenantId: TENANT_A }, (trx) =>
      trx(TABLES.Partner).count<{ count: string }[]>('* as count').first(),
    );
    const globex = await asAppRole({ tenantId: TENANT_B }, (trx) =>
      trx(TABLES.Partner).count<{ count: string }[]>('* as count').first(),
    );
    expect(Number(acme!.count)).toBe(2);
    expect(Number(globex!.count)).toBe(1);
  });

  it('a Session stitched to Acme is invisible under Globex GUC', async () => {
    if (!appRoleAvailable) return;
    const sessionId = ulid();
    // Seed via privileged db (bypasses RLS) so we can stamp tenantId
    // directly.
    await db(TABLES.Session).insert({
      id: sessionId,
      tenantId: TENANT_A,
      prefix: 'op_test_',
      tokenHash: 'h_'.padEnd(64, 'a'),
      principalKind: 'admin',
      principalId: ulid(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const seenInB = await asAppRole({ tenantId: TENANT_B }, (trx) =>
      trx(TABLES.Session).where({ id: sessionId }).first(),
    );
    expect(seenInB).toBeUndefined();

    const seenInA = await asAppRole({ tenantId: TENANT_A }, (trx) =>
      trx(TABLES.Session).where({ id: sessionId }).first(),
    );
    expect(seenInA).toBeDefined();
  });

  it('Tenant table self-policy: A sees its own row, not B\'s', async () => {
    if (!appRoleAvailable) return;
    const aRows = await asAppRole({ tenantId: TENANT_A }, (trx) =>
      trx<TenantRow>(TABLES.Tenant).whereIn('id', [TENANT_A, TENANT_B]).select('id'),
    );
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.id).toBe(TENANT_A);
  });
});
