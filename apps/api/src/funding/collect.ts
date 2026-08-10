/**
 * Collector — spec §5 (collection) + §7 timeouts. Runs OUTSIDE any
 * wrapping transaction (a scheduler job on the privileged pool): each
 * batch advances through short, individually-committed steps, and every
 * Stripe call happens between transactions, never inside one.
 *
 * reserved → invoicing → payment_processing → (webhook confirms → funded)
 *                                    └→ funding_failed → release protocol
 */

import type Stripe from 'stripe';
import type { Knex } from 'knex';
import { TABLES, type HostedFundingBatchRow, type TenantRow } from '@openpartner/db';
import { requireStripe } from '../stripe.js';
import { casBatch, FUNDING_TIMEOUT_DAYS, fundingRetryDueMs, fundingEnabled } from './state.js';
import { getFundingAuthorization } from './reserve.js';
import { releaseBatch } from './release.js';
import { findFundingPaymentIntent, paymentIntentIdFromError } from './stripe-lookup.js';

export interface CollectorDeps {
  stripe?: Stripe;
  now?: () => Date;
}

export interface CollectorResult {
  processed: number;
  advanced: string[];
  failed: string[];
  released: string[];
}

/**
 * One collector pass over every non-terminal pre-funding batch. Called by
 * the scheduler (every 5 minutes, advisory-locked, protect: true).
 */
export async function runFundingCollector(db: Knex, deps: CollectorDeps = {}): Promise<CollectorResult> {
  const result: CollectorResult = { processed: 0, advanced: [], failed: [], released: [] };
  if (!fundingEnabled()) return result;
  const now = deps.now ?? (() => new Date());

  // `release_requested` is in scope so a release that stopped halfway (a
  // Stripe call failed) gets resumed on the next tick. Without it the
  // batch was terminal-by-accident: allocations frozen, nothing looking.
  const batches = (await db(TABLES.HostedFundingBatch)
    .whereIn('status', [
      'reserved',
      'invoicing',
      'payment_processing',
      'funding_failed',
      'release_requested',
    ])
    .orderBy('createdAt', 'asc')) as HostedFundingBatchRow[];

  for (const batch of batches) {
    result.processed += 1;
    try {
      await collectBatch(db, batch, deps, now(), result);
    } catch (err) {
      // One batch's failure never blocks the rest of the pass.
      console.error(`[funding] collector error on batch ${batch.id}`, err);
      result.failed.push(batch.id);
    }
  }
  return result;
}

