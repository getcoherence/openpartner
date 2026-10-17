import type { Knex } from 'knex';

/**
 * The commission-floor platform fee (docs/platform-fee.md).
 *
 * The hosted fee was a share of attributed revenue, where "revenue" meant
 * the value of invoice_paid / subscription_created events. Revenue reported
 * under any other name, or with no value, paid nothing while partners still
 * earned commission on it. The new rule bills each attributed conversion
 *
 *   max(revenueRate × revenue, commissionRate × commissions on it)
 *
 * and this migration adds what that needs:
 *
 *  1. Program.revenueEventTypes — CORE, exported. The event types the brand
 *     declares are sales in this program (e.g. `order_paid` paid with fixed
 *     bounties), on top of invoice_paid / subscription_created. A brand
 *     fact about its own events, not hosted metadata, so it travels with
 *     the program; NOT NULL with a constant default so a bundle from before
 *     it imports with `{}`.
 *
 *     Replaces the platform-wide OPENPARTNER_BILLABLE_EVENT_TYPES_EXTRA env
 *     var. Migration path: when that var is set where this runs, its types
 *     are copied onto every existing program, so nothing billed under it
 *     stops being billed. Programs created later declare their own.
 *
 *  2. HostedFeeTerms — HOSTED BILLING SIDECAR, not exported. Per tenant:
 *     when its paid plan started, when the new rule took effect for it and
 *     why (a plan started after the cutover, a pricing-change notice, or a
 *     contract), the notice it was sent, and contract rate overrides with a
 *     monthly minimum.
 *
 *  3. UsageFeeShadow — HOSTED BILLING SIDECAR, not exported. For a tenant
 *     still on the old rule, every usage report also records what the new
 *     rule would have billed for the same conversions, for the ops console.
 *
 *  4. UsageLedger.terms — the fee terms a conversion was first billed under
 *     (rule version, rates, whether it counted as revenue). Later reports
 *     re-derive the conversion's basis with the SAME terms, so changing a
 *     rate or a program's revenue types never re-bills or credits history.
 *     Null on rows written before this: the old rule.
 *
 * RLS + app-role grants follow the canonical tenant_isolation pattern
 * (20260807000000_partner_program_rls.ts).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Program', (t) => {
    t.specificType('revenueEventTypes', 'text[]').notNullable().defaultTo('{}');
  });
  const extra = [
    ...new Set(
      (process.env.OPENPARTNER_BILLABLE_EVENT_TYPES_EXTRA ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && s !== 'invoice_paid' && s !== 'subscription_created'),
    ),
  ];
  if (extra.length > 0) {
    await knex.raw(`update "Program" set "revenueEventTypes" = ?::text[]`, [extra]);
  }

  await knex.schema.createTable('HostedFeeTerms', (t) => {
    t.string('tenantId', 32).primary().references('id').inTable('Tenant').onDelete('CASCADE');
    // The Stripe subscription planStartedAt was read from: a new
    // subscription (cancel, then subscribe again) is a new plan start.
    t.string('planSubscriptionId', 255);
    t.timestamp('planStartedAt', { useTz: true });
    // Conversions first attributed at or after this are billed on the new
    // rule. Null: the old rule.
    t.timestamp('effectiveAt', { useTz: true });
    t.string('effectiveSource', 16);
    t.timestamp('noticeSentAt', { useTz: true });
    t.string('noticeSentByEmail', 255);
    t.jsonb('noticeRecipients');
    // Contract overrides (null = the plan's platform rates).
    t.decimal('revenueRate', 8, 6);
    t.decimal('commissionRate', 8, 6);
    t.decimal('monthlyMinimumUsd', 12, 2);
    t.text('contractNote');
    t.string('updatedByEmail', 255);
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`
    alter table "HostedFeeTerms"
      add constraint hosted_fee_terms_source_check
        check ("effectiveSource" is null or "effectiveSource" in ('new_plan', 'notice', 'contract')),
      add constraint hosted_fee_terms_rates_check
        check (
          ("revenueRate" is null or ("revenueRate" >= 0 and "revenueRate" <= 1))
          and ("commissionRate" is null or ("commissionRate" >= 0 and "commissionRate" <= 1))
          and ("monthlyMinimumUsd" is null or "monthlyMinimumUsd" >= 0)
        )
  `);

  await knex.schema.createTable('UsageFeeShadow', (t) => {
    t.string('id').primary();
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    // The usage report it rode on (UsageLedger.reportKey).
    t.string('reportKey', 200).notNullable();
    t.timestamp('rangeStart', { useTz: true });
    t.timestamp('rangeEnd', { useTz: true }).notNullable();
    t.string('mode', 16).notNullable();
    // Conversions first attributed in the window, billed or not.
    t.integer('conversions').notNullable();
    t.decimal('oldBasisUsd', 18, 6).notNullable();
    t.decimal('newBasisUsd', 18, 6).notNullable();
    t.decimal('oldFeeUsd', 18, 6).notNullable();
    t.decimal('newFeeUsd', 18, 6).notNullable();
    // Conversions the commission floor set the fee for.
    t.integer('floorConversions').notNullable();
    // Conversions billed on revenue only because they paid a percent
    // commission under a non-revenue type name.
    t.integer('renamedSaleConversions').notNullable();
    // Basis in currencies with no published rate, not in the USD totals.
    t.jsonb('heldOut');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['tenantId', 'reportKey']);
    t.index(['tenantId', 'rangeEnd']);
  });

  await knex.schema.alterTable('UsageLedger', (t) => {
    t.jsonb('terms');
  });

  for (const table of ['HostedFeeTerms', 'UsageFeeShadow']) {
    await knex.raw(`alter table "${table}" enable row level security`);
    await knex.raw(`alter table "${table}" force row level security`);
    await knex.raw(`
      create policy tenant_isolation on "${table}"
        using (
          "tenantId" = current_setting('app.tenant_id', true)
          or current_setting('app.platform_admin', true) = 'on'
        )
        with check (
          "tenantId" = current_setting('app.tenant_id', true)
          or current_setting('app.platform_admin', true) = 'on'
        )
    `);
  }
  // The reporter (tenant-scoped) reads and fills in its own terms row and
  // writes shadow rows; everything else is the ops console's privileged pool.
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update on "HostedFeeTerms" to openpartner_app';
        execute 'grant select, insert on "UsageFeeShadow" to openpartner_app';
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
        execute 'revoke all privileges on "HostedFeeTerms" from openpartner_app';
        execute 'revoke all privileges on "UsageFeeShadow" from openpartner_app';
      end if;
    end
    $$;
  `);
  for (const table of ['HostedFeeTerms', 'UsageFeeShadow']) {
    await knex.raw(`drop policy if exists tenant_isolation on "${table}"`);
  }
  await knex.schema.dropTableIfExists('UsageFeeShadow');
  await knex.schema.dropTableIfExists('HostedFeeTerms');
  await knex.schema.alterTable('UsageLedger', (t) => {
    t.dropColumn('terms');
  });
  await knex.schema.alterTable('Program', (t) => {
    t.dropColumn('revenueEventTypes');
  });
}
