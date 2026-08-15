import type { Knex } from 'knex';

/**
 * DevMessage was the local / CI mailbox the magic-link suite used to
 * recover links without Postmark. With the switch to Postmark-or-console
 * (tests inject a capturing mailer directly), the table has no readers
 * and no writers.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`drop table if exists "DevMessage" cascade`);
}

export async function down(_knex: Knex): Promise<void> {
  // No-op — this was always a dev-only convenience table, and reviving
  // it would require wiring a writer back in.
}
