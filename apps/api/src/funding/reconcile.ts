/**
 * Daily funding reconciliation — spec §11.
 *
 * The state machine is designed to be correct without this job; the job
 * exists to make silent drift loud. It never moves money and never CASes
 * a batch forward — it verifies, backfills telemetry, and alerts:
 *
 *   1. Ledger invariant per non-terminal batch (allocations vs principal)
 *   2. Stuck-state detection (funded/transferring past the deadline,
 *      reconcile_required intents, recovery_required / funding_disputed
 *      batches, settled_with_residual awaiting a disposition, webhook
 *      claims that were never completed)
 *   3. A live-Stripe sweep over settled money: rail-fee backfill AND
 *      refunds / disputes / transfer reversals that happened at Stripe
 *      but whose webhook never arrived. Everything else here reads local
 *      state, which by definition cannot see a lost webhook.
 */

import type Stripe from 'stripe';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type HostedFundingBatchRow,
  type HostedFundingTransferRow,
} from '@openpartner/db';
import { requireStripe } from '../stripe.js';
import { TRANSFER_DEADLINE_DAYS } from './state.js';

export interface ReconcileDeps {
  stripe?: Stripe;
  now?: () => Date;
  /** Test seam for the per-run live-Stripe read cap. */
  sweepLimit?: number;
}

export interface ReconcileReport {
  batchesChecked: number;
  invariantViolations: string[];
  stuckBatches: string[];
  attentionBatches: string[];
  residualsAwaitingDisposition: string[];
  reconcileRequiredIntents: string[];
  feeBackfilled: string[];
  /** Webhook claims that were never finished and never redelivered. */
  unfinishedInboxEvents: string[];
  /** Funding charges refunded/disputed at Stripe with no webhook received. */
  missedRefunds: string[];
  /** Partner transfers reversed at Stripe with no webhook received. */
  missedReversals: string[];
  /** Inside the horizon but past the per-run cap — NOT checked this run. */
  sweepSkipped: string[];
}

/** A claimed-but-unfinished webhook older than this had its worker die
 *  AND never got a redelivery — nothing will pick it up on its own. */
const INBOX_STUCK_MS = 60 * 60 * 1000;
/** Per-run cap on live Stripe reads. Anything beyond it is reported AND
 *  named in the log — an unchecked batch must never look like a clean one. */
const STRIPE_SWEEP_LIMIT = 50;
/** How far back a refund, dispute or reversal can still appear. Stripe's
 *  dispute window is 120 days; 180 gives margin. Money older than this is
 *  settled history and does not need re-checking every night. */
const REVERSAL_HORIZON_DAYS = 180;
/**
 * How long after a sweep visit a row is next due — the SAME for a
 * successful read and a failed one, deliberately. Four generations of
 * global-cursor scheduling died here (per-day hash shuffle, count-derived
 * window, commit-before-work cursor, creation-id ordering, then a retry
 * set whose budget arithmetic starved either the retries or the cursor
 * depending on the limit). Any rule that gives failures a SOONER revisit
 * puts every poison row ahead of every healthy row on every run — the
 * round-8 starvation in a new costume. A uniform interval makes selection
 * pure least-recently-visited rotation: a poison row costs one slot per
 * rotation, no more, and persistent failure escalates through
 * `sweepFailCount` instead of through priority.
 */
const SWEEP_REVISIT_MS = 24 * 60 * 60 * 1000;
/** A sweep claim older than this belongs to a run that died — the row is
 *  claimable again. A Stripe read takes milliseconds; a whole run minutes. */
const SWEEP_LEASE_MS = 60 * 60 * 1000;
/** Consecutive failed reads before a row's failure is escalated to an
 *  ALERT rather than a per-run warning. */
const SWEEP_FAIL_ALERT = 3;

