/**
 * Transfer executor + funding webhook handling — spec §6/§8.
 * DB-backed; Stripe is a hand-rolled mock so every test asserts exactly
 * which calls reached the money API.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';
import { db } from '../db.js';
import { reserveFundingBatch } from '../funding/reserve.js';
import { runTransferExecutor } from '../funding/executor.js';
import { handleFundingEvent } from '../funding/webhook.js';
import type { HostedFundingBatchRow } from '@openpartner/db';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;

// ---- Stripe mock ----------------------------------------------------------

function mockStripe(overrides: Partial<Record<string, unknown>> = {}) {
  const transfersCreate = vi.fn(async (params: { amount: number; currency: string; metadata: Record<string, string> }) => ({
    id: `tr_${ulid()}`,
    amount: params.amount,
    currency: params.currency,
    metadata: params.metadata,
  }));
  const transfersList = vi.fn(async () => ({ data: [] }));
  const piRetrieve = vi.fn(async () => ({}));
  const stripe = {
    transfers: { create: transfersCreate, list: transfersList },
    paymentIntents: { retrieve: piRetrieve },
    ...overrides,
  } as unknown as Stripe;
  return { stripe, transfersCreate, transfersList, piRetrieve };
}

// ---- Seeding --------------------------------------------------------------

async function seedPartner(transferReady = true): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: TENANT,
    email: `p${id}@x.test`,
    name: 'P',
    stripeConnectAccountId: transferReady ? `acct_${id.slice(0, 10)}` : null,
    metadata: transferReady ? { stripe: { payoutsEnabled: true } } : {},
  });
  return id;
}

async function seedCommissions(partnerId: string, n: number, amount = '40.00'): Promise<string[]> {
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
    value: amount,
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
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = ulid();
    ids.push(id);
    await db(TABLES.Commission).insert({
      id,
      tenantId: TENANT,
      partnerId,
      attributionId,
      amount,
      currency: 'USD',
      status: 'approved',
    });
  }
  return ids;
}

/** Reserve a batch for the partner's approved commissions, then force it
 *  to `funded` with a fake settled charge — the executor's entry state. */
async function fundedBatch(partnerId: string, commissionIds: string[], amountMinor: number): Promise<HostedFundingBatchRow> {
  const r = await db.transaction((trx) =>
    reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId, commissionIds, amountMinor }]),
  );
  expect(r.batchId).not.toBeNull();
  await db(TABLES.HostedFundingBatch)
    .where({ id: r.batchId! })
    .update({ status: 'funded', stripeChargeId: `ch_${r.batchId!.slice(0, 12)}`, fundedAt: new Date() });
  return (await db(TABLES.HostedFundingBatch).where({ id: r.batchId! }).first()) as HostedFundingBatchRow;
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

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of [
    ...FUNDING_TABLES,
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
  ]) {
    await db(t).del();
  }
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of [...FUNDING_TABLES, TABLES.Commission, TABLES.Payout]) {
      await db(t).del();
    }
  }
  await db.destroy();
});

// ---- Executor -------------------------------------------------------------

