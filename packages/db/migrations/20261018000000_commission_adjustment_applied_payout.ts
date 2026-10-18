import type { Knex } from 'knex';

/**
 * CommissionAdjustment.appliedPayoutId — which payout netted a refund
 * clawback off the partner (docs/refund-clawback-netting.md).
 *
 * A refund of an already-paid commission records a negative
 * `refund_clawback` adjustment. The manual and direct-Connect payout rails
 * deduct outstanding clawbacks from the partner's next payout and stamp the
 * payout id here; the direct-Connect executor clears it again wherever it
 * abandons that payout (releaseClaims). Null = still outstanding.
 *
 * Nullable, no FK (like Commission.payoutId): existing rows read null, and
 * Postgres adds the column without rewriting the table. Core column,
 * exported with the rest of CommissionAdjustment — a nullable column needs
 * no export schemaVersion bump (docs/data-portability.md).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('CommissionAdjustment', (t) => {
    t.string('appliedPayoutId', 32).nullable();
  });
  await knex.raw(`
    create index "CommissionAdjustment_appliedPayoutId"
      on "CommissionAdjustment" ("appliedPayoutId")
      where "appliedPayoutId" is not null
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop index if exists "CommissionAdjustment_appliedPayoutId"');
  await knex.schema.alterTable('CommissionAdjustment', (t) => {
    t.dropColumn('appliedPayoutId');
  });
}
