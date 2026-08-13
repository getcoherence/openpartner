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
import { releaseBatch, forceReleaseBatch } from '../funding/release.js';
import { claimInboxEvent, releaseInboxClaim, stampInboxOutcome } from '../funding/inbox.js';
import { handleFundingEvent, InboxEventHeldError } from '../funding/webhook.js';
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
    const claim = await claimInboxEvent(db, id, 'payment_intent.succeeded');
    expect(claim.status).toBe('claimed');
    await stampInboxOutcome(db, id, 'confirm:funded');
    expect((await claimInboxEvent(db, id, 'payment_intent.succeeded')).status).toBe('done');
    // Not even after any amount of time — outcome is terminal.
    await db(TABLES.StripeWebhookInbox)
      .where({ stripeEventId: id })
      .update({ processedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });
    expect((await claimInboxEvent(db, id, 'payment_intent.succeeded')).status).toBe('done');
  });

  it('a live claim reports HELD, not done — the difference decides the HTTP status', async () => {
    // 'held' must never be acknowledged to Stripe: the holder may die, and
    // then the redelivery we refused was the only thing that would have
    // processed the event.
    const id = evt();
    expect((await claimInboxEvent(db, id, 'charge.refunded')).status).toBe('claimed');
    expect((await claimInboxEvent(db, id, 'charge.refunded')).status).toBe('held');
  });

  it('a claim whose worker died is taken over by the redelivery', async () => {
    const id = evt();
    expect((await claimInboxEvent(db, id, 'payment_intent.succeeded')).status).toBe('claimed');
    // …worker crashes here: no outcome was ever stamped.
    await db(TABLES.StripeWebhookInbox)
      .where({ stripeEventId: id })
      .update({ processedAt: new Date(Date.now() - 10 * 60 * 1000) });

    // Before this fix the row said "seen" and every redelivery no-opped
    // forever — the transition it carried was lost.
    expect((await claimInboxEvent(db, id, 'payment_intent.succeeded')).status).toBe('claimed');
    const row = await db(TABLES.StripeWebhookInbox).where({ stripeEventId: id }).first();
    expect(row.outcome).toBeNull();
  });

  it('a worker whose lease was taken over cannot stamp or delete the new owner claim', async () => {
    const id = evt();
    const first = await claimInboxEvent(db, id, 'payment_intent.succeeded');
    expect(first.status).toBe('claimed');
    const staleToken = first.status === 'claimed' ? first.token : '';

    // Lease expires; a redelivery takes over.
    await db(TABLES.StripeWebhookInbox)
      .where({ stripeEventId: id })
      .update({ processedAt: new Date(Date.now() - 10 * 60 * 1000) });
    const second = await claimInboxEvent(db, id, 'payment_intent.succeeded');
    expect(second.status).toBe('claimed');

    // The resurrected predecessor must not be able to finish, or delete,
    // work it no longer owns.
    expect(await stampInboxOutcome(db, id, 'stale_outcome', staleToken)).toBe(false);
    await releaseInboxClaim(db, id, staleToken);
    const row = await db(TABLES.StripeWebhookInbox).where({ stripeEventId: id }).first();
    expect(row).toBeDefined();
    expect(row.outcome).toBeNull();

    // The real owner still can.
    const token = second.status === 'claimed' ? second.token : '';
    expect(await stampInboxOutcome(db, id, 'confirm:funded', token)).toBe(true);
  });

  it('releasing a claim lets the redelivery through immediately', async () => {
    const id = evt();
    const claim = await claimInboxEvent(db, id, 'charge.dispute.created');
    expect(claim.status).toBe('claimed');
    await releaseInboxClaim(db, id, claim.status === 'claimed' ? claim.token : undefined);
    expect((await claimInboxEvent(db, id, 'charge.dispute.created')).status).toBe('claimed');
  });

  it('a held event is refused, not acknowledged', async () => {
    const batch = await seedBatch({ status: 'payment_processing' });
    const event = {
      id: evt(),
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_held', metadata: { openpartner_funding_batch_id: batch.id } } },
    } as unknown as Stripe.Event;
    // Someone else is already mid-handler on it.
    expect((await claimInboxEvent(db, event.id, event.type)).status).toBe('claimed');

    await expect(handleFundingEvent(db, mockStripe().stripe, event)).rejects.toBeInstanceOf(
      InboxEventHeldError,
    );
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

// ---- Adversarial-review fixes (Codex, 2026-08-09) --------------------------

describe.skipIf(skipIntegration)('review follow-ups', () => {
  it('a partially-reversed payout is still swept — the completing reversal is not missed', async () => {
    // Skipping `partially_reversed` meant that once a partial landed, a
    // lost webhook completing the reversal was invisible forever.
    const batch = await seedBatch({ status: 'settled', stripeChargeId: 'ch_p', fundedAt: new Date() });
    const { commissionId, partnerId } = await seedCommission();
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: TENANT,
      partnerId,
      amount: '80.00',
      currency: 'USD',
      method: 'stripe_connect',
      status: 'partially_reversed',
      stripeTransferId: 'tr_partial',
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
      stripeTransferId: 'tr_partial',
      payoutId,
    });
    const { stripe } = mockStripe({
      transfer: {
        reversed: true,
        amount_reversed: 8000,
        reversals: {
          data: [
            { id: 'trr_a', amount: 3000, created: Math.floor(Date.now() / 1000), balance_transaction: null },
            { id: 'trr_b', amount: 5000, created: Math.floor(Date.now() / 1000), balance_transaction: null },
          ],
        },
      },
    });

    const report = await runFundingReconciliation(db, { stripe });

    expect(report.missedReversals).toContain(intentId);
    expect((await db(TABLES.Payout).where({ id: payoutId }).first()).status).toBe('reversed');
  });

  it('reports what the per-run cap left unchecked instead of looking clean', async () => {
    const batches: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const b = await seedBatch({ status: 'settled', stripeChargeId: `ch_${i}`, fundedAt: new Date() });
      batches.push(b.id);
    }
    const { stripe } = mockStripe();

    const report = await runFundingReconciliation(db, { stripe, sweepLimit: 2 });

    expect(report.sweepSkipped.length).toBeGreaterThan(0);
    for (const id of report.sweepSkipped) expect(batches).toContain(id);
  });

  it('a release that could not finish is resumed by the next collector tick', async () => {
    // release_requested used to be terminal by accident: no collector
    // state matched it and a second releaseBatch call just lost the CAS.
    const batch = await seedBatch({ status: 'invoicing' });
    const allocationId = await seedAllocation(batch.id);
    const failing = mockStripe({ searchThrows: new Error('stripe down') });
    expect(await releaseBatch(db, failing.stripe, batch, 'funding_timeout')).toBe('pi_not_terminal');
    expect((await reload(batch.id)).status).toBe('release_requested');

    // Stripe is reachable again, but its search index has not caught up.
    // Round 6: an EMPTY result is not proof of absence — paymentIntents.search
    // is eventually consistent — so the batch must stay held with its
    // allocations reserved rather than being freed on "I didn't see one".
    const stillEmpty = mockStripe({ searchResult: [] });
    await runFundingCollector(db, { stripe: stillEmpty.stripe });
    expect((await reload(batch.id)).status).toBe('release_requested');
    expect((await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first()).state).toBe(
      'reserved',
    );

    // Once indexing catches up the PI is found and terminalized, and only
    // THEN are the allocations freed. The batch was resumable throughout —
    // which is the property this test was originally written for.
    const found = mockStripe({
      searchResult: [{ id: 'pi_late_indexed', status: 'processing' as PiStatus, metadata: {} }],
      retrieveStatus: 'canceled',
    });
    const result = await runFundingCollector(db, { stripe: found.stripe });

    expect(result.released).toContain(batch.id);
    expect((await reload(batch.id)).status).toBe('released');
    expect((await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first()).state).toBe(
      'released',
    );
  });

  it('a still-RESERVED batch releases without asking Stripe at all', async () => {
    // The local fact that replaces the unreliable search: the collector's
    // only path to paymentIntents.create is inside the `invoicing` branch,
    // which it enters by winning casBatch(reserved → invoicing). So if OUR
    // CAS moved the batch out of `reserved`, no PI can exist — no search,
    // no eventual-consistency exposure, and no reason to hold.
    const batch = await seedBatch({ status: 'reserved' });
    const allocationId = await seedAllocation(batch.id);
    const { stripe, search } = mockStripe({ searchThrows: new Error('must not be called') });

    expect(await releaseBatch(db, stripe, batch, 'funding_timeout')).toBe('released');
    expect(search).not.toHaveBeenCalled();
    expect((await reload(batch.id)).status).toBe('released');
    expect((await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first()).state).toBe(
      'released',
    );
  });

  it('a stuck release_requested batch is alerted after a day', async () => {
    const batch = await seedBatch({
      status: 'release_requested',
      updatedAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
    });
    await seedAllocation(batch.id);
    const { stripe } = mockStripe();

    const report = await runFundingReconciliation(db, { stripe });
    expect(report.attentionBatches).toContain(batch.id);
  });

  it('payment-wins goes through verified confirm, so the charge id is stamped', async () => {
    // A bare CAS to `funded` left stripeChargeId null and the executor
    // froze the batch as recovery_required on the next tick.
    const batch = await seedBatch({ status: 'payment_processing', stripePaymentIntentId: 'pi_won2' });
    await seedAllocation(batch.id);
    const { stripe } = mockStripe({ retrieveStatus: 'succeeded' });

    expect(await releaseBatch(db, stripe, batch, 'funding_timeout')).toBe('payment_won');

    const after = await reload(batch.id);
    expect(after.status).toBe('funded');
    expect(after.stripeChargeId).toBe('ch_pi_won2');
    expect(after.fundedAt).not.toBeNull();
  });

  it('the executor stops mid-batch when the batch is frozen under it', async () => {
    const batch = await seedBatch({
      status: 'transferring',
      stripeChargeId: 'ch_freeze',
      fundedAt: new Date(),
    });
    await seedAllocation(batch.id);
    await db(TABLES.HostedFundingBatch).where({ id: batch.id }).update({ status: 'funding_disputed' });

    const transfersCreate = vi.fn();
    const stripe = { transfers: { create: transfersCreate, list: vi.fn() } } as unknown as Stripe;
    const { runTransferExecutor } = await import('../funding/executor.js');
    await runTransferExecutor(db, { stripe });

    expect(transfersCreate).not.toHaveBeenCalled();
  });
});

