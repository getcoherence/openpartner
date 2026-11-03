import type { Knex } from 'knex';

/**
 * Admin.role: 'admin' (full) or 'viewer' (sees the admin portal, changes
 * nothing). The default makes every existing admin, and every admin that
 * signup, install, add-brand and booking claims create, a full admin.
 * Enforced in one place, requireAuth (apps/api/src/view-only.ts); see
 * docs/view-only-seats.md.
 *
 * Admin is outside the export bundle (authentication data), so the role
 * doesn't travel and the schema version doesn't change.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Admin', (t) => {
    t.text('role').notNullable().defaultTo('admin');
  });
  await knex.raw(`ALTER TABLE "Admin" ADD CONSTRAINT "admin_role_check" CHECK ("role" IN ('admin', 'viewer'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Admin', (t) => {
    t.dropColumn('role');
  });
}
