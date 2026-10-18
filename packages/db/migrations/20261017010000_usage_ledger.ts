import type { Knex } from 'knex';

/**
 * UsageLedger — what the hosted platform fee has billed, per conversion.
 *
 * The fee is a Stripe metered price on attributed GMV. The reporter used to
 * send "GMV of events since the last report", so revenue that was refunded,
 * charged back or had its commissions reversed after it was reported stayed
 * billed, and a refund in the same window was never subtracted at all. The
 * pricing page promises the opposite ("Refunded transactions don't count").
 *
 * Now each run works out every conversion's billable value as of now (its
 * value, minus refunds, zero once every commission it earned is reversed),
 * diffs that against the sum of its rows here, and writes the difference
 * as a new row: positive to bill, negative to credit. The report sends the
 * net; Stripe meters reject negative usage, so a net credit is carried
 * forward in Config and netted against the next report. Rows are never
 * updated or deleted, so a conversion's billing history is the sum of its
 * rows.
 *
 * `usdPerUnit` is the rate the row was billed at (1 for USD, the ECB rate
 * for other currencies, null for a currency with no published rate, which
 * is held out of the meter). A credit uses the rate its conversion was
 * billed at, so refunding a conversion in full nets it to exactly zero
 * whatever the exchange rate did in between.
 *
 * Hosted billing sidecar: OpenPartner's invoice basis for the brand, not the
 * brand's attribution data. Not exported (docs/data-portability.md). No FK
 * to Event, so billing history outlives anything that happens to the raw row.
 *
 * RLS + app-role grant follow the canonical tenant_isolation pattern
 * (20260807000000_partner_program_rls.ts).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('UsageLedger', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    // The conversion Event this row bills or credits.
    t.string('eventId').notNullable();
    // The report that carried the row: its meter event identifier, '@',
    // the report's run time. op-usage-opening-<tenant> for the balance
    // recorded at cutover.
    t.string('reportKey', 200).notNullable();
    t.string('reason', 16).notNullable();
    t.string('currency', 3).notNullable();
    // Signed, in the conversion's currency: positive bills, negative credits.
    t.decimal('amount', 18, 2).notNullable();
    t.decimal('usdPerUnit', 24, 12);
    t.decimal('amountUsd', 24, 6).notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // One row per conversion per report. Runs for a tenant are serialised
    // (advisory lock); this is the last line against a bug writing a
    // conversion twice into one report.
    t.unique(['tenantId', 'reportKey', 'eventId', 'currency']);
    t.index(['tenantId', 'eventId']);
  });
  await knex.raw(`
    alter table "UsageLedger"
      add constraint usage_ledger_reason_check
        check (reason in ('opening', 'billed', 'refunded', 'reversed', 'removed')),
      add constraint usage_ledger_held_out_check
        check ("usdPerUnit" is not null or "amountUsd" = 0)
  `);

  await knex.raw(`alter table "UsageLedger" enable row level security`);
  await knex.raw(`alter table "UsageLedger" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "UsageLedger"
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
        execute 'grant select, insert on "UsageLedger" to openpartner_app';
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
        execute 'revoke all privileges on "UsageLedger" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "UsageLedger"`);
  await knex.schema.dropTableIfExists('UsageLedger');
}
