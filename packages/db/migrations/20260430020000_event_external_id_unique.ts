import type { Knex } from 'knex';

/**
 * Convert Event.externalEventId's partial unique INDEX into a proper
 * UNIQUE CONSTRAINT. The previous migration created
 *
 *   create unique index ... where "externalEventId" is not null
 *
 * which Postgres can't use as an ON CONFLICT arbiter without the
 * matching WHERE clause in the INSERT — knex's .onConflict() doesn't
 * emit that, so the Stripe webhook path would fail with 42P10 on the
 * first retry. Postgres unique CONSTRAINTS allow multiple NULLs by
 * default (per SQL spec), so a plain t.unique() covers what we want.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`drop index if exists "Event_externalEventId_unique"`);
  await knex.schema.alterTable('Event', (t) => {
    t.unique(['externalEventId']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Event', (t) => {
    t.dropUnique(['externalEventId']);
  });
  await knex.raw(`
    create unique index "Event_externalEventId_unique"
      on "Event" ("externalEventId")
      where "externalEventId" is not null
  `);
}
