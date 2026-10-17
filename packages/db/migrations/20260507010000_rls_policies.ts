import type { Knex } from 'knex';

/**
 * Row-Level Security: defense-in-depth for tenant isolation.
 *
 * Application middleware sets `app.tenant_id` per request via SET LOCAL
 * inside a transaction. Every data table has a policy that filters rows
 * to that GUC value. Even if a developer forgets a `WHERE tenantId = ?`
 * filter, RLS returns 0 rows.
 *
 * FORCE ROW LEVEL SECURITY is critical: without it, the table owner
 * (the role running migrations and queries) bypasses policies. With
 * FORCE, even the owner is subject to RLS at runtime. Migrations bypass
 * via `SET row_security = off` set by the migration runner.
 *
 * Platform admin escape hatch: app.platform_admin = 'on' GUC matches
 * any tenantId. Used by Coherence support tooling to read across tenants
 * for triage. Set via SET LOCAL just like app.tenant_id, only by
 * authenticated PlatformAdmin requests.
 *
 * Policy semantics:
 *   USING       — filter on SELECT/UPDATE/DELETE
 *   WITH CHECK  — verify on INSERT/UPDATE that the new row is in scope
 *
 * We use the same predicate for both so writes can't introduce rows
 * outside the current tenant.
 */
export async function up(knex: Knex): Promise<void> {
  // PlatformAdmin: separate from tenant-scoped Admin. No tenantId column;
  // these are Coherence support staff with cross-tenant read (or write,
  // for role='admin') access. Stored separately to make the boundary
  // explicit — a regular Admin can never become platform-scoped without
  // an explicit row in this table.
  await knex.schema.createTable('PlatformAdmin', (t) => {
    t.string('id').primary();
    t.string('email').notNullable().unique();
    t.string('name').notNullable();
    t.string('role').notNullable().defaultTo('support'); // 'support' | 'admin'
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('revokedAt', { useTz: true });
  });

  // Tables that get RLS. PlatformAdmin and Tenant are explicitly excluded
  // — they're cross-tenant by design. knex_migrations is also excluded;
  // the migration runner needs unrestricted access.
  const TENANT_TABLES = [
    'Partner',
    'Campaign',
    'Link',
    'Click',
    'Identity',
    'Event',
    'Attribution',
    'Commission',
    'Payout',
    'ApiKey',
    'Config',
    'Admin',
    'MagicLinkToken',
    'Session',
    'WebhookEndpoint',
    'WebhookDelivery',
  ];

  // Policy predicate: row's tenantId matches the per-request GUC, OR
  // the platform-admin override is on. Wrapped in COALESCE so an unset
  // GUC returns NULL rather than erroring (current_setting raises by
  // default for unknown names).
  const policySql = (table: string) => `
    create policy tenant_isolation on "${table}"
      using (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
      with check (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
  `;

  for (const tbl of TENANT_TABLES) {
    await knex.raw(`alter table "${tbl}" enable row level security`);
    await knex.raw(`alter table "${tbl}" force row level security`);
    await knex.raw(policySql(tbl));
  }

  // Tenant table: only platform admins read across tenants. The app
  // doesn't need to read other tenants' rows; tenancy middleware looks
  // up the current tenant explicitly via app.tenant_id resolution.
  // Allow reads where id matches app.tenant_id (so a tenant can see its
  // own row) or platform_admin is on.
  await knex.raw(`alter table "Tenant" enable row level security`);
  await knex.raw(`alter table "Tenant" force row level security`);
  await knex.raw(`
    create policy tenant_self on "Tenant"
      using (
        id = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
      with check (
        id = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
  `);

  // PlatformAdmin: only readable when platform_admin GUC is on. This
  // prevents a leaky query path from disclosing the support staff list
  // to a tenant.
  await knex.raw(`alter table "PlatformAdmin" enable row level security`);
  await knex.raw(`alter table "PlatformAdmin" force row level security`);
  await knex.raw(`
    create policy platform_admin_self on "PlatformAdmin"
      using (current_setting('app.platform_admin', true) = 'on')
      with check (current_setting('app.platform_admin', true) = 'on')
  `);
}

export async function down(knex: Knex): Promise<void> {
  const TENANT_TABLES = [
    'Partner',
    'Campaign',
    'Link',
    'Click',
    'Identity',
    'Event',
    'Attribution',
    'Commission',
    'Payout',
    'ApiKey',
    'Config',
    'Admin',
    'MagicLinkToken',
    'Session',
    'WebhookEndpoint',
    'WebhookDelivery',
  ];
  for (const tbl of TENANT_TABLES) {
    await knex.raw(`drop policy if exists tenant_isolation on "${tbl}"`);
    await knex.raw(`alter table "${tbl}" disable row level security`);
  }
  await knex.raw('drop policy if exists tenant_self on "Tenant"');
  await knex.raw('alter table "Tenant" disable row level security');
  await knex.raw('drop policy if exists platform_admin_self on "PlatformAdmin"');
  await knex.raw('alter table "PlatformAdmin" disable row level security');
  await knex.schema.dropTableIfExists('PlatformAdmin');
}
