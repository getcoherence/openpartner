import type { Knex } from 'knex';

/**
 * Tenant.defaultCurrency — the brand's own currency (ISO 4217, upper case).
 *
 *   - An event, conversion, postback or coupon redemption that arrives
 *     without a currency is stored in it. Before this column they were
 *     stored as USD, so an INR brand's ₹25,000 sale sent without a currency
 *     became USD 25,000.
 *   - The portal formats amounts in it when there is no row currency to go
 *     by (empty states, zero totals).
 *   - payoutThresholdCents is now read in it.
 *
 * Runtime config, edited in Settings → Program, not an env var. Existing
 * tenants get USD: what their currency-less events were already stored as.
 *
 * payoutThresholdCents: the cap was 100,000 hundredths — $1,000, but also
 * ₹1,000, which refused a ₹5,000 minimum. The minimum is now in the tenant's
 * default currency, so the cap has to fit currencies with large unit
 * counts: 1,000,000,000 hundredths is 10,000,000 units (₹1 crore, Rp 10M)
 * and still fits the integer column.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.string('defaultCurrency', 3).notNullable().defaultTo('USD');
  });
  await knex.raw(
    `alter table "Tenant" add constraint "Tenant_defaultCurrency_check" check ("defaultCurrency" ~ '^[A-Z]{3}$')`,
  );
  await knex.raw(`alter table "Tenant" drop constraint "Tenant_payoutThresholdCents_check"`);
  await knex.raw(
    `alter table "Tenant" add constraint "Tenant_payoutThresholdCents_check" check ("payoutThresholdCents" is null or ("payoutThresholdCents" >= 0 and "payoutThresholdCents" <= 1000000000))`,
  );
}

export async function down(knex: Knex): Promise<void> {
  // Clamp first: a threshold above the old cap would fail the old check.
  await knex.raw(`update "Tenant" set "payoutThresholdCents" = 100000 where "payoutThresholdCents" > 100000`);
  await knex.raw(`alter table "Tenant" drop constraint "Tenant_payoutThresholdCents_check"`);
  await knex.raw(
    `alter table "Tenant" add constraint "Tenant_payoutThresholdCents_check" check ("payoutThresholdCents" is null or ("payoutThresholdCents" >= 0 and "payoutThresholdCents" <= 100000))`,
  );
  await knex.raw(`alter table "Tenant" drop constraint "Tenant_defaultCurrency_check"`);
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropColumn('defaultCurrency');
  });
}
