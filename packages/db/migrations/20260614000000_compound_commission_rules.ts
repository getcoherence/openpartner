import type { Knex } from 'knex';

/**
 * Compound commission rules.
 *
 * Two coordinated changes:
 *
 * 1. Campaign.commissionRule was a single object {type, value, recurring?}.
 *    It becomes an ARRAY of triggered sub-rules so a brand can express
 *    "$200 first-sale bonus + 20% recurring for 12 months" in one campaign.
 *    We backfill every existing row by wrapping it in a 1-element array
 *    with `trigger='every'` (no eventType filter) — that exactly preserves
 *    pre-migration behavior.
 *
 * 2. PartnerCommission gets a nullable `commissionRules` JSONB column.
 *    New snapshots write the full rule array. Old snapshots are left with
 *    NULL here and the legacy commissionType/commissionValue/recurring
 *    columns continue to satisfy the resolver. We don't backfill old
 *    snapshots because the legacy columns already encode the original
 *    approval-time state correctly — re-deriving from the (now-mutated)
 *    Campaign would defeat the snapshot's purpose.
 *
 * Why same migration: parseCommissionRule in attribution.ts tolerates both
 * the array and the legacy object shape, so a half-applied state isn't
 * catastrophic, but a single migration keeps the deployment story simple.
 */
export async function up(knex: Knex): Promise<void> {
  // Backfill existing Campaign rows: { ...rule } → [{ trigger: 'every', ...rule }]
  // Use jsonb_build_array on the existing object so we don't depend on
  // anything app-side. Skips rows that already look like an array (idempotent
  // re-run after a partial migration).
  await knex.raw(`
    update "Campaign"
    set "commissionRule" = jsonb_build_array(
      jsonb_build_object('trigger', 'every') || "commissionRule"
    )
    where jsonb_typeof("commissionRule") = 'object'
  `);

  await knex.schema.alterTable('PartnerCommission', (t) => {
    t.jsonb('commissionRules').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('PartnerCommission', (t) => {
    t.dropColumn('commissionRules');
  });

  // Unwrap the 1-element arrays back to single objects. Multi-element rules
  // can't be represented in the old shape — those rows lose all but the
  // first element on rollback, which is the best we can do without bespoke
  // collapse logic. Acceptable because down() is for development; production
  // wouldn't roll this back without a manual export first.
  await knex.raw(`
    update "Campaign"
    set "commissionRule" = ("commissionRule"->0) - 'trigger' - 'eventType' - 'recurringMonths'
    where jsonb_typeof("commissionRule") = 'array'
  `);
}
