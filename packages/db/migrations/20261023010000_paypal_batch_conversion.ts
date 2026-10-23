import type { Knex } from 'knex';

/**
 * PaypalPayoutBatch.conversion — a Pay with PayPal batch that sends a
 * balance PayPal can't send in its own currency (INR) in a PayPal currency
 * the brand chose (USD), at the ECB reference rate quoted before sending
 * (docs/paypal-payouts.md "Balances PayPal can't send").
 *
 * `{ sourceCurrency, sourceTotal, rate, rateSource: "ecb", rateDate,
 * quotedAt }`, frozen when the batch is made. The batch's own `currency`
 * and `total` are what PayPal sends (USD); the payouts keep their INR
 * amount and currency, and each payout's `metadata.manualExport.conversion`
 * records its own amounts, which is what travels in an export. Null on a
 * batch sent in the payouts' own currency, which is every batch made
 * before this column.
 *
 * PaypalPayoutBatch is delivery state and isn't exported
 * (docs/data-portability.md), so no schemaVersion bump.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('PaypalPayoutBatch', (t) => {
    t.jsonb('conversion').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('PaypalPayoutBatch', (t) => {
    t.dropColumn('conversion');
  });
}
