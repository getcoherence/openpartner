import type { Knex } from 'knex';

/**
 * Backfill RLS + app-role grant for PartnerProgram (formerly
 * PartnerCampaign).
 *
 * The table was created by 20260511000000_partner_campaign.ts — AFTER the
 * global RLS/grant migrations (20260507010000_rls_policies.ts,
 * 20260507020000_app_role.ts) — and, unlike every tenant table created
 * since (e.g. PartnerPostback), never got its own `tenant_isolation`
 * policy or `openpartner_app` DML grant. The later rename migration
 * (20260618000000) only renamed constraints and *assumed* a policy already
 * existed; it did not, so PartnerProgram has been running with neither.
 *
 * Consequences this closes:
 *   - App-role deploys (multi-tenant, DATABASE_URL_APP set): every query to
 *     PartnerProgram throws `permission denied` — partner↔program access
 *     management is broken until the grant exists.
 *   - Privileged-pool deploys: no RLS policy means no tenant filter, so a
 *     query that leans on RLS (partner-campaigns.ts derives scope from
 *     partnerId + the tenant GUC, not an explicit tenantId column filter)
 *     is not isolated.
 *
 * Mirrors the canonical pattern in 20260613000000_partner_postback.ts.
 */

export async function up(knex: Knex): Promise<void> {
  // Guarded so a re-run (or a hand-patched DB) doesn't error.
  await knex.raw(`alter table "PartnerProgram" enable row level security`);
  await knex.raw(`alter table "PartnerProgram" force row level security`);
  await knex.raw(`drop policy if exists tenant_isolation on "PartnerProgram"`);
  await knex.raw(`
    create policy tenant_isolation on "PartnerProgram"
      using (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
      with check (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
  `);
  // Idempotent grant — no-op when the openpartner_app role doesn't exist
  // (CI / single-tenant deploys where OPENPARTNER_APP_DB_PASSWORD is unset
  // and the app runs as the migration role, bypassing RLS). Same DO-block
  // guard the other RLS-tagged tables use.
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "PartnerProgram" to openpartner_app';
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
        execute 'revoke all privileges on "PartnerProgram" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "PartnerProgram"`);
  await knex.raw(`alter table "PartnerProgram" disable row level security`);
}
