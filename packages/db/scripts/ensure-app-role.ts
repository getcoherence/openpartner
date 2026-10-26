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
import { grantAppRole } from '../src/app-role-grants.js';

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

    // connect, schema usage, table and sequence grants (src/app-role-grants.ts)
    await grantAppRole(db);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('[ensure-app-role] failed:', err);
  process.exit(1);
});