describe.skipIf(skipIntegration)('transfer executor', () => {
  it('funded batch → source-linked transfer, paid Payout, transferred allocations, settled batch', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 2, '40.00');
    const batch = await fundedBatch(partnerId, commissionIds, 8000);
    const { stripe, transfersCreate } = mockStripe();

    const result = await runTransferExecutor(db, { stripe });
    expect(result.transfersConfirmed).toHaveLength(1);
    expect(result.settled).toEqual([batch.id]);

    expect(transfersCreate).toHaveBeenCalledOnce();
    const [params, opts] = transfersCreate.mock.calls[0]! as unknown as [
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(params.amount).toBe(8000);
    expect(params.source_transaction).toBe(batch.stripeChargeId);
    expect(params.transfer_group).toBe(batch.id);
    expect(opts.idempotencyKey).toMatch(/^fbt:/);

    const payout = await db(TABLES.Payout).where({ partnerId }).first();
    expect(payout.status).toBe('paid');
    expect(payout.amount).toBe('80.00');
    expect(payout.stripeTransferId).toMatch(/^tr_/);

    const commissions = await db(TABLES.Commission).whereIn('id', commissionIds);
    expect(commissions.every((c: { status: string; payoutId: string }) => c.status === 'paid' && c.payoutId === payout.id)).toBe(true);

    const after = await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first();
    expect(after.status).toBe('settled');
  });

  it('re-running the executor is idempotent — no second transfer, no second payout', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    await fundedBatch(partnerId, commissionIds, 5000);
    const { stripe, transfersCreate } = mockStripe();

    await runTransferExecutor(db, { stripe });
    await runTransferExecutor(db, { stripe });

    expect(transfersCreate).toHaveBeenCalledOnce();
    const payouts = await db(TABLES.Payout).where({ partnerId });
    expect(payouts).toHaveLength(1);
  });

  it('a commission mutated after funding holds the transfer — Stripe never called', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 2, '40.00');
    const batch = await fundedBatch(partnerId, commissionIds, 8000);
    await db(TABLES.Commission).where({ id: commissionIds[0]! }).update({ status: 'reversed' });
    const { stripe, transfersCreate } = mockStripe();

    const result = await runTransferExecutor(db, { stripe });
    expect(transfersCreate).not.toHaveBeenCalled();
    expect(result.settled).toHaveLength(0);
    const after = await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first();
    expect(after.status).toBe('transferring'); // held, not settled — operator disposition
  });

  it('allocation/principal invariant violation freezes the batch as recovery_required', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    const batch = await fundedBatch(partnerId, commissionIds, 5000);
    await db(TABLES.HostedFundingAllocation).where({ batchId: batch.id }).update({ amountMinor: 4000 });
    const { stripe, transfersCreate } = mockStripe();

    await runTransferExecutor(db, { stripe });
    expect(transfersCreate).not.toHaveBeenCalled();
    const after = await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first();
    expect(after.status).toBe('recovery_required');
  });

  it('a definite Stripe 4xx marks the intent failed; commissions stay approved', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    await fundedBatch(partnerId, commissionIds, 5000);
    const { stripe } = mockStripe({
      transfers: {
        create: vi.fn(async () => {
          const err = new Error('No such destination') as Error & { statusCode: number };
          err.statusCode = 400;
          throw err;
        }),
        list: vi.fn(async () => ({ data: [] })),
      },
    });

    const result = await runTransferExecutor(db, { stripe });
    expect(result.failed).toHaveLength(1);
    const intent = await db(TABLES.HostedFundingTransfer).where({ partnerId }).first();
    expect(intent.state).toBe('failed');
    const commissions = await db(TABLES.Commission).whereIn('id', commissionIds);
    expect(commissions.every((c: { status: string }) => c.status === 'approved')).toBe(true);
    expect(await db(TABLES.Payout).where({ partnerId }).first()).toBeUndefined();
  });

  it('ambiguous post past the idempotency window reconciles by listing — found transfer finalizes without re-POST', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    const batch = await fundedBatch(partnerId, commissionIds, 5000);

    // First pass: ambiguous network error → intent stays 'posted'.
    const netErr = mockStripe({
      transfers: {
        create: vi.fn(async () => {
          throw new Error('socket hang up');
        }),
        list: vi.fn(async () => ({ data: [] })),
      },
    });
    await runTransferExecutor(db, { stripe: netErr.stripe });
    const intent = await db(TABLES.HostedFundingTransfer).where({ partnerId }).first();
    expect(intent.state).toBe('posted');

    // Second pass, 25h later: the transfer DID land at Stripe.
    const landed = {
      id: 'tr_reconciled',
      amount: 5000,
      currency: 'usd',
      metadata: { openpartner_transfer_intent_id: intent.id },
    };
    const recon = mockStripe({
      transfers: {
        create: vi.fn(async () => {
          throw new Error('must not re-POST');
        }),
        list: vi.fn(async () => ({ data: [landed] })),
      },
    });
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const result = await runTransferExecutor(db, { stripe: recon.stripe, now: () => later });

    expect(result.transfersConfirmed).toContain(intent.id);
    const after = await db(TABLES.HostedFundingTransfer).where({ id: intent.id }).first();
    expect(after.state).toBe('confirmed');
    expect(after.stripeTransferId).toBe('tr_reconciled');
    const payout = await db(TABLES.Payout).where({ partnerId }).first();
    expect(payout.status).toBe('paid');
    const batchAfter = await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first();
    expect(batchAfter.status).toBe('settled');
  });
});

// ---- Funding webhooks -----------------------------------------------------

function stripeEvent(type: string, object: Record<string, unknown>, id = `evt_${ulid()}`): Stripe.Event {
  return { id, type, data: { object } } as unknown as Stripe.Event;
}

