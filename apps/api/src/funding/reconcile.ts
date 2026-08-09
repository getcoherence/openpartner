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
import { TABLES, type HostedFundingBatchRow } from '@openpartner/db';
import { requireStripe } from '../stripe.js';
import { casBatch, TRANSFER_DEADLINE_DAYS } from './state.js';

export interface ReconcileDeps {
  stripe?: Stripe;
  now?: () => Date;
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
}

/** A claimed-but-unfinished webhook older than this had its worker die
 *  AND never got a redelivery — nothing will pick it up on its own. */
const INBOX_STUCK_MS = 60 * 60 * 1000;
/** Per-run cap on live Stripe reads. Anything beyond it is logged, not
 *  silently dropped — an unchecked batch must never look like a clean one. */
const STRIPE_SWEEP_LIMIT = 50;

export async function runFundingReconciliation(
  db: Knex,
  deps: ReconcileDeps = {},
): Promise<ReconcileReport> {
  const now = deps.now ?? (() => new Date());
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
  const deadline = new Date(now().getTime() - TRANSFER_DEADLINE_DAYS * 24 * 60 * 60 * 1000);
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
    if (batch.status === 'settled_with_residual' && !batch.residualDisposition) {
      report.residualsAwaitingDisposition.push(batch.id);
      console.error(
        `[funding-reconcile] ALERT: batch ${batch.id} settled with ${batch.residualMinor} minor residual and no disposition`,
      );
    }
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
    .where('processedAt', '<', new Date(now().getTime() - INBOX_STUCK_MS))
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
  const funded = open.filter(
    (b) =>
      b.stripeChargeId &&
      ['funded', 'transferring', 'settled', 'settled_with_residual'].includes(b.status),
  );
  let stripe: Stripe | null = null;
  try {
    stripe = deps.stripe ?? requireStripe();
  } catch {
    return report; // no Stripe configured (selfhost) — nothing to sweep
  }

  if (funded.length > STRIPE_SWEEP_LIMIT) {
    console.warn(
      `[funding-reconcile] ${funded.length} funded batches, sweeping the oldest ${STRIPE_SWEEP_LIMIT} — ${funded.length - STRIPE_SWEEP_LIMIT} not checked this run`,
    );
  }
  for (const batch of funded.slice(0, STRIPE_SWEEP_LIMIT)) {
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
        // Same transition the webhook would have made (webhook.ts) — the
        // executor only consumes funded/transferring, so this stops any
        // further transfer out of money that came back.
        const moved = await casBatch(
          db,
          batch.id,
          ['funded', 'transferring', 'settled', 'settled_with_residual'],
          'funding_disputed',
          { failureReason: 'reconcile_detected_refund_or_dispute' },
        );
        report.missedRefunds.push(batch.id);
        console.error(
          `[funding-reconcile] ALERT: funding charge ${charge.id} for batch ${batch.id} is refunded/disputed but no webhook ever arrived — batch ${moved ? 'frozen as funding_disputed' : 'NOT transitioned'}; operator action required`,
        );
      }
    } catch (err) {
      console.error(`[funding-reconcile] charge sweep failed for batch ${batch.id}`, err);
    }
  }

  // 3b. Same argument for the transfer side: a missed `transfer.reversed`
  // leaves a Payout recorded `paid` on money that was clawed back.
  const confirmed = (await db(TABLES.HostedFundingTransfer)
    .where({ state: 'confirmed' })
    .whereNotNull('stripeTransferId')
    .orderBy('updatedAt', 'desc')
    .limit(STRIPE_SWEEP_LIMIT)) as Array<{ id: string; stripeTransferId: string; payoutId: string | null }>;
  for (const intent of confirmed) {
    try {
      const payout = intent.payoutId
        ? ((await db(TABLES.Payout).where({ id: intent.payoutId }).first(['status'])) as
            | { status: string }
            | undefined)
        : undefined;
      // Already recorded as reversed locally — the ledger knows.
      if (payout && ['reversed', 'partially_reversed'].includes(payout.status)) continue;
      const transfer = await stripe.transfers.retrieve(intent.stripeTransferId);
      if (!transfer.reversed && (transfer.amount_reversed ?? 0) === 0) continue;
      const { handleTransferReversed } = await import('./webhook.js');
      const outcome = await handleTransferReversed(db, transfer, intent.id);
      report.missedReversals.push(intent.id);
      console.error(
        `[funding-reconcile] ALERT: transfer ${transfer.id} (intent ${intent.id}) is reversed at Stripe but no webhook ever arrived — recorded now (${outcome})`,
      );
    } catch (err) {
      console.error(`[funding-reconcile] transfer sweep failed for intent ${intent.id}`, err);
    }
  }

  return report;
}
