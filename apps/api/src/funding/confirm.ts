/**
 * Funding confirmation — spec §6. The ONLY way a batch becomes `funded`.
 *
 * Called from the payment_intent.succeeded webhook (build 3) and the
 * collector's webhook-loss backstop poll. Verifies the live PaymentIntent
 * rather than trusting the event (review blocker 3): right status, exact
 * gross amount, right currency, a real paid charge behind it.
 *
 * CAS-transitions payment_processing → funded, and ALSO
 * release_requested → funded — the payment-wins rule (blocker 1): money
 * that arrived is never orphaned by a concurrent release.
 */

import type Stripe from 'stripe';
import type { Knex } from 'knex';
import { TABLES, type HostedFundingBatchRow } from '@openpartner/db';
import { casBatch } from './state.js';

export type ConfirmOutcome = 'funded' | 'verification_failed' | 'not_applicable';

export async function confirmFundingFromPaymentIntent(
  db: Knex,
  batchId: string,
  pi: Stripe.PaymentIntent,
): Promise<ConfirmOutcome> {
  const batch = (await db(TABLES.HostedFundingBatch)
    .where({ id: batchId })
    .first()) as HostedFundingBatchRow | undefined;
  if (!batch) return 'not_applicable';
  if (batch.status === 'funded' || batch.status === 'transferring' || batch.status === 'settled') {
    return 'funded'; // idempotent replay
  }

  // Verification against the live object — every check is a hard gate.
  if (pi.status !== 'succeeded') return 'verification_failed';
  if (pi.id !== batch.stripePaymentIntentId) return 'verification_failed';
  if (pi.amount_received !== Number(batch.grossChargeMinor)) {
    console.error(
      `[funding] batch ${batchId} amount mismatch: received ${pi.amount_received}, expected ${batch.grossChargeMinor}`,
    );
    return 'verification_failed';
  }
  if (pi.currency.toLowerCase() !== batch.currency.toLowerCase()) return 'verification_failed';

  const charge = typeof pi.latest_charge === 'object' && pi.latest_charge ? pi.latest_charge : null;
  const chargeId = charge?.id ?? (typeof pi.latest_charge === 'string' ? pi.latest_charge : null);
  if (!chargeId) return 'verification_failed';
  if (charge && (charge.status !== 'succeeded' || charge.refunded)) return 'verification_failed';

  // Rail-cost telemetry: the actual Stripe fee, when the balance
  // transaction came expanded. Nullable — the reconciliation job (build 4)
  // backfills it otherwise.
  const balanceTx =
    charge && typeof charge.balance_transaction === 'object' && charge.balance_transaction
      ? charge.balance_transaction
      : null;

  const won = await casBatch(db, batchId, ['payment_processing', 'release_requested'], 'funded', {
    stripeChargeId: chargeId,
    actualStripeFeeMinor: balanceTx ? balanceTx.fee : null,
    fundedAt: new Date(),
    failureReason: null,
  });
  if (!won) {
    // Someone else confirmed first, or the batch is in a state where
    // funding no longer applies (e.g. already released after a confirmed
    // cancel — designed-impossible; alert loudly rather than guess).
    const current = (await db(TABLES.HostedFundingBatch)
      .where({ id: batchId })
      .first(['status'])) as { status: string } | undefined;
    if (current?.status === 'released') {
      console.error(
        `[funding] IMPOSSIBLE-STATE ALERT: payment succeeded for RELEASED batch ${batchId} — requires human recovery`,
      );
      await db(TABLES.HostedFundingBatch)
        .where({ id: batchId, status: 'released' })
        .update({ status: 'recovery_required', updatedAt: new Date() });
      return 'verification_failed';
    }
    return current?.status === 'funded' || current?.status === 'transferring' ? 'funded' : 'not_applicable';
  }
  return 'funded';
}
