import type { Knex } from 'knex';

/**
 * Grant DML on BrandAsset to the openpartner_app role.
 *
 * Companion to 20260623000000_brand_resources, which created the table +
 * RLS policy but forgot the per-table GRANT. Without it, the app role
 * gets "permission denied for table BrandAsset" on every query — surfaces
 * as `internal_error` on /brand-resources GET.
 *
 * Idempotent DO-block guard matches the pattern other tenanted tables
 * use: no-op when the role doesn't exist (CI / single-tenant installs
 * where OPENPARTNER_APP_DB_PASSWORD is unset and the app runs as the
 * migration role, bypassing RLS).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "BrandAsset" to openpartner_app';
      end if;
    end
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'revoke select, insert, update, delete on "BrandAsset" from openpartner_app';
      end if;
    end
    $$;
  `);
}
