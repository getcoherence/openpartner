/**
 * Funding-pipeline races (audit #12). DB-backed, Stripe hand-mocked so
 * every test asserts exactly which calls reached the money API.
 *
 * Three failure modes, all of which cost the brand real money:
 *   1. an ambiguous PaymentIntent create being RE-created past Stripe's
 *      idempotency window → the brand debited twice
 *   2. a release freeing allocations while a create is in flight → money
 *      collected for commissions that are already back in the pool
 *   3. a webhook claimed before it was processed → a crash makes every
 *      redelivery a no-op and the transition is lost forever
 */

process.env.HOSTED_FUNDING_ENABLED = '1';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID, type HostedFundingBatchRow } from '@openpartner/db';
import { db } from '../db.js';
import { runFundingCollector } from '../funding/collect.js';
import { releaseBatch } from '../funding/release.js';
import { claimInboxEvent, releaseInboxClaim, stampInboxOutcome } from '../funding/inbox.js';
import { handleFundingEvent } from '../funding/webhook.js';
import { runFundingReconciliation } from '../funding/reconcile.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;

// ---- Stripe mock ----------------------------------------------------------

type PiStatus = Stripe.PaymentIntent['status'];

/** A PaymentIntent shaped enough for confirm.ts to verify it. */
function succeededPi(id: string, amountMinor = 8000) {
  return {
    id,
    status: 'succeeded' as PiStatus,
    amount_received: amountMinor,
    currency: 'usd',
    latest_charge: { id: `ch_${id}`, status: 'succeeded', refunded: false, balance_transaction: null },
    metadata: {},
  };
}

interface StripeMockOpts {
  /** What `paymentIntents.search` returns. */
  searchResult?: Array<Record<string, unknown> & { id: string; status: PiStatus }>;
  searchThrows?: Error;
  /** Hook that runs INSIDE paymentIntents.create, before it resolves —
   *  the only way to simulate "something else moved while we were in
   *  flight". */
  duringCreate?: () => Promise<void>;
  createThrows?: unknown;
  createdStatus?: PiStatus;
  cancelThrows?: Error;
  retrieveStatus?: PiStatus;
  /** Overrides for `charges.retrieve` (reconcile's refund sweep). */
  charge?: Record<string, unknown>;
  /** Overrides for `transfers.retrieve` (reconcile's reversal sweep). */
  transfer?: Record<string, unknown>;
}

function mockStripe(opts: StripeMockOpts = {}) {
  const create = vi.fn(async (params: { amount: number; metadata: Record<string, string> }) => {
    if (opts.duringCreate) await opts.duringCreate();
    if (opts.createThrows) throw opts.createThrows;
    return {
      id: `pi_${ulid().slice(0, 16)}`,
      status: opts.createdStatus ?? ('processing' as PiStatus),
      amount: params.amount,
      metadata: params.metadata,
    };
  });
  const search = vi.fn(async () => {
    if (opts.searchThrows) throw opts.searchThrows;
    return { data: opts.searchResult ?? [] };
  });
  const retrieve = vi.fn(async (id: string) =>
    (opts.retrieveStatus ?? 'processing') === 'succeeded'
      ? succeededPi(id)
      : { id, status: opts.retrieveStatus ?? ('processing' as PiStatus), metadata: {} },
  );
  const cancel = vi.fn(async (id: string) => {
    if (opts.cancelThrows) throw opts.cancelThrows;
    return { id, status: 'canceled' as PiStatus };
  });
  const confirm = vi.fn(async (id: string) => ({ id, status: 'processing' as PiStatus }));
  const chargeRetrieve = vi.fn(async (id: string) => ({
    id,
    refunded: false,
    amount_refunded: 0,
    disputed: false,
    balance_transaction: { fee: 25 },
    ...(opts.charge ?? {}),
  }));
  const transferRetrieve = vi.fn(async (id: string) => ({
    id,
    reversed: false,
    amount_reversed: 0,
    reversals: { data: [] },
    ...(opts.transfer ?? {}),
  }));
  const stripe = {
    paymentIntents: { create, search, retrieve, cancel, confirm },
    charges: { retrieve: chargeRetrieve },
    transfers: { retrieve: transferRetrieve },
  } as unknown as Stripe;
  return { stripe, create, search, retrieve, cancel, confirm, chargeRetrieve, transferRetrieve };
}

