/**
 * Track whether the "campaign ending in 7 days" reminder has been
 * sent — single column, single notification per Campaign so a
 * scheduler that fires more than once a day (or after a re-deploy)
 * doesn't re-spam everyone. Resetting (admin extends endsAt past the
 * window) is handled by the scheduler clearing this when endsAt
 * changes to a date >7d out.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.timestamp('endNotificationSentAt', { useTz: true });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.dropColumn('endNotificationSentAt');
  });
}