// ---- Round-2 review fixes (Codex, 2026-08-09) ------------------------------

describe.skipIf(skipIntegration)('round-2 hardening', () => {
  it('reclaims allocations even when the batch cannot be frozen', async () => {
    // The blocker: the status escalation ran BEFORE the reclaim, and
    // moving a released batch back to a non-terminal status raises on the
    // one-open-batch unique index whenever a newer batch exists. The throw
    // skipped the reclaim entirely — leaving a live debit AND freed
    // commissions, i.e. the double-charge this path exists to prevent.
    await seedAuthorization();
    const batch = await seedBatch({ status: 'reserved' });
    const allocationId = await seedAllocation(batch.id);
    const { stripe, cancel } = mockStripe({
      duringCreate: async () => {
        // Release frees the allocations and closes the batch…
        await db(TABLES.HostedFundingAllocation)
          .where({ batchId: batch.id })
          .update({ state: 'released' });
        await db(TABLES.HostedFundingBatch)
          .where({ id: batch.id })
          .update({ status: 'released', releasedAt: new Date() });
        // …and a NEWER batch for the same tenant/currency opens.
        await seedBatch({ status: 'reserved' });
      },
      cancelThrows: new Error('PaymentIntent is processing and cannot be canceled'),
    });

    await runFundingCollector(db, { stripe });

    expect(cancel).toHaveBeenCalledOnce();
    // The allocation is back under the batch that has the live debit.
    const allocation = await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first();
    expect(allocation.state).toBe('reserved');
    // And the PI is recorded so an operator can find the money.
    expect((await reload(batch.id)).stripePaymentIntentId).toMatch(/^pi_/);
  });

  it('a refund on an already-settled batch is recorded, not forced into the open-batch index', async () => {
    const settled = await seedBatch({
      status: 'settled',
      stripeChargeId: 'ch_settled',
      fundedAt: new Date(),
      settledAt: new Date(),
    });
    // A newer batch is open for the same tenant/currency.
    await seedBatch({ status: 'reserved' });

    const { recordFundingChargeClawback } = await import('../funding/webhook.js');
    const outcome = await recordFundingChargeClawback(db, settled.id, 'charge.refunded');

    expect(outcome).toMatch(/^clawback_on_settled:/);
    const after = await reload(settled.id);
    expect(after.status).toBe('settled'); // not dragged back into the index
    expect(after.failureReason).toBe('charge.refunded');
  });

  it('a non-terminal batch is still frozen by the same path', async () => {
    const batch = await seedBatch({ status: 'funded', stripeChargeId: 'ch_f', fundedAt: new Date() });
    const { recordFundingChargeClawback } = await import('../funding/webhook.js');

    expect(await recordFundingChargeClawback(db, batch.id, 'charge.dispute.created')).toBe(
      'funding_disputed',
    );
    expect((await reload(batch.id)).status).toBe('funding_disputed');
  });

  it('the sweep covers every row even as rows keep arriving', async () => {
    // The window version only held for a FROZEN list: adding rows changed
    // `windows`, shifted the modular sequence, and left specific indices
    // never selected. Per-object scheduling is immune to churn: every
    // eligible row holds its own place in the least-recently-visited
    // order, so arrivals compete on age instead of reshuffling the deck.
    //
    // Asserting only the ORIGINAL rows was too weak — the window version
    // happened to cover those on many days. EVERY row that exists long
    // enough to be swept must actually be swept.
    const seen = new Set<string>();
    const all: string[] = [];
    const addBatch = async (tag: string) => {
      const b = await seedBatch({ status: 'settled', stripeChargeId: `ch_${tag}`, fundedAt: new Date() });
      await seedAllocation(b.id);
      all.push(b.id);
    };
    for (let i = 0; i < 4; i += 1) await addBatch(`c${i}`);

    for (let run = 0; run < 10; run += 1) {
      const { stripe, chargeRetrieve } = mockStripe();
      await runFundingReconciliation(db, { stripe, sweepLimit: 2 });
      for (const call of chargeRetrieve.mock.calls) {
        const row = await db(TABLES.HostedFundingBatch)
          .where({ stripeChargeId: call[0] as string })
          .first();
        if (row) seen.add(row.id);
      }
      // …and the set keeps growing between runs, as it does in production.
      if (run < 5) await addBatch(`x${run}`);
    }

    // 9 rows, all present by run 5; 10 runs of 2 covers every one.
    for (const id of all) expect(seen.has(id), `never swept: ${id}`).toBe(true);
  });

  it('a full pass covers every row within ceil(total/limit) runs', async () => {
    // The first version of this was a per-day hash shuffle, which re-deals
    // independently each day: at scale an individual row had a large
    // chance of never being checked at all. Asserting "two days differ"
    // passed for that too. This asserts the property that actually
    // matters — complete coverage — by running the whole cycle.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const b = await seedBatch({ status: 'settled', stripeChargeId: `ch_r${i}`, fundedAt: new Date() });
      await seedAllocation(b.id);
      ids.push(b.id);
    }
    const limit = 2;
    const runs = Math.ceil(ids.length / limit); // 3 runs to see all 5

    const everChecked = new Set<string>();
    for (let run = 0; run < runs; run += 1) {
      const { stripe, chargeRetrieve } = mockStripe();
      await runFundingReconciliation(db, { stripe, sweepLimit: limit });
      for (const call of chargeRetrieve.mock.calls) {
        const chargeId = call[0] as string;
        const batch = await db(TABLES.HostedFundingBatch).where({ stripeChargeId: chargeId }).first();
        if (batch) everChecked.add(batch.id);
      }
    }

    expect([...everChecked].sort()).toEqual([...ids].sort());
  });

  it('consecutive runs ADVANCE instead of re-checking the same head', async () => {
    // The property a cursor gives that a fixed prefix never did. (The
    // previous assertion here — "the same day picks the same slice" —
    // was a property of the window design, and it also passed under the
    // hash shuffle it was meant to replace.)
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const b = await seedBatch({ status: 'settled', stripeChargeId: `ch_s${i}`, fundedAt: new Date() });
      await seedAllocation(b.id);
      ids.push(b.id);
    }

    const checkedIn = async () => {
      const { stripe, chargeRetrieve } = mockStripe();
      await runFundingReconciliation(db, { stripe, sweepLimit: 2 });
      return chargeRetrieve.mock.calls.map((c) => c[0] as string).sort();
    };

    const first = await checkedIn();
    const second = await checkedIn();
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(second).not.toEqual(first);
  });

  it('resuming a release does not reset the clock that detects a stuck one', async () => {
    // casBatch bumps updatedAt, and reconcile decides "stuck" from
    // updatedAt — so a release retrying every tick used to refresh its own
    // alert forever.
    const batch = await seedBatch({ status: 'invoicing' });
    await seedAllocation(batch.id);
    const failing = mockStripe({ searchThrows: new Error('stripe down') });
    await releaseBatch(db, failing.stripe, batch, 'funding_timeout');
    await db(TABLES.HostedFundingBatch)
      .where({ id: batch.id })
      .update({ updatedAt: new Date(Date.now() - 30 * 60 * 60 * 1000) });

    // The collector resumes it and fails again…
    await runFundingCollector(db, { stripe: failing.stripe });

    // …and reconcile still sees it as stuck.
    const report = await runFundingReconciliation(db, { stripe: mockStripe().stripe });
    expect(report.attentionBatches).toContain(batch.id);
  });
});

