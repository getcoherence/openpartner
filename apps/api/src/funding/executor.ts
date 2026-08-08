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
  type HostedFundingAllocationRow,
  type HostedFundingBatchRow,
  type HostedFundingTransferRow,
  type PartnerRow,
} from '@openpartner/db';
import { requireStripe } from '../stripe.js';
import { dispatchEvent } from '../webhook-dispatcher.js';
import { casBatch, minorToMajorString, TRANSFER_DEADLINE_DAYS } from './state.js';

/** Ambiguity window: within it, retrying the frozen key is safe (Stripe
 *  replays); past it the key may be pruned and we must reconcile. */
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  settled: string[];
}

export async function runTransferExecutor(db: Knex, deps: ExecutorDeps = {}): Promise<ExecutorResult> {
  const result: ExecutorResult = {
    processed: 0,
    transfersPosted: [],
    transfersConfirmed: [],
    failed: [],
    reconcileRequired: [],
    settled: [],
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
    const ageMs = now().getTime() - new Date(batch.fundedAt ?? batch.createdAt).getTime();
    if (ageMs > TRANSFER_DEADLINE_DAYS * 24 * 60 * 60 * 1000) {
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
  if (intent && intent.state === 'reconcile_required') {
    await reconcileIntent(db, stripe, batch, intent, result);
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
        .update({ state: 'transfer_pending', updatedAt: new Date() });
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
          idempotencyKey: `fbt:${intentId}`,
          state: 'pending',
          createdAt: new Date(),
          updatedAt: new Date(),
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
        .update({ state: 'reconcile_required', updatedAt: new Date() });
      result.reconcileRequired.push(intent.id);
      await reconcileIntent(db, stripe, batch, { ...intent, state: 'reconcile_required' }, result);
      return;
    }
  }

  // Step 3 — post the transfer with the frozen key. 'pending', 'posted'
  // (within window) and 'failed' all retry the same key: replays return
  // the original outcome, real retries only happen after the window.
  await db(TABLES.HostedFundingTransfer)
    .where({ id: intent.id })
    .update({ state: 'posted', postedAt: intent.postedAt ?? now, updatedAt: now });
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
        },
      },
      { idempotencyKey: intent.idempotencyKey },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const definite = isDefiniteStripeError(err);
    await db(TABLES.HostedFundingTransfer)
      .where({ id: intent.id })
      .update({
        state: definite ? 'failed' : 'posted', // ambiguous stays posted → window/reconcile
        lastError: message.slice(0, 500),
        updatedAt: new Date(),
      });
    console.error(`[funding] transfer post failed (${definite ? 'definite' : 'ambiguous'}) intent=${intent.id}: ${message}`);
    result.failed.push(intent.id);
    return;
  }

  await finalizeTransfer(db, batch, intent, group, transfer);
  result.transfersConfirmed.push(intent.id);
}

/**
 * Step 4 — one short transaction per confirmed transfer: intent →
 * confirmed, Payout written as paid, allocations → transferred,
 * commissions → paid. Webhooks fire only after the commit.
 */
async function finalizeTransfer(
  db: Knex,
  batch: HostedFundingBatchRow,
  intent: HostedFundingTransferRow,
  group: HostedFundingAllocationRow[],
  transfer: Stripe.Transfer,
): Promise<void> {
  const payoutId = ulid();
  const commissionIds = group.map((a) => a.commissionId);
  const written = await db.transaction(async (trx) => {
    const updated = await trx(TABLES.HostedFundingTransfer)
      .where({ id: intent.id })
      .whereNot({ state: 'confirmed' })
      .update({
        state: 'confirmed',
        stripeTransferId: transfer.id,
        payoutId,
        lastError: null,
        updatedAt: new Date(),
      });
    if (updated === 0) return false; // another worker finalized first

    await trx(TABLES.Payout).insert({
      id: payoutId,
      tenantId: batch.tenantId,
      partnerId: intent.partnerId,
      amount: minorToMajorString(intent.amountMinor),
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
      .update({ state: 'transferred', updatedAt: new Date() });
    await trx(TABLES.Commission)
      .whereIn('id', commissionIds)
      .update({ status: 'paid', paidAt: new Date(), payoutId });
    return true;
  });
  if (!written) return;

  // After commit only (spec §6 step 4) — the dispatcher POSTs async and a
  // subscriber can immediately re-fetch consistent rows.
  const commissions = (await db(TABLES.Commission).whereIn('id', commissionIds)) as CommissionRow[];
  dispatchEvent(batch.tenantId, 'payout.created', {
    payoutId,
    partnerId: intent.partnerId,
    amount: minorToMajorString(intent.amountMinor),
    currency: intent.currency.toUpperCase(),
    method: 'stripe_connect',
    commissionIds,
  });
  for (const c of commissions) {
    dispatchEvent(batch.tenantId, 'commission.paid', {
      commissionId: c.id,
      partnerId: c.partnerId,
      amount: c.amount,
      currency: c.currency,
      payoutId,
    });
  }
}

/**
 * Reconcile an ambiguous intent by listing transfers in the batch's
 * transfer_group and matching our metadata stamp (spec §4 retry
 * discipline). Found → finalize with the real transfer. Not found → the
 * POST never landed; reset to pending so the next tick posts fresh with a
 * NEW intent... no — same intent, key now pruned, so a fresh POST is a
 * genuine first attempt. Reset to pending is safe precisely because the
 * listing proved no transfer exists.
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
  // "absent" and get re-posted as a DUPLICATE transfer. Follow has_more to
  // exhaustion, stopping early once we find our metadata stamp.
  let match: Stripe.Transfer | undefined;
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.transfers.list({
      transfer_group: batch.id,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    match = page.data.find((t) => t.metadata?.openpartner_transfer_intent_id === intent.id);
    if (match || !page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]!.id;
  }
  if (match) {
    const group = (await db(TABLES.HostedFundingAllocation)
      .where({ batchId: batch.id, partnerId: intent.partnerId })
      .whereIn('state', ['transfer_pending', 'reserved'])) as HostedFundingAllocationRow[];
    await finalizeTransfer(db, batch, intent, group, match);
    result.transfersConfirmed.push(intent.id);
    return;
  }
  // Proven absent — safe to re-post on the next tick as a first attempt.
  await db(TABLES.HostedFundingTransfer)
    .where({ id: intent.id, state: 'reconcile_required' })
    .update({ state: 'pending', postedAt: null, updatedAt: new Date() });
}

/** A definite error is one where Stripe RESPONDED (4xx semantics) — the
 *  transfer certainly does not exist. Network/timeout errors are ambiguous. */
function isDefiniteStripeError(err: unknown): boolean {
  const e = err as { type?: string; statusCode?: number };
  return typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500;
}