async function collectBatch(
  db: Knex,
  batch: HostedFundingBatchRow,
  deps: CollectorDeps,
  now: Date,
  result: CollectorResult,
): Promise<void> {
  const stripe = deps.stripe ?? requireStripe();

  // Global timeout: a batch that hasn't funded within the window releases.
  const ageMs = now.getTime() - new Date(batch.createdAt).getTime();
  const timedOut = ageMs > FUNDING_TIMEOUT_DAYS * 24 * 60 * 60 * 1000;

  switch (batch.status) {
    case 'reserved': {
      if (timedOut) {
        if ((await releaseBatch(db, stripe, batch, 'funding_timeout')) === 'released') result.released.push(batch.id);
        return;
      }
      const claimed = await casBatch(db, batch.id, 'reserved', 'invoicing');
      if (!claimed) return; // someone else advanced it
      await createFundingPaymentIntent(db, claimed, stripe, result);
      return;
    }
    case 'invoicing': {
      // A previous worker crashed between CAS and PI stamping — reconcile
      // by metadata, never blind re-POST (finding 2): search for a PI
      // carrying our batch id first.
      const existing = await findFundingPaymentIntent(stripe, batch.id);
      if (existing) {
        await adoptExistingPaymentIntent(db, batch, existing, 'invoicing', stripe, result);
        return;
      }
      await createFundingPaymentIntent(db, batch, stripe, result);
      return;
    }
    case 'payment_processing': {
      if (timedOut) {
        if ((await releaseBatch(db, stripe, batch, 'funding_timeout')) === 'released') result.released.push(batch.id);
        return;
      }
      // The success path is webhook-driven (build 3). The collector only
      // polls as a webhook-loss backstop, cheaply.
      if (batch.stripePaymentIntentId) {
        const pi = await stripe.paymentIntents.retrieve(batch.stripePaymentIntentId);
        if (pi.status === 'succeeded') {
          const { confirmFundingFromPaymentIntent } = await import('./confirm.js');
          await confirmFundingFromPaymentIntent(db, batch.id, pi);
          result.advanced.push(batch.id);
        } else if (pi.status === 'canceled') {
          if ((await releaseBatch(db, stripe, batch, 'pi_canceled')) === 'released') result.released.push(batch.id);
        }
      }
      return;
    }
    case 'release_requested': {
      // A previous release stopped before the PI was terminal. Re-enter it
      // (releaseBatch accepts release_requested as a source state) so the
      // batch finishes releasing instead of sitting frozen forever.
      const outcome = await releaseBatch(db, stripe, batch, batch.failureReason ?? 'release_resumed');
      if (outcome === 'released') result.released.push(batch.id);
      return;
    }
    case 'funding_failed': {
      // Owned retry schedule (~day 1, 3, 7) against the same batch, then
      // the timeout above releases it.
      if (timedOut) {
        if ((await releaseBatch(db, stripe, batch, 'funding_retries_exhausted')) === 'released') {
          result.released.push(batch.id);
        }
        return;
      }
      const sinceLast = now.getTime() - new Date(batch.updatedAt).getTime();
      if (sinceLast < fundingRetryDueMs(batch.fundingAttempts)) return;
      // Retry CONFIRMS the existing PI — re-creating under the frozen
      // key would just replay the original creation response (the PI
      // object), not retry the payment. Only a batch whose PI creation
      // itself hard-failed (no PI stamped) goes back through create.
      if (batch.stripePaymentIntentId) {
        await retryFundingPaymentIntent(db, batch, stripe, result);
        return;
      }
      // No PI stamped — but "no stamp" does NOT mean "no PaymentIntent".
      // An earlier create whose response was lost (timeout, crash) may
      // have made a real bank debit. Inside Stripe's ~24h idempotency
      // window a re-create would replay harmlessly; past it, it would
      // debit the brand a SECOND time. So once we've attempted at all, we
      // ask Stripe before creating (audit #12).
      if (batch.fundingAttempts > 0) {
        const orphan = await findFundingPaymentIntent(stripe, batch.id);
        if (orphan) {
          await adoptExistingPaymentIntent(db, batch, orphan, 'funding_failed', stripe, result);
          return;
        }
      }
      const claimed = await casBatch(db, batch.id, 'funding_failed', 'invoicing');
      if (claimed) await createFundingPaymentIntent(db, claimed, stripe, result);
      return;
    }
  }
}

/**
 * Take ownership of a PaymentIntent Stripe has but our batch doesn't know
 * about — the recovery half of every ambiguous create. Stamps the id, then
 * routes on the PI's ACTUAL status rather than assuming it's still open.
 */
async function adoptExistingPaymentIntent(
  db: Knex,
  batch: HostedFundingBatchRow,
  pi: Stripe.PaymentIntent,
  from: 'invoicing' | 'funding_failed',
  stripe: Stripe,
  result: CollectorResult,
): Promise<void> {
  const stamped = await db(TABLES.HostedFundingBatch)
    .where({ id: batch.id, status: from })
    .update({ stripePaymentIntentId: pi.id, updatedAt: new Date() });
  if (stamped === 0) return; // batch moved under us; next tick re-reads

  console.warn(
    `[funding] batch ${batch.id}: adopted existing PaymentIntent ${pi.id} (${pi.status}) instead of creating a second one`,
  );
  if (pi.status === 'succeeded') {
    // Move through payment_processing so the verified confirm path applies.
    await casBatch(db, batch.id, from, 'payment_processing');
    // Re-read with the charge expanded, exactly like the webhook path:
    // confirm verifies against a live object and stamps the rail fee.
    const live = await stripe.paymentIntents.retrieve(pi.id, {
      expand: ['latest_charge.balance_transaction'],
    });
    const { confirmFundingFromPaymentIntent } = await import('./confirm.js');
    await confirmFundingFromPaymentIntent(db, batch.id, live);
    result.advanced.push(batch.id);
    return;
  }
  if (pi.status === 'canceled') {
    // Stay where we are; the release protocol owns terminalization.
    return;
  }
  await casBatch(db, batch.id, from, 'payment_processing');
  result.advanced.push(batch.id);
}

/**
 * Retry a failed payment by confirming the SAME PaymentIntent with the
 * tenant's authorized payment method. Per-attempt idempotency key — each
 * scheduled retry is a distinct, deliberate attempt.
 */