// ---- Round-3 review fixes (Codex, 2026-08-10) ------------------------------

describe.skipIf(skipIntegration)('round-3 hardening', () => {
  it('an out-of-order clawback freezes a batch that is only release_requested', async () => {
    // confirm.ts allows release_requested → funded, so a refund that
    // arrived while the batch sat there used to be acked without effect —
    // and the batch could then fund and pay out normally.
    const batch = await seedBatch({ status: 'release_requested' });
    await seedAllocation(batch.id);
    const { recordFundingChargeClawback } = await import('../funding/webhook.js');

    expect(await recordFundingChargeClawback(db, batch.id, 'charge.refunded')).toBe('funding_disputed');
    expect((await reload(batch.id)).status).toBe('funding_disputed');
  });

  it('a truncated reversal list never derives payout state', async () => {
    const batch = await seedBatch({ status: 'settled', stripeChargeId: 'ch_t', fundedAt: new Date() });
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
      stripeTransferId: 'tr_trunc',
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
      stripeTransferId: 'tr_trunc',
      payoutId,
    });

    // Every page still says there's more — the ledger can't be completed.
    const listReversals = vi.fn(async () => ({
      data: [{ id: `trr_${Math.random()}`, amount: 1, created: 0, balance_transaction: null }],
      has_more: true,
    }));
    const stripe = {
      transfers: { listReversals },
      paymentIntents: { search: vi.fn(), retrieve: vi.fn() },
    } as unknown as Stripe;
    const { handleTransferReversed } = await import('../funding/webhook.js');

    const outcome = await handleTransferReversed(
      db,
      stripe,
      {
        id: 'tr_trunc',
        reversed: true,
        amount_reversed: 8000,
        reversals: { data: [{ id: 'trr_0', amount: 1, created: 0 }], has_more: true },
      } as unknown as Stripe.Transfer,
      intentId,
    );

    expect(outcome).toMatch(/^reversal_list_truncated:/);
    // No terminal state derived from an incomplete ledger…
    expect((await db(TABLES.Payout).where({ id: payoutId }).first()).status).toBe('paid');
    // …but the reversals we DID read are recorded. Discarding them threw
    // away a valid audit trail and re-fetched the same prefix forever.
    expect(await db(TABLES.PayoutReversal).where({ payoutId }).first()).toBeDefined();
  });

  it('a live allocation under a terminal batch is alerted, not silently stranded', async () => {
    const batch = await seedBatch({ status: 'released', releasedAt: new Date() });
    await seedAllocation(batch.id); // stays 'reserved'
    const { stripe } = mockStripe();

    const report = await runFundingReconciliation(db, { stripe });

    expect(report.attentionBatches).toContain(batch.id);
  });

  it('a batch frozen DURING the run stops before the NEXT partner', async () => {
    // Two earlier versions of this test were vacuous: they froze the
    // batch BEFORE calling the executor, so the scan never selected it
    // and the test passed with the gate deleted. There was also no
    // synchronization point — just a racing update with nothing to hook.
    //
    // Two partners give a real barrier: freeze from INSIDE the first
    // transfer, then assert the second one never happens. That is exactly
    // the production interleaving (a dispute webhook landing mid-batch).
    const batch = await seedBatch({
      status: 'transferring',
      stripeChargeId: 'ch_gate',
      fundedAt: new Date(),
      // Two allocations, so the principal has to cover both or the
      // executor's ledger invariant freezes the batch before any transfer.
      principalMinor: '16000',
      grossChargeMinor: '16000',
    });
    await seedAllocation(batch.id);
    await seedAllocation(batch.id); // a second partner in the same batch

    const transfersCreate = vi.fn(async (params: { amount: number }) => {
      await db(TABLES.HostedFundingBatch)
        .where({ id: batch.id })
        .update({ status: 'funding_disputed' });
      return { id: `tr_${params.amount}`, amount: params.amount, currency: 'usd', metadata: {} };
    });
    const stripe = { transfers: { create: transfersCreate, list: vi.fn() } } as unknown as Stripe;
    const { runTransferExecutor } = await import('../funding/executor.js');

    await runTransferExecutor(db, { stripe });

    // Exactly one partner was paid; the freeze stopped everything after.
    expect(transfersCreate).toHaveBeenCalledTimes(1);
  });
});

