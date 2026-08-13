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
  /** Immutable ELIGIBILITY order — see the ordering note below. */
  orderKeyOf: (row: T) => string,
  limit: number,
): Promise<{ due: T[]; deferred: T[]; commit: (failedIds?: string[]) => Promise<void> }> {
  // Rows that failed a previous run come back FIRST and stay in the set
  // until they succeed, independent of where the cursor is (round 6).
  const retrySet = await getSweepRetry(db, cursorKey);
  const retryIds = new Set(retrySet);
  // Retries get at most HALF the budget (round 7). Letting them take the
  // whole limit was the poison-item failure in a new costume: with `limit`
  // persistently-failing rows, `remaining` was 0 every run, `cursorDue` was
  // always empty, the cursor reset to null forever, and NOTHING else was
  // ever swept — the exact starvation the retry set was introduced to
  // prevent. Reserving cursor capacity means both always make progress.
  // Never take the LAST slot (round 8). `Math.max(1, ...)` meant that at
  // limit 1 the retry set took the only slot, `remaining` was 0, and one
  // permanently-failing row starved every healthy cursor row forever — the
  // poison-item failure yet again. Cursor work now always gets at least one
  // slot; at limit 1 retries get none and are reached by the cursor
  // instead, since they remain in `rows`.
  const retryBudget = Math.max(0, Math.min(Math.floor(limit / 2), limit - 1));
  // Select in RETRY-SET order, not row order. `commit` rotates survivors to
  // the back of the stored set, but selecting by filtering `rows` threw
  // that order away and re-picked the same head every run — so the rotation
  // rotated nothing and the tail of the set was never retried (round 8).
  const byId = new Map(rows.map((r) => [idOf(r), r]));
  const retryDue = retrySet
    .map((id) => byId.get(id))
    .filter((r): r is T => r !== undefined)
    .slice(0, retryBudget);
  const retryDueIds = new Set(retryDue.map(idOf));

  // ORDER BY WHEN A ROW BECAME ELIGIBLE, not by its id. Ids are assigned
  // at creation, but rows join this sweep later (a batch when it funds, a
  // transfer when it confirms). A row that becomes eligible BEHIND the
  // cursor was therefore never selected, and if a full slice of newer
  // eligible rows arrives before every run the cursor never wraps to
  // reach it — so it was skipped forever, and on the charge side it
  // eventually aged out of the horizon entirely.
  const cursorable = rows.filter((r) => !retryDueIds.has(idOf(r)));
  const ordered = [...cursorable].sort((a, b) =>
    orderKeyOf(a) < orderKeyOf(b) ? -1 : orderKeyOf(a) > orderKeyOf(b) ? 1 : 0,
  );
  const remaining = Math.max(0, limit - retryDue.length);
  const cursor = await getSweepCursor(db, cursorKey);
  const startIndex = cursor ? ordered.findIndex((r) => orderKeyOf(r) > cursor) : 0;
  // findIndex returns -1 when the cursor is past every key — wrap.
  const from = startIndex === -1 ? 0 : startIndex;
  const cursorDue = ordered.slice(from, from + remaining);
  const last = cursorDue.length > 0 ? orderKeyOf(cursorDue[cursorDue.length - 1]!) : null;

  const due = [...retryDue, ...cursorDue];
  const dueIds = new Set(due.map(idOf));
  const wrapped = from + remaining >= ordered.length;

  return {
    due,
    deferred: rows.filter((r) => !dueIds.has(idOf(r))),
    // COMMIT AFTER THE WORK, never before — and never acknowledge an item
    // that FAILED.
    //
    // The cursor used to advance unconditionally once the loop finished,
    // even though per-item Stripe errors are caught and logged inside it.
    // A failed row was therefore both skipped AND passed over, and could
    // age out of the horizon before the cursor wrapped back.
    //
    // The obvious fix — don't commit the cursor if anything failed — is
    // worse: one permanently unreadable Stripe object would pin the
    // cursor and starve everything behind it. So failures go into a
    // durable retry set instead, and the cursor is free to move on.
    commit: async (failedIds: string[] = []) => {
      const failed = new Set(failedIds);
      const succeeded = new Set([...dueIds].filter((id) => !failed.has(id)));
      // ROTATE: the ids we just attempted and that failed again go to the
      // BACK, so a persistently-failing head cannot monopolise the retry
      // budget and hide the tail behind it forever.
      const attempted = new Set(retryDue.map(idOf));
      const untouched = retrySet.filter((id) => !succeeded.has(id) && !attempted.has(id));
      const retriedAgain = retrySet.filter((id) => !succeeded.has(id) && attempted.has(id));
      const newlyFailed = failedIds.filter((id) => !retrySet.includes(id));
      let list = [...untouched, ...retriedAgain, ...newlyFailed];
      if (list.length > RETRY_SET_CAP) {
        // Drop from the FRONT (oldest-attempted) and say exactly which ids
        // are being forgotten — a silently dropped id is the failure this
        // whole mechanism exists to prevent, so it must never be quiet.
        const dropped = list.slice(0, list.length - RETRY_SET_CAP);
        console.error(
          `[funding-reconcile] ALERT: ${cursorKey} retry set exceeded ${RETRY_SET_CAP} (${list.length}) — DROPPING ${dropped.length} id(s) that will no longer be retried: ${dropped.join(', ')}. Stripe reads are failing persistently; investigate before these age out of their horizon.`,
        );
        list = list.slice(-RETRY_SET_CAP);
      }
      await setSweepRetry(db, cursorKey, list);
      await setSweepCursor(db, cursorKey, wrapped ? null : last);
    },
  };
}

