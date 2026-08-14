/**
 * Idempotent app-role provisioning, run on every boot.
 *
 * The original role-creation lives in migration 20260507020000_app_role.ts
 * — but that's a one-shot: knex_migrations marks it applied and never
 * re-runs. So if OPENPARTNER_APP_DB_PASSWORD changes after the first
 * apply (or was unset on first apply and set later), there's no path
 * back into the migration. Postgres ends up with a different password
 * than the env, and the app pool fails authentication forever.
 *
 * This script reconciles every boot: if the env var is set, the role
 * exists with that exact password and has the necessary grants. Safe
 * to run on a healthy DB — every statement is idempotent.
 *
 * Skipped entirely when OPENPARTNER_APP_DB_PASSWORD is unset, matching
 * the migration's behavior so self-hosters who don't want RLS aren't
 * forced into role management.
 */

import 'dotenv/config';
import knex from 'knex';
import config from '../knexfile.js';

// Tables that the app role needs DML on. Mirrors the list inside the
// app_role migration; kept in sync manually because both grow as new
// tenanted tables land. (Coupon + NetworkOutbox got their own
// conditional grants in their own migrations — those are also redone
// here so a freshly-provisioned role lands fully wired.)
const TENANT_TABLES = [
  'Tenant',
  'Partner',
  'Campaign',
  'PartnerCampaign',
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
  'PlatformSession',
  'WebhookEndpoint',
  'WebhookDelivery',
  'PlatformAdmin',
  'NetworkOutbox',
  'Coupon',
  'PartnerCommission',
];

// Tables where the app role gets LESS than full DML. OperatorRecoveryRequest
// is append-only from the app's side: the API inserts and lists, every
// update runs on the privileged pool, and withholding UPDATE/DELETE here is
// what makes the audit trail tamper-resistant to tenant-scoped code.
const RESTRICTED_GRANTS: Array<{ table: string; grant: string }> = [
  { table: 'OperatorRecoveryRequest', grant: 'select, insert' },
];

async function main(): Promise<void> {
  const password = process.env.OPENPARTNER_APP_DB_PASSWORD;
  if (!password) {
    console.log('[ensure-app-role] OPENPARTNER_APP_DB_PASSWORD unset — skipping');
    return;
  }

  // Same allow-list as the migration. Postgres role DDL doesn't accept
  // bind params, so we inline. Anything that could close the literal is
  // refused up front.
  if (!/^[A-Za-z0-9_\-!@#$%^&*+=.,:?/]+$/.test(password)) {
    throw new Error(
      'OPENPARTNER_APP_DB_PASSWORD contains characters that are not safe to inline in CREATE ROLE',
    );
  }
  const literal = `'${password}'`;

  const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const db = knex(config[env]!);

  try {
    // role + password
    const existing = (await db.raw(`select 1 from pg_roles where rolname = 'openpartner_app'`)) as {
      rows: unknown[];
    };
    if (existing.rows.length === 0) {
      await db.raw(`create role openpartner_app login password ${literal}`);
      console.log('[ensure-app-role] created openpartner_app');
    } else {
      await db.raw(`alter role openpartner_app password ${literal}`);
      console.log('[ensure-app-role] synced openpartner_app password');
    }

    // connect + schema usage
    const dbName = (await db.raw('select current_database() as n')).rows[0].n as string;
    await db.raw(`grant connect on database "${dbName}" to openpartner_app`);
    await db.raw('grant usage on schema public to openpartner_app');

    // DML on tenanted tables. Skip silently if a table doesn't exist yet
    // — keeps boot-time reconciliation safe on a freshly-migrated DB
    // where one of these tables hasn't shipped yet (e.g. running an old
    // image against a schema older than this script's table list).
    for (const tbl of TENANT_TABLES) {
      const tableExists = (await db.raw(
        `select 1 from information_schema.tables where table_schema = 'public' and table_name = ?`,
        [tbl],
      )) as { rows: unknown[] };
      if (tableExists.rows.length === 0) continue;
      await db.raw(`grant select, insert, update, delete on "${tbl}" to openpartner_app`);
    }
    for (const { table, grant } of RESTRICTED_GRANTS) {
      const tableExists = (await db.raw(
        `select 1 from information_schema.tables where table_schema = 'public' and table_name = ?`,
        [table],
      )) as { rows: unknown[] };
      if (tableExists.rows.length === 0) continue;
      // Revoke first so a role provisioned before the grant narrowed
      // doesn't keep the wider privileges forever.
      await db.raw(`revoke all privileges on "${table}" from openpartner_app`);
      await db.raw(`grant ${grant} on "${table}" to openpartner_app`);
    }

    await db.raw('grant usage on all sequences in schema public to openpartner_app');
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('[ensure-app-role] failed:', err);
  process.exit(1);
});
