/**
 * Move destinationUrl onto Campaign so the brand controls it, not the
 * partner. Today every Link carries its own destinationUrl which means
 * a partner can point their share link anywhere — fine for the early
 * single-tenant model where links were admin-created, but wrong for
 * multi-tenant where partners create their own links and the brand
 * needs to control where traffic lands.
 *
 * Backfill: pick the most-common destinationUrl per Campaign as its
 * default. (Brands almost always use one URL per Campaign anyway.)
 *
 * deepLinkAllowedDomains is a comma-separated allowlist; when set,
 * partners can override the destination as long as their override
 * matches one of the allowed hosts. Empty = partner can't override.
 *
 * Link.destinationUrl stays for now as an override field (NULL = use
 * Campaign default). Lock-down to Campaign-only is a future migration
 * once the UI lands and we're sure no caller relies on the per-Link
 * value.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.string('destinationUrl');
    t.string('deepLinkAllowedDomains'); // comma-separated host list; null = no overrides
  });

  // Backfill: most-common destinationUrl per Campaign. Falls back to
  // empty string if a Campaign has zero Links (those are picked up in
  // the manual NOT NULL conversion below).
  await knex.raw(`
    update "Campaign" c
    set "destinationUrl" = (
      select "destinationUrl" from "Link" l
      where l."campaignId" = c.id
      group by "destinationUrl"
      order by count(*) desc
      limit 1
    )
    where c."destinationUrl" is null
  `);

  // Any Campaign that still has no destinationUrl (no Links yet) gets
  // a placeholder. Brand admin must edit before the Campaign is useful.
  await knex.raw(`update "Campaign" set "destinationUrl" = 'https://example.com' where "destinationUrl" is null`);

  await knex.schema.alterTable('Campaign', (t) => {
    t.string('destinationUrl').notNullable().alter();
  });

  // Link.destinationUrl becomes nullable — null means "use Campaign's".
  await knex.schema.alterTable('Link', (t) => {
    t.string('destinationUrl').nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Link', (t) => {
    t.string('destinationUrl').notNullable().alter();
  });
  await knex.schema.alterTable('Campaign', (t) => {
    t.dropColumn('destinationUrl');
    t.dropColumn('deepLinkAllowedDomains');
  });
}
