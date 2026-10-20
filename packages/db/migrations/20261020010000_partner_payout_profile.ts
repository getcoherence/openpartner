import type { Knex } from 'knex';

/**
 * PartnerPayoutProfile — where a partner wants manual-rail payouts sent
 * (docs/manual-payout-files.md).
 *
 * The manual rail is the brand paying off-platform: OpenPartner records the
 * payout and the brand sends the money from its own PayPal or Wise account.
 * Until now nothing stored where to send it, so every brand kept a
 * spreadsheet. This table holds one destination per partner, which the
 * brand turns into a PayPal Payouts or Wise batch file. Money never passes
 * through OpenPartner.
 *
 * Sidecar to Partner (1:1, partnerId is both PK and FK), like
 * PartnerNetworkConsent: most partners on a Connect program never need one.
 *
 *   method   'paypal' | 'bank' | 'upi' | 'other' — in the clear, so the
 *            batch page can sort partners into files without opening
 *            every row.
 *   country  where the account is held (ISO 3166-1 alpha-2), in the clear
 *            for the country-access check; null where the method has none
 *            (a PayPal email, free-text instructions).
 *   details  everything else (email, account holder, IBAN, account and
 *            routing numbers, UPI ID, instructions) as JSON, sealed with
 *            AES-256-GCM under SECRETS_ENCRYPTION_KEY
 *            (apps/api/src/payout-profile.ts). A row holds plaintext JSON
 *            only between a SQL-dump restore and its first read, which
 *            seals it.
 *   updatedBy who last saved it: 'partner' (portal), 'admin' (portal
 *            session) or 'api' (an API key). Changed details shortly
 *            before a payout are a classic account-takeover pattern, so
 *            the batch page shows recent changes.
 *
 * Cascades with the partner and the tenant; the tenant purge also deletes
 * it explicitly (scheduler.ts TENANT_PURGE_ORDER). Exported in the
 * portability bundle with the details opened (export schemaVersion 9).
 *
 * RLS + app-role grant follow the canonical tenant_isolation pattern, with
 * the plain predicate 20261017100000_rls_plain_tenant_policies settled on.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('PartnerPayoutProfile', (t) => {
    t.string('partnerId').primary().references('id').inTable('Partner').onDelete('CASCADE');
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('method', 16).notNullable();
    t.string('country', 2);
    t.text('details').notNullable();
    t.string('updatedBy', 16).notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId', 'method']);
  });
  await knex.raw(`
    alter table "PartnerPayoutProfile"
      add constraint partner_payout_profile_method_check
        check (method in ('paypal', 'bank', 'upi', 'other')),
      add constraint partner_payout_profile_country_check
        check (country is null or (country = upper(country) and length(country) = 2)),
      add constraint partner_payout_profile_updated_by_check
        check ("updatedBy" in ('partner', 'admin', 'api'))
  `);

  await knex.raw(`alter table "PartnerPayoutProfile" enable row level security`);
  await knex.raw(`alter table "PartnerPayoutProfile" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "PartnerPayoutProfile"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "PartnerPayoutProfile" to openpartner_app';
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
        execute 'revoke all privileges on "PartnerPayoutProfile" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "PartnerPayoutProfile"`);
  await knex.schema.dropTableIfExists('PartnerPayoutProfile');
}
