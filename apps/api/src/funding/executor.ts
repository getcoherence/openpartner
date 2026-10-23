/**
 * Transfer executor — spec §6 step 2–5. Consumes `funded` batches and
 * moves money to partners, one short transaction per step, every Stripe
 * call between transactions.
 *
 * The core discipline is the TRANSFER INTENT (finding 2): a
 * HostedFundingTransfer row is created and COMMITTED before any
 * transfers.create call, carrying a frozen idempotency key
 * (`fbt:<intentId>`). A crashed worker retries the same key; an ambiguous
 * outcome older than Stripe's ~24h key-pruning window is resolved by
 * listing transfers by transfer_group + metadata — never a blind re-POST.
 * A listing that finds nothing HOLDS the intent for an operator, who alone
 * may authorise a fresh key (`releaseFundedTransferForRetry`) — the direct
 * rail's round-6 rule, docs/payout-funding.md §4. A single match is
 * authenticated against the frozen intent before it is recorded, and
 * anything else (two matches, an abandoned generation's, a match that
 * fails authentication) PARKS the intent in `duplicate_review` until an
 * operator resolves it (`resolveFundedDuplicateReview`) — the direct
 * rail's round-10 and duplicate-review rules.
 *
 * Transfers are linked to the funding charge via `source_transaction`, so
 * they draw on the brand's settled payment, not the platform's pooled
 * balance. Money only moves after money arrived.
 */

import type Stripe from 'stripe';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type CommissionRow,
  type FundingTransferState,
  type HostedFundingAllocationRow,
  type HostedFundingBatchRow,
  type HostedFundingTransferRow,
  type PartnerRow,
  type TenantRow,
} from '@openpartner/db';
import { requireStripe } from '../stripe.js';
import { dispatchEvent } from '../webhook-dispatcher.js';
import type { WebhookPayload } from '../openapi/webhook-events.js';
import { dispatchCommissionEvents } from '../commission-events.js';
import { casBatch, minorToMajorString, TRANSFER_DEADLINE_DAYS } from './state.js';
import { partnerPayoutHolds, type PayoutHold, type PayoutHoldReason } from '../sanctions-screening.js';
import { sendOpsEmail } from '../platform-ops-mail.js';
import { payoutStatementUrl } from '../portal-url.js';
import { opsFundedTransfersHeldEmail } from '../email-templates.js';
import { getPortalBaseUrl } from '../portal-url.js';
import { isDefiniteStripeError, listTransferGroup, readGeneration } from '../payout-transfers.js';

/** Ambiguity window: within it, retrying the frozen key is safe (Stripe
 *  replays); past it the key may be pruned and we must reconcile. */
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** lastError of an intent the executor holds for an operator: past the
 *  key window and nothing in its transfer group. */
const AWAITING_OPERATOR = 'awaiting_operator:no_transfer_found_past_window';

/** Clock-skew grace when checking a found transfer's `created` against the
 *  intent's `postedAt` — the direct rail's figure. */
const CREATED_SKEW_MS = 5 * 60 * 1000;

/**
 * The idempotency key for a transfer intent at a key generation.
 * Generation 0 is the key every intent is created with; only an operator
 * hands out a later one (`releaseFundedTransferForRetry`), because
 * Stripe's retention is anchored to the key's first use and re-using a
 * key would replay its stored outcome. The stored `idempotencyKey` is
 * frozen per generation and doubles as the generation fence.
 */
export function fundedTransferKey(intentId: string, generation = 0): string {
  return generation > 0 ? `fbt:${intentId}:g${generation}` : `fbt:${intentId}`;
}

/** The generation an intent's stored key belongs to, or null when the key
 *  is not one `fundedTransferKey` wrote (a hand edit). */
export function keyGenerationOf(intent: Pick<HostedFundingTransferRow, 'id' | 'idempotencyKey'>): number | null {
  if (intent.idempotencyKey === fundedTransferKey(intent.id)) return 0;
  const prefix = `fbt:${intent.id}:g`;
  if (!intent.idempotencyKey.startsWith(prefix)) return null;
  const g = readGeneration(intent.idempotencyKey.slice(prefix.length));
  return g !== null && g > 0 && intent.idempotencyKey === fundedTransferKey(intent.id, g) ? g : null;
}

export interface ExecutorDeps {
  stripe?: Stripe;
  now?: () => Date;
}

export interface ExecutorResult {
  processed: number;
  transfersPosted: string[];
  transfersConfirmed: string[];
  failed: string[];
  reconcileRequired: string[];
  /** Intents HELD in reconcile_required for an operator: nothing found
   *  past the key window. Later ticks keep listing. */
  awaitingOperator: string[];
  /** Intents PARKED in duplicate_review on this run: more than one
   *  transfer, one from an abandoned key generation, or one that failed
   *  authentication. Reported once; the executor stops scanning them. */
  duplicateReview: string[];
  settled: string[];
  /** Partners whose share of a funded batch a compliance hold stopped
   *  before any transfer: allocations canceled, residual on the batch. */
  heldForCompliance: Array<{
    batchId: string;
    tenantId: string;
    partnerId: string;
    reason: PayoutHoldReason;
    amountMinor: number;
    currency: string;
  }>;
}

export async function runTransferExecutor(db: Knex, deps: ExecutorDeps = {}): Promise<ExecutorResult> {
  const result: ExecutorResult = {
    processed: 0,
    transfersPosted: [],
    transfersConfirmed: [],
    failed: [],
    reconcileRequired: [],
    awaitingOperator: [],
    duplicateReview: [],
    settled: [],
    heldForCompliance: [],
  };
  const batches = (await db(TABLES.HostedFundingBatch)
    .whereIn('status', ['funded', 'transferring'])
    .orderBy('createdAt', 'asc')) as HostedFundingBatchRow[];

  for (const batch of batches) {
    result.processed += 1;
    try {
      await executeBatch(db, batch, deps, result);
    } catch (err) {
      console.error(`[funding] executor error on batch ${batch.id}`, err);
      result.failed.push(batch.id);
    }
  }
  try {
    await notifyOpsOfHeldTransfers(db, result.heldForCompliance);
  } catch (err) {
    // The cancellations are committed and ALERT-logged; a lost email must
    // not fail the job.
    console.error('[funding] ops notice for compliance-held transfers failed', err);
  }
  return result;
}

