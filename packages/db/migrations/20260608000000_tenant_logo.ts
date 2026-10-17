import type { Knex } from 'knex';

/**
 * Per-tenant brand logo. Stores the public URL emitted by whichever
 * storage backend POST /uploads/logo wrote the file to (S3-compatible
 * object store on hosted, local filesystem for self-hosters).
 *
 * Nullable — most tenants will start without a logo and the UI falls
 * back to the textual displayName. No backfill needed.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.string('logoUrl', 1024).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropColumn('logoUrl');
  });
}
