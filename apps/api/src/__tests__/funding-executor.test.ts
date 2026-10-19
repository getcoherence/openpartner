/**
 * Transfer executor + funding webhook handling — spec §6/§8.
 * DB-backed; Stripe is a hand-rolled mock so every test asserts exactly
 * which calls reached the money API.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';

// No configured Stripe client: every money call in this file goes to a
// mock passed in explicitly, and the recovery route's inline apply must
// not reach a real (test-mode) account through a developer's .env.
vi.mock('../stripe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stripe.js')>()),
  stripe: null,
}));

const ADMIN_KEY = 'op_test_admin_key_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;

import { db } from '../db.js';
import { createApp } from '../app.js';
import { reserveFundingBatch } from '../funding/reserve.js';
import {
  fundedTransferKey,
  releaseFundedTransferForRetry,
  runTransferExecutor,
} from '../funding/executor.js';
import { handleFundingEvent } from '../funding/webhook.js';
import { applyRecoveryRequests } from '../operator-recovery.js';
import type { HostedFundingBatchRow, HostedFundingTransferRow } from '@openpartner/db';

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

const TABLES_TO_CLEAN = [
  TABLES.OperatorRecoveryRequest,
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
];

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) {
    await db(t).del();
  }
});

afterAll(async () => {
  // All of it, not just the funding rows: the last test's Partner, Program,
  // Click, Event and Attribution would otherwise outlive this file.
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) {
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

  it('reconcile pages past the first 100 transfers to find the match (no duplicate re-POST)', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    const batch = await fundedBatch(partnerId, commissionIds, 5000);

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

    // Our transfer landed but sits on PAGE 2 of the transfer_group listing.
    const landed = { id: 'tr_page2', amount: 5000, currency: 'usd', metadata: { openpartner_transfer_intent_id: intent.id } };
    const listMock = vi.fn(async (params: { starting_after?: string }) => {
      if (!params.starting_after) {
        const dummies = Array.from({ length: 100 }, (_, i) => ({ id: `tr_dummy_${i}`, metadata: {} }));
        return { data: dummies, has_more: true };
      }
      return { data: [landed], has_more: false };
    });
    const recon = mockStripe({
      transfers: {
        create: vi.fn(async () => {
          throw new Error('must not re-POST');
        }),
        list: listMock,
      },
    });
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const result = await runTransferExecutor(db, { stripe: recon.stripe, now: () => later });

    expect(result.transfersConfirmed).toContain(intent.id);
    expect(listMock).toHaveBeenCalledTimes(2); // paged past the first 100
    const after = await db(TABLES.HostedFundingTransfer).where({ id: intent.id }).first();
    expect(after.state).toBe('confirmed');
    expect(after.stripeTransferId).toBe('tr_page2');
  });
});

// ---- Ambiguity discipline (the direct rail's round 6) -----------------------

const LATER = () => new Date(Date.now() + 25 * 60 * 60 * 1000);

function stripeError(statusCode: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`stripe ${statusCode}`), { statusCode, ...extra });
}

/** A transfer as Stripe would list it in the batch's transfer_group. */
function listedTransfer(
  intent: Pick<HostedFundingTransferRow, 'id' | 'batchId' | 'destinationAccountId' | 'amountMinor'>,
  patch: Record<string, unknown> = {},
) {
  return {
    id: `tr_${ulid()}`,
    amount: Number(intent.amountMinor),
    amount_reversed: 0,
    currency: 'usd',
    destination: intent.destinationAccountId,
    transfer_group: intent.batchId,
    metadata: { openpartner_transfer_intent_id: intent.id } as Record<string, string>,
    ...patch,
  };
}

async function intentOf(partnerId: string): Promise<HostedFundingTransferRow> {
  return (await db(TABLES.HostedFundingTransfer).where({ partnerId }).first()) as HostedFundingTransferRow;
}

/** Fund a batch and post its transfer into an ambiguous network error:
 *  the intent is `posted` with its outcome unknown. */
