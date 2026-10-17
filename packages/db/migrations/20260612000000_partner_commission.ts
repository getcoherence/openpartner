import type { Knex } from 'knex';

/**
 * Per-Partner commission snapshot.
 *
 * Sidecar to Partner (1:1, partnerId is both PK and FK). Stamped when
 * the Network's federation push provisions a Partner via /partners
 * with a commissionSnapshot field. Existing tenants with no Network
 * federation just don't write rows here; commission accrual falls
 * back to the live Campaign rule for partners without a snapshot
 * (status quo).
 *
 * Why a sidecar instead of columns on Partner:
 *   - Keeps Partner clean — most installs without Network federation
 *     never need this column set.
 *   - Sidecar lets us add a `version` column later for an amendment
 *     flow without rewriting Partner.
 *   - The "no row = use live Campaign rule" semantic is explicit by
 *     row presence rather than nullable column ambiguity.
 *
 * What's snapshotted: commission rule (type/value/recurring) +
 * holdback days. These directly determine payout amounts. NOT
 * snapshotted: attribution model/window, cookie window — those affect
 * which clicks get credit, not the dollar amount, and stay
 * Campaign-owned to avoid surprising attribution divergence.
 *
 * RLS: tenant-scoped via partnerId → Partner.tenantId. The app role
 * gets full DML; cross-tenant access is blocked via the Partner FK
 * + RLS on Partner.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('PartnerCommission', (t) => {
    t.string('partnerId').primary().references('id').inTable('Partner').onDelete('CASCADE');
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('commissionType', 16).notNullable(); // 'percent' | 'fixed'
    t.decimal('commissionValue', 12, 4).notNullable();
    t.boolean('recurring').notNullable().defaultTo(false);
    t.integer('holdbackDays').nullable();
    /** 'approval' = stamped at PartnershipRequest approval time via federation;
     *  'backfill' = retroactively populated by an admin migration script;
     *  'amendment' = updated via a future amendment-acceptance flow. */
    t.string('source', 16).notNullable();
    t.timestamp('snapshottedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId']);
  });

  // RLS: scope to current tenant via app.tenant_id GUC.
  await knex.raw(`alter table "PartnerCommission" enable row level security`);
  await knex.raw(`alter table "PartnerCommission" force row level security`);
  await knex.raw(`
    create policy partner_commission_tenant on "PartnerCommission"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);

  // App role gets DML.
  const hasAppRole = (await knex.raw(`select 1 from pg_roles where rolname = 'openpartner_app'`)) as {
    rows: unknown[];
  };
  if (hasAppRole.rows.length > 0) {
    await knex.raw(`grant select, insert, update, delete on "PartnerCommission" to openpartner_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop policy if exists partner_commission_tenant on "PartnerCommission"');
  await knex.schema.dropTableIfExists('PartnerCommission');
}