/**
 * Claim up to `limit` eligible rows for this run, least-recently-visited
 * first, in ONE short statement — the scheduling state lives on the rows
 * themselves (`sweepDueAt` / `sweepLeaseAt` / `sweepLeaseToken`).
 *
 * Never-swept rows have a NULL `sweepDueAt` and take their place in the
 * order from their own eligibility time (when a batch funded, when an
 * intent last changed), so a backlog and fresh arrivals compete on age
 * rather than the arrivals jumping the queue. There is no global cursor
 * and therefore no high-water mark for a row to land behind: a clock-skewed
 * eligibility timestamp can delay a row by one rotation at most, never
 * strand it, because selection is a per-run RANK over live rows rather
 * than a committed position.
 *
 * `for update skip locked` keeps two concurrent runs off the same rows;
 * the lease keeps a crashed run's rows out of rotation only until
 * `SWEEP_LEASE_MS` passes. Stripe reads happen OUTSIDE this statement,
 * and every claimed row is then acknowledged by `ackSweepRow` under the
 * token — a worker whose lease was taken over cannot overwrite the new
 * owner's schedule.
 */
async function claimSweepRows<T>(
  db: Knex,
  table: string,
  token: string,
  limit: number,
  eligible: (qb: Knex.QueryBuilder) => void,
  /** SQL expression for a never-swept row's place in the order. */
  eligibilityOrderSql: string,
): Promise<T[]> {
  // Lease times come from the DATABASE clock, on both sides (round 10).
  // Writing the worker's own clock let a clock-fast worker strand a row
  // behind a future lease after a crash, and a clock-slow worker write a
  // lease that was already "expired" and be reclaimed mid-flight. One
  // clock, one comparison.
  //
  // The never-swept eligibility hint is clamped with least(..., now())
  // for the same reason: a future-skewed timestamp must mean "due now",
  // not "sorts behind every rescheduled row forever".
  const sub = db(table)
    .select('id')
    .modify(eligible)
    .where((qb) =>
      qb
        .whereNull('sweepLeaseAt')
        .orWhereRaw(`"sweepLeaseAt" < now() - make_interval(secs => ?)`, [SWEEP_LEASE_MS / 1000]),
    )
    .orderByRaw(`coalesce("sweepDueAt", least(${eligibilityOrderSql}, now())) asc, id asc`)
    .limit(limit)
    .forUpdate()
    .skipLocked();
  return (await db(table)
    .whereIn('id', sub)
    .update({ sweepLeaseAt: db.fn.now(), sweepLeaseToken: token })
    .returning('*')) as T[];
}

/**
 * Reschedule a claimed row after its read, success or failure — fenced on
 * the claim token. Returns the new consecutive-failure count (0 on
 * success) so the caller can escalate.
 */
async function ackSweepRow(
  db: Knex,
  table: string,
  id: string,
  token: string,
  runAt: Date,
  failed: boolean,
): Promise<number> {
  const rows = (await db(table)
    .where({ id, sweepLeaseToken: token })
    .update({
      sweepDueAt: new Date(runAt.getTime() + SWEEP_REVISIT_MS),
      sweepLeaseAt: null,
      sweepLeaseToken: null,
      sweepFailCount: failed ? db.raw('"sweepFailCount" + 1') : 0,
    })
    .returning(['sweepFailCount'])) as Array<{ sweepFailCount: number }>;
  return rows[0]?.sweepFailCount ?? 0;
}

