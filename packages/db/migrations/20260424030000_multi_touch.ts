import type { Knex } from 'knex';

/**
 * Multi-touch attribution requires two schema relaxations:
 *
 * 1. Identity was modeled as "one stitched click per user — first stitch
 *    wins." That's a single-touch assumption. For first_click / linear /
 *    position we need to capture every click the user makes, then let the
 *    attribution engine decide which one(s) get credit per event.
 *
 * 2. Attribution's unique (eventId, model) meant one attribution row per
 *    event per model. Linear and position models emit multiple Attribution
 *    rows per event (one per touch, each with a fractional weight). We need
 *    (eventId, model, clickId) instead.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Identity', (t) => {
    t.dropUnique(['userId']);
    t.unique(['clickId', 'userId']);
    t.index(['userId']);
  });

  await knex.schema.alterTable('Attribution', (t) => {
    t.dropUnique(['eventId', 'model']);
    t.unique(['eventId', 'model', 'clickId']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Attribution', (t) => {
    t.dropUnique(['eventId', 'model', 'clickId']);
    t.unique(['eventId', 'model']);
  });

  await knex.schema.alterTable('Identity', (t) => {
    t.dropUnique(['clickId', 'userId']);
    t.dropIndex(['userId']);
    t.unique(['userId']);
  });
}