async function executeBatch(
  db: Knex,
  batch: HostedFundingBatchRow,
  deps: ExecutorDeps,
  result: ExecutorResult,
): Promise<void> {
  const stripe = deps.stripe ?? requireStripe();
  const now = deps.now ?? (() => new Date());

  if (batch.status === 'funded') {
    const moved = await casBatch(db, batch.id, 'funded', 'transferring');
    if (!moved) return; // dispute webhook or another worker moved it
    batch = moved;
  }

  if (!batch.stripeChargeId) {
    // Designed-impossible: funded without a verified charge. Freeze loudly.
    console.error(`[funding] ALERT: batch ${batch.id} is ${batch.status} with no stripeChargeId`);
    await casBatch(db, batch.id, 'transferring', 'recovery_required');
    return;
  }

  const allocations = (await db(TABLES.HostedFundingAllocation)
    .where({ batchId: batch.id })) as HostedFundingAllocationRow[];

  // Funding invariant (spec §6) — asserted before any money moves:
  // every funded cent is accounted for by allocation state + residual.
  // `released` allocations shrank the principal with them (pre-charge
  // interlock cancels) and are excluded; `canceled` ones are frozen money
  // heading for a residual and still count.
  const stateSum = allocations
    .filter((a) => a.state !== 'released')
    .reduce((s, a) => s + Number(a.amountMinor), 0);
  const expected = Number(batch.principalMinor);
  if (stateSum !== expected) {
    console.error(
      `[funding] ALERT: invariant violation on batch ${batch.id}: allocations sum ${stateSum} != principal ${expected} — freezing`,
    );
    await casBatch(db, batch.id, 'transferring', 'recovery_required');
    return;
  }

  // Per-partner transfer groups from live allocations.
  const byPartner = new Map<string, HostedFundingAllocationRow[]>();
  for (const a of allocations) {
    if (a.state !== 'reserved' && a.state !== 'transfer_pending') continue;
    const list = byPartner.get(a.partnerId) ?? [];
    list.push(a);
    byPartner.set(a.partnerId, list);
  }

  for (const [partnerId, group] of byPartner) {
    // Re-read the batch status before EACH transfer. A dispute webhook or
    // the reconcile sweep can freeze the batch (→ funding_disputed) while
    // we're working through its partners; the in-memory row we CASed to
    // `transferring` at the top would otherwise keep paying money out of
    // a charge that has been clawed back.
    const live = (await db(TABLES.HostedFundingBatch)
      .where({ id: batch.id })
      .first(['status'])) as { status: string } | undefined;
    if (live?.status !== 'transferring') {
      console.warn(
        `[funding] batch ${batch.id} left 'transferring' mid-run (now ${live?.status ?? 'missing'}) — stopping before partner ${partnerId}`,
      );
      return;
    }
    await executePartnerTransfer(db, stripe, batch, partnerId, group, now(), result);
  }

  // Settlement check: every allocation terminal → settled. Allocations
  // canceled AFTER the charge amount froze (reversal interlock on an
  // in-flight batch) are funded-but-untransferred money: the batch closes
  // settled_with_residual and the residual awaits an operator disposition
  // (refund / manual payout / credit next batch — spec §7).
  const terminalStates = (await db(TABLES.HostedFundingAllocation)
    .where({ batchId: batch.id })
    .select('state')
    .sum({ total: 'amountMinor' })
    .groupBy('state')) as Array<{ state: string; total: string }>;
  const openMinor = terminalStates
    .filter((r) => !['transferred', 'canceled', 'released'].includes(r.state))
    .reduce((s, r) => s + Number(r.total), 0);
  if (openMinor === 0) {
    const canceledMinor = terminalStates
      .filter((r) => r.state === 'canceled')
      .reduce((s, r) => s + Number(r.total), 0);
    const residual = canceledMinor > 0;
    const settled = await casBatch(
      db,
      batch.id,
      'transferring',
      residual ? 'settled_with_residual' : 'settled',
      { settledAt: new Date(), ...(residual ? { residualMinor: canceledMinor } : {}) },
    );
    if (settled) {
      result.settled.push(batch.id);
      if (residual) {
        console.error(
          `[funding] ALERT: batch ${batch.id} settled with ${canceledMinor} minor residual — operator disposition required`,
        );
      }
    }
  } else {
    // Deadline escalation (§7): allocations stuck past the transfer window
    // need an operator-recorded residual disposition (build 4 surfaces it).
    // Allocations behind an intent parked in duplicate_review are not
    // counted: their disposition is that intent's resolution, the daily
    // reconcile names them, and re-alerting here every tick is the noise
    // parking exists to stop.
    const ageMs = now().getTime() - new Date(batch.fundedAt ?? batch.createdAt).getTime();
    if (
      ageMs > TRANSFER_DEADLINE_DAYS * 24 * 60 * 60 * 1000 &&
      (await hasUnparkedOpenAllocations(db, batch.id))
    ) {
      console.error(
        `[funding] ALERT: batch ${batch.id} still has untransferred allocations ${TRANSFER_DEADLINE_DAYS}d after funding — residual disposition required`,
      );
    }
  }
}

