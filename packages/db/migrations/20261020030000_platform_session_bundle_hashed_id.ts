import type { Knex } from 'knex';

/**
 * PlatformSessionBundle.id becomes sha256(op_bundle_id cookie) instead of
 * the cookie value itself.
 *
 * The bundle cookie is a bearer credential: POST /identities/switch mints a
 * fresh platform session for any live identity in the bundle on that cookie
 * alone. Stored verbatim, anyone who could read this table (a backup, a SQL
 * dump, a read-only leak) could take over every identity stacked in every
 * bundle. Session, PlatformSession and MagicLinkToken already store only a
 * sha256 of their token; this brings the bundle in line. The column keeps
 * its name and type — it is still the primary key and still what
 * PlatformSession.bundleId references — it just holds the hash, and the new
 * code only ever looks it up by hashing the cookie
 * (apps/api/src/platform-sessions.ts).
 *
 * Existing bundles are DELETED, not hashed in place. Hashing in place
 * (id = sha256(id)) would keep today's cookies working, but every backup
 * taken before this migration holds those cookie values in the clear, and
 * bundles never expire: a leaked backup would stay a working key to that
 * browser's identities for as long as the browser keeps the cookie,
 * including identities stacked after the leak. Deleting ends that for good.
 *
 * What users see: PlatformSession.bundleId is ON DELETE SET NULL, so every
 * platform session stays valid and its holder stays signed in as their
 * current identity. /me/identities reports no bundle and the switcher falls
 * back to its workspaces-only mode. The next sign-in or "Add another
 * account" starts a fresh bundle under the new scheme. Identities that were
 * stacked behind the current one have to be added again.
 *
 * down() deletes bundles too. Rows written after up() hold hashes, and the
 * pre-hash code looks a bundle up by id = cookie, so keeping them would make
 * every stored hash a working cookie again — the hole this closes. Note that
 * redeploying an older image does NOT run down(): the knexfile disables the
 * migration-list check, so the old build boots with this migration still
 * applied, and every stored hash is a working cookie for it. As part of
 * such a rollback, delete the PlatformSessionBundle rows by hand (or run
 * down()) as soon as the old build takes traffic.
 */

export async function up(knex: Knex): Promise<void> {
  await knex('PlatformSessionBundle').del();
}

export async function down(knex: Knex): Promise<void> {
  await knex('PlatformSessionBundle').del();
}
