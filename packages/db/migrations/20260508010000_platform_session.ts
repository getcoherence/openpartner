/**
 * PlatformSession — identity-level sessions used by the multi-tenant
 * deployment's workspace picker.
 *
 * The existing Session table is per-tenant (tenantId NOT NULL, principal
 * scoped to a single Admin/Partner row). That's the right shape for the
 * "user is acting inside this brand" state, but it can't represent the
 * "user has authenticated their email but hasn't picked a workspace yet"
 * intermediate state we need for the picker.
 *
 * Solution: a thin parallel table keyed by email. After the platform
 * magic link verifies, we issue a PlatformSession; the SPA reads
 * /api/me/workspaces (which lists every Admin row matching that email),
 * the user picks one, and /api/workspaces/:slug/enter exchanges the
 * platform session for a regular per-tenant Session pinned to the
 * matching Admin row.
 *
 * No tenantId here on purpose — RLS doesn't apply (the table holds no
 * tenant data; just email + token bookkeeping).
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('PlatformSession', (t) => {
    t.string('id').primary();
    t.string('prefix', 8).notNullable();
    t.string('tokenHash').notNullable().unique();
    t.string('email').notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expiresAt', { useTz: true }).notNullable();
    t.timestamp('lastSeenAt', { useTz: true });
    t.timestamp('revokedAt', { useTz: true });
    t.index(['prefix']);
    t.index(['email']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('PlatformSession');
}