async function executePartnerTransfer(
  db: Knex,
  stripe: Stripe,
  batch: HostedFundingBatchRow,
  partnerId: string,
  group: HostedFundingAllocationRow[],
  now: Date,
  result: ExecutorResult,
): Promise<void> {
  // One intent per (batch, partner, currency) — enforced by unique index.
  let intent = (await db(TABLES.HostedFundingTransfer)
    .where({ batchId: batch.id, partnerId, currency: batch.currency })
    .first()) as HostedFundingTransferRow | undefined;

  if (intent && intent.state === 'confirmed') return;
  // Parked for a human (see parkForReview). Nothing here may touch it: not
  // a listing, not an alert, and not the compliance cancel below, because
  // a transfer for it may be with the partner. Its allocations stay
  // transfer_pending until resolveFundedDuplicateReview settles them.
  if (intent && intent.state === 'duplicate_review') return;
  if (intent && intent.state === 'reconcile_required') {
    await reconcileIntent(db, stripe, batch, intent, result);
    return;
  }

  // Compliance hold (docs/sanctions-screening.md). The planner holds a
  // partner before reserving, but the batch was reserved before the
  // brand's payment settled, often days ago, and a daily rescreen or a
  // newly blocked country can flag the partner inside that window. While nothing for
  // them has reached Stripe (no intent, a `pending` one, or a `failed` one
  // Stripe refused), their allocations are canceled: funded money that
  // won't transfer, which settles the batch with a residual (spec §7.4).
  // A `posted` intent is left for the pre-POST check below.
  const hold = await partnerHold(db, batch.tenantId, partnerId);
  if (hold && (!intent || intent.state === 'pending' || intent.state === 'failed')) {
    await cancelHeldAllocations(db, batch, partnerId, intent ?? null, hold, result);
    return;
  }

  if (!intent) {
    // Step 2 — freeze the intent BEFORE any Stripe call, in one short
    // transaction: re-verify commissions under lock, claim allocations,
    // commit the intent row with its frozen key.
    const partner = (await db(TABLES.Partner).where({ id: partnerId }).first()) as
      | PartnerRow
      | undefined;
    const destination = partner?.stripeConnectAccountId;
    const meta = (partner?.metadata ?? {}) as { stripe?: { payoutsEnabled?: boolean } };
    if (!destination || meta.stripe?.payoutsEnabled !== true) {
      // Partner became transfer-unready after funding — allocation stays
      // live; the deadline alert escalates it to a residual disposition.
      console.error(
        `[funding] partner ${partnerId} not transfer-ready for funded batch ${batch.id} — allocation held`,
      );
      return;
    }

    intent = await db.transaction(async (trx) => {
      // The batch must STILL be transferring at the moment we commit the
      // intent. The per-partner status read before this is only a check;
      // this is the gate. Without it a dispute could freeze the batch
      // between the two and we would still create an intent — and then
      // transfer — out of a charge that has been clawed back.
      const live = (await trx(TABLES.HostedFundingBatch)
        .where({ id: batch.id })
        .forUpdate()
        .first(['status'])) as { status: string } | undefined;
      if (live?.status !== 'transferring') {
        console.warn(
          `[funding] batch ${batch.id} left 'transferring' before the intent for partner ${partnerId} was committed (now ${live?.status ?? 'missing'}) — not creating it`,
        );
        return undefined;
      }

      // Re-verify (finding 5): commissions must still be 'approved' and
      // untouched by reversal/refund/fraud since reservation.
      const commissionIds = group.map((a) => a.commissionId);
      const stillApproved = (await trx(TABLES.Commission)
        .whereIn('id', commissionIds)
        .where({ status: 'approved' })
        .forUpdate()
        .select('id')) as Array<{ id: string }>;
      if (stillApproved.length !== commissionIds.length) {
        console.error(
          `[funding] batch ${batch.id} partner ${partnerId}: ${commissionIds.length - stillApproved.length} commission(s) no longer approved — transfer held for operator disposition`,
        );
        return undefined;
      }

      const claimed = await trx(TABLES.HostedFundingAllocation)
        .whereIn('id', group.map((a) => a.id))
        .where({ state: 'reserved' })
        .update({ state: 'transfer_pending', updatedAt: db.fn.now() });
      // Idempotent re-entry: a previous run may have already claimed them
      // (state transfer_pending) — that's fine, the intent row is the gate.
      if (claimed !== group.length && group.some((a) => a.state === 'reserved')) {
        // Partial claim = concurrent mutation. Back off; next tick re-reads.
        throw new Error(`allocation claim race on batch ${batch.id} partner ${partnerId}`);
      }

      const intentId = ulid();
      const amountMinor = group.reduce((s, a) => s + Number(a.amountMinor), 0);
      const [row] = (await trx(TABLES.HostedFundingTransfer)
        .insert({
          id: intentId,
          tenantId: batch.tenantId,
          batchId: batch.id,
          partnerId,
          currency: batch.currency,
          amountMinor,
          destinationAccountId: destination,
          idempotencyKey: fundedTransferKey(intentId),
          state: 'pending',
          createdAt: new Date(),
          updatedAt: db.fn.now(),
        })
        .returning('*')) as HostedFundingTransferRow[];
      return row;
    });
    if (!intent) return;
  }

  // Ambiguity check for a previously-posted intent: inside the idempotency
  // window the frozen-key retry below is safe (Stripe replays the original
  // outcome); past it, reconcile by listing — never re-POST.
  if (intent.state === 'posted' && intent.postedAt) {
    const age = now.getTime() - new Date(intent.postedAt).getTime();
    if (age > IDEMPOTENCY_WINDOW_MS) {
      await db(TABLES.HostedFundingTransfer)
        .where({ id: intent.id, state: 'posted' })
        .update({ state: 'reconcile_required', updatedAt: db.fn.now() });
      result.reconcileRequired.push(intent.id);
      await reconcileIntent(db, stripe, batch, { ...intent, state: 'reconcile_required' }, result);
      return;
    }
  }

  // A held partner reaching here has a `posted` intent (every other state
  // stopped above). Its transfer may already exist, so it can't be
  // canceled, but a re-POST could still create it. None is made while the
  // hold stands: the hold lifts and the retry resumes, or the key window
  // lapses and the listing above settles it.
  if (hold) {
    console.error(
      `[funding] ALERT: partner ${partnerId} is on a compliance hold (${hold.reason}) with transfer intent ${intent.id} already posted on batch ${batch.id} — not re-posting; the transfer may exist at Stripe`,
    );
    return;
  }

  // Step 3 — post the transfer with the frozen key. 'pending', 'posted'
  // (within window) and 'failed' all retry the same key: replays return
  // the original outcome, real retries only happen after the window.
  // LAST gate before the irreversible call. The check inside the
  // intent-creation transaction only covers intents created on THIS pass
  // — an existing pending/failed/posted intent skipped it entirely — and
  // even a fresh one can have its batch frozen between that commit and
  // this line. This can't be atomic with a Stripe call, but it narrows
  // the gap to the request itself and closes the existing-intent hole.
  const stillTransferring = (await db(TABLES.HostedFundingBatch)
    .where({ id: batch.id })
    .first(['status'])) as { status: string } | undefined;
  if (stillTransferring?.status !== 'transferring') {
    console.warn(
      `[funding] batch ${batch.id} is ${stillTransferring?.status ?? 'missing'} — not posting the transfer for partner ${partnerId}`,
    );
    return;
  }

  const generation = keyGenerationOf(intent);
  if (generation === null) {
    console.error(
      `[funding] ALERT: transfer intent ${intent.id} has an unrecognised idempotency key — refusing to post; operator repair required`,
    );
    result.failed.push(intent.id);
    return;
  }

  // Compare-and-set on the state we read AND the key we are about to post:
  // a row another writer finalized, or an operator re-armed onto a new key,
  // is no longer ours to post.
  const claimed = await db(TABLES.HostedFundingTransfer)
    .where({ id: intent.id, idempotencyKey: intent.idempotencyKey })
    .whereIn('state', ['pending', 'posted', 'failed'])
    .update({ state: 'posted', postedAt: intent.postedAt ?? now, updatedAt: db.fn.now() });
  if (claimed === 0) {
    console.warn(`[funding] transfer intent ${intent.id} moved before its post — not posting`);
    return;
  }
  let transfer: Stripe.Transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: Number(intent.amountMinor),
        currency: intent.currency,
        destination: intent.destinationAccountId,
        source_transaction: batch.stripeChargeId!,
        transfer_group: batch.id,
        metadata: {
          openpartner_transfer_intent_id: intent.id,
          openpartner_funding_batch_id: batch.id,
          openpartner_tenant_id: batch.tenantId,
          openpartner_partner_id: partnerId,
          // Which key generation produced this transfer, so a reconcile
          // can tell a superseded attempt's straggler from the current one.
          openpartner_key_generation: String(generation),
        },
      },
      { idempotencyKey: intent.idempotencyKey },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Shared with the direct rail: a 409 idempotency conflict or a 429 is
    // AMBIGUOUS, not proof of absence. Another request may be mid-flight on
    // this key, and a `failed` intent is read elsewhere as "Stripe refused
    // it" (the compliance hold cancels its allocations into a residual).
    const definite = isDefiniteStripeError(err);
    // Compare-and-set on `posted`: a concurrent finalize must win, never be
    // overwritten back to failed/posted.
    const recorded = await db(TABLES.HostedFundingTransfer)
      .where({ id: intent.id, state: 'posted', idempotencyKey: intent.idempotencyKey })
      .update({
        state: definite ? 'failed' : 'posted', // ambiguous stays posted → window/reconcile
        lastError: message.slice(0, 500),
        updatedAt: db.fn.now(),
      });
    if (recorded === 0) {
      console.warn(
        `[funding] transfer post errored for intent ${intent.id}, but the intent already left 'posted' — leaving it: ${message}`,
      );
      return;
    }
    console.error(`[funding] transfer post failed (${definite ? 'definite' : 'ambiguous'}) intent=${intent.id}: ${message}`);
    result.failed.push(intent.id);
    return;
  }

  // The response to our own keyed POST needs no authentication. A tick that
  // moved the intent to reconcile_required while this POST hung may still
  // be finalized by it; a parked or re-armed one may not.
  const written = await finalizeTransfer(db, batch, intent, group, transfer, {
    from: ['posted', 'reconcile_required'],
  });
  if (written) result.transfersConfirmed.push(intent.id);
}

