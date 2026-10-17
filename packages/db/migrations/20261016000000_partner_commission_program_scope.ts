import type { Knex } from 'knex';

/**
 * Program-scoped partner commission terms.
 *
 * PartnerCommission was 1:1 with Partner (partnerId was the primary key),
 * so one override replaced the rule for EVERY program the partner is in.
 * A creator approved through the Network for one offering, then granted a
 * second program, was paid the first offering's terms on both.
 *
 * Adds a nullable `programId`:
 *   - null     → partner-wide: applies to every program without its own row
 *                (exactly what every existing row meant, so they keep working)
 *   - non-null → applies to that one program only
 *
 * Resolution order (attribution.ts, commission-auto-approve.ts,
 * routes/commissions.ts): program-specific row → partner-wide row →
 * Program rule.
 *
 * Keys:
 *   - `id` becomes the primary key — a nullable column can't be part of one.
 *     Existing rows get `'pcm_' || partnerId`, the same deterministic id the
 *     importer gives a schemaVersion ≤ 2 bundle's rows (export.ts
 *     `legacyPartnerCommissionId`), so exporting before this migration and
 *     re-importing after it lines up row-for-row.
 *   - Two partial unique indexes carry the natural key: one partner-wide row
 *     per partner, one row per (partner, program). Upserts name the matching
 *     index predicate in ON CONFLICT (apps/api/src/partner-commission.ts).
 *   - `id` also gets a DB default, so an INSERT that omits it — a SQL dump
 *     written before this migration — still has a key.
 *
 * RLS: the original policy (partner_commission_tenant) predates the
 * canonical shape and has no platform_admin escape hatch. Replaced with the
 * standard `tenant_isolation` policy, same as 20260807000000_partner_program_rls.
 */

const PARTNER_WIDE_UNIQUE = 'PartnerCommission_partner_wide_unique';
const PARTNER_PROGRAM_UNIQUE = 'PartnerCommission_partner_program_unique';
const PARTNER_LOOKUP_INDEX = 'PartnerCommission_partnerId_programId_index';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('PartnerCommission', (t) => {
    t.string('id').nullable();
    t.string('programId').nullable().references('id').inTable('Program').onDelete('CASCADE');
  });

  await knex.raw(`update "PartnerCommission" set "id" = 'pcm_' || "partnerId" where "id" is null`);
  await knex.raw(`
    alter table "PartnerCommission"
      alter column "id" set not null,
      alter column "id" set default ('pcm_' || md5(random()::text || clock_timestamp()::text))
  `);

  // Swap the primary key. partnerId keeps its FK to Partner (a separate
  // constraint); it just stops being unique on its own.
  await knex.raw(`alter table "PartnerCommission" drop constraint "PartnerCommission_pkey"`);
  await knex.raw(`alter table "PartnerCommission" add constraint "PartnerCommission_pkey" primary key ("id")`);

  await knex.raw(`
    create unique index "${PARTNER_WIDE_UNIQUE}"
      on "PartnerCommission" ("tenantId", "partnerId")
      where "programId" is null
  `);
  await knex.raw(`
    create unique index "${PARTNER_PROGRAM_UNIQUE}"
      on "PartnerCommission" ("tenantId", "partnerId", "programId")
      where "programId" is not null
  `);
  // The old PK index served every `where partnerId = ?` lookup (accrual,
  // the holdback joins). The unique indexes lead with tenantId, which the
  // privileged pool doesn't filter on, so keep a partnerId-led index.
  await knex.raw(`create index "${PARTNER_LOOKUP_INDEX}" on "PartnerCommission" ("partnerId", "programId")`);

  await knex.raw(`alter table "PartnerCommission" enable row level security`);
  await knex.raw(`alter table "PartnerCommission" force row level security`);
  await knex.raw(`drop policy if exists partner_commission_tenant on "PartnerCommission"`);
  await knex.raw(`drop policy if exists tenant_isolation on "PartnerCommission"`);
  await knex.raw(`
    create policy tenant_isolation on "PartnerCommission"
      using (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
      with check (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "PartnerCommission" to openpartner_app';
      end if;
    end
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Lossy by necessity: program-scoped rows have no representation in a
  // one-row-per-partner table. Export first if any exist.
  await knex.raw(`delete from "PartnerCommission" where "programId" is not null`);

  await knex.raw(`drop policy if exists tenant_isolation on "PartnerCommission"`);
  await knex.raw(`
    create policy partner_commission_tenant on "PartnerCommission"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);

  await knex.raw(`drop index if exists "${PARTNER_LOOKUP_INDEX}"`);
  await knex.raw(`drop index if exists "${PARTNER_PROGRAM_UNIQUE}"`);
  await knex.raw(`drop index if exists "${PARTNER_WIDE_UNIQUE}"`);
  await knex.raw(`alter table "PartnerCommission" drop constraint "PartnerCommission_pkey"`);
  await knex.raw(`alter table "PartnerCommission" add constraint "PartnerCommission_pkey" primary key ("partnerId")`);
  await knex.schema.alterTable('PartnerCommission', (t) => {
    t.dropColumn('programId');
    t.dropColumn('id');
  });
}
