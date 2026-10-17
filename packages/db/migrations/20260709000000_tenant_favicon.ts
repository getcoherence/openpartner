import type { Knex } from 'knex';

/**
 * Tenant.faviconUrl — a browser-tab icon distinct from the logo.
 *
 * Logos are usually horizontal lockups or wordmarks; favicons are square
 * simplified marks. Conflating them made white-label tabs show either a
 * squashed wordmark or (before the BrandDocument fix) the platform mark.
 * Null = fall back to logoUrl, then to a generated monogram.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.text('faviconUrl').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropColumn('faviconUrl');
  });
}
