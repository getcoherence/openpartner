import type { Knex } from 'knex';

/**
 * Drop Network + magic-link tables — OSS is now strictly vendor-direct.
 * The Network service (creator discovery, offering catalog, matchmaking)
 * lives in a separate private repo and talks to OSS instances over
 * scoped API keys + REST, not by sharing a schema.
 *
 * Uses `drop if exists` so both kinds of database succeed:
 *   - a fresh OSS install that never had these tables, and
 *   - an existing deployment that applied the now-deleted network /
 *     promo_codes / magic_links / vendor_email migrations before this
 *     one.
 *
 * Order matters: drop tables that reference others first. ApiKey has
 * no direct FK into the Network tables (the scoped-key federation
 * pattern means the Network holds OUR key, not the other way around),
 * so ApiKey and everything it cares about is unaffected.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`drop table if exists "Partnership" cascade`);
  await knex.raw(`drop table if exists "PartnershipRequest" cascade`);
  await knex.raw(`drop table if exists "Offering" cascade`);
  await knex.raw(`drop table if exists "NetworkCreator" cascade`);
  await knex.raw(`drop table if exists "NetworkVendor" cascade`);
  await knex.raw(`drop table if exists "MagicLinkToken" cascade`);
  await knex.raw(`drop table if exists "Session" cascade`);
  await knex.raw(`drop table if exists "DevMessage" cascade`);
}

export async function down(_knex: Knex): Promise<void> {
  // One-way door. Re-creating these tables means switching back to
  // the Network-embedded model we deliberately moved away from.
}
