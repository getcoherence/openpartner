import type { Knex } from 'knex';

/**
 * Tenant RLS policies become plain `"tenantId" = app.tenant_id` equality.
 *
 * Until now most tenant policies read
 *
 *   "tenantId" = current_setting('app.tenant_id', true)
 *     or current_setting('app.platform_admin', true) = 'on'
 *
 * The OR keeps the planner from using a tenant-leading index for the policy,
 * so any query that leaves tenant scoping to RLS scans every tenant's rows
 * (Partner by email: Seq Scan over 50k rows, 3 ms -> 0.04 ms without the OR).
 * Queries that do name tenantId got a ~50x row underestimate, because the
 * OR'd policy multiplies in as a second, independent filter. Plain equality
 * fixes both: the policy becomes an index condition, and when the query also
 * says `tenantId = ?` the planner merges the two into one equivalence class
 * (exact estimates; the policy collapses to a one-time check).
 *
 * The platform-admin escape hatch moves out of the database. tenancy.ts runs
 * a platform admin's tenant request on the privileged pool (row_security =
 * off, the pool /platform-admin/* already uses) instead of setting
 * app.platform_admin on the app pool. The GUC was settable by any SQL running
 * as openpartner_app, `set_config('app.platform_admin', 'on', true)` inside a
 * SELECT included, so it widened a tenant session to every tenant. After this
 * migration no policy reads it.
 *
 * Policies are found in pg_policies rather than listed, so tables added by
 * migrations that merge before this one are covered too. Each rewritten
 * policy is tagged with COMMENT ON POLICY; down() restores exactly the tagged
 * ones. Shapes handled:
 *
 *   tenant_isolation (every tenant table)  OR -> "tenantId" = app.tenant_id
 *   tenant_self on Tenant                  OR -> id = app.tenant_id
 *   platform_admin_self on PlatformAdmin   GUC -> false (app role never reads it)
 *
 * Anything else that mentions app.platform_admin aborts the migration rather
 * than being rewritten blind. tenant-policy-shape.test.ts fails if a later
 * migration brings the OR back.
 */

const TAG_PREFIX = 'rls_plain_tenant_policies:';

type Shape = 'tenant' | 'tenant_self' | 'platform_admin';

const TENANT_EQ = `"tenantId" = current_setting('app.tenant_id', true)`;
const TENANT_SELF_EQ = `id = current_setting('app.tenant_id', true)`;
const PLATFORM_GUC = `current_setting('app.platform_admin', true) = 'on'`;

const NEW_PREDICATE: Record<Shape, string> = {
  tenant: TENANT_EQ,
  tenant_self: TENANT_SELF_EQ,
  platform_admin: 'false',
};

const OLD_PREDICATE: Record<Shape, string> = {
  tenant: `${TENANT_EQ} or ${PLATFORM_GUC}`,
  tenant_self: `${TENANT_SELF_EQ} or ${PLATFORM_GUC}`,
  platform_admin: PLATFORM_GUC,
};

/** pg_policies deparses with casts and parentheses; compare without them. */
function normalize(expr: string): string {
  return expr.replace(/::text/g, '').replace(/[()\s]/g, '').toLowerCase();
}

const KNOWN_SHAPES = Object.entries(OLD_PREDICATE).map(([shape, sql]) => [normalize(sql), shape as Shape] as const);

function classify(qual: string | null): Shape | null {
  if (qual === null) return null;
  const n = normalize(qual);
  return KNOWN_SHAPES.find(([known]) => known === n)?.[1] ?? null;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** ALTER POLICY takes an ACCESS EXCLUSIVE lock on each table until the
 *  migration commits. Behind a long-running query that request would queue
 *  every later query on the table; failing the deploy (the entrypoint
 *  refuses to boot) and retrying is the better outcome. */
async function boundLockWait(knex: Knex): Promise<void> {
  await knex.raw(`set local lock_timeout = '5s'`);
}

export async function up(knex: Knex): Promise<void> {
  await boundLockWait(knex);
  const { rows } = (await knex.raw(
    `select tablename, policyname, qual, with_check
       from pg_policies
      where schemaname = current_schema()
        and (qual like '%app.platform_admin%' or with_check like '%app.platform_admin%')
      order by tablename, policyname`,
  )) as { rows: Array<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }> };

  const plan = rows.map((r) => {
    const shape = classify(r.qual);
    if (!shape || classify(r.with_check) !== shape) {
      throw new Error(
        `[rls_plain_tenant_policies] ${r.tablename}.${r.policyname} references app.platform_admin in an unexpected shape; ` +
          `rewrite it by hand. using: ${r.qual} / with check: ${r.with_check}`,
      );
    }
    return { ...r, shape };
  });

  for (const p of plan) {
    const target = `${ident(p.policyname)} on ${ident(p.tablename)}`;
    const predicate = NEW_PREDICATE[p.shape];
    await knex.raw(`alter policy ${target} using (${predicate}) with check (${predicate})`);
    await knex.raw(`comment on policy ${target} is '${TAG_PREFIX}${p.shape}'`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await boundLockWait(knex);
  const { rows } = (await knex.raw(
    `select c.relname as tablename, p.polname as policyname, d.description
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_description d on d.objoid = p.oid and d.classoid = 'pg_policy'::regclass
      where n.nspname = current_schema()
        and d.description like ?
      order by c.relname, p.polname`,
    [`${TAG_PREFIX}%`],
  )) as { rows: Array<{ tablename: string; policyname: string; description: string }> };

  for (const r of rows) {
    const shape = r.description.slice(TAG_PREFIX.length) as Shape;
    const predicate = OLD_PREDICATE[shape];
    if (!predicate) throw new Error(`[rls_plain_tenant_policies] unknown tag on ${r.tablename}.${r.policyname}: ${r.description}`);
    const target = `${ident(r.policyname)} on ${ident(r.tablename)}`;
    await knex.raw(`alter policy ${target} using (${predicate}) with check (${predicate})`);
    await knex.raw(`comment on policy ${target} is null`);
  }
}
