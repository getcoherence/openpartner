import type { Knex } from 'knex';

/**
 * Config = singleton key/value store for deployment-level state.
 *
 * First use: stashing the merchant Stripe subscription id (flat mode) and
 * customer id so the billing/portal endpoints can find them without every
 * operator having to juggle env vars after the first checkout.
 *
 * Principle (CLAUDE.md #2): this is a hosted-specific sidecar — self-hosted
 * deployments can leave it empty. Keeping state here rather than in Partner
 * or Campaign is what preserves round-trip import cleanliness.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('Config', (t) => {
    t.string('key').primary();
    t.jsonb('value').notNullable();
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('Config');
}
