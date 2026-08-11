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
import { DEFAULT_TENANT_ID, TABLES, type HostedFundingBatchRow } from '@openpartner/db';
import { requireStripe } from '../stripe.js';
import { casBatch, TRANSFER_DEADLINE_DAYS } from './state.js';

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
const SWEEP_CURSOR_CHARGES = 'funding.sweep.cursor.charges';
const SWEEP_CURSOR_TRANSFERS = 'funding.sweep.cursor.transfers';

/**
 * Advance a persisted CURSOR over a stable ordering, and return this
 * run's slice.
 *
 * Two previous attempts at this were wrong in the same way — they looked
 * like rotation without guaranteeing coverage:
 *   - a per-day hash shuffle re-deals independently every day, so a row
 *     can simply keep losing;
 *   - a window computed as `(day % ceil(total/limit)) * limit` only holds
 *     for a FROZEN list. In production rows are added daily, `windows`
 *     changes, the modular sequence shifts, and specific indices are
 *     never selected at all.
 *
 * A cursor has neither problem: it walks ids in order and remembers where
 * it stopped, so every row is reached regardless of churn, and rows added
 * behind the cursor are picked up on the next wrap.
 */
async function sweepSlice<T>(
  db: Knex,
  cursorKey: string,
  rows: T[],
  idOf: (row: T) => string,
  limit: number,
): Promise<{ due: T[]; deferred: T[] }> {
  if (rows.length <= limit) {
    await setSweepCursor(db, cursorKey, null); // whole set covered; start over
    return { due: rows, deferred: [] };
  }
  const ordered = [...rows].sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));
  const cursor = await getSweepCursor(db, cursorKey);
  const startIndex = cursor ? ordered.findIndex((r) => idOf(r) > cursor) : 0;
  // findIndex returns -1 when the cursor is past every id — wrap.
  const from = startIndex === -1 ? 0 : startIndex;
  const due = ordered.slice(from, from + limit);
  const last = due.length > 0 ? idOf(due[due.length - 1]!) : null;
  // Wrapping is explicit: once we hand out the tail, the next run starts
  // from the beginning rather than stalling at the end.
  await setSweepCursor(db, cursorKey, from + limit >= ordered.length ? null : last);
  const dueIds = new Set(due.map(idOf));
  return { due, deferred: ordered.filter((r) => !dueIds.has(idOf(r))) };
}

/** The sweep is platform-wide, but Config is tenant-scoped; the seeded
 *  tenant holds these two platform rows. Documented rather than tidy —
 *  a dedicated table for two strings isn't worth a migration. */
async function getSweepCursor(db: Knex, key: string): Promise<string | null> {
  const row = (await db(TABLES.Config)
    .where({ tenantId: DEFAULT_TENANT_ID, key })
    .first(['value'])) as { value: unknown } | undefined;
  const v = row?.value;
  return typeof v === 'string' ? v : null;
}

async function setSweepCursor(db: Knex, key: string, value: string | null): Promise<void> {
  await db(TABLES.Config)
    .insert({ tenantId: DEFAULT_TENANT_ID, key, value: JSON.stringify(value), updatedAt: new Date() })
    .onConflict(['tenantId', 'key'])
    .merge({ value: JSON.stringify(value), updatedAt: new Date() });
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
  const funded = open.filter(
    (b) =>
      b.stripeChargeId &&
      ['funded', 'transferring', 'settled', 'settled_with_residual'].includes(b.status) &&
      new Date(b.fundedAt ?? b.createdAt) >= horizon,
  );
  let stripe: Stripe | null = null;
  try {
    stripe = deps.stripe ?? requireStripe();
  } catch {
    return report; // no Stripe configured (selfhost) — nothing to sweep
  }

  // ROTATE, don't just cap. A fixed order plus a fixed prefix meant the
  // same head of the list was re-checked every night while everything
  // behind it was never checked at all — reporting the skipped ids made
  // that visible but didn't fix the scheduling. Ordering by a per-day
  // hash gives every row a turn, so coverage is eventually complete.
  const chargeSlice = await sweepSlice(db, SWEEP_CURSOR_CHARGES, funded, (b) => b.id, sweepLimit);
  if (chargeSlice.deferred.length > 0) {
    report.sweepSkipped.push(...chargeSlice.deferred.map((b) => b.id));
    console.warn(
      `[funding-reconcile] ${funded.length} batches inside the ${REVERSAL_HORIZON_DAYS}d reversal horizon exceeds the ${sweepLimit}/run cap — ${chargeSlice.deferred.length} deferred; the cursor resumes from here next run (full pass every ${Math.ceil(funded.length / sweepLimit)} runs)`,
    );
  }
  for (const batch of chargeSlice.due) {
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
      console.error(`[funding-reconcile] charge sweep failed for batch ${batch.id}`, err);
    }
  }

  // 3b. Same argument for the transfer side: a missed `transfer.reversed`
  // leaves a Payout recorded `paid` on money that was clawed back.
  // NO age horizon on this side. Refunds have a documented deadline;
  // transfer reversals do not — Stripe places no age limit on reversing a
  // transfer, so cutting the sweep off at 180 days would simply stop
  // looking at money that can still come back. Rotation is what keeps the
  // unbounded set affordable.
  const confirmedAll = (await db(TABLES.HostedFundingTransfer)
    .where({ state: 'confirmed' })
    .whereNotNull('stripeTransferId')) as Array<{
    id: string;
    stripeTransferId: string;
    payoutId: string | null;
  }>;
  const transferSlice = await sweepSlice(
    db,
    SWEEP_CURSOR_TRANSFERS,
    confirmedAll,
    (i) => i.id,
    sweepLimit,
  );
  const confirmed = transferSlice.due;
  if (transferSlice.deferred.length > 0) {
    report.sweepSkipped.push(...transferSlice.deferred.map((i) => i.id));
    console.warn(
      `[funding-reconcile] ${confirmedAll.length} confirmed transfers exceeds the ${sweepLimit}/run cap — ${transferSlice.deferred.length} deferred; the cursor resumes from here next run (full pass every ${Math.ceil(confirmedAll.length / sweepLimit)} runs)`,
    );
  }
  for (const intent of confirmed) {
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
      if (payout?.status === 'reversed') continue;
      const transfer = await stripe.transfers.retrieve(intent.stripeTransferId);
      if (!transfer.reversed && (transfer.amount_reversed ?? 0) === 0) continue;
      const { handleTransferReversed } = await import('./webhook.js');
      const outcome = await handleTransferReversed(db, stripe, transfer, intent.id);
      report.missedReversals.push(intent.id);
      console.error(
        `[funding-reconcile] ALERT: transfer ${transfer.id} (intent ${intent.id}) is reversed at Stripe but no webhook ever arrived — outcome: ${outcome}`,
      );
    } catch (err) {
      console.error(`[funding-reconcile] transfer sweep failed for intent ${intent.id}`, err);
    }
  }

  report.attentionBatches = [...new Set(report.attentionBatches)];
  return report;
}