// ---- Seeding --------------------------------------------------------------

async function seedAuthorization(): Promise<void> {
  const adminId = ulid();
  await db(TABLES.Admin).insert({
    id: adminId,
    tenantId: TENANT,
    email: `a${adminId}@x.test`,
    name: 'A',
  });
  await db(TABLES.HostedFundingAuthorization).insert({
    id: ulid(),
    tenantId: TENANT,
    adminId,
    termsVersion: 'test-v1',
    stripePaymentMethodId: 'pm_test_bank',
    paymentMethodType: 'us_bank_account',
  });
  await db(TABLES.Tenant).where({ id: TENANT }).update({ stripeCustomerId: 'cus_test' });
}

async function seedBatch(patch: Partial<HostedFundingBatchRow> = {}): Promise<HostedFundingBatchRow> {
  const id = ulid();
  await db(TABLES.HostedFundingBatch).insert({
    id,
    tenantId: TENANT,
    currency: 'usd',
    principalMinor: 8000,
    grossChargeMinor: 8000,
    status: 'reserved',
    fundingAttempts: 0,
    ...patch,
  });
  return (await db(TABLES.HostedFundingBatch).where({ id }).first()) as HostedFundingBatchRow;
}

async function reload(id: string): Promise<HostedFundingBatchRow> {
  return (await db(TABLES.HostedFundingBatch).where({ id }).first()) as HostedFundingBatchRow;
}

/** A real approved commission — allocations carry an FK to one. */
async function seedCommission(): Promise<{ commissionId: string; partnerId: string }> {
  const partnerId = ulid();
  await db(TABLES.Partner).insert({
    id: partnerId,
    tenantId: TENANT,
    email: `p${partnerId}@x.test`,
    name: 'P',
    stripeConnectAccountId: `acct_${partnerId.slice(0, 10)}`,
    metadata: { stripe: { payoutsEnabled: true } },
  });
  const programId = ulid();
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: TENANT,
    name: 'prog',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl: 'https://x.test',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  const clickId = ulid();
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: TENANT,
    partnerId,
    programId,
    landingUrl: 'https://x.test/',
    ts: new Date(),
  });
  const eventId = ulid();
  await db(TABLES.Event).insert({
    id: eventId,
    tenantId: TENANT,
    userId: `u-${clickId}`,
    type: 'invoice_paid',
    value: '400.00',
    currency: 'USD',
    ts: new Date(),
  });
  const attributionId = ulid();
  await db(TABLES.Attribution).insert({
    id: attributionId,
    tenantId: TENANT,
    eventId,
    clickId,
    partnerId,
    programId,
    model: 'last_click',
    weight: '1',
    computedAt: new Date(),
  });
  const commissionId = ulid();
  await db(TABLES.Commission).insert({
    id: commissionId,
    tenantId: TENANT,
    partnerId,
    attributionId,
    amount: '80.00',
    currency: 'USD',
    status: 'approved',
  });
  return { commissionId, partnerId };
}

/** An allocation so release has something to free. */
async function seedAllocation(batchId: string): Promise<string> {
  const { commissionId, partnerId } = await seedCommission();
  const id = ulid();
  await db(TABLES.HostedFundingAllocation).insert({
    id,
    tenantId: TENANT,
    batchId,
    partnerId,
    commissionId,
    amountMinor: 8000,
    state: 'reserved',
  });
  return id;
}

