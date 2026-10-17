import type { Knex } from 'knex';

/**
 * Per-object durable scheduling for the reconcile sweep (audit #12,
 * round 9).
 *
 * The sweep used to walk a GLOBAL cursor over an in-memory ordering, with
 * a Config-stored retry set bolted on. Four successive coverage mechanisms
 * failed the same way (per-day hash shuffle, count-derived window,
 * commit-before-work cursor, creation-id ordering) because a global
 * high-water mark has to make a claim about ordering that concurrent
 * writers keep falsifying. Scheduling state now lives ON each swept row:
 *
 *   - sweepDueAt      when this row should next be looked at. NULL means
 *                     "never swept" and sorts by the row's own eligibility
 *                     time, so backlog and fresh arrivals compete fairly.
 *   - sweepLeaseAt /  a short claim taken by the running sweep so two
 *     sweepLeaseToken concurrent runs cannot read the same row, and a
 *                     crashed run's rows become claimable again after the
 *                     lease expires. Acknowledgement is fenced on the
 *                     token, so a worker that lost its lease cannot
 *                     overwrite the reschedule of the worker that took it.
 *   - sweepFailCount  consecutive failed Stripe reads, for escalation.
 *                     Reset on success. Failures do NOT reschedule sooner
 *                     than successes — a uniform revisit interval is what
 *                     keeps a poison row from monopolising the budget.
 *
 * Both tables are hosted-only sidecars (CLAUDE.md §2) — no core-table or
 * export-schema impact. No index: these tables hold at most a few
 * thousand rows and the sweep runs daily.
 */

const TABLES = ['HostedFundingBatch', 'HostedFundingTransfer'] as const;

export async function up(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    await knex.raw(`
      alter table "${table}"
        add column "sweepDueAt" timestamptz null,
        add column "sweepLeaseAt" timestamptz null,
        add column "sweepLeaseToken" text null,
        add column "sweepFailCount" integer not null default 0
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    await knex.raw(`
      alter table "${table}"
        drop column "sweepDueAt",
        drop column "sweepLeaseAt",
        drop column "sweepLeaseToken",
        drop column "sweepFailCount"
    `);
  }
}