async function postAmbiguously(): Promise<{ partnerId: string; commissionIds: string[]; batch: HostedFundingBatchRow; intent: HostedFundingTransferRow }> {
  const partnerId = await seedPartner();
  const commissionIds = await seedCommissions(partnerId, 1, '50.00');
  const batch = await fundedBatch(partnerId, commissionIds, 5000);
  const { stripe } = mockStripe({
    transfers: {
      create: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
      list: vi.fn(async () => ({ data: [] })),
    },
  });
  await runTransferExecutor(db, { stripe });
  const intent = await intentOf(partnerId);
  expect(intent.state).toBe('posted');
  return { partnerId, commissionIds, batch, intent };
}

/** …then let the key window lapse with nothing visible at Stripe. */
async function heldIntent() {
  const posted = await postAmbiguously();
  const { stripe } = mockStripe({
    transfers: {
      create: vi.fn(async () => {
        throw new Error('must not re-POST');
      }),
      list: vi.fn(async () => ({ data: [], has_more: false })),
    },
  });
  const result = await runTransferExecutor(db, { stripe, now: LATER });
  expect(result.awaitingOperator).toEqual([posted.intent.id]);
  return { ...posted, intent: await intentOf(posted.partnerId) };
}

describe.skipIf(skipIntegration)('transfer executor — ambiguous Stripe errors', () => {
  it.each([
    ['409 idempotency conflict', stripeError(409)],
    ['429 rate limit', stripeError(429)],
    ['400 idempotency_error (key reused, params differ)', stripeError(400, { rawType: 'idempotency_error' })],
  ])('a %s leaves the intent posted — never failed — and the next tick replays the same key', async (_label, err) => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    const batch = await fundedBatch(partnerId, commissionIds, 5000);
    const first = mockStripe({
      transfers: {
        create: vi.fn(async () => {
          throw err;
        }),
        list: vi.fn(async () => ({ data: [] })),
      },
    });

    await runTransferExecutor(db, { stripe: first.stripe });
    const intent = await intentOf(partnerId);
    expect(intent.state).toBe('posted');
    expect(intent.lastError).toBe(err.message);
    // Still claimed: nothing reads this as "Stripe refused it".
    const allocations = await db(TABLES.HostedFundingAllocation).where({ batchId: batch.id });
    expect(allocations.every((a: { state: string }) => a.state === 'transfer_pending')).toBe(true);
    expect(await db(TABLES.Payout).where({ partnerId }).first()).toBeUndefined();

    // Inside the window the retry replays the frozen key; Stripe returns the
    // transfer the first request created.
    const replay = mockStripe();
    const result = await runTransferExecutor(db, { stripe: replay.stripe });
    expect(replay.transfersCreate).toHaveBeenCalledOnce();
    const [, opts] = replay.transfersCreate.mock.calls[0]! as unknown as [unknown, { idempotencyKey: string }];
    expect(opts.idempotencyKey).toBe(intent.idempotencyKey);
    expect(result.transfersConfirmed).toEqual([intent.id]);
    expect((await intentOf(partnerId)).state).toBe('confirmed');
  });

});

