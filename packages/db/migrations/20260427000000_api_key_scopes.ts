import type { Knex } from 'knex';

/**
 * Scoped API keys.
 *
 * Historically every admin key had full, unrestricted power over an
 * OpenPartner instance. That's a problem the moment a vendor joins the
 * Network — they'd have to hand over their root key just so we could call
 * POST /partners on their behalf. A leak of our federation store would
 * mean full compromise of every vendor.
 *
 * scopes = null            → legacy admin: no restrictions (default).
 * scopes = []              → explicit "no permissions" (effectively dead).
 * scopes = ['partners:write', ...]  → only allowed on endpoints demanding
 *                                     one of those scopes; everything else
 *                                     is 403.
 *
 * Scope strings are namespaced `<resource>:<action>`. Current set used by
 * federation: partners:write, partners:read, links:write, commissions:read.
 * New scopes land here as we extend the federation surface.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ApiKey', (t) => {
    t.jsonb('scopes'); // null = legacy unrestricted admin
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ApiKey', (t) => {
    t.dropColumn('scopes');
  });
}