/** What a finalize must still find on the intent row for its write to
 *  stand. The key is always the one the caller observed. */
interface FinalizeFence {
  from: FundingTransferState[];
  /** An operator resolution: the review nonce read before its listing. */
  reviewNonce?: string | null;
  /** Audit stamp; null (the default) clears a stale error. */
  lastError?: string | null;
}

/**
 * Step 4 — one short transaction per confirmed transfer: intent →
 * confirmed, Payout written as paid, allocations → transferred,
 * commissions → paid. Webhooks fire only after the commit.
 *
 * Compare-and-set on the states the caller expects AND the key it
 * observed. This used to finalize from any state but `confirmed`, so a
 * reconciler holding a stale listing could record its transfer over an
 * intent another tick had just parked for review, or one an operator had
 * re-armed onto a new key. Returns whether this call wrote the ledger.
 */
async function finalizeTransfer(
  db: Knex,
  batch: HostedFundingBatchRow,
  intent: HostedFundingTransferRow,
  group: HostedFundingAllocationRow[],
  transfer: Stripe.Transfer,
  fence: FinalizeFence,
): Promise<boolean> {
  const payoutId = ulid();
  const commissionIds = group.map((a) => a.commissionId);
  const written = await db.transaction(async (trx) => {
    const updated = await trx(TABLES.HostedFundingTransfer)
      .where({ id: intent.id, idempotencyKey: intent.idempotencyKey })
      .whereIn('state', fence.from)
      .modify((qb) => {
        if (fence.reviewNonce !== undefined) {
          qb.whereRaw('"reviewNonce" is not distinct from ?', [fence.reviewNonce]);
        }
      })
      .update({
        state: 'confirmed',
        stripeTransferId: transfer.id,
        payoutId,
        lastError: fence.lastError ?? null,
        updatedAt: db.fn.now(),
      });
    if (updated === 0) return false; // another writer moved it first

    await trx(TABLES.Payout).insert({
      id: payoutId,
      tenantId: batch.tenantId,
      partnerId: intent.partnerId,
      amount: minorToMajorString(intent.amountMinor, intent.currency),
      currency: intent.currency.toUpperCase(),
      method: 'stripe_connect',
      status: 'paid',
      stripeTransferId: transfer.id,
      metadata: {
        fundingBatchId: batch.id,
        transferIntentId: intent.id,
        commissionCount: commissionIds.length,
      },
      completedAt: new Date(),
    });
    await trx(TABLES.HostedFundingAllocation)
      .whereIn('id', group.map((a) => a.id))
      .update({ state: 'transferred', updatedAt: db.fn.now() });
    await trx(TABLES.Commission)
      .whereIn('id', commissionIds)
      .update({ status: 'paid', paidAt: new Date(), payoutId });
    return true;
  });
  if (!written) return false;

  // After commit only (spec §6 step 4) — the dispatcher POSTs async and a
  // subscriber can immediately re-fetch consistent rows.
  const commissions = (await db(TABLES.Commission).whereIn('id', commissionIds)) as CommissionRow[];
  const linkTenant = await db<TenantRow>(TABLES.Tenant).where({ id: batch.tenantId }).first('slug', 'customDomain');
  dispatchEvent(batch.tenantId, 'payout.created', {
    payoutId,
    partnerId: intent.partnerId,
    amount: minorToMajorString(intent.amountMinor, intent.currency),
    currency: intent.currency.toUpperCase(),
    method: 'stripe_connect',
    commissionIds,
    statementUrl: payoutStatementUrl(linkTenant, payoutId),
  } satisfies WebhookPayload<'payout.created'>);
  void dispatchCommissionEvents(batch.tenantId, 'commission.paid', commissions, { payoutId });
  return true;
}

/**
 * Reconcile an ambiguous intent by listing transfers in the batch's
 * transfer_group (spec §4 retry discipline). One transfer from the current
 * key generation that authenticates against the frozen intent → finalize
 * with it. Nothing → HOLD in `reconcile_required`; later ticks keep
 * listing, so a straggler still finalizes. Anything else → PARK in
 * `duplicate_review` for an operator.
 */