describe.skipIf(skipIntegration)('transfer executor — empty listing past the window HOLDS', () => {
  it('an empty listing past the window holds the intent: no re-POST across ticks, allocations stay claimed', async () => {
    const { partnerId, batch, intent } = await postAmbiguously();
    const create = vi.fn(async () => {
      throw new Error('must not re-POST');
    });
    const list = vi.fn(async () => ({ data: [], has_more: false }));
    const { stripe } = mockStripe({ transfers: { create, list } });

    const first = await runTransferExecutor(db, { stripe, now: LATER });
    expect(first.awaitingOperator).toEqual([intent.id]);
    const held = await intentOf(partnerId);
    expect(held.state).toBe('reconcile_required');
    expect(held.idempotencyKey).toBe(fundedTransferKey(intent.id)); // same key — nothing re-armed
    expect(held.postedAt).not.toBeNull();
    expect(held.lastError).toBe('awaiting_operator:no_transfer_found_past_window');

    // Later ticks keep LISTING and never post; the hold is recorded once,
    // so updatedAt keeps measuring how long it has been held.
    await runTransferExecutor(db, { stripe, now: LATER });
    await runTransferExecutor(db, { stripe, now: LATER });
    expect(create).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(3);
    const still = await intentOf(partnerId);
    expect(still.state).toBe('reconcile_required');
    expect(new Date(still.updatedAt).getTime()).toBe(new Date(held.updatedAt).getTime());

    const allocations = await db(TABLES.HostedFundingAllocation).where({ batchId: batch.id });
    expect(allocations.every((a: { state: string }) => a.state === 'transfer_pending')).toBe(true);
    expect((await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first()).status).toBe('transferring');
    expect(await db(TABLES.Payout).where({ partnerId }).first()).toBeUndefined();
  });

  it('a straggler that lands while held still finalizes normally', async () => {
    const { partnerId, batch, intent } = await heldIntent();
    const landed = listedTransfer(intent);
    const { stripe, transfersCreate } = mockStripe({
      transfers: {
        create: vi.fn(async () => {
          throw new Error('must not re-POST');
        }),
        list: vi.fn(async () => ({ data: [landed], has_more: false })),
      },
    });

    const result = await runTransferExecutor(db, { stripe, now: LATER });
    expect(transfersCreate).not.toHaveBeenCalled();
    expect(result.transfersConfirmed).toEqual([intent.id]);
    const after = await intentOf(partnerId);
    expect(after.state).toBe('confirmed');
    expect(after.stripeTransferId).toBe(landed.id);
    expect(after.lastError).toBeNull();
    expect((await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first()).status).toBe('settled');
  });
});

describe.skipIf(skipIntegration)('transfer executor — a finalize racing a failure', () => {
  it('a definite failure arriving after a concurrent finalize cannot overwrite confirmed', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    await fundedBatch(partnerId, commissionIds, 5000);
    // While this POST is in flight another worker finalizes the intent (a
    // replay that came back first); then this response arrives as a 400.
    const create = vi.fn(async () => {
      await db(TABLES.HostedFundingTransfer)
        .where({ partnerId })
        .update({ state: 'confirmed', stripeTransferId: 'tr_won', lastError: null });
      throw stripeError(400);
    });
    const { stripe } = mockStripe({ transfers: { create, list: vi.fn(async () => ({ data: [] })) } });

    const result = await runTransferExecutor(db, { stripe });
    expect(create).toHaveBeenCalledOnce();
    expect(result.failed).toEqual([]);
    const intent = await intentOf(partnerId);
    expect(intent.state).toBe('confirmed');
    expect(intent.stripeTransferId).toBe('tr_won');
    expect(intent.lastError).toBeNull();
  });

  it('an ambiguous error after a concurrent finalize does not drag it back to posted', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedCommissions(partnerId, 1, '50.00');
    await fundedBatch(partnerId, commissionIds, 5000);
    const create = vi.fn(async () => {
      await db(TABLES.HostedFundingTransfer)
        .where({ partnerId })
        .update({ state: 'confirmed', stripeTransferId: 'tr_won', lastError: null });
      throw new Error('socket hang up');
    });
    const { stripe } = mockStripe({ transfers: { create, list: vi.fn(async () => ({ data: [] })) } });

    await runTransferExecutor(db, { stripe });
    const intent = await intentOf(partnerId);
    expect(intent.state).toBe('confirmed');
    expect(intent.lastError).toBeNull();
  });
});