/** The sweep is platform-wide, but Config is tenant-scoped; the seeded
 *  tenant holds these two platform rows. Documented rather than tidy —
 *  a dedicated table for two strings isn't worth a migration. */
async function getSweepCursor(db: Knex, key: string): Promise<string | null> {
  try {
    const row = (await db(TABLES.Config)
      .where({ tenantId: DEFAULT_TENANT_ID, key })
      .first(['value'])) as { value: unknown } | undefined;
    const v = row?.value;
    return typeof v === 'string' ? v : null;
  } catch (err) {
    // Degrade to "sweep from the top" rather than taking the whole job
    // down. Config.tenantId is an FK to the seeded tenant, so a deployment
    // that deleted that row would otherwise fail EVERY reconciliation.
    console.error(`[funding-reconcile] sweep cursor ${key} unreadable — starting from the top`, err);
    return null;
  }
}

/** Ids that failed their Stripe read and must be retried regardless of
 *  where the cursor has moved to. Bounded so a permanently-broken object
 *  cannot grow it without limit; overflow is alerted, not silent. */
const RETRY_SET_CAP = 200;

async function getSweepRetry(db: Knex, key: string): Promise<string[]> {
  try {
    const row = (await db(TABLES.Config)
      .where({ tenantId: DEFAULT_TENANT_ID, key: `${key}.retry` })
      .first(['value'])) as { value: unknown } | undefined;
    const v = row?.value;
    return Array.isArray(v) ? (v as string[]).filter((x) => typeof x === 'string') : [];
  } catch (err) {
    // Same degradation as the cursor: losing the retry set costs a delayed
    // re-check, not correctness — the row stays eligible and the cursor
    // still reaches it on a wrap.
    console.error(`[funding-reconcile] sweep retry set ${key} unreadable — treating as empty`, err);
    return [];
  }
}

async function setSweepRetry(db: Knex, key: string, ids: string[]): Promise<void> {
  try {
    await db(TABLES.Config)
      .insert({
        tenantId: DEFAULT_TENANT_ID,
        key: `${key}.retry`,
        value: JSON.stringify(ids),
        updatedAt: new Date(),
      })
      .onConflict(['tenantId', 'key'])
      .merge({ value: JSON.stringify(ids), updatedAt: new Date() });
  } catch (err) {
    console.error(`[funding-reconcile] sweep retry set ${key} not persisted`, err);
  }
}