async function reconcileIntent(
  db: Knex,
  stripe: Stripe,
  batch: HostedFundingBatchRow,
  intent: HostedFundingTransferRow,
  result: ExecutorResult,
): Promise<void> {
  // Page through the ENTIRE transfer_group, not just the first 100 — a batch
  // with >100 transfers whose match sits on a later page would otherwise look
  // "absent". The shared lister also refuses a listing it could not finish
  // (an empty page claiming more, or past its page budget, the direct rail's
  // round 10): a partial listing can hide the duplicate that would have
  // stopped a finalize. Nothing is decided on it; the next tick lists again.
  //
  // Every match is collected, not the first: once an operator has re-armed
  // an intent onto a new key, a late transfer from the old key can sit
  // beside the new one, and recording either alone hides the other.
  const matches = await listFundedTransferMembers(
    db,
    stripe,
    intent,
    `funded reconcile of transfer intent ${intent.id}`,
  );
  if (matches === 'cannot_verify') {
    result.failed.push(intent.id);
    return;
  }

  const generation = keyGenerationOf(intent);
  // A transfer without the stamp (one that predates generations, or whose
  // metadata was cleared) reads as generation 0.
  const stale = matches.filter(
    (t) => generation === null || readGeneration(t.metadata?.openpartner_key_generation) !== generation,
  );
  if (matches.length > 1 || stale.length > 0) {
    // Two transfers for one intent, or one from a key an operator already
    // abandoned: the partner may have been paid twice. Never pick one —
    // the ledger stays unwritten and a human decides.
    const ids = matches.map((t) => t.id).join(', ');
    const parked = await parkForReview(
      db,
      intent,
      matches.length > 1 ? `duplicate_transfers:${ids}` : `superseded_generation_transfer:${ids}`,
    );
    if (!parked) return;
    console.error(
      `[funding] ALERT: transfer intent ${intent.id} (batch ${batch.id}, partner ${intent.partnerId}) has ${matches.length} transfer(s) in its group (${ids}) that do not match its one current key generation (${generation ?? 'unreadable'}) — the partner may have been paid twice; ledger NOT written, PARKED in duplicate_review for an operator`,
    );
    result.duplicateReview.push(intent.id);
    return;
  }

  if (matches.length === 1) {
    const found = matches[0]!;
    // AUTHENTICATE before recording it as THE payment (the direct rail's
    // round 10). Membership rests partly on metadata, which is mutable at
    // Stripe, and anything on the platform account can set a transfer's
    // group to this batch. Two immutable references pin the real payment:
    // the intent's frozen amount, currency and destination, and Stripe's
    // own `created` against `postedAt`, which is stamped before this
    // generation's first POST. A genuine current-generation transfer
    // cannot predate it (5 minutes' grace for clock skew), so a forged
    // stamp on an older transfer fails even when everything else matches.
    // A member that fails is never finalized; it parks like a duplicate.
    const failure = authenticationFailure(intent, found);
    if (failure) {
      const parked = await parkForReview(db, intent, `unauthenticated_group_transfer:${found.id}`);
      if (!parked) return;
      console.error(
        `[funding] ALERT: transfer intent ${intent.id} (batch ${batch.id}, partner ${intent.partnerId}) found transfer ${found.id} in its group that does not match the frozen intent (${failure}) — NOT finalized; PARKED in duplicate_review for an operator`,
      );
      result.duplicateReview.push(intent.id);
      return;
    }
    const allocations = (await db(TABLES.HostedFundingAllocation)
      .where({ batchId: batch.id, partnerId: intent.partnerId })
      .whereIn('state', ['transfer_pending', 'reserved'])) as HostedFundingAllocationRow[];
    const written = await finalizeTransfer(db, batch, intent, allocations, found, {
      from: ['reconcile_required'],
    });
    if (written) result.transfersConfirmed.push(intent.id);
    return;
  }

  // NOTHING FOUND. This used to reset the intent to `pending`, reasoning
  // that the listing "proved" no transfer exists. It proves no such thing
  // (the direct rail's round-6 finding, docs/direct-connect-payouts.md).
  // `transfers.list` is accurate about requests Stripe has FINISHED, but it
  // cannot see a POST still in flight, and stripe-node's timeout is a
  // socket-inactivity timeout with no wall-clock bound. An empty listing
  // means UNKNOWN, never ABSENT, and re-posting on it is the double-pay:
  // the old POST lands while the new one creates a second transfer under a
  // key Stripe has pruned.
  //
  // So the intent stays `reconcile_required` on the same key with its
  // allocations `transfer_pending`, later ticks keep listing (a straggler
  // finalizes above), and only an operator may authorise a fresh key
  // (`releaseFundedTransferForRetry`). The cost is liveness, not money.
  await holdForOperator(db, intent, AWAITING_OPERATOR);
  console.error(
    `[funding] ALERT: transfer intent ${intent.id} (batch ${batch.id}, partner ${intent.partnerId}) found no transfer in its group past the idempotency window — HELD on key generation ${generation ?? 'unreadable'} awaiting an operator; allocations stay transfer_pending. An empty listing does not prove the POST never landed.`,
  );
  result.awaitingOperator.push(intent.id);
}

/** Record why a `reconcile_required` intent is held. Written once per
 *  reason, so `updatedAt` keeps measuring how long it has been held (the
 *  daily reconcile's unlinked-intent alert reads it). */
async function holdForOperator(db: Knex, intent: HostedFundingTransferRow, reason: string): Promise<void> {
  await db(TABLES.HostedFundingTransfer)
    .where({ id: intent.id, state: 'reconcile_required', idempotencyKey: intent.idempotencyKey })
    .whereRaw('"lastError" is distinct from ?', [reason.slice(0, 500)])
    .update({ lastError: reason.slice(0, 500), updatedAt: db.fn.now() });
}

/**
 * Park an intent for human review, in a state the executor does NOT scan.
 *
 * Holding it in `reconcile_required` meant re-listing at Stripe and
 * re-alerting on every 5-minute tick forever, and reversing
 * the surplus doesn't make that stop, because reversed transfers still
 * list. The disposition is manual either way; this makes "a human owns it
 * now" a state rather than a hope, the direct rail's `duplicate_review`.
 *
 * Fenced on the key the caller observed, so a reconciler working from a
 * stale snapshot cannot park an intent an operator has since re-armed
 * (whose new generation's single transfer would read as "superseded"
 * against the stale view). A fresh `reviewNonce` starts the resolution
 * fence. Returns whether this call parked it.
 */
async function parkForReview(db: Knex, intent: HostedFundingTransferRow, reason: string): Promise<boolean> {
  const parked = await db(TABLES.HostedFundingTransfer)
    .where({ id: intent.id, idempotencyKey: intent.idempotencyKey })
    .whereIn('state', ['posted', 'reconcile_required'])
    .update({
      state: 'duplicate_review',
      lastError: reason.slice(0, 500),
      reviewNonce: ulid(),
      updatedAt: db.fn.now(),
    });
  if (parked === 0) {
    console.warn(
      `[funding] transfer intent ${intent.id} moved while it was being reconciled — not parking it (${reason.slice(0, 200)})`,
    );
  }
  return parked > 0;
}

/**
 * Why a lone group member cannot be recorded as this intent's payment, or
 * null when it can. Checks only immutable facts: Stripe's amount,
 * currency, destination and `created` against what the intent froze
 * before its first POST. Fails closed on anything it cannot compare.
 */
