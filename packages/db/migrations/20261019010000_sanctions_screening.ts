import type { Knex } from 'knex';

/**
 * Sanctions screening results (docs/sanctions-screening.md).
 *
 * The hosted platform screens brand names, brand admins and payable
 * partners against the US Consolidated Screening List (OFAC's SDN list
 * and the other federal export and sanctions lists), and holds payouts to
 * a partner with an unresolved or confirmed match. Each screening is kept
 * as a compliance record: OFAC expects them for 10 years (31 CFR
 * 501.601). So rows are append-only, except for the one-time review stamp
 * (decision / reviewedByEmail / reviewedAt / reviewNote), and carry NO
 * foreign key: a tenant hard delete or a partner erasure must neither take
 * the record with it nor fail on it.
 *
 * PLATFORM-scoped hosted sidecar, same pattern as
 * 20261019000000_location_declaration.ts: only the privileged `db` pool
 * touches it, it is NOT granted to the openpartner_app role, carries no RLS
 * policy, and is not in the export allowlist.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('SanctionsScreening', (t) => {
    t.string('id').primary();
    t.string('subjectKind').notNullable(); // 'tenant' | 'partner'
    t.string('subjectId').notNullable();
    // The brand the subject belongs to. Equals subjectId for a tenant.
    t.string('tenantId').notNullable();
    // Exactly what was sent to the list. A brand is screened under its
    // display name and its primary admin's name, one row each.
    t.text('screenedName').notNullable();
    // The subject's latest declared country at the time, for the reviewer.
    // Context only: it is never sent as a search filter.
    t.string('country', 2);
    t.string('result').notNullable(); // 'clear' | 'possible_match' | 'error' | 'skipped'
    // Top list entries above the match threshold: [{ source, name, score,
    // entryId, type, programs, countries }]. Empty unless possible_match.
    t.jsonb('matches').notNullable().defaultTo('[]');
    // Why an 'error' row has no answer (HTTP status, timeout). Never PII.
    t.text('errorDetail');
    // What asked for it: 'signup' | 'add_brand' | 'first_payable' |
    // 'rescreen' | 'backfill' (a brand never screened) | 'ops'.
    t.string('trigger').notNullable();
    t.timestamp('screenedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // An operator's review of a possible_match. Written once.
    t.string('decision'); // 'cleared' | 'confirmed_match'
    t.string('reviewedByEmail');
    t.timestamp('reviewedAt', { useTz: true });
    t.text('reviewNote');
    // A rescreen that finds only list entries an operator already decided
    // on inherits that decision rather than reopening the review. Points at
    // the row that carries the operator's own review.
    t.string('decisionCarriedFromId');
    t.index(['subjectKind', 'subjectId', 'screenedAt']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('SanctionsScreening');
}