describe.skipIf(skipIntegration)('releaseFundedTransferForRetry — the operator path out of a hold', () => {
  it('re-arms a held intent onto the next key generation; the next tick posts exactly once under it', async () => {
    const { partnerId, batch, intent } = await heldIntent();
    const guard = mockStripe({ transfers: { list: vi.fn(async () => ({ data: [], has_more: false })) } });

    expect(await releaseFundedTransferForRetry(db, intent.id, 0, 'ops@test', guard.stripe)).toBe('rearmed');
    const rearmed = await intentOf(partnerId);
    expect(rearmed.state).toBe('pending');
    expect(rearmed.idempotencyKey).toBe(`fbt:${intent.id}:g1`);
    expect(rearmed.postedAt).toBeNull();
    expect(rearmed.lastError).toBe('operator_rearm:ops@test');

    const { stripe, transfersCreate } = mockStripe();
    const result = await runTransferExecutor(db, { stripe, now: LATER });
    expect(transfersCreate).toHaveBeenCalledOnce();
    const [params, opts] = transfersCreate.mock.calls[0]! as unknown as [
      { metadata: Record<string, string> },
      { idempotencyKey: string },
    ];
    expect(opts.idempotencyKey).toBe(`fbt:${intent.id}:g1`);
    expect(params.metadata.openpartner_key_generation).toBe('1');
    expect(result.transfersConfirmed).toEqual([intent.id]);
    expect((await intentOf(partnerId)).state).toBe('confirmed');
    expect((await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first()).status).toBe('settled');

    // And never again.
    await runTransferExecutor(db, { stripe, now: LATER });
    expect(transfersCreate).toHaveBeenCalledOnce();
  });

  it('refuses on any transfer for the intent — including one whose metadata was cleared', async () => {
    const { partnerId, intent } = await heldIntent();
    // Metadata is mutable at Stripe; the destination is not.
    const cleared = listedTransfer(intent, { metadata: {} });
    const otherPartner = listedTransfer(intent, { destination: 'acct_someone_else', metadata: {} });
    const { stripe } = mockStripe({
      transfers: { list: vi.fn(async () => ({ data: [otherPartner, cleared], has_more: false })) },
    });

    expect(await releaseFundedTransferForRetry(db, intent.id, 0, 'ops@test', stripe)).toBe('transfer_exists');
    const after = await intentOf(partnerId);
    expect(after.state).toBe('reconcile_required');
    expect(after.idempotencyKey).toBe(fundedTransferKey(intent.id));
  });

  it("another partner's transfer in the shared batch group does not block the re-arm", async () => {
    const { intent } = await heldIntent();
    const otherPartner = listedTransfer(intent, {
      destination: 'acct_someone_else',
      metadata: { openpartner_transfer_intent_id: ulid() },
    });
    const { stripe } = mockStripe({
      transfers: { list: vi.fn(async () => ({ data: [otherPartner], has_more: false })) },
    });
    expect(await releaseFundedTransferForRetry(db, intent.id, 0, 'ops@test', stripe)).toBe('rearmed');
  });

  it('is fenced on the generation the operator observed, and needs a readable Stripe', async () => {
    const { intent } = await heldIntent();
    const empty = mockStripe({ transfers: { list: vi.fn(async () => ({ data: [], has_more: false })) } });
    expect(await releaseFundedTransferForRetry(db, intent.id, 1, 'ops@test', empty.stripe)).toBe('generation_moved');

    const down = mockStripe({
      transfers: {
        list: vi.fn(async () => {
          throw new Error('stripe unreachable');
        }),
      },
    });
    expect(await releaseFundedTransferForRetry(db, intent.id, 0, 'ops@test', down.stripe)).toBe('cannot_verify');

    // Two operators observing generation 0: exactly one hands it out.
    expect(await releaseFundedTransferForRetry(db, intent.id, 0, 'a@test', empty.stripe)).toBe('rearmed');
    expect(await releaseFundedTransferForRetry(db, intent.id, 0, 'b@test', empty.stripe)).toBe('not_held');
  });

  it('refuses an intent that is not held', async () => {
    const { intent } = await postAmbiguously(); // posted, inside the window
    const { stripe } = mockStripe({ transfers: { list: vi.fn(async () => ({ data: [], has_more: false })) } });
    expect(await releaseFundedTransferForRetry(db, intent.id, 0, 'ops@test', stripe)).toBe('not_held');
    expect(await releaseFundedTransferForRetry(db, ulid(), 0, 'ops@test', stripe)).toBe('not_held');
  });

  it('after a re-arm, a late transfer from the abandoned key is never recorded as the current one', async () => {
    const { partnerId, intent } = await heldIntent();
    const empty = mockStripe({ transfers: { list: vi.fn(async () => ({ data: [], has_more: false })) } });
    expect(await releaseFundedTransferForRetry(db, intent.id, 0, 'ops@test', empty.stripe)).toBe('rearmed');

    // Generation 1's POST is ambiguous too…
    const netErr = mockStripe({
      transfers: {
        create: vi.fn(async () => {
          throw new Error('socket hang up');
        }),
        list: vi.fn(async () => ({ data: [] })),
      },
    });
    await runTransferExecutor(db, { stripe: netErr.stripe, now: LATER });
    expect((await intentOf(partnerId)).state).toBe('posted');

    // …and a day later the listing shows only generation 0's straggler.
    const straggler = listedTransfer(intent, {
      metadata: { openpartner_transfer_intent_id: intent.id, openpartner_key_generation: '0' },
    });
    const muchLater = () => new Date(Date.now() + 50 * 60 * 60 * 1000);
    const recon = mockStripe({
      transfers: {
        create: vi.fn(async () => {
          throw new Error('must not re-POST');
        }),
        list: vi.fn(async () => ({ data: [straggler], has_more: false })),
      },
    });
    const result = await runTransferExecutor(db, { stripe: recon.stripe, now: muchLater });
    expect(result.awaitingOperator).toEqual([intent.id]);
    const held = await intentOf(partnerId);
    expect(held.state).toBe('reconcile_required');
    expect(held.lastError).toBe(`superseded_generation_transfer:${straggler.id}`);
    expect(await db(TABLES.Payout).where({ partnerId }).first()).toBeUndefined();

    // Both generations landing is a duplicate: still not finalized.
    const current = listedTransfer(intent, {
      metadata: { openpartner_transfer_intent_id: intent.id, openpartner_key_generation: '1' },
    });
    const both = mockStripe({
      transfers: {
        create: vi.fn(async () => {
          throw new Error('must not re-POST');
        }),
        list: vi.fn(async () => ({ data: [current, straggler], has_more: false })),
      },
    });
    await runTransferExecutor(db, { stripe: both.stripe, now: muchLater });
    const dup = await intentOf(partnerId);
    expect(dup.state).toBe('reconcile_required');
    expect(dup.lastError).toBe(`duplicate_transfers:${current.id}, ${straggler.id}`);
    expect(await db(TABLES.Payout).where({ partnerId }).first()).toBeUndefined();
  });
});