// ---- Round-6 review fixes (Codex, 2026-08-12) ------------------------------

describe.skipIf(skipIntegration)('round-6 hardening', () => {
  async function seedPayoutWithIntent(amount = '80.00') {
    const { partnerId } = await seedCommission();
    const batch = await seedBatch({ status: 'settled' });
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: TENANT,
      partnerId,
      amount,
      currency: 'USD',
      status: 'paid',
      method: 'stripe_connect',
      stripeTransferId: 'tr_r6',
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
      stripeTransferId: 'tr_r6',
      payoutId,
    });
    return { payoutId, intentId, partnerId };
  }

  it('a reversal arriving before finalization is RETRIED, never acknowledged', async () => {
    // The intent is committed before the Stripe call but its Payout is only
    // linked at finalization. A reversal landing in that gap used to return
    // 'transfer_intent_unknown', which was stamped terminal in the inbox and
    // answered 2xx — so Stripe stopped redelivering and the only notice that
    // the money came back was thrown away.
    //
    // Revert the throw and this test sees a terminal inbox outcome.
    const { partnerId } = await seedCommission();
    const batch = await seedBatch({ status: 'settled' });
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
      state: 'posted',
      stripeTransferId: 'tr_unlinked',
      payoutId: null, // not finalized yet
    });

    const { stripe } = mockStripe();
    const event = {
      id: `evt_${ulid()}`,
      type: 'transfer.reversed',
      data: {
        object: {
          id: 'tr_unlinked',
          object: 'transfer',
          amount: 8000,
          currency: 'usd',
          reversed: true,
          metadata: { openpartner_transfer_intent_id: intentId },
        },
      },
    } as unknown as Stripe.Event;

    await expect(handleFundingEvent(db, stripe, event)).rejects.toThrow(/no payout yet/);

    // Crucially: no terminal outcome, and the claim was dropped so the
    // redelivery is processed immediately rather than waiting out the lease.
    const inboxRow = await db(TABLES.StripeWebhookInbox).where({ stripeEventId: event.id }).first();
    expect(inboxRow?.outcome ?? null).toBeNull();
  });

  it('reversal status derivation takes the payout row lock', async () => {
    // Two reversal events for one payout are leased independently, so their
    // handlers run concurrently. Summing and writing without the payout row
    // locked let them interleave and REGRESS 'reversed' back to
    // 'partially_reversed' — and 'reversed' is what gates the clawback
    // adjustments.
    //
    // Proven directly: hold FOR UPDATE on the payout in a competing
    // transaction and the handler must block until it is released.
    const { payoutId, intentId } = await seedPayoutWithIntent('80.00');
    await db(TABLES.PayoutReversal).insert({
      id: ulid(),
      tenantId: TENANT,
      payoutId,
      stripeReversalId: 'trr_first',
      amountMinor: 3000, // partial — 30 of 80
      reason: null,
      balanceTransactionId: null,
      createdAt: new Date(),
    });

    const { stripe } = mockStripe();
    const event = {
      id: `evt_${ulid()}`,
      type: 'transfer.reversed',
      data: {
        object: {
          id: 'tr_r6',
          object: 'transfer',
          amount: 8000,
          currency: 'usd',
          reversed: true,
          metadata: { openpartner_transfer_intent_id: intentId },
        },
      },
    } as unknown as Stripe.Event;

    // A weaker version of this test passed with the lock removed, because
    // the handler still blocks eventually — at its UPDATE. Blocking is not
    // the property; SUMMING AFTER ACQUIRING is. So the blocker changes the
    // ledger while it holds the lock:
    //
    //   with the lock    → handler sums after commit, sees 30+50=80 → reversed
    //   without the lock → handler already summed 30 → partially_reversed
    //
    // which is exactly the regression seen in production terms.
    const blocker = await db.transaction();
    await blocker(TABLES.Payout).where({ id: payoutId }).forUpdate().first();

    let settled = false;
    const inFlight = handleFundingEvent(db, stripe, event).then((r) => {
      settled = true;
      return r;
    });
    // Room to either block on the lock (fixed) or race past the sum (broken).
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);

    // The completing reversal lands while the lock is held.
    await blocker(TABLES.PayoutReversal).insert({
      id: ulid(),
      tenantId: TENANT,
      payoutId,
      stripeReversalId: 'trr_completing',
      amountMinor: 5000,
      reason: null,
      balanceTransactionId: null,
      createdAt: new Date(),
    });
    await blocker.commit();
    await inFlight;
    expect(settled).toBe(true);

    const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
    expect(payout!.status).toBe('reversed');
  });
});

