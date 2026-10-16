import type { Knex } from 'knex';

/**
 * Commission.metadata — how each ledger row's amount was computed.
 *
 * Commission slabs (value bands and performance tiers, see
 * docs/commission-slabs.md) make the rate depend on the event's value or on
 * the partner's prior attributed performance. The ledger is immutable, so
 * the band/tier that applied is stamped on the row at accrual time: an
 * auditor can see why a commission is 15% rather than 10% without
 * re-deriving it, and a re-derivation can be compared against it.
 *
 * NOT NULL with a constant default: existing rows read `{}` (no slab
 * applied), and Postgres 11+ adds the column without rewriting the table.
 * Core column, exported with the rest of Commission — nothing hosted-only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Commission', (t) => {
    t.jsonb('metadata').notNullable().defaultTo('{}');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Commission', (t) => {
    t.dropColumn('metadata');
  });
}