describe.skipIf(skipIntegration)('operator recovery — hosted transfer re-arm', () => {
  const app = createApp();

  it('POST /funding/transfers/:id/recovery re-arms through the apply loop and schedules the recheck', async () => {
    const { partnerId, intent } = await heldIntent();
    const res = await request(app)
      .post(`/funding/transfers/${intent.id}/recovery`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ kind: 'release_intent_for_retry', observedGeneration: 0, note: 'confirmed in the dashboard' });
    expect(res.status).toBe(201);
    // With no Stripe client configured the inline pass claims nothing: the
    // decision is durable and queued, and the scheduler's pass applies it.
    expect(res.body.request.status).toBe('pending');
    const row = await db(TABLES.OperatorRecoveryRequest).where({ targetId: intent.id }).first();
    expect(row.rail).toBe('hosted_funding');
    expect(row.kind).toBe('release_intent_for_retry');
    expect(row.params).toEqual({ observedGeneration: 0 });

    const { stripe } = mockStripe({ transfers: { list: vi.fn(async () => ({ data: [], has_more: false })) } });
    await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe });
    const settled = await db(TABLES.OperatorRecoveryRequest).where({ id: row.id }).first();
    expect(settled.status).toBe('applied');
    expect(settled.outcome).toBe('rearmed');
    expect(settled.recheckDueAt).not.toBeNull();
    expect((await intentOf(partnerId)).idempotencyKey).toBe(`fbt:${intent.id}:g1`);
  });

  it('the route 404s a transfer intent that does not exist', async () => {
    const res = await request(app)
      .post(`/funding/transfers/${ulid()}/recovery`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ kind: 'release_intent_for_retry', observedGeneration: 0 });
    expect(res.status).toBe(404);
  });

  it('the recheck alarms when the abandoned key lands after the re-armed transfer confirmed', async () => {
    const { partnerId, intent } = await heldIntent();
    const id = ulid();
    await db(TABLES.OperatorRecoveryRequest).insert({
      id,
      tenantId: TENANT,
      rail: 'hosted_funding',
      kind: 'release_intent_for_retry',
      targetId: intent.id,
      params: JSON.stringify({ observedGeneration: 0 }),
      requestedBy: 'ops@test',
      status: 'pending',
    });
    const empty = mockStripe({ transfers: { list: vi.fn(async () => ({ data: [], has_more: false })) } });
    await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe: empty.stripe });
    expect((await db(TABLES.OperatorRecoveryRequest).where({ id }).first()).status).toBe('applied');

    // Generation 1 posts and confirms…
    const post = mockStripe();
    await runTransferExecutor(db, { stripe: post.stripe, now: LATER });
    const confirmed = await intentOf(partnerId);
    expect(confirmed.state).toBe('confirmed');

    // …then generation 0's in-flight POST lands, metadata cleared and all.
    const straggler = listedTransfer(intent, { metadata: {} });
    const recorded = listedTransfer(intent, { id: confirmed.stripeTransferId });
    await db(TABLES.OperatorRecoveryRequest)
      .where({ id })
      .update({ recheckDueAt: new Date(Date.now() - 60_000) });
    const recheck = mockStripe({
      transfers: { list: vi.fn(async () => ({ data: [recorded, straggler], has_more: false })) },
    });
    const result = await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe: recheck.stripe });
    expect(result.recheck.orphaned).toEqual([intent.id]);
    const after = await db(TABLES.OperatorRecoveryRequest).where({ id }).first();
    expect(after.recheckOutcome).toBe(`orphan_transfers:${straggler.id}`);
    expect(after.recheckDueAt).toBeNull();
    // Detector only: the intent is untouched.
    expect((await intentOf(partnerId)).stripeTransferId).toBe(confirmed.stripeTransferId);
  });

  it('the recheck stays quiet when only the recorded transfer is live', async () => {
    const { partnerId, intent } = await heldIntent();
    const id = ulid();
    await db(TABLES.OperatorRecoveryRequest).insert({
      id,
      tenantId: TENANT,
      rail: 'hosted_funding',
      kind: 'release_intent_for_retry',
      targetId: intent.id,
      params: JSON.stringify({ observedGeneration: 0 }),
      requestedBy: 'ops@test',
      status: 'pending',
    });
    const empty = mockStripe({ transfers: { list: vi.fn(async () => ({ data: [], has_more: false })) } });
    await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe: empty.stripe });
    const post = mockStripe();
    await runTransferExecutor(db, { stripe: post.stripe, now: LATER });
    const confirmed = await intentOf(partnerId);

    await db(TABLES.OperatorRecoveryRequest)
      .where({ id })
      .update({ recheckDueAt: new Date(Date.now() - 60_000) });
    const recorded = listedTransfer(intent, { id: confirmed.stripeTransferId });
    const recheck = mockStripe({
      transfers: { list: vi.fn(async () => ({ data: [recorded], has_more: false })) },
    });
    const result = await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe: recheck.stripe });
    expect(result.recheck.orphaned).toEqual([]);
    expect((await db(TABLES.OperatorRecoveryRequest).where({ id }).first()).recheckOutcome).toBe('clear');
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
    await fundedBatch(partnerId, commissionIds, 5000);
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