describe.skipIf(skipIntegration)('round-6: sweep coverage', () => {
  /** A funded batch the charge sweep will pick up. */
  async function seedSweepable(fundedAt: Date, chargeId: string) {
    return seedBatch({
      // 'settled' is terminal, so several can coexist — the one-open-batch
      // index forbids multiple 'funded' rows per tenant+currency — and it is
      // still inside the charge sweep's eligible set.
      status: 'settled',
      stripeChargeId: chargeId,
      fundedAt,
      actualStripeFeeMinor: '25', // already backfilled — keeps the sweep read-only
    });
  }

  it('an item whose Stripe read FAILED is retried, not passed over', async () => {
    // The cursor used to advance unconditionally once the loop finished,
    // even though per-item errors are caught and logged inside it. A failed
    // row was skipped AND acknowledged, and on the charge side could age
    // out of the 180-day horizon before the cursor wrapped back to it.
    //
    // Under per-object scheduling a failed row keeps its place in the
    // rotation forever — it can be re-read a rotation late, but it can
    // never be dropped or age out unseen.
    const now = Date.now();
    const a = await seedSweepable(new Date(now - 3 * 86400000), 'ch_fails');
    const b = await seedSweepable(new Date(now - 2 * 86400000), 'ch_ok');

    let failFor: string | null = 'ch_fails';
    const stripe = {
      charges: {
        retrieve: vi.fn(async (id: string) => {
          if (id === failFor) throw new Error('stripe read failed');
          return { id, refunded: false, amount_refunded: 0, disputed: false, balance_transaction: { fee: 25 } };
        }),
      },
      transfers: { retrieve: vi.fn() },
      paymentIntents: { retrieve: vi.fn(), search: vi.fn(async () => ({ data: [] })), cancel: vi.fn() },
    } as unknown as Stripe;

    await runFundingReconciliation(db, { stripe, sweepLimit: 2 });

    // Stripe recovers. The NEXT run must come back to the failed batch even
    // though the cursor moved past it.
    failFor = null;
    const seen: string[] = [];
    const recovering = {
      charges: {
        retrieve: vi.fn(async (id: string) => {
          seen.push(id);
          return { id, refunded: false, amount_refunded: 0, disputed: false, balance_transaction: { fee: 25 } };
        }),
      },
      transfers: { retrieve: vi.fn() },
      paymentIntents: { retrieve: vi.fn(), search: vi.fn(async () => ({ data: [] })), cancel: vi.fn() },
    } as unknown as Stripe;
    await runFundingReconciliation(db, { stripe: recovering, sweepLimit: 2 });

    expect(seen).toContain('ch_fails');
    expect([a.id, b.id]).toHaveLength(2); // (ids used only for clarity)
  });

  it('a row that becomes eligible BEHIND the cursor is still swept, under churn', async () => {
    // Ids are assigned at CREATION but rows join this sweep when they FUND.
    // Under id ordering a batch that funds after the cursor has passed its
    // id position is only reachable on a wrap — and if a full slice of
    // newer eligible rows keeps arriving, the cursor never wraps and the
    // row is starved forever. On the charge side it then ages out of the
    // 180-day horizon and its clawback is lost.
    //
    // The churn is the point: an earlier version of this test seeded three
    // rows and passed under BOTH orderings, because with nothing arriving
    // the cursor wraps and covers everything either way.
    const seen: string[] = [];
    const mk = () =>
      ({
        charges: {
          retrieve: vi.fn(async (id: string) => {
            seen.push(id);
            return { id, refunded: false, amount_refunded: 0, disputed: false, balance_transaction: { fee: 25 } };
          }),
        },
        transfers: { retrieve: vi.fn() },
        paymentIntents: { retrieve: vi.fn(), search: vi.fn(async () => ({ data: [] })), cancel: vi.fn() },
      }) as unknown as Stripe;

    const t0 = Date.now() - 30 * 86400000;
    // Created FIRST, so it holds the lowest id — but not funded yet, so it
    // is not eligible and the cursor will walk straight past its position.
    const lateFunder = await seedBatch({
      status: 'reserved',
      stripeChargeId: null,
      fundedAt: null,
    });
    // Enough ahead of it that the cursor cannot reach the end and wrap
    // (a wrap would reset to the top and pick the low id up by accident).
    for (let i = 0; i < 6; i += 1) {
      await seedSweepable(new Date(t0 + i * 1000), `ch_seed_${i}`);
    }

    // Three runs: the cursor advances well past where lateFunder's id sits.
    await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 1 });
    await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 1 });
    await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 1 });

    // NOW it funds: LATER than everything already swept (that is what
    // "funds late" means) but still the oldest id in the table.
    await db(TABLES.HostedFundingBatch).where({ id: lateFunder.id }).update({
      status: 'settled',
      stripeChargeId: 'ch_late_funder',
      fundedAt: new Date(t0 + 6000),
      actualStripeFeeMinor: 25,
    });

    // Churn: a newer eligible row arrives before every run, so the cursor
    // never reaches the end and never wraps.
    for (let i = 0; i < 6; i += 1) {
      await seedSweepable(new Date(t0 + 10000 + i * 1000), `ch_churn_${i}`);
      await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 1 });
    }

    // Ordering by eligibility time puts it ahead of the cursor, so it gets
    // its turn. Ordering by id leaves it behind, and it is never read.
    expect(seen).toContain('ch_late_funder');
  });
});

describe.skipIf(skipIntegration)('round-6: operator disposition for a stuck release', () => {
  it('frees a batch stuck in release_requested with no PI', async () => {
    // The counterpart to "empty search is not proof": a batch whose PI
    // genuinely never existed now has no automatic way out, so there has to
    // be a manual one. A hold with no release is a leak.
    const batch = await seedBatch({ status: 'invoicing' });
    const allocationId = await seedAllocation(batch.id);
    const failing = mockStripe({ searchResult: [] });
    expect(await releaseBatch(db, failing.stripe, batch, 'funding_timeout')).toBe('pi_not_terminal');
    expect((await reload(batch.id)).status).toBe('release_requested');

    expect(await forceReleaseBatch(db, batch.id, 'keith', 'confirmed_no_pi')).toBe('released');
    expect((await reload(batch.id)).status).toBe('released');
    expect((await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first()).state).toBe(
      'released',
    );
  });

  it('REFUSES to force a batch that has a stamped PaymentIntent', async () => {
    // Forcing past a live intent is precisely the double-charge the whole
    // protocol prevents. That case is not stuck — it is the ordinary release
    // path — so the operator tool must not touch it.
    const batch = await seedBatch({
      status: 'release_requested',
      stripePaymentIntentId: 'pi_live_and_dangerous',
    });
    const allocationId = await seedAllocation(batch.id);

    expect(await forceReleaseBatch(db, batch.id, 'keith', 'oops')).toBe('has_payment_intent');
    expect((await reload(batch.id)).status).toBe('release_requested');
    expect((await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first()).state).toBe(
      'reserved',
    );
  });

  it('does nothing to a batch that is not stuck', async () => {
    const batch = await seedBatch({ status: 'reserved' });
    expect(await forceReleaseBatch(db, batch.id, 'keith', 'wrong_state')).toBe('not_stuck');
    expect((await reload(batch.id)).status).toBe('reserved');
  });
});

