import type { Knex } from 'knex';

/**
 * Multi-identity session bundle.
 *
 * X-style stacking of multiple signed-in identities in one browser. Each
 * bundle is a server-side wallet of PlatformSession rows the same device
 * has authenticated; bundle membership is the only state that decides
 * what shows up in the identity-switcher popover.
 *
 *   PlatformSessionBundle    Opaque per-device record. Bundle id rides on
 *                            the op_bundle_id cookie alongside the
 *                            existing op_platform_session cookie. lastUsedAt
 *                            advances on every list/switch/attach to drive
 *                            future "you have a session you haven't used
 *                            in 30 days" hygiene jobs.
 *
 *   PlatformSession.bundleId Nullable for backwards compat — existing
 *                            sessions are treated as singletons until they
 *                            re-verify, at which point /auth/platform-verify
 *                            attaches them to a bundle (creating one if
 *                            the op_bundle_id cookie isn't set).
 *
 * Dedup rule (enforced in app code, not DB): one alive session per (email,
 * bundleId). Re-signin with an already-bundled email replaces the prior
 * session for that email instead of stacking — keeps the switcher tidy
 * and avoids surprising the user with duplicate entries.
 *
 * Cap: 5 alive sessions per bundle. Beyond that, oldest is evicted. Most
 * humans run 1-3 identities in a single browser; 5 is generous.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('PlatformSessionBundle', (t) => {
    t.string('id').primary();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('lastUsedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.alterTable('PlatformSession', (t) => {
    t.string('bundleId')
      .nullable()
      .references('id')
      .inTable('PlatformSessionBundle')
      .onDelete('SET NULL');
    t.index(['bundleId']);
  });

  // Grant DML on PlatformSessionBundle to the openpartner_app role.
  // Same idempotent DO-block pattern as 20260613000000_partner_postback.
  // PlatformSession already has the grant from initial schema; bundleId
  // is just a new column on it.
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "PlatformSessionBundle" to openpartner_app';
      end if;
    end
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('PlatformSession', (t) => {
    t.dropIndex(['bundleId']);
    t.dropColumn('bundleId');
  });
  await knex.schema.dropTableIfExists('PlatformSessionBundle');
}