function authenticationFailure(intent: HostedFundingTransferRow, t: Stripe.Transfer): string | null {
  const expected = Number(intent.amountMinor);
  if (!Number.isSafeInteger(expected) || Number(t.amount) !== expected) {
    return `amount ${String(t.amount)} != frozen ${intent.amountMinor}`;
  }
  if (t.currency !== intent.currency.toLowerCase()) {
    return `currency ${String(t.currency)} != frozen ${intent.currency}`;
  }
  const destination = typeof t.destination === 'string' ? t.destination : t.destination?.id;
  if (!intent.destinationAccountId || destination !== intent.destinationAccountId) {
    return `destination ${String(destination)} != frozen ${intent.destinationAccountId}`;
  }
  const postedAtMs = intent.postedAt ? new Date(intent.postedAt).getTime() : NaN;
  if (typeof t.created !== 'number' || Number.isNaN(postedAtMs)) {
    return 'no creation time or postedAt to compare';
  }
  if (t.created * 1000 < postedAtMs - CREATED_SKEW_MS) {
    return `created ${new Date(t.created * 1000).toISOString()} predates postedAt ${new Date(postedAtMs).toISOString()}`;
  }
  return null;
}

/**
 * The transfers in an intent's batch group that belong to it, or
 * 'cannot_verify' when the group cannot be listed in full.
 *
 * The group is the batch, shared by every partner in it, so membership has
 * to be narrowed, and narrowing on metadata alone is the direct rail's
 * round-9 hole: metadata is mutable at Stripe, and a transfer whose stamp
 * was cleared would vanish from every listing-based decision. So a
 * transfer belongs to this intent when it is stamped with this intent, OR
 * when it pays this intent's destination (immutable) and is not stamped
 * with another intent of the same batch. Two partners sharing a Connect
 * account keep their stamped transfers apart; an unstamped transfer to a
 * shared account counts against both, which fails closed.
 *
 * Shared by reconcile, the operator re-arm and resolve, and the
 * operator-recovery recheck, so all four agree on what "this intent's
 * transfers" means.
 */
export async function listFundedTransferMembers(
  db: Knex,
  stripe: Stripe,
  intent: Pick<HostedFundingTransferRow, 'id' | 'batchId' | 'destinationAccountId'>,
  logContext: string,
): Promise<Stripe.Transfer[] | 'cannot_verify'> {
  const group = await listTransferGroup(stripe, intent.batchId, logContext);
  if (group === 'cannot_verify') return group;
  const siblings = new Set(
    ((await db(TABLES.HostedFundingTransfer)
      .where({ batchId: intent.batchId })
      .whereNot({ id: intent.id })
      .select('id')) as Array<{ id: string }>).map((r) => r.id),
  );
  return group.filter((t) => {
    const stamped = t.metadata?.openpartner_transfer_intent_id;
    if (stamped === intent.id) return true;
    const destination = typeof t.destination === 'string' ? t.destination : t.destination?.id;
    return destination === intent.destinationAccountId && !(stamped && siblings.has(stamped));
  });
}

/** Does the batch have a live allocation that is NOT behind an intent
 *  parked in duplicate_review? Only those are the §7 deadline's business. */
async function hasUnparkedOpenAllocations(db: Knex, batchId: string): Promise<boolean> {
  const row = await db(TABLES.HostedFundingAllocation)
    .where({ batchId })
    .whereNotIn('state', ['transferred', 'canceled', 'released'])
    .whereNotExists(
      db(TABLES.HostedFundingTransfer)
        .whereRaw('"HostedFundingTransfer"."batchId" = "HostedFundingAllocation"."batchId"')
        .whereRaw('"HostedFundingTransfer"."partnerId" = "HostedFundingAllocation"."partnerId"')
        .where(`${TABLES.HostedFundingTransfer}.state`, 'duplicate_review'),
    )
    .first(['id']);
  return row !== undefined;
}

/**
 * Operator path out of a HELD intent: authorise a fresh-key attempt.
 *
 * The executor never re-arms by itself (see reconcileIntent). The operator
 * is asserting what no listing can prove: that no transfer for this
 * intent exists or ever will. This function refuses on positive evidence
 * against that: any transfer in the batch's group stamped with this intent
 * OR paying its destination (metadata is mutable at Stripe; the
 * destination is not), unless it is stamped with another intent of the
 * batch (`listFundedTransferMembers`), which is a partner sharing the
 * Connect account and not this intent's payment. It then moves the intent
 * back to `pending` on the NEXT key generation (`fbt:<intentId>:g<N+1>`),
 * because Stripe anchors a key's retention to its first use and the old
 * key would replay its stored outcome.
 *
 * Fenced on the key the operator observed (generation N), so two
 * operators, or an operator and a concurrent reconcile, cannot both hand
 * out a generation. Called by the operator-recovery apply loop (kind
 * `release_intent_for_retry`, rail `hosted_funding`, target = intent id).
 * If the abandoned key's POST lands anyway, the `transfer.created` detector
 * (funding/webhook.ts) alarms, and the apply loop's 24h recheck is the
 * backstop for a missed webhook.
 */
export async function releaseFundedTransferForRetry(
  db: Knex,
  intentId: string,
  observedGeneration: number,
  operator: string,
  /** REQUIRED — the listing below is the guard, as on the direct rail. */
  stripe: Stripe,
): Promise<'rearmed' | 'not_held' | 'generation_moved' | 'transfer_exists' | 'cannot_verify'> {
  const intent = (await db(TABLES.HostedFundingTransfer).where({ id: intentId }).first()) as
    | HostedFundingTransferRow
    | undefined;
  if (!intent || intent.state !== 'reconcile_required') return 'not_held';
  const observedKey = fundedTransferKey(intent.id, observedGeneration);
  if (intent.idempotencyKey !== observedKey) return 'generation_moved';

  const ours = await listFundedTransferMembers(
    db,
    stripe,
    intent,
    `OPERATOR ${operator} re-arm of funded transfer ${intentId}`,
  );
  if (ours === 'cannot_verify') return 'cannot_verify';
  if (ours.length > 0) {
    console.error(
      `[funding] OPERATOR ${operator} tried to re-arm transfer intent ${intentId} but ${ours.length} transfer(s) for it exist in batch ${intent.batchId}'s group (${ours
        .map((t) => t.id)
        .join(', ')}) — refusing; the executor finalizes a single current-generation match, anything else needs reconciliation`,
    );
    return 'transfer_exists';
  }

  const rearmed = await db(TABLES.HostedFundingTransfer)
    .where({ id: intentId, state: 'reconcile_required', idempotencyKey: observedKey })
    .update({
      state: 'pending',
      idempotencyKey: fundedTransferKey(intent.id, observedGeneration + 1),
      postedAt: null,
      lastError: `operator_rearm:${operator}`.slice(0, 500),
      updatedAt: db.fn.now(),
    });
  if (rearmed === 0) return 'generation_moved';
  console.error(
    `[funding] OPERATOR ${operator} re-armed transfer intent ${intentId} at key generation ${observedGeneration + 1} — asserting no transfer exists for it`,
  );
  return 'rearmed';
}

