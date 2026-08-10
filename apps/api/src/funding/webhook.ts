/**
 * Funding-scoped Stripe webhook handling — spec §6/§8/§9.
 *
 * Funding events are identified by our own metadata stamps
 * (`openpartner_funding_batch_id` on PaymentIntents/charges,
 * `openpartner_transfer_intent_id` on transfers) and processed on the
 * privileged pool BEFORE the tenant-scoped attribution path: they are
 * platform-money events, not merchant conversion events.
 *
 * Every handler is CAS-based and replays are absorbed by the inbox, so
 * out-of-order and duplicate deliveries degrade to logged no-ops. A stale
 * event that loses its CAS re-reads the live Stripe object before deciding
 * anything (finding 7).
 */

import type Stripe from 'stripe';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type CommissionRow,
  type HostedFundingBatchRow,
  type HostedFundingTransferRow,
  type PayoutRow,
} from '@openpartner/db';
import { casBatch, toMinor } from './state.js';
import { claimInboxEvent, releaseInboxClaim, stampInboxOutcome } from './inbox.js';
import { confirmFundingFromPaymentIntent } from './confirm.js';
import { releaseBatch } from './release.js';

/** Event types the funding pipeline may own. Everything else short-circuits
 *  in the caller without touching the inbox. */
const FUNDING_EVENT_TYPES = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'charge.dispute.created',
  'transfer.reversed',
]);

/**
 * Another worker holds an unfinished claim on this event. The caller must
 * turn this into a non-2xx so Stripe redelivers — acknowledging would end
 * delivery for an event that is not yet processed.
 */
export class InboxEventHeldError extends Error {
  constructor(public stripeEventId: string) {
    super(`funding webhook ${stripeEventId} is being processed by another worker`);
    this.name = 'InboxEventHeldError';
  }
}

function fundingBatchIdOf(event: Stripe.Event): string | null {
  const obj = event.data.object as { metadata?: Record<string, string> | null };
  return obj?.metadata?.openpartner_funding_batch_id ?? null;
}

function transferIntentIdOf(event: Stripe.Event): string | null {
  const obj = event.data.object as { metadata?: Record<string, string> | null };
  return obj?.metadata?.openpartner_transfer_intent_id ?? null;
}

/**
 * Handle an event if the funding pipeline owns it. Returns an outcome
 * string when handled (caller responds 2xx and stops), null when the event
 * is not funding-scoped (caller continues down the normal path).
 */
export async function handleFundingEvent(
  db: Knex,
  stripe: Stripe,
  event: Stripe.Event,
): Promise<string | null> {
  if (!FUNDING_EVENT_TYPES.has(event.type)) return null;

  const batchId = fundingBatchIdOf(event);
  const intentId = event.type === 'transfer.reversed' ? transferIntentIdOf(event) : null;
  if (!batchId && !intentId) return null; // not ours — merchant-side event

  // The claim is a lease: it blocks replays of an event we FINISHED, and
  // blocks concurrent workers, but a claim whose worker died is taken
  // over by a later redelivery instead of swallowing the event forever
  // (inbox.ts).
  const claim = await claimInboxEvent(db, event.id, event.type);
  if (claim.status === 'done') return 'inbox_replay';
  if (claim.status === 'held') {
    // Unfinished and owned by someone else. Do NOT acknowledge: a 2xx
    // here tells Stripe the event is delivered, and if that worker dies
    // the redelivery we're refusing is the only thing that would ever
    // process it. Throwing → 5xx → Stripe retries later, by which point
    // the lease has either completed or expired for takeover.
    throw new InboxEventHeldError(event.id);
  }

  let outcome: string;
  try {
    outcome = await routeFundingEvent(db, stripe, event, batchId, intentId);
  } catch (err) {
    // Drop the claim, then rethrow → 5xx → Stripe redelivers, and the
    // redelivery is processed at once rather than waiting out the lease.
    // Every handler is idempotent, so re-running is safe.
    await releaseInboxClaim(db, event.id, claim.token);
    throw err;
  }
  // Scoped to our token: if our lease expired and another worker took
  // over, this loses and THEY own the outcome.
  await stampInboxOutcome(db, event.id, outcome, claim.token);
  return outcome;
}

