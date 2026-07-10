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
import {
  TABLES,
  type HostedFundingBatchRow,
  type HostedFundingAuthorizationRow,
  type TenantRow,
} from '@openpartner/db';
import { requireStripe } from '../stripe.js';
import { casBatch, FUNDING_TIMEOUT_DAYS, fundingRetryDueMs, fundingEnabled } from './state.js';
import { getFundingAuthorization } from './reserve.js';
import { releaseBatch } from './release.js';

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

  const batches = (await db(TABLES.HostedFundingBatch)
    .whereIn('status', ['reserved', 'invoicing', 'payment_processing', 'funding_failed'])
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
      // by deterministic idempotency key metadata, never blind re-POST
      // (finding 2): search for a PI carrying our batch id first.
      const existing = await stripe.paymentIntents.search({
        query: `metadata['openpartner_funding_batch_id']:'${batch.id}'`,
        limit: 1,
      });
      if (existing.data.length > 0) {
        const pi = existing.data[0]!;
        await db(TABLES.HostedFundingBatch)
          .where({ id: batch.id, status: 'invoicing' })
          .update({ stripePaymentIntentId: pi.id, updatedAt: new Date() });
        await casBatch(db, batch.id, 'invoicing', 'payment_processing');
        result.advanced.push(batch.id);
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
      const claimed = await casBatch(db, batch.id, 'funding_failed', 'invoicing');
      if (claimed) await createFundingPaymentIntent(db, claimed, stripe, result);
      return;
    }
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
    await db(TABLES.HostedFundingBatch)
      .where({ id: batch.id })
      .update({
        stripePaymentIntentId: pi.id,
        paymentMethodType: auth.paymentMethodType,
        fundingAttempts: batch.fundingAttempts + 1,
        updatedAt: new Date(),
      });
    await casBatch(db, batch.id, 'invoicing', 'payment_processing');
    result.advanced.push(batch.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await casBatch(db, batch.id, 'invoicing', 'funding_failed', {
      failureReason: message.slice(0, 500),
      fundingAttempts: batch.fundingAttempts + 1,
    });
    console.error(`[funding] PI creation failed for batch ${batch.id}: ${message}`);
    result.failed.push(batch.id);
  }
}
