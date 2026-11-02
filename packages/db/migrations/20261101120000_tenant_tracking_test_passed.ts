import type { Knex } from 'knex';

/**
 * Tenant.trackingTestPassedAt: when the brand first passed a test click
 * (Admin → Tracking health → Send a test click) all the way to identify.
 *
 * Together with a linked click (any Identity row), it is what makes a
 * brand's tracking "verified" (apps/api/src/tracking-verification.ts):
 * operators approve brands on it, and partners can only join a brand that
 * has it. TestClick rows are deleted after 90 days, so the pass is kept
 * here. Set once, never cleared. Tenant isn't in the export bundle, like
 * couponIntegrationVerifiedAt beside it.
 *
 * Backfilled from any test click already identified.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.timestamp('trackingTestPassedAt', { useTz: true }).nullable();
  });
  await knex.raw(`
    update "Tenant" t
       set "trackingTestPassedAt" = p.passed
      from (select "tenantId", min("identifiedAt") as passed
              from "TestClick"
             where "identifiedAt" is not null
             group by "tenantId") p
     where p."tenantId" = t.id
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropColumn('trackingTestPassedAt');
  });
}
