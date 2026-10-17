import type { Knex } from 'knex';

/**
 * Categories on Campaign — drives marketplace filtering + the "Category"
 * chip on the discover card. Multi-value (a SaaS analytics tool can be
 * tagged both `saas` and `analytics`); each value is one of the curated
 * slugs in @openpartner/db's PROGRAM_CATEGORIES list.
 *
 * Stored as a Postgres text[] so we can use array-contains queries for
 * server-side filtering when the dataset outgrows the current
 * client-side filter pattern. Defaults to {} (empty array) so existing
 * campaigns satisfy the NOT NULL constraint without backfill.
 *
 * The Network's Offering snapshots this through `terms.categories` so
 * the public marketplace can filter without round-tripping to the
 * vendor instance.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.specificType('categories', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.dropColumn('categories');
  });
}