export async function runFundingReconciliation(
  db: Knex,
  deps: ReconcileDeps = {},
): Promise<ReconcileReport> {
  const now = deps.now ?? (() => new Date());
  // One instant for the whole run. The job takes minutes; calling now()
  // per use let a UTC day boundary split a single run across two sweep
  // windows, which is exactly when coverage reasoning breaks down.
  const runAt = now();
  const sweepLimit = deps.sweepLimit ?? STRIPE_SWEEP_LIMIT;
  const report: ReconcileReport = {
    batchesChecked: 0,
    invariantViolations: [],
    stuckBatches: [],
    attentionBatches: [],
    residualsAwaitingDisposition: [],
    reconcileRequiredIntents: [],
    feeBackfilled: [],
    unfinishedInboxEvents: [],
    missedRefunds: [],
    missedReversals: [],
    sweepSkipped: [],
  };

  // 1. Invariant: for every batch that reserved money, its allocations
  // must sum to its principal — regardless of allocation state (canceled
  // rows still account for reserved cents until disposition).
  const open = (await db(TABLES.HostedFundingBatch)
    .whereNotIn('status', ['released'])
    .orderBy('createdAt', 'asc')) as HostedFundingBatchRow[];
  for (const batch of open) {
    report.batchesChecked += 1;
    // `released` allocations shrank the principal with them (pre-charge
    // interlock cancels) — every other state must account for it exactly.
    const sumRow = (await db(TABLES.HostedFundingAllocation)
      .where({ batchId: batch.id })
      .whereNot({ state: 'released' })
      .sum({ total: 'amountMinor' })
      .first()) as { total: string | null } | undefined;
    const allocated = Number(sumRow?.total ?? 0);
    if (allocated !== Number(batch.principalMinor)) {
      report.invariantViolations.push(batch.id);
      console.error(
        `[funding-reconcile] INVARIANT VIOLATION batch ${batch.id} (${batch.status}): allocations ${allocated} != principal ${batch.principalMinor}`,
      );
    }
  }

  // 2a. Batches funded but not settled past the transfer deadline.
  const deadline = new Date(runAt.getTime() - TRANSFER_DEADLINE_DAYS * 24 * 60 * 60 * 1000);
  for (const batch of open) {
    if (
      ['funded', 'transferring'].includes(batch.status) &&
      new Date(batch.fundedAt ?? batch.createdAt) < deadline
    ) {
      report.stuckBatches.push(batch.id);
      console.error(
        `[funding-reconcile] ALERT: batch ${batch.id} ${batch.status} since ${batch.fundedAt?.toISOString?.() ?? batch.fundedAt} — past the ${TRANSFER_DEADLINE_DAYS}d transfer deadline, residual disposition needed`,
      );
    }
    if (['recovery_required', 'funding_disputed'].includes(batch.status)) {
      report.attentionBatches.push(batch.id);
      console.error(
        `[funding-reconcile] ALERT: batch ${batch.id} requires human attention (${batch.status})`,
      );
    }
    // A release that can't finish (Stripe unreachable, PI not cancelable)
    // leaves the batch here with its allocations frozen. The collector
    // retries it every tick, so a batch still stuck a day later means
    // something is durably wrong.
    if (
      batch.status === 'release_requested' &&
      new Date(batch.updatedAt) < new Date(runAt.getTime() - 24 * 60 * 60 * 1000)
    ) {
      report.attentionBatches.push(batch.id);
      console.error(
        `[funding-reconcile] ALERT: batch ${batch.id} has been release_requested for over a day — its PaymentIntent is not terminalizing and its allocations stay frozen`,
      );
    }
    if (batch.status === 'settled_with_residual' && !batch.residualDisposition) {
      report.residualsAwaitingDisposition.push(batch.id);
      console.error(
        `[funding-reconcile] ALERT: batch ${batch.id} settled with ${batch.residualMinor} minor residual and no disposition`,
      );
    }
  }

  // 2a-bis. Live allocations under a TERMINAL batch. The orphan-PI
  // recovery path can leave one: it reclaims allocations back to
  // `reserved` and then fails to re-open the batch (the one-open-batch
  // index refuses when a newer batch exists). Reservation won't re-take
  // those commissions (the live-allocation index blocks it) and the
  // invariant loop above skips released batches — so nothing surfaced it
  // and the partner simply never got paid.
  const orphanedAllocations = (await db(TABLES.HostedFundingAllocation)
    .join(
      TABLES.HostedFundingBatch,
      `${TABLES.HostedFundingBatch}.id`,
      `${TABLES.HostedFundingAllocation}.batchId`,
    )
    .whereIn(`${TABLES.HostedFundingAllocation}.state`, ['reserved', 'transfer_pending'])
    .whereIn(`${TABLES.HostedFundingBatch}.status`, ['released', 'settled', 'settled_with_residual'])
    .select(
      `${TABLES.HostedFundingAllocation}.id as allocationId`,
      `${TABLES.HostedFundingBatch}.id as batchId`,
      `${TABLES.HostedFundingBatch}.status as batchStatus`,
    )) as Array<{ allocationId: string; batchId: string; batchStatus: string }>;
  for (const row of orphanedAllocations) {
    report.attentionBatches.push(row.batchId);
    console.error(
      `[funding-reconcile] ALERT: allocation ${row.allocationId} is live under ${row.batchStatus} batch ${row.batchId} — its commission can never be re-reserved and will never be paid; operator action required`,
    );
  }

  // 2b. Transfer intents needing reconciliation (the executor also
  // handles these on its own cadence — this is the daily double-check).
  const intents = (await db(TABLES.HostedFundingTransfer)
    .whereIn('state', ['reconcile_required'])
    .select('id')) as Array<{ id: string }>;
  report.reconcileRequiredIntents = intents.map((i) => i.id);
  if (intents.length > 0) {
    console.error(
      `[funding-reconcile] ${intents.length} transfer intent(s) in reconcile_required`,
    );
  }

  // 2c. Webhook events claimed but never finished. A crashed handler
  // normally gets picked up by Stripe's redelivery (the inbox claim is a
  // lease). One that's still unfinished an hour later never got that
  // redelivery — the transition it carried is simply missing, and only a
  // manual replay from the Stripe dashboard will apply it.
  const stuckEvents = (await db(TABLES.StripeWebhookInbox)
    .whereNull('outcome')
    .where('processedAt', '<', new Date(runAt.getTime() - INBOX_STUCK_MS))
    .select('stripeEventId', 'type')) as Array<{ stripeEventId: string; type: string }>;
  report.unfinishedInboxEvents = stuckEvents.map((e) => e.stripeEventId);
  for (const e of stuckEvents) {
    console.error(
      `[funding-reconcile] ALERT: webhook ${e.stripeEventId} (${e.type}) was claimed but never completed and never redelivered — replay it from the Stripe dashboard`,
    );
  }

  // 2d. Transfer intents that POSTED but never got linked to a Payout.
  //
  // This is the condition behind the lost reversal round 7 fixed, and it
  // needs its own detector rather than relying on the inbox alert above
  // (round 8). That alert measures age from `processedAt`, which a claim
  // takeover REFRESHES — so an event redelivered every few minutes keeps
  // pushing its own alert out and can stay unprocessable indefinitely.
  //
  // The underlying fact is not timing-dependent: an intent stuck in
  // `posted` with no payoutId cannot accept a reversal, and if its batch
  // has reached a state the executor no longer scans (a disputed funding
  // charge) nothing will ever link it. Report that directly.
  const unlinkedDeadline = new Date(runAt.getTime() - INBOX_STUCK_MS);
  const unlinked = (await db(TABLES.HostedFundingTransfer)
    .whereIn('state', ['posted', 'reconcile_required'])
    .whereNull('payoutId')
    .where('updatedAt', '<', unlinkedDeadline)
    .select('id', 'batchId', 'stripeTransferId')) as Array<{
    id: string;
    batchId: string;
    stripeTransferId: string | null;
  }>;
  for (const i of unlinked) {
    report.attentionBatches.push(i.batchId);
    console.error(
      `[funding-reconcile] ALERT: transfer intent ${i.id} (batch ${i.batchId}, transfer ${i.stripeTransferId ?? 'none'}) has been posted with no linked Payout for over an hour — it cannot accept a reversal in this state; operator action required`,
    );
  }

  // 3. Live-Stripe sweep over settled money. Two jobs, one charge fetch:
  // backfill the rail fee, and — the reason this is not optional — notice
  // a refund or dispute whose webhook we never received. Everything else
  // here reads local state, so a LOST webhook is invisible to it: the
  // batch stays unfrozen and its payouts stay recorded as paid while the
  // money has gone back to the brand.
  // Bounded by AGE, not by an arbitrary page: a refund or dispute can only
  // appear within Stripe's dispute window, so everything inside that
  // horizon gets checked every run and nothing older needs to be. Slicing
  // the oldest N of an ever-growing list (the first version) meant the
  // same 50 batches were re-checked forever while newer ones — the only
  // ones that can still change — were never looked at.
  const horizon = new Date(runAt.getTime() - REVERSAL_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  let stripe: Stripe | null = null;
  try {
    stripe = deps.stripe ?? requireStripe();
  } catch {
    return finalize(report); // no Stripe configured (selfhost) — nothing to sweep
  }

  // One claim token per run: every row claimed below is acknowledged under
  // it, so a run that dies leaves only expiring leases behind.
  const sweepToken = ulid();

  // A batch joins this sweep when it FUNDS; a never-swept row is ordered
  // by that moment. After the first visit its own `sweepDueAt` carries the
  // rotation.
  const chargeEligible = (qb: Knex.QueryBuilder) =>
    qb
      .whereNotNull('stripeChargeId')
      .whereIn('status', ['funded', 'transferring', 'settled', 'settled_with_residual'])
      .whereRaw(`coalesce("fundedAt", "createdAt") >= ?`, [horizon]);
  const chargeDue = await claimSweepRows<HostedFundingBatchRow>(
    db,
    TABLES.HostedFundingBatch,
    sweepToken,
    sweepLimit,
    chargeEligible,
    `coalesce("fundedAt", "createdAt")`,
  );
  // An unchecked batch must never look like a clean one: name what the cap
  // deferred. Deferral is not loss — every eligible row keeps its place in
  // the least-recently-visited order and gets its turn.
  const chargeEligibleIds = (await db(TABLES.HostedFundingBatch)
    .select('id')
    .modify(chargeEligible)) as Array<{ id: string }>;
  const claimedChargeIds = new Set(chargeDue.map((b) => b.id));
  const chargeDeferred = chargeEligibleIds.map((r) => r.id).filter((id) => !claimedChargeIds.has(id));
  if (chargeDeferred.length > 0) {
    report.sweepSkipped.push(...chargeDeferred);
    console.warn(
      `[funding-reconcile] ${chargeEligibleIds.length} batches inside the ${REVERSAL_HORIZON_DAYS}d reversal horizon exceeds the ${sweepLimit}/run cap — ${chargeDeferred.length} deferred to later runs (full pass every ${Math.ceil(chargeEligibleIds.length / sweepLimit)} runs)`,
    );
  }
  for (const batch of chargeDue) {
    let failed = false;
    try {
      const charge = await stripe.charges.retrieve(batch.stripeChargeId!, {
        expand: ['balance_transaction'],
      });
      const tx = typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
      if (tx && batch.actualStripeFeeMinor == null) {
        await db(TABLES.HostedFundingBatch)
          .where({ id: batch.id })
          .update({ actualStripeFeeMinor: tx.fee, updatedAt: new Date() });
        report.feeBackfilled.push(batch.id);
      }
      const clawedBack = charge.refunded || (charge.amount_refunded ?? 0) > 0 || charge.disputed;
      if (clawedBack && batch.status !== 'funding_disputed') {
        // Exactly what the webhook would have done — shared so the two
        // paths can't drift, and so the settled case (which must NOT be
        // dragged back into the open-batch unique index) is handled the
        // same way in both.
        const { recordFundingChargeClawback } = await import('./webhook.js');
        const outcome = await recordFundingChargeClawback(
          db,
          batch.id,
          'reconcile_detected_refund_or_dispute',
        );
        report.missedRefunds.push(batch.id);
        console.error(
          `[funding-reconcile] ALERT: funding charge ${charge.id} for batch ${batch.id} is refunded/disputed but no webhook ever arrived (${outcome})`,
        );
      }
    } catch (err) {
      failed = true;
      console.error(`[funding-reconcile] charge sweep failed for batch ${batch.id}`, err);
    }
    // Success and failure reschedule IDENTICALLY (see SWEEP_REVISIT_MS) —
    // a failed row keeps its place in the rotation forever, so it can be
    // slow to re-check but can never be dropped or age out unseen.
    const failCount = await ackSweepRow(
      db,
      TABLES.HostedFundingBatch,
      batch.id,
      sweepToken,
      runAt,
      failed,
    );
    if (failed && failCount >= SWEEP_FAIL_ALERT) {
      console.error(
        `[funding-reconcile] ALERT: charge read for batch ${batch.id} has failed ${failCount} consecutive sweeps — investigate before its horizon passes`,
      );
    }
  }

  // 3b. Same argument for the transfer side: a missed `transfer.reversed`
  // leaves a Payout recorded `paid` on money that was clawed back.
  // NO age horizon on this side. Refunds have a documented deadline;
  // transfer reversals do not — Stripe places no age limit on reversing a
  // transfer, so cutting the sweep off at 180 days would simply stop
  // looking at money that can still come back. Rotation is what keeps the
  // unbounded set affordable.
  //
  // A never-swept intent is ordered by `updatedAt` — roughly when it
  // confirmed (`postedAt` is stamped BEFORE the Stripe call, round 7).
  // Under the old global cursor the exactness of that timestamp was
  // load-bearing: `db.fn.now()` renders as CURRENT_TIMESTAMP, which is
  // transaction-START time, and start order is not commit order — a row
  // could still commit with a key behind the already-persisted cursor and
  // be stranded (round 9). With per-row scheduling the timestamp is only
  // a PRIORITY hint for a row's first visit: skew can delay that visit by
  // one rotation at most, never strand the row, because selection is a
  // per-run rank over live rows and there is no high-water mark to fall
  // behind.
  const transferEligible = (qb: Knex.QueryBuilder) =>
    qb.where({ state: 'confirmed' }).whereNotNull('stripeTransferId');
  const transferDue = await claimSweepRows<HostedFundingTransferRow>(
    db,
    TABLES.HostedFundingTransfer,
    sweepToken,
    sweepLimit,
    transferEligible,
    `"updatedAt"`,
  );
  const transferEligibleIds = (await db(TABLES.HostedFundingTransfer)
    .select('id')
    .modify(transferEligible)) as Array<{ id: string }>;
  const claimedTransferIds = new Set(transferDue.map((i) => i.id));
  const transferDeferred = transferEligibleIds
    .map((r) => r.id)
    .filter((id) => !claimedTransferIds.has(id));
  if (transferDeferred.length > 0) {
    report.sweepSkipped.push(...transferDeferred);
    console.warn(
      `[funding-reconcile] ${transferEligibleIds.length} confirmed transfers exceeds the ${sweepLimit}/run cap — ${transferDeferred.length} deferred to later runs (full pass every ${Math.ceil(transferEligibleIds.length / sweepLimit)} runs)`,
    );
  }
  for (const intent of transferDue) {
    let failed = false;
    try {
      const payout = intent.payoutId
        ? ((await db(TABLES.Payout).where({ id: intent.payoutId }).first(['status'])) as
            | { status: string }
            | undefined)
        : undefined;
      // Only a FULLY reversed payout is finished. Skipping
      // `partially_reversed` too meant that once a partial landed, the
      // webhook completing the reversal could be lost and this sweep —
      // the only backstop — would never look again.
      if (payout?.status !== 'reversed') {
        const transfer = await stripe.transfers.retrieve(intent.stripeTransferId!);
        if (transfer.reversed || (transfer.amount_reversed ?? 0) !== 0) {
          const { handleTransferReversed } = await import('./webhook.js');
          const outcome = await handleTransferReversed(db, stripe, transfer, intent.id);
          report.missedReversals.push(intent.id);
          console.error(
            `[funding-reconcile] ALERT: transfer ${transfer.id} (intent ${intent.id}) is reversed at Stripe but no webhook ever arrived — outcome: ${outcome}`,
          );
        }
      }
    } catch (err) {
      failed = true;
      console.error(`[funding-reconcile] transfer sweep failed for intent ${intent.id}`, err);
    }
    const failCount = await ackSweepRow(
      db,
      TABLES.HostedFundingTransfer,
      intent.id,
      sweepToken,
      runAt,
      failed,
    );
    if (failed && failCount >= SWEEP_FAIL_ALERT) {
      console.error(
        `[funding-reconcile] ALERT: transfer read for intent ${intent.id} has failed ${failCount} consecutive sweeps — a reversal on it would currently go unnoticed`,
      );
    }
  }

  return finalize(report);
}

/** Applied at EVERY exit, not just the last one — the no-Stripe early
 *  return produced un-deduped reports. */
function finalize(report: ReconcileReport): ReconcileReport {
  report.attentionBatches = [...new Set(report.attentionBatches)];
  report.sweepSkipped = [...new Set(report.sweepSkipped)];
  return report;
}