async function retryFundingPaymentIntent(
  db: Knex,
  batch: HostedFundingBatchRow,
  stripe: Stripe,
  result: CollectorResult,
): Promise<void> {
  const pi = await stripe.paymentIntents.retrieve(batch.stripePaymentIntentId!);
  if (pi.status === 'succeeded') {
    const { confirmFundingFromPaymentIntent } = await import('./confirm.js');
    // Payment-wins CAS covers payment_processing/release_requested; a
    // funding_failed batch whose PI actually succeeded moves through
    // payment_processing first so the same verified path applies.
    await casBatch(db, batch.id, 'funding_failed', 'payment_processing');
    await confirmFundingFromPaymentIntent(db, batch.id, pi);
    result.advanced.push(batch.id);
    return;
  }
  if (pi.status === 'canceled') {
    if ((await releaseBatch(db, stripe, batch, 'pi_canceled')) === 'released') result.released.push(batch.id);
    return;
  }
  if (pi.status !== 'requires_payment_method' && pi.status !== 'requires_confirmation') {
    return; // processing — leave it alone until it terminalizes
  }
  const auth = await getFundingAuthorization(db, batch.tenantId);
  if (!auth) {
    console.error(`[funding] retry impossible: tenant ${batch.tenantId} authorization revoked (batch ${batch.id})`);
    return; // timeout will release it
  }
  const attempt = batch.fundingAttempts + 1;
  try {
    await stripe.paymentIntents.confirm(
      pi.id,
      { payment_method: auth.stripePaymentMethodId },
      { idempotencyKey: `fbpc:${batch.id}:${attempt}` },
    );
    await casBatch(db, batch.id, 'funding_failed', 'payment_processing', {
      fundingAttempts: attempt,
    });
    result.advanced.push(batch.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db(TABLES.HostedFundingBatch)
      .where({ id: batch.id, status: 'funding_failed' })
      .update({ failureReason: message.slice(0, 500), fundingAttempts: attempt, updatedAt: new Date() });
    console.error(`[funding] retry confirm failed for batch ${batch.id}: ${message}`);
    result.failed.push(batch.id);
  }
}

async function createFundingPaymentIntent(
  db: Knex,
  batch: HostedFundingBatchRow,
  stripe: Stripe,
  result: CollectorResult,
): Promise<void> {
  const auth = await getFundingAuthorization(db, batch.tenantId);
  const tenant = (await db(TABLES.Tenant)
    .where({ id: batch.tenantId })
    .first(['stripeCustomerId'])) as Pick<TenantRow, 'stripeCustomerId'> | undefined;
  if (!auth || !tenant?.stripeCustomerId) {
    await casBatch(db, batch.id, 'invoicing', 'funding_failed', {
      failureReason: !auth ? 'authorization_missing_or_revoked' : 'no_stripe_customer',
      fundingAttempts: batch.fundingAttempts + 1,
    });
    result.failed.push(batch.id);
    return;
  }

  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: Number(batch.grossChargeMinor),
        currency: batch.currency,
        customer: tenant.stripeCustomerId,
        payment_method: auth.stripePaymentMethodId,
        // Launch: bank-debit-only (spec §12). The card path is disabled
        // pending counsel; do not widen this list without reading §12.
        payment_method_types: ['us_bank_account'],
        off_session: true,
        confirm: true,
        description: `Partner commission funding — batch ${batch.id}`,
        statement_descriptor_suffix: undefined, // bank debits: descriptor set at account level
        metadata: {
          openpartner_funding_batch_id: batch.id,
          openpartner_tenant_id: batch.tenantId,
        },
      },
      // Frozen key: a crashed worker retries into the SAME PI. After the
      // idempotency window, the 'invoicing' reconcile path (metadata
      // search) takes over — never a second blind create.
      { idempotencyKey: `fbpi:${batch.id}` },
    );
    // Status-predicated stamp (audit #12). A release can claim this batch
    // while the create above is in flight — at which point the batch has
    // no PI id, so release sees nothing to cancel and frees the
    // allocations. Writing the id unconditionally would leave a real
    // debit attached to a released batch. Losing this CAS means exactly
    // that happened, and the PI we just made is an orphan.
    const stamped = await db(TABLES.HostedFundingBatch)
      .where({ id: batch.id, status: 'invoicing' })
      .update({
        stripePaymentIntentId: pi.id,
        paymentMethodType: auth.paymentMethodType,
        fundingAttempts: batch.fundingAttempts + 1,
        updatedAt: new Date(),
      });
    if (stamped === 0) {
      await abandonOrphanPaymentIntent(db, stripe, batch, pi);
      return;
    }
    await casBatch(db, batch.id, 'invoicing', 'payment_processing');
    result.advanced.push(batch.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A create that failed AFTER Stripe made the intent (declines, bank
    // setup errors) carries it on the error. Record which intent failed,
    // so the retry confirms that one instead of creating another.
    const failedPiId = paymentIntentIdFromError(err);
    if (failedPiId) {
      await db(TABLES.HostedFundingBatch)
        .where({ id: batch.id, status: 'invoicing' })
        .update({ stripePaymentIntentId: failedPiId, updatedAt: new Date() });
    }
    await casBatch(db, batch.id, 'invoicing', 'funding_failed', {
      failureReason: message.slice(0, 500),
      fundingAttempts: batch.fundingAttempts + 1,
    });
    console.error(`[funding] PI creation failed for batch ${batch.id}: ${message}`);
    result.failed.push(batch.id);
  }
}