async function routeFundingEvent(
  db: Knex,
  stripe: Stripe,
  event: Stripe.Event,
  batchId: string | null,
  intentId: string | null,
): Promise<string> {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      // Never trust the payload — fetch the live PI with the balance
      // transaction expanded so confirm can stamp the actual rail fee.
      const payloadPi = event.data.object as Stripe.PaymentIntent;
      const pi = await stripe.paymentIntents.retrieve(payloadPi.id, {
        expand: ['latest_charge.balance_transaction'],
      });
      const result = await confirmFundingFromPaymentIntent(db, batchId!, pi);
      return `confirm:${result}`;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const failure =
        pi.last_payment_error?.message ?? pi.last_payment_error?.code ?? 'payment_failed';
      const moved = await casBatch(db, batchId!, 'payment_processing', 'funding_failed', {
        failureReason: failure.slice(0, 500),
      });
      // Retry cadence is owned by the collector (~day 1/3/7 against the
      // same PI); this handler only records the failure.
      return moved ? 'payment_failed_recorded' : 'payment_failed_stale';
    }
    case 'payment_intent.canceled': {
      // Usually our own release protocol canceling the PI — releaseBatch
      // CASes to release_requested first, so this event finds the batch
      // already past the states releaseBatch claims and no-ops. An
      // externally-canceled PI (Stripe expiry) goes through the full
      // release protocol here for promptness; the collector would catch
      // it on the next tick anyway.
      const batch = (await db(TABLES.HostedFundingBatch)
        .where({ id: batchId! })
        .first()) as HostedFundingBatchRow | undefined;
      if (!batch) return 'batch_not_found';
      if (!['reserved', 'invoicing', 'payment_processing', 'funding_failed'].includes(batch.status)) {
        return `canceled_noop:${batch.status}`;
      }
      const released = await releaseBatch(db, stripe, batch, 'pi_canceled_webhook');
      return `canceled:${released}`;
    }
    case 'charge.refunded':
    case 'charge.dispute.created': {
      // The brand's funding charge came back (spec §8). Freeze the batch:
      // funding_disputed stops the executor cold (it only consumes
      // funded/transferring). Transfer reversals + the receivables ledger
      // are an operator flow — this handler makes the state loud and safe.
      const moved = await casBatch(
        db,
        batchId!,
        ['payment_processing', 'funded', 'transferring', 'settled', 'settled_with_residual'],
        'funding_disputed',
        { failureReason: event.type },
      );
      console.error(
        `[funding] ALERT: funding charge ${event.type} on batch ${batchId} — batch ${moved ? 'frozen as funding_disputed' : `NOT transitioned (stale CAS)`}; operator action required`,
      );
      return moved ? 'funding_disputed' : 'dispute_stale_cas';
    }
    case 'transfer.reversed': {
      return handleTransferReversed(db, event.data.object as Stripe.Transfer, intentId!);
    }
    default:
      return 'unhandled';
  }
}

/**
 * A partner-bound transfer was reversed (spec §4 PayoutReversal, finding
 * 11). Payout state is DERIVED from the reversal ledger; Commission rows
 * are never flipped paid → reversed — a compensating CommissionAdjustment
 * records the clawback when the payout is fully reversed.
 */
export async function handleTransferReversed(
  db: Knex,
  transfer: Stripe.Transfer,
  intentId: string,
): Promise<string> {
  const intent = (await db(TABLES.HostedFundingTransfer)
    .where({ id: intentId })
    .first()) as HostedFundingTransferRow | undefined;
  if (!intent || !intent.payoutId) return 'transfer_intent_unknown';

  const payout = (await db(TABLES.Payout).where({ id: intent.payoutId }).first()) as
    | PayoutRow
    | undefined;
  if (!payout) return 'payout_not_found';

  // Record every reversal exactly once (unique stripeReversalId).
  const reversals = transfer.reversals?.data ?? [];
  let recorded = 0;
  for (const reversal of reversals) {
    const inserted = await db(TABLES.PayoutReversal)
      .insert({
        id: ulid(),
        tenantId: intent.tenantId,
        payoutId: payout.id,
        stripeReversalId: reversal.id,
        amountMinor: reversal.amount,
        reason: null,
        balanceTransactionId:
          typeof reversal.balance_transaction === 'string' ? reversal.balance_transaction : null,
        createdAt: new Date(reversal.created * 1000),
      })
      .onConflict('stripeReversalId')
      .ignore()
      .returning('id');
    recorded += inserted.length;
  }

  // Derive the payout state from the full reversal ledger.
  const sumRow = (await db(TABLES.PayoutReversal)
    .where({ payoutId: payout.id })
    .sum({ total: 'amountMinor' })
    .first()) as { total: string | null } | undefined;
  const reversedMinor = Number(sumRow?.total ?? 0);
  const payoutMinor = toMinor(payout.amount);
  const fullyReversed = reversedMinor >= payoutMinor;
  await db(TABLES.Payout)
    .where({ id: payout.id })
    .update({ status: fullyReversed ? 'reversed' : 'partially_reversed' });

  if (fullyReversed) {
    // Compensating entries for the payout's commissions — paid rows stay
    // paid (immutable history); the adjustment ledger carries the clawback.
    const commissions = (await db(TABLES.Commission)
      .where({ payoutId: payout.id })) as CommissionRow[];
    for (const c of commissions) {
      // check-then-insert is only safe under a lock: this handler can run
      // concurrently with itself (a redelivery taking over an expired
      // lease) and with the reconcile sweep, and CommissionAdjustment has
      // no unique constraint to catch a duplicate clawback.
      await db.transaction(async (trx) => {
        await trx(TABLES.Commission).where({ id: c.id }).forUpdate().first(['id']);
        const already = await trx(TABLES.CommissionAdjustment)
          .where({ commissionId: c.id, reason: 'transfer_reversed' })
          .first(['id']);
        if (already) return;
        await trx(TABLES.CommissionAdjustment).insert({
          id: ulid(),
          tenantId: c.tenantId,
          commissionId: c.id,
          amount: `-${c.amount}`,
          currency: c.currency,
          reason: 'transfer_reversed',
          metadata: { stripeTransferId: transfer.id },
          createdAt: new Date(),
        });
      });
    }
  } else {
    console.error(
      `[funding] ALERT: partial transfer reversal on payout ${payout.id} (${reversedMinor}/${payoutMinor} minor) — commission-level disposition needs an operator`,
    );
  }
  return `reversal_recorded:${recorded}:${fullyReversed ? 'full' : 'partial'}`;
}