// ---- Round-7 review fixes (Codex, 2026-08-12) ------------------------------

describe.skipIf(skipIntegration)('round-7 hardening', () => {
  it('the fast path is gated on the state the CAS WON, not the caller snapshot', async () => {
    // releaseBatch accepts four source states but the no-search fast path is
    // only sound for `reserved`. Deciding from the caller's stale
    // batch.status meant a row that moved reserved → invoicing between the
    // caller's SELECT and the CAS still skipped the search — freeing the
    // allocations while a PaymentIntent was being created for it.
    const batch = await seedBatch({ status: 'reserved' });
    const allocationId = await seedAllocation(batch.id);

    // The row moves on underneath us; the caller still holds `reserved`.
    await db(TABLES.HostedFundingBatch).where({ id: batch.id }).update({ status: 'invoicing' });

    const { stripe, search } = mockStripe({ searchResult: [] });
    const outcome = await releaseBatch(db, stripe, batch, 'funding_timeout');

    // It must NOT take the fast path: it has to ask Stripe, and an empty
    // answer is not proof, so it holds.
    expect(search).toHaveBeenCalled();
    expect(outcome).toBe('pi_not_terminal');
    expect((await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first()).state).toBe(
      'reserved',
    );
  });

  it('forceReleaseBatch does not free allocations when it loses its CAS', async () => {
    // It used to free them and only then attempt the closing transition, so
    // losing that CAS to a concurrent release left a batch heading for
    // `funded` with released, re-batchable allocations.
    const batch = await seedBatch({ status: 'release_requested' });
    const allocationId = await seedAllocation(batch.id);

    // The race has to happen BETWEEN the read and the CAS. An earlier
    // version of this test flipped the status up front, so the early guard
    // returned not_stuck before the ordering code ran at all — and it
    // passed with the fix reverted. The seam stages it properly: a
    // concurrent release finds the orphan PI and carries the batch to
    // `funded` while force-release is mid-flight.
    expect(
      await forceReleaseBatch(db, batch.id, 'keith', 'confirmed_no_pi', {
        __afterRead: async () => {
          await db(TABLES.HostedFundingBatch).where({ id: batch.id }).update({ status: 'funded' });
        },
      }),
    ).toBe('not_stuck');
    expect((await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first()).state).toBe(
      'reserved',
    );
    expect((await reload(batch.id)).status).toBe('funded');
  });

  it('a saturated retry set cannot starve the cursor', async () => {
    // Retry work used to take the whole budget, so `limit` persistently
    // failing rows meant the cursor never advanced and nothing else was ever
    // swept — the poison-item starvation the retry set was added to prevent,
    // reintroduced in a new shape. Retries now get at most half.
    const now = Date.now();
    const failing: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const b = await seedBatch({
        status: 'settled',
        stripeChargeId: `ch_bad_${i}`,
        fundedAt: new Date(now - (10 - i) * 86400000),
        actualStripeFeeMinor: '25',
      });
      failing.push(b.id);
    }
    const healthy = await seedBatch({
      status: 'settled',
      stripeChargeId: 'ch_healthy',
      fundedAt: new Date(now - 1000),
      actualStripeFeeMinor: '25',
    });

    const seen: string[] = [];
    const mk = () =>
      ({
        charges: {
          retrieve: vi.fn(async (id: string) => {
            seen.push(id);
            if (id.startsWith('ch_bad_')) throw new Error('persistently unreadable');
            return { id, refunded: false, amount_refunded: 0, disputed: false, balance_transaction: { fee: 25 } };
          }),
        },
        transfers: { retrieve: vi.fn() },
        paymentIntents: { retrieve: vi.fn(), search: vi.fn(async () => ({ data: [] })), cancel: vi.fn() },
      }) as unknown as Stripe;

    // Budget of 2 → at most 1 retry slot, so cursor work always gets one.
    for (let run = 0; run < 4; run += 1) {
      await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 2 });
    }

    expect(seen).toContain('ch_healthy');
    expect(failing.length).toBe(4);
    expect(healthy.id).toBeTruthy();
  });

  it('an intent that confirms LATE is still swept — postedAt is not eligibility', async () => {
    // postedAt is stamped before the Stripe call, so an intent whose
    // response was lost sits `posted` while the cursor walks past it, then
    // confirms much later and lands behind the cursor. Ordering on a key
    // that moves forward at confirmation means a row can only ever be
    // re-visited, never skipped.
    const { partnerId } = await seedCommission();
    const batch = await seedBatch({ status: 'settled' });
    const t0 = new Date(Date.now() - 30 * 86400000);

    const lateIntent = ulid();
    await db(TABLES.HostedFundingTransfer).insert({
      id: lateIntent,
      tenantId: TENANT,
      batchId: batch.id,
      partnerId,
      currency: 'usd',
      amountMinor: 8000,
      destinationAccountId: 'acct_x',
      idempotencyKey: `fbt:${lateIntent}`,
      state: 'posted', // not yet eligible
      stripeTransferId: 'tr_late',
      postedAt: t0,
      payoutId: null,
    });

    // Newer intents that ARE eligible, so the cursor has somewhere to walk.
    // Each needs its own partner: (batchId, partnerId, currency) is unique.
    // updatedAt is set explicitly so the ordering under test is controlled
    // rather than "whatever the insert happened to stamp".
    const mkIntent = async (i: number, updatedAt: Date, state: string, tag: string) => {
      const id = ulid();
      const { partnerId: seedPartnerId } = await seedCommission();
      await db(TABLES.HostedFundingTransfer).insert({
        id,
        tenantId: TENANT,
        batchId: batch.id,
        partnerId: seedPartnerId,
        currency: 'usd',
        amountMinor: 1000,
        destinationAccountId: 'acct_x',
        idempotencyKey: `fbt:${id}`,
        state,
        stripeTransferId: tag,
        postedAt: new Date(t0.getTime() + 1000 + i * 1000),
        payoutId: null,
      });
      await db(TABLES.HostedFundingTransfer).where({ id }).update({ updatedAt });
      return id;
    };
    for (let i = 0; i < 4; i += 1) {
      await mkIntent(i, new Date(t0.getTime() + 1000 + i * 1000), 'confirmed', `tr_seed_${i}`);
    }

    const seen: string[] = [];
    const mk = () =>
      ({
        charges: { retrieve: vi.fn(async (id: string) => ({ id, refunded: false, amount_refunded: 0, disputed: false, balance_transaction: { fee: 25 } })) },
        transfers: {
          retrieve: vi.fn(async (id: string) => {
            seen.push(id);
            return { id, reversed: false, amount_reversed: 0, reversals: { data: [] } };
          }),
        },
        paymentIntents: { retrieve: vi.fn(), search: vi.fn(async () => ({ data: [] })), cancel: vi.fn() },
      }) as unknown as Stripe;

    // Walk the cursor past where this intent's postedAt sits.
    await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 1 });
    await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 1 });
    await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 1 });

    // NOW it confirms — long after its postedAt. updatedAt moves with it, so
    // under the fixed ordering it lands AHEAD of the cursor.
    await db(TABLES.HostedFundingTransfer)
      .where({ id: lateIntent })
      .update({ state: 'confirmed', updatedAt: new Date(t0.getTime() + 6000) });

    // Churn: a newer eligible intent before every run, so the cursor never
    // reaches the end and never wraps. Without this the cursor wraps and
    // picks the low-postedAt row up by accident — which is why an earlier
    // version of this test passed under BOTH orderings.
    for (let i = 0; i < 4; i += 1) {
      await mkIntent(10 + i, new Date(t0.getTime() + 10000 + i * 1000), 'confirmed', `tr_churn_${i}`);
      await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 1 });
    }

    expect(seen).toContain('tr_late');
  });

  it('an unprocessable reversal KEEPS its inbox claim so the stuck alert can see it', async () => {
    // Deleting the claim on every attempt made an intent whose payoutId is
    // never populated invisible: Stripe eventually stops redelivering and
    // there is no row left for the unfinished-claim alert to report.
    const { partnerId } = await seedCommission();
    const batch = await seedBatch({ status: 'settled' });
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
      state: 'posted',
      stripeTransferId: 'tr_orphan',
      payoutId: null,
    });

    const { stripe } = mockStripe();
    const event = {
      id: `evt_${ulid()}`,
      type: 'transfer.reversed',
      data: {
        object: {
          id: 'tr_orphan',
          object: 'transfer',
          amount: 8000,
          currency: 'usd',
          reversed: true,
          metadata: { openpartner_transfer_intent_id: intentId },
        },
      },
    } as unknown as Stripe.Event;

    await expect(handleFundingEvent(db, stripe, event)).rejects.toThrow(/no payout yet/);

    const row = (await db(TABLES.StripeWebhookInbox)
      .where({ stripeEventId: event.id })
      .first()) as { outcome: string | null; processedAt: Date } | undefined;
    expect(row).toBeTruthy(); // the row SURVIVES
    expect(row!.outcome ?? null).toBeNull(); // and is unfinished, so it alerts
  });
});

