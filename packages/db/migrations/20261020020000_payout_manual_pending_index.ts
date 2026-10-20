import type { Knex } from 'knex';

/**
 * Payout ("tenantId", id) WHERE method = 'manual' AND status = 'pending'.
 *
 * The manual rail's batch files (apps/api/src/manual-payout-files.ts) only
 * ever read a tenant's pending manual payouts: a run's to-send list, the
 * payouts one file holds, the runs page. They read them in id order, a
 * chunk at a time, and filter the run and file ids out of `metadata` as
 * they go. Without this, each of those reads walked every payout the
 * tenant ever made. The index holds only payouts not confirmed yet, so it
 * stays small however long a brand has paid partners.
 *
 * The predicate is plain text equality, which RLS lets into an index
 * condition (unlike the `metadata->>…` lookups, which aren't leakproof).
 * Payout is small next to Click/Event, so a regular (locking) build is
 * brief.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`set local lock_timeout = '5s'`);
  await knex.raw(`
    create index "Payout_tenantId_id_manual_pending_index"
      on "Payout" ("tenantId", id)
      where method = 'manual' and status = 'pending'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop index if exists "Payout_tenantId_id_manual_pending_index"');
}
