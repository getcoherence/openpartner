/**
 * Release protocol — spec §7 / review blocker 1.
 *
 * Releasing reserved money is where the double-pay race lived: a batch
 * whose funding later succeeds must NEVER have freed its commissions for
 * re-batching. Order of operations is therefore sacred:
 *
 *   1. CAS batch → release_requested (allocations untouched)
 *   2. Terminalize the PaymentIntent (cancel; treat "already succeeded"
 *      as THE PAYMENT WINNING — batch goes to funded, not released)
 *   3. Only after the PI is terminally canceled (or never existed):
 *      allocations → released, batch → released
 *
 * Released allocations never touch Commission status — reservation never
 * changed it, so the commissions simply become selectable again.
 */

import type Stripe from 'stripe';
import type { Knex } from 'knex';
import { TABLES, type HostedFundingBatchRow } from '@openpartner/db';
import { casBatch } from './state.js';

export type ReleaseOutcome = 'released' | 'payment_won' | 'lost_cas' | 'pi_not_terminal';

export async function releaseBatch(
  db: Knex,
  stripe: Stripe | null,
  batch: HostedFundingBatchRow,
  reason: string,
): Promise<ReleaseOutcome> {
  // Step 1 — claim the release. Losing the CAS means another actor moved
  // the batch (e.g. a funding webhook landed): re-read and defer to it.
  const claimed = await casBatch(
    db,
    batch.id,
    ['reserved', 'invoicing', 'payment_processing', 'funding_failed'],
    'release_requested',
    { failureReason: reason },
  );
  if (!claimed) return 'lost_cas';

  // Step 2 — terminalize the money side. A batch that has a PI can never
  // release without a Stripe client to confirm the PI is dead.
  if (claimed.stripePaymentIntentId && !stripe) return 'pi_not_terminal';
  if (claimed.stripePaymentIntentId && stripe) {
    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripe.paymentIntents.retrieve(claimed.stripePaymentIntentId);
    } catch (err) {
      console.error(`[funding] release: PI retrieve failed for batch ${batch.id}`, err);
      return 'pi_not_terminal'; // retry on the next collector tick
    }
    if (pi.status === 'succeeded') {
      // The race the protocol exists for: money arrived. Release LOSES.
      await casBatch(db, batch.id, 'release_requested', 'funded', {
        failureReason: null,
      });
      console.warn(`[funding] release lost to successful payment — batch ${batch.id} proceeds to transfer`);
      return 'payment_won';
    }
    if (pi.status !== 'canceled') {
      try {
        await stripe.paymentIntents.cancel(claimed.stripePaymentIntentId);
      } catch (err) {
        // Cancel can race a success; re-check next tick rather than guess.
        console.error(`[funding] release: PI cancel failed for batch ${batch.id}`, err);
        return 'pi_not_terminal';
      }
    }
  }

  // Step 3 — the PI is terminal (canceled or never created): free the
  // allocations and close the batch.
  const now = new Date();
  await db(TABLES.HostedFundingAllocation)
    .where({ batchId: batch.id, state: 'reserved' })
    .update({ state: 'released', updatedAt: now });
  const closed = await casBatch(db, batch.id, 'release_requested', 'released', {
    releasedAt: now,
  });
  return closed ? 'released' : 'lost_cas';
}
