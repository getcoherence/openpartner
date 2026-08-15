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
import { findFundingPaymentIntent } from './stripe-lookup.js';

/**
 * How long a batch must have sat QUIET in `release_requested` before an
 * operator may force it. This is what makes the force's own search
 * meaningful: a PaymentIntent can only be created while a batch is in the
 * collector's `invoicing` branch, so any PI for a batch that has been
 * release_requested this long must predate the stuck state by at least
 * this long — far past Stripe's search-indexing lag — and the search
 * below is therefore guaranteed to see it. Without the gate, a PI that a
 * concurrent releaseBatch had just discovered (but not yet stamped) could
 * be un-indexed for OUR search while visible to ITS search (round 9).
 */
const FORCE_RELEASE_QUIET_MS = 60 * 60 * 1000;

export type ReleaseOutcome = 'released' | 'payment_won' | 'lost_cas' | 'pi_not_terminal';

export async function releaseBatch(
  db: Knex,
  stripe: Stripe | null,
  batch: HostedFundingBatchRow,
  reason: string,
): Promise<ReleaseOutcome> {
  // Step 1 — claim the release. Losing the CAS means another actor moved
  // the batch (e.g. a funding webhook landed): re-read and defer to it.
  //
  // `release_requested` is included as a source state on purpose: this
  // protocol can stop halfway (a Stripe call fails → 'pi_not_terminal'),
  // and without re-entry that batch would sit in release_requested with
  // nothing able to pick it up again — no collector state matched it and
  // a second releaseBatch call just lost the CAS.
  //
  // Re-entry must NOT rewrite the row. `casBatch` bumps `updatedAt`, and
  // reconcile decides a release is stuck from `updatedAt` — so a release
  // that fails every five-minute tick would refresh its own alert clock
  // forever and never be reported. When we're already in
  // release_requested there is nothing to transition anyway: just carry
  // on to the money side.
  //
  // The `reserved` claim is attempted SEPARATELY and first (round 7). The
  // no-search fast path below is only sound if the batch was genuinely
  // `reserved` at the moment we claimed it, and the broad CAS cannot tell
  // us which of its four source states it matched. Deciding from the
  // caller's `batch.status` was a stale read: a row that moved
  // reserved → invoicing between the caller's SELECT and this CAS still
  // won the broad CAS, and the fast path then freed the allocations while
  // a PaymentIntent was being created for it.
  //
  // Winning a CAS whose only source state is `reserved` proves it.
  let claimedFromReserved = false;
  let claimed: HostedFundingBatchRow | null = null;
  if (batch.status === 'release_requested') {
    claimed =
      ((await db(TABLES.HostedFundingBatch)
        .where({ id: batch.id, status: 'release_requested' })
        .first()) as HostedFundingBatchRow | undefined) ?? null;
  } else {
    claimed = await casBatch(db, batch.id, 'reserved', 'release_requested', {
      failureReason: reason,
    });
    if (claimed) {
      claimedFromReserved = true;
    } else {
      claimed = await casBatch(
        db,
        batch.id,
        ['invoicing', 'payment_processing', 'funding_failed'],
        'release_requested',
        { failureReason: reason },
      );
    }
  }
  if (!claimed) return 'lost_cas';

  // Step 1b — "no PI on the row" does NOT mean "no PI at Stripe". A
  // create can be in flight right now (the id is only stamped when the
  // call returns) or may have completed with its response lost. Freeing
  // allocations while a real debit exists is the one unrecoverable
  // mistake this protocol can make, so ask Stripe before believing the
  // row (audit #12).
  //
  // Search is eventually consistent, so this can still miss a PI created
  // milliseconds ago — that window is covered on the other side, by the
  // status-predicated stamp in collect.ts, which cancels a PI whose batch
  // was released underneath it.
  let paymentIntentId = claimed.stripePaymentIntentId;
  if (!paymentIntentId && stripe) {
    // A batch we claimed straight out of `reserved` provably never reached
    // Stripe, and that is a LOCAL fact needing no search.
    //
    // The collector's only path to `paymentIntents.create` runs inside the
    // `invoicing` branch, which it can only enter by winning
    // casBatch(reserved → invoicing). So if OUR CAS moved it out of
    // `reserved`, the collector never did, and no PI can exist for this
    // batch. Anything else — invoicing, payment_processing, funding_failed
    // — may have a PI whose id we have not stamped yet.
    if (claimedFromReserved) {
      // fall through with no PI: nothing to terminalize
    } else {
      let orphan: Stripe.PaymentIntent | null;
      try {
        orphan = await findFundingPaymentIntent(stripe, batch.id);
      } catch (err) {
        // Couldn't ask ⇒ don't know ⇒ don't free. Next tick retries.
        console.error(`[funding] release: PI search failed for batch ${batch.id}`, err);
        return 'pi_not_terminal';
      }
      if (orphan) {
        paymentIntentId = orphan.id;
        await db(TABLES.HostedFundingBatch)
          .where({ id: batch.id, status: 'release_requested' })
          .update({ stripePaymentIntentId: orphan.id, updatedAt: new Date() });
        console.warn(
          `[funding] release: batch ${batch.id} had an unstamped PaymentIntent ${orphan.id} — terminalizing it before freeing`,
        );
      } else {
        // EMPTY IS NOT ABSENT (round-6 review). `paymentIntents.search` is
        // Stripe's Search API and is explicitly eventually consistent — a
        // PI created moments ago is not indexed yet. Treating an empty
        // result as proof let a release free allocations while a live PI
        // could still debit the brand; those commissions then landed in a
        // NEW batch and were charged twice.
        //
        // A thrown lookup already meant "don't know". An empty one means
        // exactly the same thing, and now says so. The batch stays
        // `release_requested` with allocations reserved; the collector
        // resumes it, and a later search finds the PI once indexing
        // catches up. If no PI ever existed, it sits until the daily
        // reconcile's stuck-release alert brings a human — liveness, not
        // money.
        console.warn(
          `[funding] release: batch ${batch.id} has no stamped PI and search returned nothing — NOT treating that as proof of absence; staying release_requested`,
        );
        return 'pi_not_terminal';
      }
    }
  }

  // Step 2 — terminalize the money side. A batch that has a PI can never
  // release without a Stripe client to confirm the PI is dead.
  if (paymentIntentId && !stripe) return 'pi_not_terminal';
  if (paymentIntentId && stripe) {
    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (err) {
      console.error(`[funding] release: PI retrieve failed for batch ${batch.id}`, err);
      return 'pi_not_terminal'; // retry on the next collector tick
    }
    if (pi.status === 'succeeded') {
      // The race the protocol exists for: money arrived. Release LOSES.
      //
      // Go through the ONE verified funding transition rather than CASing
      // to `funded` directly: confirm re-reads the live PI, checks amount
      // and currency, and stamps stripeChargeId + fundedAt. A bare CAS
      // left the batch funded with no charge id, and the executor then
      // froze it as recovery_required on the very next tick.
      const live = await stripe.paymentIntents.retrieve(pi.id, {
        expand: ['latest_charge.balance_transaction'],
      });
      const { confirmFundingFromPaymentIntent } = await import('./confirm.js');
      const outcome = await confirmFundingFromPaymentIntent(db, batch.id, live);
      if (outcome === 'funded') {
        console.warn(`[funding] release lost to successful payment — batch ${batch.id} proceeds to transfer`);
        return 'payment_won';
      }
      // Verification refused the payment (amount/currency/charge mismatch).
      // Neither release nor fund on a guess — freeze for an operator.
      await casBatch(db, batch.id, 'release_requested', 'recovery_required', {
        failureReason: `payment_won_but_unverifiable:${outcome}`,
      });
      console.error(
        `[funding] ALERT: batch ${batch.id} raced a succeeded PaymentIntent that failed verification (${outcome}) — frozen for operator review`,
      );
      return 'pi_not_terminal';
    }
    if (pi.status !== 'canceled') {
      try {
        await stripe.paymentIntents.cancel(paymentIntentId);
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

/**
 * OPERATOR ACTION — free a batch that is stuck in `release_requested`.
 *
 * Since round 6 an empty `paymentIntents.search` no longer counts as proof
 * that no PaymentIntent exists, because Stripe's search index is eventually
 * consistent. That is the right call — freeing allocations while a live PI
 * can still debit the brand is the one unrecoverable mistake here — but it
 * means a batch for which a PI genuinely never existed has no automatic way
 * out. It sits `release_requested` with its allocations reserved until the
 * daily reconcile's stuck-release alert brings a human. This is that human's
 * tool, and it exists because a hold with no release is a leak.
 *
 * The operator is asserting what the system deliberately refuses to infer:
 * that no PaymentIntent for this batch exists or ever will. Check first —
 *
 *   stripe payment_intents search --query "metadata['openpartner_funding_batch_id']:'<batchId>'"
 *
 * and give the index time to settle before concluding it is empty.
 *
 * Refuses outright when the batch HAS a stamped PI: that case is not stuck,
 * it is the ordinary release path, and forcing past a live intent is exactly
 * the double-charge this protocol exists to prevent. Cancel the PI in Stripe
 * first and let the normal path finish.
 *
 * And it VERIFIES its own premise (round 9): the null-id fence closed
 * "stamp commits before the force CAS", but not "releaseBatch discovered a
 * PI and had not stamped it yet" — the force won its CAS with the id still
 * null, freed the allocations, and the discovered PI could then succeed
 * against a batch whose commissions were already re-batchable. The quiet
 * gate plus the force's own search close that: no PI can be CREATED for a
 * release_requested batch, so after an hour of quiet any existing PI is
 * old enough to be indexed, and the search here will find it.
 */
export async function forceReleaseBatch(
  db: Knex,
  batchId: string,
  operator: string,
  reason: string,
  /** REQUIRED — the force asks Stripe itself rather than trusting the
   *  operator's (or the row's) claim that no PaymentIntent exists. */
  stripe: Stripe,
  /** Test seam: runs between the read and the CAS, so the check/use race
   *  this function's ordering guards against can be staged deterministically
   *  rather than hoped for. Never passed in production. */
  opts: { __afterRead?: () => Promise<void> } = {},
): Promise<
  'released' | 'not_stuck' | 'has_payment_intent' | 'too_recent' | 'cannot_verify'
> {
  const batch = (await db(TABLES.HostedFundingBatch)
    .where({ id: batchId })
    .first()) as HostedFundingBatchRow | undefined;
  if (!batch || batch.status !== 'release_requested') return 'not_stuck';
  if (batch.stripePaymentIntentId) return 'has_payment_intent';
  if (!stripe) return 'cannot_verify';

  // Quiet gate — see FORCE_RELEASE_QUIET_MS. `updatedAt` moves when the
  // batch enters release_requested and when a resuming releaseBatch stamps
  // a discovered PI; deliberate re-entry does NOT rewrite the row, so a
  // batch failing its release every tick still goes quiet here.
  if (new Date(batch.updatedAt).getTime() > Date.now() - FORCE_RELEASE_QUIET_MS) {
    console.error(
      `[funding] OPERATOR ${operator} force-release of ${batchId} refused — the batch moved less than an hour ago; give the collector's own search time, then retry`,
    );
    return 'too_recent';
  }

  // Ask Stripe. Found ⇒ this batch is not the case the force exists for:
  // stamp the PI so the ordinary release path can terminalize it, and
  // refuse. Couldn't ask ⇒ don't know ⇒ don't free.
  let orphan: Stripe.PaymentIntent | null;
  try {
    orphan = await findFundingPaymentIntent(stripe, batchId);
  } catch (err) {
    console.error(
      `[funding] OPERATOR ${operator} force-release of ${batchId} refused — PI search failed`,
      err,
    );
    return 'cannot_verify';
  }
  if (orphan) {
    await db(TABLES.HostedFundingBatch)
      .where({ id: batchId, status: 'release_requested' })
      .update({ stripePaymentIntentId: orphan.id, updatedAt: new Date() });
    console.error(
      `[funding] OPERATOR ${operator} force-release of ${batchId} refused — PaymentIntent ${orphan.id} exists; stamped it so the ordinary release path can terminalize it`,
    );
    return 'has_payment_intent';
  }

  // The metadata search above is the ONLY stamp a funding PI carries, and
  // metadata is MUTABLE — cleared or forged, the PI is invisible to it
  // (round 10; the same failure the transfer-side fixes closed with
  // transfer_group, which PaymentIntents do not have). The customer LIST
  // is the immutable fallback: funding PIs are created on the tenant's
  // Stripe customer, and one-open-batch-per-tenant+currency means any
  // non-canceled PI at this batch's exact amount and currency, created
  // since the batch was, is almost certainly this batch's. Refuse on
  // suspicion — fail closed; an operator can cancel the PI in Stripe and
  // retry.
  const tenant = (await db(TABLES.Tenant)
    .where({ id: batch.tenantId })
    .first(['stripeCustomerId'])) as { stripeCustomerId: string | null } | undefined;
  if (tenant?.stripeCustomerId) {
    let recent: Stripe.ApiList<Stripe.PaymentIntent>;
    try {
      recent = await stripe.paymentIntents.list({
        customer: tenant.stripeCustomerId,
        limit: 100,
      });
    } catch (err) {
      console.error(
        `[funding] OPERATOR ${operator} force-release of ${batchId} refused — customer PI list failed`,
        err,
      );
      return 'cannot_verify';
    }
    const createdFloor = new Date(batch.createdAt).getTime() - 5 * 60 * 1000;
    const suspicious = recent.data.filter(
      (pi) =>
        pi.status !== 'canceled' &&
        Number(pi.amount) === Number(batch.grossChargeMinor) &&
        pi.currency === batch.currency &&
        pi.created * 1000 >= createdFloor,
    );
    if (suspicious.length > 0) {
      console.error(
        `[funding] OPERATOR ${operator} force-release of ${batchId} refused — ${suspicious.length} unexplained PaymentIntent(s) on the tenant's customer match this batch's amount (${suspicious
          .map((p) => `${p.id}:${p.status}`)
          .join(', ')}); their metadata does not claim this batch, which is itself suspicious`,
      );
      return 'has_payment_intent';
    }
  }

  await opts.__afterRead?.();

  // CAS FIRST, then free (round 7). This used to free the allocations and
  // only then attempt the closing transition — so losing that CAS to a
  // concurrent release that had just found an orphan PI left a batch on its
  // way to `funded` while its allocations were already released and
  // re-batchable. Winning the CAS is what earns the right to free them.
  const now = new Date();
  const closed = await casBatch(
    db,
    batchId,
    'release_requested',
    'released',
    {
      releasedAt: now,
      failureReason: `operator_force_release:${operator}:${reason}`.slice(0, 500),
    },
    // Round 8: status alone was not enough. A concurrent releaseBatch can
    // search, find an orphan PI and STAMP it while the row stays
    // `release_requested` — so this CAS still won, freed the allocations,
    // and left a batch heading for `funded` whose commissions were already
    // back in the pool. Require the id to still be null at the moment we
    // win, not merely when we read.
    { stripePaymentIntentId: null },
  );
  if (!closed) return 'not_stuck'; // someone else moved it, or stamped a PI
  await db(TABLES.HostedFundingAllocation)
    .where({ batchId, state: 'reserved' })
    .update({ state: 'released', updatedAt: now });
  console.error(
    `[funding] OPERATOR ${operator} force-released stuck batch ${batchId} (${reason}) — asserting no PaymentIntent exists; allocations returned to the pool`,
  );
  return 'released';
}
