import type { Knex } from 'knex';

/**
 * Event.externalEventId — idempotency key for Stripe webhook retries.
 *
 * Stripe retries deliver the same event.id repeatedly on 5xx / timeout.
 * Before this column every retry inserted a fresh Event row, which the
 * attribution engine then commissioned again — silent revenue double-
 * counting. Unique index enforces at the DB.
 *
 * Backfill: copy metadata->>'stripeEventId' for rows where it was set
 * (the only prior caller that stamped stripeEventId was the Stripe
 * webhook, so the backfill rehydrates existing rows' idempotency keys).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Event', (t) => {
    t.string('externalEventId').nullable();
  });

  await knex.raw(`
    update "Event"
    set "externalEventId" = "metadata"->>'stripeEventId'
    where "metadata"->>'stripeEventId' is not null
  `);

  // Partial unique index — NULLs are allowed and unconstrained so
  // non-external events (e.g. server-posted revenue events) aren't
  // affected.
  await knex.raw(`
    create unique index "Event_externalEventId_unique"
      on "Event" ("externalEventId")
      where "externalEventId" is not null
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`drop index if exists "Event_externalEventId_unique"`);
  await knex.schema.alterTable('Event', (t) => {
    t.dropColumn('externalEventId');
  });
}
