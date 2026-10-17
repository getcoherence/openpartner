import type { Knex } from 'knex';

/**
 * Platform-operator brand review: session store, signup blocklist, and an
 * audit log.
 *
 * All three tables are PLATFORM-scoped (no tenantId) and are only ever
 * touched by the privileged `db` pool (see apps/api/src/db.ts) via
 * before-tenant routes — the same pattern signup + platform-auth use. They
 * are deliberately NOT granted to the openpartner_app role and carry no RLS
 * policy: the app pool has no path to them, and the owner pool bypasses RLS
 * anyway. This mirrors how PlatformAdmin itself sits outside per-tenant RLS
 * (see 20260507010000_rls_policies.ts).
 */
export async function up(knex: Knex): Promise<void> {
  // Cross-tenant operator session — magic-link login for the platform-ops
  // console. Distinct from tenant-scoped Session (RLS'd, per-brand) and
  // from PlatformSession (the multi-brand customer identity wallet).
  await knex.schema.createTable('PlatformAdminSession', (t) => {
    t.string('id').primary();
    t.string('prefix').notNullable();
    t.string('tokenHash').notNullable();
    t.string('platformAdminId').notNullable();
    t.string('email').notNullable();
    t.string('role').notNullable(); // snapshot of PlatformAdmin.role at issue time
    t.timestamp('expiresAt', { useTz: true }).notNullable();
    t.timestamp('revokedAt', { useTz: true });
    t.timestamp('lastSeenAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['prefix']);
    t.index(['platformAdminId']);
  });

  // Signup blocklist. Checked in POST /signup before a Tenant is created:
  // a banned email (exact) or banned domain (the part after @) is refused
  // outright. Populated manually from the ops console, or automatically
  // when an operator rejects a spam brand and opts to ban it.
  await knex.schema.createTable('SignupBlocklist', (t) => {
    t.string('id').primary();
    t.string('type').notNullable(); // 'email' | 'domain'
    t.string('value').notNullable(); // normalized lowercase (full address, or bare domain)
    t.text('reason');
    t.string('createdByEmail'); // platform operator, or null for seed/import
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['type', 'value']);
  });

  // Append-only audit of platform-operator actions (approve / reject /
  // reinstate / ban / unban). Gives per-operator accountability the review
  // console reads back.
  await knex.schema.createTable('PlatformAuditLog', (t) => {
    t.string('id').primary();
    t.string('platformAdminId');
    t.string('platformAdminEmail').notNullable();
    t.string('action').notNullable(); // e.g. brand.approve, brand.reject, blocklist.add
    t.string('targetType'); // 'tenant' | 'blocklist' | ...
    t.string('targetId');
    t.jsonb('detail').notNullable().defaultTo('{}');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['createdAt']);
    t.index(['targetType', 'targetId']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('PlatformAuditLog');
  await knex.schema.dropTableIfExists('SignupBlocklist');
  await knex.schema.dropTableIfExists('PlatformAdminSession');
}