/**
 * OPERATOR ACTION — resolve a transfer intent parked in `duplicate_review`.
 *
 * Reconcile parks an intent when its group shows more than one transfer
 * for it, one from an abandoned key generation, or one that fails
 * authentication: the partner may have been paid more than once, and no
 * automatic rule can be right. The operator reverses the surplus in
 * Stripe, then tells us which of two things is now true:
 *
 *   { keptTransferId }  the partner keeps this transfer: it paid these
 *                       allocations, so record the ledger against it
 *                       (Payout paid, allocations transferred,
 *                       commissions paid).
 *   { allReversed }     every transfer was reversed: the money is back in
 *                       the platform balance, so the allocations are
 *                       canceled and the batch settles with a residual for
 *                       a §7 disposition, the same path a compliance hold
 *                       takes for funded money that won't transfer.
 *
 * Mirrors the direct rail's `resolveDuplicateReview`, and like it VERIFIES
 * BOTH DISPOSITIONS against Stripe rather than taking the operator's word.
 * The kept transfer must belong to this intent, be wholly unreversed, and
 * match the frozen amount, currency and destination; every other member
 * must be fully reversed. "All reversed" must be true of every member.
 * Members are `listFundedTransferMembers`, so a transfer whose metadata was
 * cleared still counts against the resolution.
 *
 * The commit is fenced on the `reviewNonce` read BEFORE the listing. The
 * funding webhook moves it whenever a member sees reversal activity, so a
 * reversal landing between this listing and the commit makes the commit
 * lose ('review_moved', retryable) and the next attempt re-verifies.
 * Called by the operator-recovery apply loop (kind
 * `resolve_duplicate_review`, rail `hosted_funding`, target = intent id).
 */
export async function resolveFundedDuplicateReview(
  db: Knex,
  intentId: string,
  operator: string,
  disposition: { keptTransferId: string } | { allReversed: true },
  /** REQUIRED. Both dispositions are checked against Stripe. */
  stripe: Stripe,
): Promise<
  | 'resolved'
  | 'not_in_duplicate_review'
  | 'review_moved'
  | 'cannot_verify'
  | 'kept_transfer_invalid'
  | 'transfers_still_live'
> {
  if (!stripe) return 'cannot_verify';
  const intent = (await db(TABLES.HostedFundingTransfer).where({ id: intentId }).first()) as
    | HostedFundingTransferRow
    | undefined;
  if (!intent || intent.state !== 'duplicate_review') return 'not_in_duplicate_review';
  const observedNonce = intent.reviewNonce;

  const members = await listFundedTransferMembers(
    db,
    stripe,
    intent,
    `OPERATOR ${operator} resolve of funded transfer ${intentId}`,
  );
  if (members === 'cannot_verify') return 'cannot_verify';
  const live = (t: Stripe.Transfer) => Number(t.amount_reversed ?? 0) < Number(t.amount ?? 0);

  if ('keptTransferId' in disposition) {
    const kept = members.find((t) => t.id === disposition.keptTransferId);
    if (!kept) {
      console.error(
        `[funding] OPERATOR ${operator} named kept transfer ${disposition.keptTransferId} for transfer intent ${intentId}, but it is not one of this intent's transfers in batch ${intent.batchId}'s group — refusing`,
      );
      return 'kept_transfer_invalid';
    }
    if (Number(kept.amount_reversed ?? 0) > 0) {
      console.error(
        `[funding] OPERATOR ${operator} named kept transfer ${kept.id} for transfer intent ${intentId}, but it is reversed — refusing`,
      );
      return 'kept_transfer_invalid';
    }
    // Amount, currency and destination against the FROZEN intent: "present
    // and unreversed" alone would let a one-cent transfer mark the whole
    // allocation paid (the direct rail's round 9). Its `created` is not
    // checked: an operator keeping a transfer is asserting it is ours.
    const expected = Number(intent.amountMinor);
    const keptDestination = typeof kept.destination === 'string' ? kept.destination : kept.destination?.id;
    if (
      !Number.isSafeInteger(expected) ||
      Number(kept.amount) !== expected ||
      kept.currency !== intent.currency.toLowerCase() ||
      keptDestination !== intent.destinationAccountId
    ) {
      console.error(
        `[funding] OPERATOR ${operator} named kept transfer ${kept.id} for transfer intent ${intentId}, but it is ${String(kept.amount)} ${String(kept.currency)} to ${String(keptDestination)} where the intent froze ${intent.amountMinor} ${intent.currency} to ${intent.destinationAccountId} — refusing; that transfer is not this payment`,
      );
      return 'kept_transfer_invalid';
    }
    // Every OTHER member must be fully reversed first. Resolving while one
    // still holds money records this allocation paid and forgets it: the
    // partner keeps the surplus with nothing left flagging it.
    const liveOthers = members.filter((t) => t.id !== kept.id && live(t));
    if (liveOthers.length > 0) {
      console.error(
        `[funding] OPERATOR ${operator} kept ${kept.id} for transfer intent ${intentId}, but ${liveOthers.length} other transfer(s) still hold money (${liveOthers
          .map((t) => t.id)
          .join(', ')}) — reverse the surplus first`,
      );
      return 'transfers_still_live';
    }

    const batch = (await db(TABLES.HostedFundingBatch).where({ id: intent.batchId }).first()) as
      | HostedFundingBatchRow
      | undefined;
    if (!batch) return 'not_in_duplicate_review';
    const allocations = (await db(TABLES.HostedFundingAllocation)
      .where({ batchId: intent.batchId, partnerId: intent.partnerId })
      .whereIn('state', ['transfer_pending', 'reserved'])) as HostedFundingAllocationRow[];
    // The money moved whatever the batch's status, so the ledger records it
    // even on a batch a dispute froze since; the executor settles a
    // transferring batch on its next tick.
    const written = await finalizeTransfer(db, batch, intent, allocations, kept, {
      from: ['duplicate_review'],
      reviewNonce: observedNonce,
      lastError: `operator_kept_transfer:${operator}`,
    });
    if (written) {
      console.error(
        `[funding] OPERATOR ${operator} resolved duplicate_review on transfer intent ${intentId}: kept ${kept.id}, allocations transferred and commissions recorded PAID`,
      );
      return 'resolved';
    }
    return reviewOutcomeAfterLostFence(db, intentId, operator);
  }

  const liveMembers = members.filter(live);
  if (liveMembers.length > 0) {
    console.error(
      `[funding] OPERATOR ${operator} claimed all transfers reversed for transfer intent ${intentId}, but ${liveMembers.length} still hold money (${liveMembers
        .map((t) => t.id)
        .join(', ')}) — refusing`,
    );
    return 'transfers_still_live';
  }
  const canceledMinor = await db.transaction(async (trx) => {
    const closed = await trx(TABLES.HostedFundingTransfer)
      .where({ id: intentId, state: 'duplicate_review', idempotencyKey: intent.idempotencyKey })
      .whereRaw('"reviewNonce" is not distinct from ?', [observedNonce])
      .update({ state: 'failed', lastError: `operator_all_reversed:${operator}`, updatedAt: db.fn.now() });
    if (closed === 0) return null;
    // Funded money that will not transfer: the same `canceled` state the
    // compliance hold and the reversal interlock use. The commissions stay
    // `approved`, and reserve.ts won't take them again until the batch's
    // residual has a disposition, so the brand is never charged twice.
    const canceled = (await trx(TABLES.HostedFundingAllocation)
      .where({ batchId: intent.batchId, partnerId: intent.partnerId })
      .whereIn('state', ['transfer_pending', 'reserved'])
      .update({ state: 'canceled', updatedAt: db.fn.now() })
      .returning(['amountMinor'])) as Array<{ amountMinor: string | number }>;
    return canceled.reduce((s, a) => s + Number(a.amountMinor), 0);
  });
  if (canceledMinor === null) return reviewOutcomeAfterLostFence(db, intentId, operator);
  console.error(
    `[funding] OPERATOR ${operator} resolved duplicate_review on transfer intent ${intentId}: all transfers reversed, ${canceledMinor} minor of allocations canceled — batch ${intent.batchId} settles with a residual that needs a disposition`,
  );
  return 'resolved';
}

