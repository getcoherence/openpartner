/**
 * Soft-delete (`pendingDeletionAt`) on Tenant for the brand-side
 * GDPR-erasure flow. Setting the column immediately blocks access
 * (tenantMiddleware refuses requests for tenants with the column set);
 * a scheduler sweep hard-deletes after the 30-day grace window.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.timestamp('pendingDeletionAt', { useTz: true });
    t.text('deletionReason');
    t.index(['pendingDeletionAt']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropIndex(['pendingDeletionAt']);
    t.dropColumn('pendingDeletionAt');
    t.dropColumn('deletionReason');
  });
}
