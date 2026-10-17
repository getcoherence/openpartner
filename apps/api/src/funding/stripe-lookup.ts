/**
 * "Does a charge already exist for this batch?" — the question every
 * ambiguous funding path has to answer before it does anything else.
 *
 * A PaymentIntent creation whose response we never saw may still have
 * created a real bank debit. Re-creating past Stripe's ~24h idempotency
 * window would debit the brand TWICE, and freeing a batch's allocations
 * while such a debit is in flight collects money that no batch owns. Both
 * are unrecoverable without an operator, so the rule is: **ask Stripe,
 * never assume.**
 *
 * The lookup is a metadata search on our own stamp. Search is eventually
 * consistent (Stripe indexes within roughly a second, but it is NOT a
 * read-your-writes API), so it is a backstop for retries — never the only
 * guard against a create that is in flight *right now*. The status-
 * predicated stamp in collect.ts covers that window.
 */

import type Stripe from 'stripe';

/** Our stamp on every funding PaymentIntent. */
export const FUNDING_BATCH_METADATA_KEY = 'openpartner_funding_batch_id';

/**
 * Find the funding PaymentIntent for a batch, if Stripe has one.
 *
 * Throws if the search itself fails — callers must treat "I couldn't ask"
 * as "I don't know", and a money path that doesn't know must not act.
 */
export async function findFundingPaymentIntent(
  stripe: Stripe,
  batchId: string,
): Promise<Stripe.PaymentIntent | null> {
  // Batch ids are ULIDs we generated; refuse anything else rather than
  // interpolate it into a query language.
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(batchId)) {
    throw new Error(`refusing to search Stripe for suspicious batch id: ${batchId}`);
  }
  const found = await stripe.paymentIntents.search({
    query: `metadata['${FUNDING_BATCH_METADATA_KEY}']:'${batchId}'`,
    limit: 1,
  });
  return found.data[0] ?? null;
}

/**
 * Stripe attaches the PaymentIntent to errors raised by a create/confirm
 * that got far enough to make one (card declines, bank-debit setup
 * failures). Digging it out means a failed create still records WHICH
 * intent failed, so the retry confirms that one instead of making another.
 */
export function paymentIntentIdFromError(err: unknown): string | null {
  const e = err as {
    payment_intent?: { id?: string };
    raw?: { payment_intent?: { id?: string } };
  };
  return e?.payment_intent?.id ?? e?.raw?.payment_intent?.id ?? null;
}