/** A resolution's commit lost its fence. Tell "the webhook moved the
 *  nonce under us" (re-verify and retry) from "someone else resolved it". */
async function reviewOutcomeAfterLostFence(
  db: Knex,
  intentId: string,
  operator: string,
): Promise<'review_moved' | 'not_in_duplicate_review'> {
  const after = (await db(TABLES.HostedFundingTransfer).where({ id: intentId }).first(['state'])) as
    | Pick<HostedFundingTransferRow, 'state'>
    | undefined;
  if (after?.state === 'duplicate_review') {
    console.error(
      `[funding] OPERATOR ${operator} resolve of transfer intent ${intentId} lost to new reversal activity recorded by the webhook — re-verify and retry`,
    );
    return 'review_moved';
  }
  return 'not_in_duplicate_review';
}

/** The partner's compliance hold, if any. `db` is the privileged pool the
 *  executor runs on, which the hold records need. */
async function partnerHold(db: Knex, tenantId: string, partnerId: string): Promise<PayoutHold | undefined> {
  const partner = (await db(TABLES.Partner)
    .where({ id: partnerId })
    .first(['id', 'name'])) as Pick<PartnerRow, 'id' | 'name'> | undefined;
  if (!partner) return undefined;
  return (await partnerPayoutHolds(db, tenantId, [partner])).get(partnerId);
}

/**
 * Stop a held partner's share of a funded batch while none of it has
 * reached Stripe. Their live allocations go to `canceled`, the state the
 * reversal interlock already uses for funded money that won't transfer:
 * the batch settles `settled_with_residual` and the residual waits for an
 * operator's disposition (spec §7.4). An intent that was never posted, or
 * that Stripe refused, is closed as `failed` so nothing retries it.
 *
 * The commissions stay `approved`: reservation never changed them.
 * Reservation won't take them again until that disposition is recorded
 * (reserve.ts), and the planner keeps holding them while the hold stands.
 */
async function cancelHeldAllocations(
  db: Knex,
  batch: HostedFundingBatchRow,
  partnerId: string,
  intent: HostedFundingTransferRow | null,
  hold: PayoutHold,
  result: ExecutorResult,
): Promise<void> {
  const canceledMinor = await db.transaction(async (trx) => {
    // Same gate as intent creation: a batch a dispute froze is not ours
    // to edit.
    const live = (await trx(TABLES.HostedFundingBatch)
      .where({ id: batch.id })
      .forUpdate()
      .first(['status'])) as { status: string } | undefined;
    if (live?.status !== 'transferring') return 0;
    if (intent) {
      const closed = await trx(TABLES.HostedFundingTransfer)
        .where({ id: intent.id })
        .whereIn('state', ['pending', 'failed'])
        .update({ state: 'failed', lastError: `compliance_hold:${hold.reason}`, updatedAt: db.fn.now() });
      if (closed === 0) return 0; // posted meanwhile: the pre-POST check owns it
    }
    // Without an intent the allocations are still `reserved`; with one they
    // were claimed to `transfer_pending` alongside it.
    const canceled = (await trx(TABLES.HostedFundingAllocation)
      .where({ batchId: batch.id, partnerId })
      .whereIn('state', intent ? ['reserved', 'transfer_pending'] : ['reserved'])
      .update({ state: 'canceled', updatedAt: db.fn.now() })
      .returning(['amountMinor'])) as Array<{ amountMinor: string | number }>;
    return canceled.reduce((s, a) => s + Number(a.amountMinor), 0);
  });
  if (canceledMinor === 0) return;
  console.error(
    `[funding] ALERT: partner ${partnerId} is on a compliance hold (${hold.reason}) — ${canceledMinor} minor on funded batch ${batch.id} will not transfer; the batch settles with a residual that needs a disposition`,
  );
  result.heldForCompliance.push({
    batchId: batch.id,
    tenantId: batch.tenantId,
    partnerId,
    reason: hold.reason,
    amountMinor: canceledMinor,
    currency: batch.currency,
  });
}

/** One ops email per executor run, listing every partner whose funded
 *  transfer a compliance hold stopped. Best-effort (sendOpsEmail never
 *  throws): the console ALERT above is the record either way. */
async function notifyOpsOfHeldTransfers(db: Knex, held: ExecutorResult['heldForCompliance']): Promise<void> {
  if (held.length === 0) return;
  const tenants = (await db(TABLES.Tenant)
    .whereIn('id', [...new Set(held.map((h) => h.tenantId))])
    .select('id', 'displayName', 'slug')) as Array<Pick<TenantRow, 'id' | 'displayName' | 'slug'>>;
  const partners = (await db(TABLES.Partner)
    .whereIn('id', [...new Set(held.map((h) => h.partnerId))])
    .select('id', 'name')) as Array<Pick<PartnerRow, 'id' | 'name'>>;
  const tenantById = new Map(tenants.map((t) => [t.id, t]));
  const partnerName = new Map(partners.map((p) => [p.id, p.name]));
  await sendOpsEmail(
    db,
    opsFundedTransfersHeldEmail({
      items: held.map((h) => ({
        brandName: tenantById.get(h.tenantId)?.displayName ?? h.tenantId,
        slug: tenantById.get(h.tenantId)?.slug ?? null,
        partnerName: partnerName.get(h.partnerId) ?? h.partnerId,
        reason: h.reason,
        amount: `${minorToMajorString(h.amountMinor, h.currency)} ${h.currency.toUpperCase()}`,
        batchId: h.batchId,
      })),
      reviewUrl: `${getPortalBaseUrl()}/platform/screening`,
    }),
    'funded_transfer_compliance_hold',
  );
}
