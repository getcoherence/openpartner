import type { Knex } from 'knex';

/**
 * Pay-by-invoice billing for hosted brands (docs/invoice-billing.md).
 *
 * Some brands can't be auto-charged reliably — Indian cards under RBI's
 * e-mandate rules need the cardholder to approve each recurring debit over
 * ₹15,000. Those brands get a Stripe subscription with
 * collection_method=send_invoice instead: Stripe emails each monthly
 * invoice and the brand pays it from the hosted invoice page (card or bank
 * transfer).
 *
 *  1. HostedBillingProfile — HOSTED BILLING SIDECAR, not exported. Per
 *     tenant: how its OpenPartner subscription is collected (an ops choice;
 *     null follows the country default in PlatformSetting
 *     'invoiceBilling'), the invoice terms, the overdue grace before partner
 *     onboarding pauses, and the brand's Indian GSTIN (printed on invoices
 *     as Stripe customer tax ID in_gst; who last set it is kept apart from
 *     who set the terms). A row exists only once ops or the brand set
 *     something.
 *
 *  2. HostedBillingState gains how the LIVE subscription is collected, the
 *     oldest open pay-by-invoice invoice (id + due date) the overdue grace
 *     counts from, and when the brand first paid a non-zero invoice (no
 *     grace before that). Overdue follows the invoices rather than the
 *     subscription status: Stripe derives the status from the LATEST
 *     invoice only, so paying February made it active again while January
 *     was still owed.
 *
 * RLS + app-role grant follow the canonical tenant_isolation pattern, with
 * the plain predicate 20261017100000_rls_plain_tenant_policies settled on.
 * The brand writes its own GSTIN through the tenant-scoped pool; everything
 * else is the ops console's privileged pool.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('HostedBillingProfile', (t) => {
    t.string('tenantId', 32).primary().references('id').inTable('Tenant').onDelete('CASCADE');
    // 'send_invoice' | 'charge_automatically'. Null: the country default.
    t.string('collectionMethod', 32);
    t.integer('daysUntilDue').notNullable().defaultTo(15);
    t.integer('graceDays').notNullable().defaultTo(30);
    t.string('gstin', 15);
    t.string('gstinUpdatedByEmail', 255);
    t.timestamp('gstinUpdatedAt', { useTz: true });
    t.string('updatedByEmail', 255);
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`
    alter table "HostedBillingProfile"
      add constraint hosted_billing_profile_method_check
        check ("collectionMethod" is null or "collectionMethod" in ('send_invoice', 'charge_automatically')),
      add constraint hosted_billing_profile_terms_check
        check ("daysUntilDue" between 1 and 90 and "graceDays" between 0 and 180),
      add constraint hosted_billing_profile_gstin_check
        check ("gstin" is null or "gstin" ~ '^[0-9]{2}[A-Z0-9]{13}$')
  `);

  await knex.schema.alterTable('HostedBillingState', (t) => {
    t.string('collectionMethod', 32);
    t.string('oldestOpenInvoiceId', 255);
    t.timestamp('oldestOpenInvoiceDueAt', { useTz: true });
    t.timestamp('invoicePaidAt', { useTz: true });
  });

  await knex.raw(`alter table "HostedBillingProfile" enable row level security`);
  await knex.raw(`alter table "HostedBillingProfile" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "HostedBillingProfile"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update on "HostedBillingProfile" to openpartner_app';
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
        execute 'revoke all privileges on "HostedBillingProfile" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "HostedBillingProfile"`);
  await knex.schema.dropTableIfExists('HostedBillingProfile');
  await knex.schema.alterTable('HostedBillingState', (t) => {
    t.dropColumn('invoicePaidAt');
    t.dropColumn('oldestOpenInvoiceDueAt');
    t.dropColumn('oldestOpenInvoiceId');
    t.dropColumn('collectionMethod');
  });
}
