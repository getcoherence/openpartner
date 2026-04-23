import type { Knex } from 'knex';

/**
 * API keys for auth. Two shapes:
 *   - Admin keys (partnerId = NULL) — full access to all endpoints.
 *   - Partner keys (partnerId set)  — scoped to that partner's resources.
 *
 * We store only a sha256 of the key. `prefix` is the first 8 chars of the
 * plaintext, used as an indexable lookup handle — avoids scanning the full
 * table per auth check.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ApiKey', (t) => {
    t.string('id').primary();
    t.string('prefix').notNullable();
    t.string('keyHash').notNullable();
    t.string('partnerId').references('id').inTable('Partner'); // null = admin key
    t.string('label'); // human-readable — "CI", "production server"
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('lastUsedAt', { useTz: true });
    t.timestamp('revokedAt', { useTz: true });
    t.index(['prefix']);
    t.index(['partnerId']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ApiKey');
}