/**
 * We created a PaymentIntent for a batch that a release claimed while the
 * call was in flight. Cancel it — the allocations are already free, so
 * this money must not arrive. If Stripe won't cancel (a bank debit that
 * already moved to `processing`), the batch is frozen for an operator:
 * money is coming in that no batch owns.
 */
async function abandonOrphanPaymentIntent(
  db: Knex,
  stripe: Stripe,
  batch: HostedFundingBatchRow,
  pi: Stripe.PaymentIntent,
): Promise<void> {
  try {
    await stripe.paymentIntents.cancel(pi.id);
    console.warn(
      `[funding] batch ${batch.id}: released mid-create — canceled orphan PaymentIntent ${pi.id}`,
    );
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db(TABLES.HostedFundingBatch)
      .where({ id: batch.id })
      .update({ stripePaymentIntentId: pi.id, updatedAt: new Date() });

    // ORDER MATTERS. Reclaiming the allocations is the part that actually
    // prevents a second debit, so it runs FIRST and unconditionally. The
    // status escalation below can legitimately fail — moving a released
    // batch back to a non-terminal status violates the one-open-batch
    // unique index if a newer batch already exists — and casBatch raises
    // on that rather than returning null. Doing the escalation first meant
    // the throw skipped the reclaim entirely, leaving a live debit and
    // freed commissions: exactly the double-charge this path exists to
    // stop.
    const reclaimed = await reclaimReleasedAllocations(db, batch.id);
    const stillFree = await db(TABLES.HostedFundingAllocation)
      .where({ batchId: batch.id, state: 'released' })
      .count<{ count: string }[]>('* as count')
      .first();
    const unreclaimed = Number((stillFree as { count?: string } | undefined)?.count ?? 0);

    let frozen = false;
    try {
      frozen = !!(await casBatch(
        db,
        batch.id,
        ['released', 'release_requested', 'funding_failed', 'payment_processing'],
        'recovery_required',
        { failureReason: `orphan_payment_intent:${pi.id}` },
      ));
    } catch (casErr) {
      // Almost certainly the open-batch unique index: a newer batch for
      // this tenant/currency is already live. The batch stays `released`
      // and reconciliation skips released batches, so the alert below is
      // the only thing that will surface it.
      console.error(`[funding] batch ${batch.id}: could not freeze as recovery_required`, casErr);
    }
    console.error(
      `[funding] ALERT: batch ${batch.id} was released while PaymentIntent ${pi.id} was in flight and the PI could not be canceled (${message}) — ${reclaimed} allocation(s) reclaimed, ${unreclaimed} already taken by a newer batch, batch ${frozen ? 'frozen recovery_required' : 'STILL RELEASED (could not freeze — a newer batch is open)'}; operator reconciliation required${unreclaimed > 0 ? ' — COMMISSIONS MAY BE DOUBLE-CHARGED' : ''}`,
    );
  }
}

/**
 * Pull a released batch's allocations back under it. Only rows whose
 * commission isn't already live somewhere else are taken — if a newer
 * batch has already reserved one, that batch owns it and an operator has
 * to untangle the overlap (the alert above says so).
 */
async function reclaimReleasedAllocations(db: Knex, batchId: string): Promise<number> {
  return db(TABLES.HostedFundingAllocation)
    .where({ batchId, state: 'released' })
    .whereNotExists(function () {
      this.select('*')
        .from(`${TABLES.HostedFundingAllocation} as other`)
        .whereRaw(`"other"."commissionId" = "${TABLES.HostedFundingAllocation}"."commissionId"`)
        .whereRaw(`"other"."batchId" <> ?`, [batchId])
        .whereNotIn('other.state', ['released', 'canceled']);
    })
    .update({ state: 'reserved', updatedAt: new Date() });
}