async function setSweepCursor(db: Knex, key: string, value: string | null): Promise<void> {
  try {
    await db(TABLES.Config)
      .insert({ tenantId: DEFAULT_TENANT_ID, key, value: JSON.stringify(value), updatedAt: new Date() })
      .onConflict(['tenantId', 'key'])
      .merge({ value: JSON.stringify(value), updatedAt: new Date() });
  } catch (err) {
    // Losing the cursor costs repeated work, not correctness.
    console.error(`[funding-reconcile] sweep cursor ${key} not persisted`, err);
  }
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
    return finalize(report); // no Stripe configured (selfhost) — nothing to sweep
  }

  // ROTATE, don't just cap. A fixed order plus a fixed prefix meant the
  // same head of the list was re-checked every night while everything
  // behind it was never checked at all — reporting the skipped ids made
  // that visible but didn't fix the scheduling. Ordering by a per-day
  // hash gives every row a turn, so coverage is eventually complete.
  const chargeSlice = await sweepSlice(
    db,
    SWEEP_CURSOR_CHARGES,
    funded,
    (b) => b.id,
    // A batch joins this sweep when it FUNDS, so that is the ordering that
    // guarantees coverage. `fundedAt` never moves once set; the id is the
    // tiebreak. Ordering by id alone skipped batches that funded behind
    // the cursor.
    (b) => `${new Date(b.fundedAt ?? b.createdAt).toISOString()}|${b.id}`,
    sweepLimit,
  );
  if (chargeSlice.deferred.length > 0) {
    report.sweepSkipped.push(...chargeSlice.deferred.map((b) => b.id));
    console.warn(
      `[funding-reconcile] ${funded.length} batches inside the ${REVERSAL_HORIZON_DAYS}d reversal horizon exceeds the ${sweepLimit}/run cap — ${chargeSlice.deferred.length} deferred; the cursor resumes from here next run (full pass every ${Math.ceil(funded.length / sweepLimit)} runs)`,
    );
  }
  const chargeFailures: string[] = [];
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
      // Remember it: a swallowed failure used to be acknowledged by the
      // cursor and could age out of the horizon before the next wrap.
      chargeFailures.push(batch.id);
      console.error(`[funding-reconcile] charge sweep failed for batch ${batch.id}`, err);
    }
  }

  await chargeSlice.commit(chargeFailures);

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
    postedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  const transferSlice = await sweepSlice(
    db,
    SWEEP_CURSOR_TRANSFERS,
    confirmedAll,
    (i) => i.id,
    // An intent joins this sweep when it CONFIRMS. `postedAt` is NOT that
    // moment (round 7): it is stamped before the Stripe call, so an intent
    // whose response was lost sits `posted` while the cursor walks past its
    // postedAt, then confirms a day later via reconcile — landing BEHIND
    // the cursor and starvable under churn, exactly the bug this ordering
    // was meant to fix.
    //
    // `updatedAt` is the right key precisely because it MOVES: finalization
    // bumps it at the moment the row becomes eligible, so the row is always
    // ahead of the cursor when it joins. Later mutations bump it again,
    // which can only re-visit a row — never skip one. Re-sweeping is free
    // (the sweep is a read plus idempotent handlers); skipping is not.
    //
    // That argument needs the timestamps to come from ONE clock, and in
    // round 7 they did not: every writer used the app's `new Date()`, so a
    // node running a minute behind could finalize a row with a timestamp
    // BEHIND the cursor and strand it (round 8). Every writer of this
    // column now uses `db.fn.now()` — the database's own clock — so the
    // ordering has a single source and "only ever forward" is true.
    (i) => `${new Date(i.updatedAt ?? i.postedAt ?? i.createdAt).toISOString()}|${i.id}`,
    sweepLimit,
  );
  const confirmed = transferSlice.due;
  if (transferSlice.deferred.length > 0) {
    report.sweepSkipped.push(...transferSlice.deferred.map((i) => i.id));
    console.warn(
      `[funding-reconcile] ${confirmedAll.length} confirmed transfers exceeds the ${sweepLimit}/run cap — ${transferSlice.deferred.length} deferred; the cursor resumes from here next run (full pass every ${Math.ceil(confirmedAll.length / sweepLimit)} runs)`,
    );
  }
  const transferFailures: string[] = [];
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
      transferFailures.push(intent.id);
      console.error(`[funding-reconcile] transfer sweep failed for intent ${intent.id}`, err);
    }
  }

  await transferSlice.commit(transferFailures);

  return finalize(report);
}

/** Applied at EVERY exit, not just the last one — the no-Stripe early
 *  return produced un-deduped reports. */
function finalize(report: ReconcileReport): ReconcileReport {
  report.attentionBatches = [...new Set(report.attentionBatches)];
  report.sweepSkipped = [...new Set(report.sweepSkipped)];
  return report;
}
