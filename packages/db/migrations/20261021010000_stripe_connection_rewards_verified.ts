import type { Knex } from 'knex';

/**
 * TenantStripeConnection.rewardsVerifiedAt — when a reward backfill last
 * finished checking every partner code's promotion code against THIS
 * connection's Stripe account (apps/api/src/customer-rewards.ts
 * backfillCustomerRewards).
 *
 * A connect clears it and starts that check in the background. A promo id
 * stored under another account (a previous connection, live vs. test mode)
 * isn't in this one, and the check is what re-provisions it. Until the
 * check completes (a Stripe outage, a deploy mid-pass), the hourly sweep
 * runs it again. Null on existing rows, so the first sweep after deploy
 * checks every connected brand once.
 *
 * Hosted-only sidecar, never exported, like the rest of the table.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('TenantStripeConnection', (t) => {
    t.timestamp('rewardsVerifiedAt', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('TenantStripeConnection', (t) => {
    t.dropColumn('rewardsVerifiedAt');
  });
}