describe.skipIf(skipIntegration)('round-8 hardening', () => {
  it('forceReleaseBatch loses if a live PI is stamped while it works', async () => {
    // The CAS was on status alone, but a concurrent releaseBatch can find an
    // orphan PI and STAMP it while the row stays `release_requested`. The
    // status-only CAS still won, freed the allocations, and left a batch on
    // its way to `funded` whose commissions were already back in the pool.
    const batch = await seedBatch({ status: 'release_requested' });
    const allocationId = await seedAllocation(batch.id);

    expect(
      await forceReleaseBatch(db, batch.id, 'keith', 'confirmed_no_pi', {
        __afterRead: async () => {
          // The other releaser finds the orphan and stamps it. Status is
          // deliberately unchanged — that is the whole point.
          await db(TABLES.HostedFundingBatch)
            .where({ id: batch.id })
            .update({ stripePaymentIntentId: 'pi_found_by_the_other_worker' });
        },
      }),
    ).toBe('not_stuck');

    expect((await db(TABLES.HostedFundingAllocation).where({ id: allocationId }).first()).state).toBe(
      'reserved',
    );
    expect((await reload(batch.id)).status).toBe('release_requested');
  });

  it('two permanently-failing rows are both eventually re-attempted', async () => {
    // Written against the retry set, where this property rested on a
    // rotation that could not be isolated by test. Under per-object
    // scheduling it is structural — every failed row keeps its own place
    // in the least-recently-visited order — but the assertion stays: no
    // failing row may ever be abandoned, whatever the mechanism.
    const now = Date.now();
    const a = await seedBatch({
      status: 'settled',
      stripeChargeId: 'ch_fail_a',
      fundedAt: new Date(now - 9 * 86400000),
      actualStripeFeeMinor: '25',
    });
    const b = await seedBatch({
      status: 'settled',
      stripeChargeId: 'ch_fail_b',
      fundedAt: new Date(now - 8 * 86400000),
      actualStripeFeeMinor: '25',
    });

    const attempts: string[] = [];
    const mk = () =>
      ({
        charges: {
          retrieve: vi.fn(async (id: string) => {
            attempts.push(id);
            if (id.startsWith('ch_fail_')) throw new Error('always fails');
            return { id, refunded: false, amount_refunded: 0, disputed: false, balance_transaction: { fee: 25 } };
          }),
        },
        transfers: { retrieve: vi.fn() },
        paymentIntents: { retrieve: vi.fn(), search: vi.fn(async () => ({ data: [] })), cancel: vi.fn() },
      }) as unknown as Stripe;

    // First run: the retry set is empty, so the cursor sweeps BOTH and both
    // fail — that is what puts them in the set.
    await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 2 });
    expect(attempts).toContain('ch_fail_a');
    expect(attempts).toContain('ch_fail_b');
    attempts.length = 0;

    // Now churn: a newer eligible row before every run, so the cursor is
    // permanently busy ahead and can never wrap back to a or b. From here
    // the ONLY way either gets looked at again is the retry set — and the
    // only way the SECOND one does is if selection actually rotates.
    // Without the churn the cursor reaches it anyway and this test passes
    // with the rotation reverted, which is exactly what happened first time.
    for (let i = 0; i < 6; i += 1) {
      await seedBatch({
        status: 'settled',
        stripeChargeId: `ch_churn_${i}`,
        fundedAt: new Date(now + i * 1000),
        actualStripeFeeMinor: '25',
      });
      await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 2 });
    }

    expect(attempts).toContain('ch_fail_a');
    expect(attempts).toContain('ch_fail_b');
    expect([a.id, b.id]).toHaveLength(2);
  });

  it('a poison row cannot starve the sweep at limit 1', async () => {
    // At limit 1 the retry set used to take the only slot, so `remaining`
    // was 0 and one permanently-failing row starved every healthy row
    // forever. Round 9 then found the inverse: the fix gave retries a
    // budget of 0 at limit 1, so under churn a poison row was never
    // re-attempted at all. Per-object scheduling dissolves the dilemma —
    // a failed row reschedules exactly like a healthy one, so at limit 1
    // the two rows here simply alternate.
    const now = Date.now();
    await seedBatch({
      status: 'settled',
      stripeChargeId: 'ch_poison',
      fundedAt: new Date(now - 9 * 86400000),
      actualStripeFeeMinor: '25',
    });
    await seedBatch({
      status: 'settled',
      stripeChargeId: 'ch_wants_a_turn',
      fundedAt: new Date(now - 8 * 86400000),
      actualStripeFeeMinor: '25',
    });

    const seen: string[] = [];
    const mk = () =>
      ({
        charges: {
          retrieve: vi.fn(async (id: string) => {
            seen.push(id);
            if (id === 'ch_poison') throw new Error('always fails');
            return { id, refunded: false, amount_refunded: 0, disputed: false, balance_transaction: { fee: 25 } };
          }),
        },
        transfers: { retrieve: vi.fn() },
        paymentIntents: { retrieve: vi.fn(), search: vi.fn(async () => ({ data: [] })), cancel: vi.fn() },
      }) as unknown as Stripe;

    for (let i = 0; i < 4; i += 1) {
      await runFundingReconciliation(db, { stripe: mk(), sweepLimit: 1 });
    }

    expect(seen).toContain('ch_wants_a_turn');
  });

  it('an intent posted with no linked payout is alerted on its own', async () => {
    // The inbox stuck-claim alert measures from processedAt, which a claim
    // takeover REFRESHES — so an event redelivered every few minutes pushes
    // its own alert out indefinitely. The underlying condition is not
    // timing-dependent and gets its own detector.
    const { partnerId } = await seedCommission();
    const batch = await seedBatch({ status: 'funding_disputed' });
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
      state: 'posted',
      stripeTransferId: 'tr_never_linked',
      payoutId: null,
    });
    // Older than the alert threshold.
    await db(TABLES.HostedFundingTransfer)
      .where({ id: intentId })
      .update({ updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });

    const { stripe } = mockStripe();
    const report = await runFundingReconciliation(db, { stripe });

    expect(report.attentionBatches).toContain(batch.id);
  });
});

