/**
 * Work that must only describe committed rows, queued against whichever
 * database handle wrote them. Today: webhooks (attribution.created,
 * commission.accrued, the manual commission routes, partner.created,
 * partnership.approved, partner.activated).
 *
 * The attribution engine runs on whatever handle its caller passes: the
 * request transaction (tenantMiddleware), the Stripe webhook's own tenant
 * transaction, a scheduler job's, or the bare pool in scripts and tests. A
 * webhook dispatched from inside a transaction can reach the receiver before
 * COMMIT, so a receiver that fetches the attribution finds nothing yet, or is
 * told about rows that then roll back.
 *
 * onCommit(db, label, job) runs `job`:
 *   - now, on the bare pool: the write is already durable
 *   - after COMMIT, on a transaction its owner registered with
 *     trackCommitJobs (the request transaction, which tenantMiddleware
 *     commits by hand). The owner runs the queue and drops it on rollback
 *   - after COMMIT, on any other transaction, i.e. the callback form
 *     `db.transaction(async (trx) => …)`: its executionPromise resolves on
 *     commit and rejects on rollback. A savepoint hands its jobs to its
 *     parent when released, so they wait for the outermost COMMIT, and are
 *     dropped if the savepoint rolls back.
 * A transaction opened by hand (`await db.transaction()`) must register:
 * its executionPromise also resolves on a bare rollback().
 *
 * A job that throws is logged. It never affects the caller.
 */

import type { Knex } from 'knex';

type Job = () => Promise<void>;

const registered = new WeakMap<Knex.Transaction, Job[]>();

/** For the owner of a hand-committed transaction: `jobs` is where onCommit
 *  queues work for `trx`. Run it after COMMIT; discard it on rollback. */
export function trackCommitJobs(trx: Knex.Transaction, jobs: Job[]): void {
  registered.set(trx, jobs);
}

export function onCommit(db: Knex, label: string, job: () => unknown): void {
  const run: Job = async () => {
    try {
      await job();
    } catch (err) {
      console.error(`[on-commit] job failed: ${label}`, err);
    }
  };
  if (!db.isTransaction) {
    void run();
    return;
  }
  queue(db as Knex.Transaction, run);
}

function queue(trx: Knex.Transaction, run: Job): void {
  const jobs = registered.get(trx);
  if (jobs) {
    jobs.push(run);
    return;
  }
  trx.executionPromise.then(
    () => (trx.parentTransaction ? queue(trx.parentTransaction, run) : void run()),
    () => {}, // rolled back: the rows the job describes never existed
  );
}
