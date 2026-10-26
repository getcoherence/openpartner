/**
 * The boot-time app-role grants (packages/db/src/app-role-grants.ts) cover
 * every table the openpartner_app role needs, under its current name.
 *
 * Each tenant table's migration grants openpartner_app its privileges only
 * when the role exists at migrate time. A role provisioned later gets them
 * only from scripts/ensure-app-role.ts on boot. That script's list once
 * still named Campaign and PartnerCampaign, and missed every tenant table
 * added since, so a role provisioned after the Program rename failed every
 * RLS-pool query on Program with "permission denied".
 *
 * The scratch-role test needs a superuser connection (CI and local docker
 * have one) to create and SET ROLE to a throwaway role; the migration-parity
 * test needs openpartner_app to have existed before migrate (dev DBs, not CI).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESTRICTED_GRANTS, TABLES, TENANT_TABLES, grantAppRole } from '@openpartner/db';

const { db } = await import('../db.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const FULL_DML = ['delete', 'insert', 'select', 'update'];

// Every listed table → the privileges grantAppRole gives it, sorted.
const listed = new Map<string, string[]>([
  ...TENANT_TABLES.map((t): [string, string[]] => [t, FULL_DML]),
  ...RESTRICTED_GRANTS.map(({ table, grant }): [string, string[]] => [
    table,
    grant
      .split(',')
      .map((p) => p.trim())
      .sort(),
  ]),
]);

const scratchRole = `op_grants_test_${randomBytes(4).toString('hex')}`;
let scratchRoleCreated = false;

/** Table → sorted privileges `role` holds, read straight from the ACLs. */
async function privileges(role: string): Promise<Map<string, string[]>> {
  const { rows } = (await db.raw(
    `select c.relname as tbl, string_agg(lower(a.privilege_type), ',' order by lower(a.privilege_type)) as privs
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(c.relacl) a
      where n.nspname = 'public'
        and a.grantee = (select oid from pg_roles where rolname = ?)
      group by c.relname`,
    [role],
  )) as { rows: Array<{ tbl: string; privs: string }> };
  return new Map(rows.map((r) => [r.tbl, r.privs.split(',')]));
}

async function publicTables(where = 'true'): Promise<string[]> {
  const { rows } = (await db.raw(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and ${where}
      order by 1`,
  )) as { rows: Array<{ relname: string }> };
  return rows.map((r) => r.relname);
}

afterAll(async () => {
  await db.destroy();
});

describe('app-role grant lists', () => {
  it('name each table once', () => {
    const names = [...TENANT_TABLES, ...RESTRICTED_GRANTS.map((g) => g.table)];
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  it('name only TABLES constants', () => {
    const known = new Set<string>(Object.values(TABLES));
    expect([...listed.keys()].filter((t) => !known.has(t))).toEqual([]);
  });
});

describe.skipIf(skipIntegration)('app-role grants against the migrated schema', () => {
  beforeAll(async () => {
    const { rows } = (await db.raw(`select rolsuper from pg_roles where rolname = current_user`)) as {
      rows: Array<{ rolsuper: boolean }>;
    };
    if (!rows[0]?.rolsuper) return;
    await db.raw(`create role "${scratchRole}" nologin nosuperuser nobypassrls`);
    scratchRoleCreated = true;
  });

  afterAll(async () => {
    if (!scratchRoleCreated) return;
    await db.raw(`drop owned by "${scratchRole}"`);
    await db.raw(`drop role "${scratchRole}"`);
  });

  it('cover every table with row-level security', async () => {
    const rls = await publicTables('c.relrowsecurity');
    expect(rls.filter((t) => !listed.has(t))).toEqual([]);
  });

  it('name only tables that exist', async () => {
    const existing = new Set(await publicTables());
    expect([...listed.keys()].filter((t) => !existing.has(t))).toEqual([]);
  });

  it('give a freshly provisioned role exactly the listed privileges', async () => {
    if (!scratchRoleCreated) return;
    await grantAppRole(db, scratchRole);
    const held = await privileges(scratchRole);
    const wrong = [...listed]
      .filter(([t, privs]) => held.get(t)?.join() !== privs.join())
      .map(([t, privs]) => `${t}: want ${privs.join()}, got ${held.get(t)?.join() ?? 'nothing'}`);
    expect(wrong).toEqual([]);

    // The query that failed on Oct 26 2026, now under RLS as that role.
    await db.transaction(async (trx) => {
      await trx.raw('set local row_security = on');
      await trx.raw(`set local role "${scratchRole}"`);
      await trx.raw('select 1 from ?? limit 0', [TABLES.Program]);
    });
  });

  it('grant no table more than its own migration granted openpartner_app', async () => {
    // Only meaningful where openpartner_app existed when the migrations
    // ran, so each one's conditional grant landed on it. Tables it holds
    // nothing on (CI, or the app_role migration's own list on a DB
    // migrated without OPENPARTNER_APP_DB_PASSWORD) are skipped.
    const fromMigrations = await privileges('openpartner_app');
    const wider = [...listed]
      .filter(([t, privs]) => {
        const had = fromMigrations.get(t);
        return had && privs.some((p) => !had.includes(p));
      })
      .map(([t, privs]) => `${t}: listed ${privs.join()}, migration ${fromMigrations.get(t)!.join()}`);
    expect(wider).toEqual([]);
  });
});
