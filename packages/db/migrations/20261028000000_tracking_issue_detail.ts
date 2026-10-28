import type { Knex } from 'knex';

/**
 * TrackingIssue.detail — what went wrong, for the kinds that know. The
 * first is `reward_code_refused`: a partner code whose customer discount
 * the brand's Stripe wouldn't create, with Stripe's own answer, so Admin →
 * Tracking health's setup checks can say why instead of only how many.
 *
 * Nullable, at most 500 characters, the latest one seen (like sampleRef).
 * TrackingIssue isn't exported (docs/data-portability.md), so the export
 * format doesn't change. The app role already updates TrackingIssue rows.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('TrackingIssue', (t) => {
    t.string('detail', 500);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('TrackingIssue', (t) => {
    t.dropColumn('detail');
  });
}
