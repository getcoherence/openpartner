import type { Knex } from 'knex';

/**
 * Provision a non-superuser app role that's actually subject to RLS.
 *
 * Postgres bypasses RLS for superusers and BYPASSRLS roles regardless
 * of FORCE ROW LEVEL SECURITY on the table. So RLS only protects when
 * the app connects as a role that has neither flag.
 *
 * This migration creates `openpartner_app` if it doesn't exist, grants
 * it DML on all tenanted tables, and sets it as the role the app uses
 * at runtime (via the OPENPARTNER_APP_DB_PASSWORD env var).
 *
 * Migrations continue running as the cluster role (doadmin in DO,
 * `openpartner` in dev docker-compose) — that's the role with the
 * privileges to run DDL.
 *
 * If OPENPARTNER_APP_DB_PASSWORD is unset, the migration is skipped
 * with a notice. Self-host installs that don't need RLS isolation can
 * leave it unset and run the app as the same role as migrations
 * (RLS is bypassed but app-level tenantId filtering still applies).
 */
export async function up(knex: Knex): Promise<void> {
  const password = process.env.OPENPARTNER_APP_DB_PASSWORD;
  if (!password) {
    console.log('[migrate] OPENPARTNER_APP_DB_PASSWORD unset — skipping app-role provisioning');
    console.log('[migrate]   App will run as the migration role; RLS will be bypassed (superuser).');
    console.log('[migrate]   Set OPENPARTNER_APP_DB_PASSWORD on next migrate to enable RLS enforcement.');
    return;
  }

  // Postgres role-management statements don't accept parameter binds — we
  // have to inline. Reject anything that could break out of the literal.
  if (!/^[A-Za-z0-9_\-!@#$%^&*+=.,:?/]+$/.test(password)) {
    throw new Error(
      'OPENPARTNER_APP_DB_PASSWORD contains characters that are not safe to inline in CREATE ROLE',
    );
  }
  const literal = `'${password}'`;

  // Idempotent: CREATE ROLE will fail if it exists; check first.
  const existing = (await knex.raw(`select 1 from pg_roles where rolname = 'openpartner_app'`)) as {
    rows: unknown[];
  };
  if (existing.rows.length === 0) {
    await knex.raw(`create role openpartner_app login password ${literal}`);
  } else {
    await knex.raw(`alter role openpartner_app password ${literal}`);
  }

  // Grant connect + schema usage.
  const dbName = (await knex.raw('select current_database() as n')).rows[0].n as string;
  await knex.raw(`grant connect on database "${dbName}" to openpartner_app`);
  await knex.raw('grant usage on schema public to openpartner_app');

  // Grant DML on all tenanted tables. The app needs SELECT/INSERT/UPDATE/DELETE
  // — DDL stays with the migration role.
  const TENANT_TABLES = [
    'Tenant', // app reads its own tenant via RLS
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
    'PlatformAdmin',
  ];
  for (const tbl of TENANT_TABLES) {
    await knex.raw(`grant select, insert, update, delete on "${tbl}" to openpartner_app`);
  }

  // Sequences are also needed if any table uses serial/identity columns.
  // None of ours do (we use ULIDs as strings), but leave the grant for
  // future tables.
  await knex.raw('grant usage on all sequences in schema public to openpartner_app');

  // Set GUC permissions: openpartner_app needs to be able to set
  // app.tenant_id and app.platform_admin via SET LOCAL. Custom GUCs are
  // settable by any role by default; explicit grant not required.

  console.log('[migrate] openpartner_app role ready; configure DATABASE_URL to use it.');
}

export async function down(knex: Knex): Promise<void> {
  const exists = (await knex.raw(`select 1 from pg_roles where rolname = 'openpartner_app'`)) as {
    rows: unknown[];
  };
  if (exists.rows.length === 0) return;
  // Drop the role's privileges first, then the role itself.
  const dbName = (await knex.raw('select current_database() as n')).rows[0].n as string;
  await knex.raw(`revoke all privileges on all tables in schema public from openpartner_app`);
  await knex.raw(`revoke all privileges on all sequences in schema public from openpartner_app`);
  await knex.raw(`revoke all privileges on database "${dbName}" from openpartner_app`);
  await knex.raw(`revoke usage on schema public from openpartner_app`);
  await knex.raw(`drop role if exists openpartner_app`);
}