describe.skipIf(skipIntegration)('funding webhook handling', () => {
  it('non-funding events pass through untouched (null return, no inbox row)', async () => {
    const { stripe } = mockStripe();
    const outcome = await handleFundingEvent(
      db,
      stripe,
      stripeEvent('payment_intent.succeeded', { id: 'pi_x', metadata: {} }),
    );
    expect(outcome).toBeNull();
    expect(await db(TABLES.StripeWebhookInbox).first()).toBeUndefined();
  });

  it('inbox absorbs duplicate deliveries', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    const batch = await fundedBatch(partnerId, commissionIds, 5000);
    const event = stripeEvent('payment_intent.payment_failed', {
      id: 'pi_dup',
      metadata: { openpartner_funding_batch_id: batch.id },
      last_payment_error: { message: 'insufficient funds' },
    });
    const { stripe } = mockStripe();
    const first = await handleFundingEvent(db, stripe, event);
    const second = await handleFundingEvent(db, stripe, event);
    expect(first).not.toBe('inbox_replay');
    expect(second).toBe('inbox_replay');
  });

  it('payment_intent.payment_failed CASes payment_processing → funding_failed with the reason', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    const batch = await fundedBatch(partnerId, commissionIds, 5000);
    await db(TABLES.HostedFundingBatch).where({ id: batch.id }).update({ status: 'payment_processing' });
    const { stripe } = mockStripe();

    const outcome = await handleFundingEvent(
      db,
      stripe,
      stripeEvent('payment_intent.payment_failed', {
        id: 'pi_f',
        metadata: { openpartner_funding_batch_id: batch.id },
        last_payment_error: { message: 'R01 insufficient funds' },
      }),
    );
    expect(outcome).toBe('payment_failed_recorded');
    const after = await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first();
    expect(after.status).toBe('funding_failed');
    expect(after.failureReason).toContain('R01');
  });

  it('charge.refunded on the funding charge freezes the batch as funding_disputed', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    const batch = await fundedBatch(partnerId, commissionIds, 5000);
    const { stripe } = mockStripe();

    const outcome = await handleFundingEvent(
      db,
      stripe,
      stripeEvent('charge.refunded', {
        id: batch.stripeChargeId,
        metadata: { openpartner_funding_batch_id: batch.id },
      }),
    );
    expect(outcome).toBe('funding_disputed');
    const after = await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first();
    expect(after.status).toBe('funding_disputed');
  });

  it('transfer.reversed records the reversal ledger and derives payout state', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    const batch = await fundedBatch(partnerId, commissionIds, 5000);
    const { stripe } = mockStripe();
    await runTransferExecutor(db, { stripe });
    const intent = await db(TABLES.HostedFundingTransfer).where({ partnerId }).first();
    expect(intent.state).toBe('confirmed');

    // Partial reversal first.
    const partial = await handleFundingEvent(
      db,
      stripe,
      stripeEvent('transfer.reversed', {
        id: intent.stripeTransferId,
        metadata: { openpartner_transfer_intent_id: intent.id },
        reversals: { data: [{ id: 'trr_1', amount: 2000, created: 1750000000, balance_transaction: 'txn_1' }] },
      }),
    );
    expect(partial).toBe('reversal_recorded:1:partial');
    let payout = await db(TABLES.Payout).where({ id: intent.payoutId }).first();
    expect(payout.status).toBe('partially_reversed');
    expect(await db(TABLES.CommissionAdjustment).first()).toBeUndefined();

    // Remainder reversed → fully reversed + compensating adjustments.
    const full = await handleFundingEvent(
      db,
      stripe,
      stripeEvent('transfer.reversed', {
        id: intent.stripeTransferId,
        metadata: { openpartner_transfer_intent_id: intent.id },
        reversals: {
          data: [
            { id: 'trr_1', amount: 2000, created: 1750000000, balance_transaction: 'txn_1' },
            { id: 'trr_2', amount: 3000, created: 1750000100, balance_transaction: 'txn_2' },
          ],
        },
      }),
    );
    expect(full).toBe('reversal_recorded:1:full'); // trr_1 deduped by unique index
    payout = await db(TABLES.Payout).where({ id: intent.payoutId }).first();
    expect(payout.status).toBe('reversed');

    const adjustments = await db(TABLES.CommissionAdjustment).where({ reason: 'transfer_reversed' });
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].amount).toBe('-50.00');
    // Paid commission is immutable history — still 'paid'.
    const commission = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(commission.status).toBe('paid');
  });
});