const FUNDING_TABLES = [
  TABLES.PayoutReversal,
  TABLES.CommissionAdjustment,
  TABLES.HostedFundingTransfer,
  TABLES.HostedFundingAllocation,
  TABLES.HostedFundingBatch,
  TABLES.HostedFundingAuthorization,
  TABLES.StripeWebhookInbox,
];

const PRODUCT_TABLES = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.Payout,
  TABLES.Program,
  TABLES.Partner,
];

async function wipe(): Promise<void> {
  for (const t of [...FUNDING_TABLES, ...PRODUCT_TABLES, TABLES.Admin]) await db(t).del();
  await db(TABLES.Tenant).where({ id: TENANT }).update({ stripeCustomerId: null });
}

beforeEach(async () => {
  if (skipIntegration) return;
  await wipe();
});

afterAll(async () => {
  if (!skipIntegration) await wipe();
  await db.destroy();
});

// ---- Race 1: ambiguous PaymentIntent create --------------------------------

describe.skipIf(skipIntegration)('ambiguous PaymentIntent create', () => {
  it('a retry after a lost create adopts the existing PI instead of charging again', async () => {
    await seedAuthorization();
    // The shape a lost response leaves behind: an attempt was made, no id
    // was stamped, the batch fell to funding_failed.
    const batch = await seedBatch({
      status: 'funding_failed',
      fundingAttempts: 1,
      updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    const { stripe, create, search } = mockStripe({
      searchResult: [{ id: 'pi_orphan', status: 'processing' }],
    });

    await runFundingCollector(db, { stripe });

    expect(search).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled(); // the whole point
    const after = await reload(batch.id);
    expect(after.stripePaymentIntentId).toBe('pi_orphan');
    expect(after.status).toBe('payment_processing');
  });

  it('an adopted PI that already succeeded confirms funding rather than re-charging', async () => {
    await seedAuthorization();
    const batch = await seedBatch({
      status: 'funding_failed',
      fundingAttempts: 2,
      updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    await seedAllocation(batch.id);
    const { stripe, create } = mockStripe({
      searchResult: [succeededPi('pi_succeeded')],
      retrieveStatus: 'succeeded',
    });

    await runFundingCollector(db, { stripe });

    expect(create).not.toHaveBeenCalled();
    const after = await reload(batch.id);
    expect(after.stripePaymentIntentId).toBe('pi_succeeded');
    expect(after.status).toBe('funded');
  });

  it('a first attempt does not pay for a search — there is nothing to find', async () => {
    await seedAuthorization();
    const batch = await seedBatch({ status: 'reserved', fundingAttempts: 0 });
    const { stripe, create, search } = mockStripe();

    await runFundingCollector(db, { stripe });

    expect(search).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect((await reload(batch.id)).status).toBe('payment_processing');
  });

  it('a create that fails WITH a PaymentIntent records it, so the retry confirms that one', async () => {
    await seedAuthorization();
    const batch = await seedBatch({ status: 'reserved' });
    const declined = Object.assign(new Error('Your bank account was declined'), {
      statusCode: 402,
      raw: { payment_intent: { id: 'pi_declined' } },
    });
    const { stripe, create } = mockStripe({ createThrows: declined });

    await runFundingCollector(db, { stripe });

    expect(create).toHaveBeenCalledOnce();
    const after = await reload(batch.id);
    expect(after.status).toBe('funding_failed');
    // Stamped even though the call threw — otherwise the retry would
    // create a second intent for the same batch.
    expect(after.stripePaymentIntentId).toBe('pi_declined');
    expect(after.fundingAttempts).toBe(1);
  });
});

// ---- Race 2: release vs in-flight create -----------------------------------

describe.skipIf(skipIntegration)('release vs in-flight create', () => {
  it('release asks Stripe before freeing, and terminalizes a PI the row never knew about', async () => {
    const batch = await seedBatch({ status: 'invoicing' });
    const allocationId = await seedAllocation(batch.id);
    const { stripe, search, cancel } = mockStripe({
      searchResult: [{ id: 'pi_inflight', status: 'processing' }],
      retrieveStatus: 'processing',
    });

    const outcome = await releaseBatch(db, stripe, batch, 'funding_timeout');

    expect(search).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('pi_inflight');
    expect(outcome).toBe('released');
    expect((await reload(batch.id)).stripePaymentIntentId).toBe('pi_inflight');
    const allocation = await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first();
    expect(allocation.state).toBe('released'); // freed only after the PI died
  });

  it('an unstamped PI that already succeeded means the payment WINS the release', async () => {
    const batch = await seedBatch({ status: 'payment_processing' });
    const allocationId = await seedAllocation(batch.id);
    const { stripe, cancel } = mockStripe({
      searchResult: [succeededPi('pi_won')],
      retrieveStatus: 'succeeded',
    });

    const outcome = await releaseBatch(db, stripe, batch, 'funding_timeout');

    expect(outcome).toBe('payment_won');
    expect(cancel).not.toHaveBeenCalled();
    expect((await reload(batch.id)).status).toBe('funded');
    const allocation = await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first();
    expect(allocation.state).toBe('reserved'); // NOT freed
  });

  it("a search that fails means 'I don't know' — allocations stay put", async () => {
    const batch = await seedBatch({ status: 'invoicing' });
    const allocationId = await seedAllocation(batch.id);
    const { stripe } = mockStripe({ searchThrows: new Error('stripe down') });

    const outcome = await releaseBatch(db, stripe, batch, 'funding_timeout');

    expect(outcome).toBe('pi_not_terminal');
    const allocation = await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first();
    expect(allocation.state).toBe('reserved');
  });

  it('a batch released mid-create cancels the orphaned PaymentIntent', async () => {
    await seedAuthorization();
    const batch = await seedBatch({ status: 'reserved' });
    const { stripe, cancel } = mockStripe({
      // The release lands while the create is in flight.
      duringCreate: async () => {
        await db(TABLES.HostedFundingBatch)
          .where({ id: batch.id })
          .update({ status: 'released', releasedAt: new Date() });
      },
    });

    await runFundingCollector(db, { stripe });

    expect(cancel).toHaveBeenCalledOnce();
    const after = await reload(batch.id);
    expect(after.status).toBe('released');
    // Never stamped onto a released batch.
    expect(after.stripePaymentIntentId).toBeNull();
  });

  it('an orphan that cannot be canceled freezes the batch for an operator', async () => {
    await seedAuthorization();
    const batch = await seedBatch({ status: 'reserved' });
    const { stripe, cancel } = mockStripe({
      duringCreate: async () => {
        await db(TABLES.HostedFundingBatch)
          .where({ id: batch.id })
          .update({ status: 'released', releasedAt: new Date() });
      },
      cancelThrows: new Error('PaymentIntent is processing and cannot be canceled'),
    });

    await runFundingCollector(db, { stripe });

    expect(cancel).toHaveBeenCalledOnce();
    const after = await reload(batch.id);
    expect(after.status).toBe('recovery_required');
    expect(after.stripePaymentIntentId).toMatch(/^pi_/);
    expect(after.failureReason).toMatch(/^orphan_payment_intent:/);
  });
});

// ---- Race 3: inbox claim before process ------------------------------------

describe.skipIf(skipIntegration)('webhook inbox claim lease', () => {
  const evt = () => `evt_${ulid()}`;

  it('a finished event never re-runs', async () => {
    const id = evt();
    expect(await claimInboxEvent(db, id, 'payment_intent.succeeded')).toBe(true);
    await stampInboxOutcome(db, id, 'confirm:funded');
    expect(await claimInboxEvent(db, id, 'payment_intent.succeeded')).toBe(false);
    // Not even after any amount of time — outcome is terminal.
    await db(TABLES.StripeWebhookInbox)
      .where({ stripeEventId: id })
      .update({ processedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });
    expect(await claimInboxEvent(db, id, 'payment_intent.succeeded')).toBe(false);
  });

  it('a live claim blocks a concurrent worker', async () => {
    const id = evt();
    expect(await claimInboxEvent(db, id, 'charge.refunded')).toBe(true);
    expect(await claimInboxEvent(db, id, 'charge.refunded')).toBe(false);
  });

  it('a claim whose worker died is taken over by the redelivery', async () => {
    const id = evt();
    expect(await claimInboxEvent(db, id, 'payment_intent.succeeded')).toBe(true);
    // …worker crashes here: no outcome was ever stamped.
    await db(TABLES.StripeWebhookInbox)
      .where({ stripeEventId: id })
      .update({ processedAt: new Date(Date.now() - 10 * 60 * 1000) });

    // Before this fix the row said "seen" and every redelivery no-opped
    // forever — the transition it carried was lost.
    expect(await claimInboxEvent(db, id, 'payment_intent.succeeded')).toBe(true);
    const row = await db(TABLES.StripeWebhookInbox).where({ stripeEventId: id }).first();
    expect(row.outcome).toBeNull();
  });

  it('releasing a claim lets the redelivery through immediately', async () => {
    const id = evt();
    expect(await claimInboxEvent(db, id, 'charge.dispute.created')).toBe(true);
    await releaseInboxClaim(db, id);
    expect(await claimInboxEvent(db, id, 'charge.dispute.created')).toBe(true);
  });

  it('a handler that throws leaves the event replayable', async () => {
    const batch = await seedBatch({ status: 'payment_processing' });
    const event = {
      id: evt(),
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_boom',
          metadata: { openpartner_funding_batch_id: batch.id },
        },
      },
    } as unknown as Stripe.Event;
    const exploding = {
      paymentIntents: {
        retrieve: vi.fn(async () => {
          throw new Error('stripe timeout');
        }),
      },
    } as unknown as Stripe;

    await expect(handleFundingEvent(db, exploding, event)).rejects.toThrow('stripe timeout');
    expect(await db(TABLES.StripeWebhookInbox).where({ stripeEventId: event.id }).first()).toBeUndefined();

    // Stripe redelivers; this time it works and is recorded terminal.
    const { stripe } = mockStripe();
    const ok = {
      ...stripe,
      paymentIntents: {
        ...(stripe as unknown as { paymentIntents: object }).paymentIntents,
        retrieve: vi.fn(async () => ({ id: 'pi_boom', status: 'succeeded', metadata: {} })),
      },
    } as unknown as Stripe;
    const outcome = await handleFundingEvent(db, ok, event);
    expect(outcome).toMatch(/^confirm:/);
    const row = await db(TABLES.StripeWebhookInbox).where({ stripeEventId: event.id }).first();
    expect(row.outcome).toMatch(/^confirm:/);
  });

  it('reconciliation alerts on a claim that was never finished and never redelivered', async () => {
    const id = evt();
    await claimInboxEvent(db, id, 'payment_intent.succeeded');
    await db(TABLES.StripeWebhookInbox)
      .where({ stripeEventId: id })
      .update({ processedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });

    const report = await runFundingReconciliation(db, { stripe: mockStripe().stripe });
    expect(report.unfinishedInboxEvents).toContain(id);
  });
});

// ---- Lost webhooks: the live-Stripe backstop -------------------------------

describe.skipIf(skipIntegration)('reconciliation catches what webhooks lost', () => {
  it('a refunded funding charge with no webhook freezes the batch', async () => {
    const batch = await seedBatch({
      status: 'funded',
      stripeChargeId: 'ch_funded',
      fundedAt: new Date(),
    });
    await seedAllocation(batch.id);
    const { stripe } = mockStripe({
      charge: { refunded: true, amount_refunded: 8000 },
    });

    const report = await runFundingReconciliation(db, { stripe });

    expect(report.missedRefunds).toContain(batch.id);
    expect((await reload(batch.id)).status).toBe('funding_disputed');
  });

  it('a clean charge only backfills the rail fee', async () => {
    const batch = await seedBatch({
      status: 'settled',
      stripeChargeId: 'ch_clean',
      fundedAt: new Date(),
    });
    await seedAllocation(batch.id);
    const { stripe } = mockStripe();

    const report = await runFundingReconciliation(db, { stripe });

    expect(report.missedRefunds).toHaveLength(0);
    const after = await reload(batch.id);
    expect(after.status).toBe('settled');
    expect(Number(after.actualStripeFeeMinor)).toBe(25);
  });

  it('a reversed transfer with no webhook is recorded and the payout derived', async () => {
    const batch = await seedBatch({ status: 'settled', stripeChargeId: 'ch_x', fundedAt: new Date() });
    const { commissionId, partnerId } = await seedCommission();
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: TENANT,
      partnerId,
      amount: '80.00',
      currency: 'USD',
      method: 'stripe_connect',
      status: 'paid',
      stripeTransferId: 'tr_reversed',
      metadata: {},
    });
    await db(TABLES.Commission).where({ id: commissionId }).update({ status: 'paid', payoutId });
    const intentId = ulid();
    await db(TABLES.HostedFundingTransfer).insert({
      id: intentId,
      tenantId: TENANT,
      batchId: batch.id,
      partnerId,
      currency: 'usd',
      amountMinor: 8000,
      destinationAccountId: 'acct_x',
      idempotencyKey: `fbt:${intentId}`,
      state: 'confirmed',
      stripeTransferId: 'tr_reversed',
      payoutId,
    });
    const { stripe } = mockStripe({
      transfer: {
        reversed: true,
        amount_reversed: 8000,
        reversals: {
          data: [
            { id: 'trr_1', amount: 8000, created: Math.floor(Date.now() / 1000), balance_transaction: null },
          ],
        },
      },
    });

    const report = await runFundingReconciliation(db, { stripe });

    expect(report.missedReversals).toContain(intentId);
    const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
    expect(payout.status).toBe('reversed');
    const reversal = await db(TABLES.PayoutReversal).where({ payoutId }).first();
    expect(reversal.stripeReversalId).toBe('trr_1');
    // Paid commissions stay paid; the clawback is a compensating entry.
    const commission = await db(TABLES.Commission).where({ id: commissionId }).first();
    expect(commission.status).toBe('paid');
    const adjustment = await db(TABLES.CommissionAdjustment).where({ commissionId }).first();
    expect(adjustment.reason).toBe('transfer_reversed');
  });

  it('a payout already recorded reversed is not re-swept', async () => {
    const batch = await seedBatch({ status: 'settled', stripeChargeId: 'ch_y', fundedAt: new Date() });
    const { partnerId } = await seedCommission();
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: TENANT,
      partnerId,
      amount: '80.00',
      currency: 'USD',
      method: 'stripe_connect',
      status: 'reversed',
      stripeTransferId: 'tr_known',
      metadata: {},
    });
    const intentId = ulid();
    await db(TABLES.HostedFundingTransfer).insert({
      id: intentId,
      tenantId: TENANT,
      batchId: batch.id,
      partnerId,
      currency: 'usd',
      amountMinor: 8000,
      destinationAccountId: 'acct_x',
      idempotencyKey: `fbt:${intentId}`,
      state: 'confirmed',
      stripeTransferId: 'tr_known',
      payoutId,
    });
    const { stripe, transferRetrieve } = mockStripe();

    const report = await runFundingReconciliation(db, { stripe });

    expect(transferRetrieve).not.toHaveBeenCalled();
    expect(report.missedReversals).toHaveLength(0);
  });
});