// ---- Round-9 review fixes (Codex, 2026-08-13) ------------------------------

describe.skipIf(skipIntegration)('round-9: per-object sweep scheduling', () => {
  // Round 9 retired the global cursor + retry set: scheduling state lives
  // on the swept rows themselves (sweepDueAt / sweepLeaseAt /
  // sweepLeaseToken / sweepFailCount), claims are `for update skip locked`
  // under a per-run lease token, and success and failure reschedule
  // IDENTICALLY so selection is pure least-recently-visited rotation.
  // The older coverage tests above still pin the coverage properties;
  // these pin the parts of the new machine they cannot see.

  const mkSweepable = (tag: string) =>
    seedBatch({
      status: 'settled',
      stripeChargeId: `ch_${tag}`,
      fundedAt: new Date(Date.now() - 86400000),
      actualStripeFeeMinor: '25',
    });

  it('a row leased by a live concurrent run is left alone; a dead run lease expires', async () => {
    const held = await mkSweepable('held');
    await mkSweepable('free');
    // Another run claimed `held` five minutes ago and is still working.
    await db(TABLES.HostedFundingBatch)
      .where({ id: held.id })
      .update({ sweepLeaseAt: new Date(Date.now() - 5 * 60 * 1000), sweepLeaseToken: 'other_run' });

    const first = mockStripe();
    await runFundingReconciliation(db, { stripe: first.stripe });
    const firstSeen = first.chargeRetrieve.mock.calls.map((c) => c[0] as string);
    expect(firstSeen).toContain('ch_free');
    // Revert the lease guard in the claim and this double-sweeps the row
    // out from under the run that holds it.
    expect(firstSeen).not.toContain('ch_held');

    // The holder died. Once its lease ages past the TTL the row is
    // claimable again — a crash costs a delay, never a dropped row.
    await db(TABLES.HostedFundingBatch)
      .where({ id: held.id })
      .update({ sweepLeaseAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
    const second = mockStripe();
    await runFundingReconciliation(db, { stripe: second.stripe });
    expect(second.chargeRetrieve.mock.calls.map((c) => c[0] as string)).toContain('ch_held');
  });

  it('failures reschedule IDENTICALLY to successes, and escalate via sweepFailCount', async () => {
    // Any rule that revisits failures sooner puts every poison row ahead
    // of every healthy row on every run — the round-8 starvation again.
    // So after a run where one row fails and one succeeds, both must carry
    // the SAME next-due; persistence is escalated by count, not priority.
    const poison = await mkSweepable('always_fails');
    const healthy = await mkSweepable('fine');
    let failing = true;
    const mk = () =>
      ({
        charges: {
          retrieve: vi.fn(async (id: string) => {
            if (failing && id === 'ch_always_fails') throw new Error('unreadable');
            return { id, refunded: false, amount_refunded: 0, disputed: false, balance_transaction: { fee: 25 } };
          }),
        },
        transfers: { retrieve: vi.fn() },
        paymentIntents: { retrieve: vi.fn(), search: vi.fn(async () => ({ data: [] })), cancel: vi.fn() },
      }) as unknown as Stripe;

    await runFundingReconciliation(db, { stripe: mk() });
    const p1 = await reload(poison.id);
    const h1 = await reload(healthy.id);
    expect(p1.sweepDueAt).toEqual(h1.sweepDueAt); // identical reschedule
    expect(p1.sweepLeaseToken).toBeNull(); // acknowledged, not left claimed
    expect(p1.sweepFailCount).toBe(1);
    expect(h1.sweepFailCount).toBe(0);

    await runFundingReconciliation(db, { stripe: mk() });
    await runFundingReconciliation(db, { stripe: mk() });
    expect((await reload(poison.id)).sweepFailCount).toBe(3);

    // Stripe recovers: the count resets rather than ratcheting forever.
    failing = false;
    await runFundingReconciliation(db, { stripe: mk() });
    expect((await reload(poison.id)).sweepFailCount).toBe(0);
  });
});
