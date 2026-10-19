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
  resolveFundedDuplicateReview,
  runTransferExecutor,
} from '../funding/executor.js';
import { handleFundingEvent } from '../funding/webhook.js';
import { runFundingReconciliation } from '../funding/reconcile.js';
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
    const landed = listedTransfer(intent, { id: 'tr_reconciled' });
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
    await fundedBatch(partnerId, commissionIds, 5000);

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
    const landed = listedTransfer(intent, { id: 'tr_page2' });
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
    // Stripe stamps creation in whole seconds; "now" is after the intent's
    // postedAt in every flow here, which authentication requires.
    created: Math.floor(Date.now() / 1000),
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

const MUCH_LATER = () => new Date(Date.now() + 50 * 60 * 60 * 1000);

/** A held intent an operator re-armed onto generation 1, whose generation-1
 *  POST was ambiguous too: `posted` on `fbt:<id>:g1`. */
async function rearmedAndPostedAmbiguously() {
  const held = await heldIntent();
  const empty = mockStripe({ transfers: { list: vi.fn(async () => ({ data: [], has_more: false })) } });
  expect(await releaseFundedTransferForRetry(db, held.intent.id, 0, 'ops@test', empty.stripe)).toBe('rearmed');
  const netErr = mockStripe({
    transfers: {
      create: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
      list: vi.fn(async () => ({ data: [] })),
    },
  });
  await runTransferExecutor(db, { stripe: netErr.stripe, now: LATER });
  const intent = await intentOf(held.partnerId);
  expect(intent.state).toBe('posted');
  expect(intent.idempotencyKey).toBe(`fbt:${intent.id}:g1`);
  return { ...held, intent };
}

/** A transfer listing mock that refuses any POST. */
function listingOnly(list: (...args: never[]) => unknown, extra: Record<string, unknown> = {}) {
  const transfersCreate = vi.fn(async () => {
    throw new Error('must not re-POST');
  });
  const transfersList = vi.fn(list);
  const { stripe } = mockStripe({ transfers: { create: transfersCreate, list: transfersList, ...extra } });
  return { stripe, transfersCreate, transfersList };
}

/** An ambiguous post whose key window lapsed with TWO transfers stamped for
 *  the intent in its group: parked in duplicate_review. */
async function parkedIntent() {
  const posted = await postAmbiguously();
  const keep = listedTransfer(posted.intent);
  const dup = listedTransfer(posted.intent);
  const { stripe } = listingOnly(async () => ({ data: [keep, dup], has_more: false }));
  const result = await runTransferExecutor(db, { stripe, now: LATER });
  expect(result.duplicateReview).toEqual([posted.intent.id]);
  const intent = await intentOf(posted.partnerId);
  expect(intent.state).toBe('duplicate_review');
  return { ...posted, intent, keep, dup };
}

/** A listed transfer as Stripe shows it once fully reversed. */
function reversed<T extends { amount: number }>(t: T): T & { amount_reversed: number; reversed: true } {
  return { ...t, amount_reversed: t.amount, reversed: true };
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
    const { partnerId, intent } = await rearmedAndPostedAmbiguously();

    // A day later the listing shows only generation 0's straggler.
    const straggler = listedTransfer(intent, {
      metadata: { openpartner_transfer_intent_id: intent.id, openpartner_key_generation: '0' },
    });
    const recon = mockStripe({
      transfers: {
        create: vi.fn(async () => {
          throw new Error('must not re-POST');
        }),
        list: vi.fn(async () => ({ data: [straggler], has_more: false })),
      },
    });
    const result = await runTransferExecutor(db, { stripe: recon.stripe, now: MUCH_LATER });
    expect(result.duplicateReview).toEqual([intent.id]);
    const parked = await intentOf(partnerId);
    expect(parked.state).toBe('duplicate_review');
    expect(parked.lastError).toBe(`superseded_generation_transfer:${straggler.id}`);
    expect(await db(TABLES.Payout).where({ partnerId }).first()).toBeUndefined();
  });

  it('after a re-arm, both generations landing parks as a duplicate — never finalized', async () => {
    const { partnerId, intent } = await rearmedAndPostedAmbiguously();
    const straggler = listedTransfer(intent, {
      metadata: { openpartner_transfer_intent_id: intent.id, openpartner_key_generation: '0' },
    });
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
    await runTransferExecutor(db, { stripe: both.stripe, now: MUCH_LATER });
    const dup = await intentOf(partnerId);
    expect(dup.state).toBe('duplicate_review');
    expect(dup.lastError).toBe(`duplicate_transfers:${current.id}, ${straggler.id}`);
    expect(dup.reviewNonce).not.toBeNull();
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

// ---- Single-match authentication (the direct rail's round 10) ---------------

describe.skipIf(skipIntegration)('transfer executor — a lone match is authenticated before it is recorded', () => {
  type Intent = HostedFundingTransferRow;
  const postedSeconds = (intent: Intent) => Math.floor(new Date(intent.postedAt!).getTime() / 1000);

  it.each<[string, (intent: Intent) => Record<string, unknown>]>([
    ['the wrong amount', () => ({ amount: 4999 })],
    ['the wrong currency', () => ({ currency: 'eur' })],
    ['another destination, though its metadata names the intent', () => ({ destination: 'acct_elsewhere' })],
    ['a creation time before postedAt minus 5 minutes', (intent) => ({ created: postedSeconds(intent) - 6 * 60 })],
    ['no creation time', () => ({ created: undefined })],
  ])('a transfer with %s parks the intent instead of finalizing', async (_label, patch) => {
    const { partnerId, batch, intent } = await postAmbiguously();
    const found = listedTransfer(intent, patch(intent));
    const { stripe, transfersCreate } = listingOnly(async () => ({ data: [found], has_more: false }));

    const result = await runTransferExecutor(db, { stripe, now: LATER });
    expect(transfersCreate).not.toHaveBeenCalled();
    expect(result.transfersConfirmed).toEqual([]);
    expect(result.duplicateReview).toEqual([intent.id]);
    const parked = await intentOf(partnerId);
    expect(parked.state).toBe('duplicate_review');
    expect(parked.lastError).toBe(`unauthenticated_group_transfer:${found.id}`);
    expect(parked.stripeTransferId).toBeNull();
    expect(await db(TABLES.Payout).where({ partnerId }).first()).toBeUndefined();
    const allocations = await db(TABLES.HostedFundingAllocation).where({ batchId: batch.id });
    expect(allocations.every((a: { state: string }) => a.state === 'transfer_pending')).toBe(true);
  });

  it('a creation time inside the 5-minute skew still finalizes', async () => {
    const { partnerId, intent } = await postAmbiguously();
    const found = listedTransfer(intent, { created: postedSeconds(intent) - 4 * 60 });
    const { stripe } = listingOnly(async () => ({ data: [found], has_more: false }));

    const result = await runTransferExecutor(db, { stripe, now: LATER });
    expect(result.transfersConfirmed).toEqual([intent.id]);
    expect((await intentOf(partnerId)).stripeTransferId).toBe(found.id);
  });

  it('a transfer to the destination whose metadata was cleared is still the intent’s: it authenticates and finalizes', async () => {
    const { partnerId, intent } = await postAmbiguously();
    const cleared = listedTransfer(intent, { metadata: {} });
    const { stripe } = listingOnly(async () => ({ data: [cleared], has_more: false }));

    const result = await runTransferExecutor(db, { stripe, now: LATER });
    expect(result.transfersConfirmed).toEqual([intent.id]);
    expect((await intentOf(partnerId)).stripeTransferId).toBe(cleared.id);
  });

  it('a cleared-metadata transfer beside the stamped one is a duplicate, not invisible', async () => {
    const { partnerId, intent } = await postAmbiguously();
    const stamped = listedTransfer(intent);
    const cleared = listedTransfer(intent, { metadata: {} });
    const { stripe } = listingOnly(async () => ({ data: [stamped, cleared], has_more: false }));

    const result = await runTransferExecutor(db, { stripe, now: LATER });
    expect(result.duplicateReview).toEqual([intent.id]);
    expect((await intentOf(partnerId)).lastError).toBe(`duplicate_transfers:${stamped.id}, ${cleared.id}`);
  });

  it('two partners sharing a Connect account each finalize their own stamped transfer', async () => {
    const a = await seedPartner();
    const b = await seedPartner();
    const shared = `acct_shared_${ulid().slice(0, 8)}`;
    await db(TABLES.Partner).whereIn('id', [a, b]).update({ stripeConnectAccountId: shared });
    const aIds = await seedCommissions(a, 1, '50.00');
    const bIds = await seedCommissions(b, 1, '50.00');
    const r = await db.transaction((trx) =>
      reserveFundingBatch(trx, TENANT, 'usd', [
        { partnerId: a, commissionIds: aIds, amountMinor: 5000 },
        { partnerId: b, commissionIds: bIds, amountMinor: 5000 },
      ]),
    );
    await db(TABLES.HostedFundingBatch)
      .where({ id: r.batchId! })
      .update({ status: 'funded', stripeChargeId: `ch_${r.batchId!.slice(0, 12)}`, fundedAt: new Date() });
    const netErr = listingOnly(async () => ({ data: [] }), {
      create: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    });
    await runTransferExecutor(db, { stripe: netErr.stripe });
    const ia = await intentOf(a);
    const ib = await intentOf(b);
    expect([ia.state, ib.state]).toEqual(['posted', 'posted']);

    // Same destination, same amount — only the stamps tell them apart, and
    // a stamp naming the OTHER intent of this batch is not a duplicate.
    const ta = listedTransfer(ia);
    const tb = listedTransfer(ib);
    const { stripe } = listingOnly(async () => ({ data: [ta, tb], has_more: false }));
    const result = await runTransferExecutor(db, { stripe, now: LATER });
    expect(result.duplicateReview).toEqual([]);
    expect(result.transfersConfirmed.sort()).toEqual([ia.id, ib.id].sort());
    expect((await intentOf(a)).stripeTransferId).toBe(ta.id);
    expect((await intentOf(b)).stripeTransferId).toBe(tb.id);
    expect((await db(TABLES.HostedFundingBatch).where({ id: r.batchId! }).first()).status).toBe('settled');
  });

  it('a listing that cannot be completed decides nothing', async () => {
    const { partnerId, intent } = await postAmbiguously();
    // An empty page that claims more pages: not a complete group.
    const { stripe } = listingOnly(async () => ({ data: [], has_more: true }));
    const result = await runTransferExecutor(db, { stripe, now: LATER });
    expect(result.failed).toEqual([intent.id]);
    expect(result.awaitingOperator).toEqual([]);
    const after = await intentOf(partnerId);
    expect(after.state).toBe('reconcile_required');
    expect(after.lastError).not.toBe('awaiting_operator:no_transfer_found_past_window');
  });

  it('a reconcile whose listing went stale cannot finalize over an intent parked meanwhile', async () => {
    const { partnerId, intent } = await postAmbiguously();
    const found = listedTransfer(intent);
    const { stripe } = listingOnly(async () => {
      // Another tick parks the intent while this listing is in flight.
      await db(TABLES.HostedFundingTransfer)
        .where({ id: intent.id })
        .update({ state: 'duplicate_review', lastError: 'duplicate_transfers:elsewhere', reviewNonce: ulid() });
      return { data: [found], has_more: false };
    });
    const result = await runTransferExecutor(db, { stripe, now: LATER });
    expect(result.transfersConfirmed).toEqual([]);
    const after = await intentOf(partnerId);
    expect(after.state).toBe('duplicate_review');
    expect(after.stripeTransferId).toBeNull();
    expect(await db(TABLES.Payout).where({ partnerId }).first()).toBeUndefined();
  });
});

// ---- Parked duplicates and their operator path out ---------------------------

describe.skipIf(skipIntegration)('transfer executor — a parked intent is left alone', () => {
  it('later ticks neither list nor alert, and it is outside the §7 deadline alert', async () => {
    const { intent, batch } = await heldIntent();
    const mentions = (calls: unknown[][], text: string) => calls.filter((c) => String(c[0]).includes(text));

    // Past the deadline while still HELD: the deadline alert fires.
    await db(TABLES.HostedFundingBatch)
      .where({ id: batch.id })
      .update({ fundedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) });
    let errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const empty = listingOnly(async () => ({ data: [], has_more: false }));
    await runTransferExecutor(db, { stripe: empty.stripe, now: LATER });
    expect(mentions(errors.mock.calls, `batch ${batch.id} still has untransferred`)).toHaveLength(1);
    errors.mockRestore();

    // Two transfers show up: parked, with one ALERT.
    const both = listingOnly(async () => ({ data: [listedTransfer(intent), listedTransfer(intent)], has_more: false }));
    expect((await runTransferExecutor(db, { stripe: both.stripe, now: LATER })).duplicateReview).toEqual([intent.id]);

    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { stripe, transfersList, transfersCreate } = listingOnly(async () => ({ data: [], has_more: false }));
    const later = await runTransferExecutor(db, { stripe, now: LATER });
    await runTransferExecutor(db, { stripe, now: LATER });
    const noise = [...mentions(errors.mock.calls, intent.id), ...mentions(errors.mock.calls, batch.id)];
    errors.mockRestore();
    expect(transfersList).not.toHaveBeenCalled();
    expect(transfersCreate).not.toHaveBeenCalled();
    expect(later.duplicateReview).toEqual([]);
    expect(later.awaitingOperator).toEqual([]);
    expect(noise).toEqual([]);
    expect((await intentOf(intent.partnerId)).state).toBe('duplicate_review');
    expect((await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first()).status).toBe('transferring');
  });

  it('the daily reconcile names it', async () => {
    const { intent } = await parkedIntent();
    const { stripe } = mockStripe({ charges: { retrieve: vi.fn(async () => ({})) } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = await runFundingReconciliation(db, { stripe });
    errors.mockRestore();
    expect(report.duplicateReviewIntents).toEqual([intent.id]);
    expect(report.attentionBatches).toContain(intent.batchId);
  });
});

describe.skipIf(skipIntegration)('resolveFundedDuplicateReview — verified against Stripe', () => {
  it('keep: the kept transfer pays the allocations, and the batch settles on the next tick', async () => {
    const { partnerId, commissionIds, batch, intent, keep, dup } = await parkedIntent();
    const { stripe } = listingOnly(async () => ({ data: [keep, reversed(dup)], has_more: false }));

    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { keptTransferId: keep.id }, stripe),
    ).toBe('resolved');
    const after = await intentOf(partnerId);
    expect(after.state).toBe('confirmed');
    expect(after.stripeTransferId).toBe(keep.id);
    expect(after.lastError).toBe('operator_kept_transfer:ops@test');
    const payout = await db(TABLES.Payout).where({ partnerId }).first();
    expect(payout.status).toBe('paid');
    expect(payout.stripeTransferId).toBe(keep.id);
    expect(after.payoutId).toBe(payout.id);
    const commissions = await db(TABLES.Commission).whereIn('id', commissionIds);
    expect(commissions.every((c: { status: string; payoutId: string }) => c.status === 'paid' && c.payoutId === payout.id)).toBe(true);

    const tick = listingOnly(async () => ({ data: [], has_more: false }));
    expect((await runTransferExecutor(db, { stripe: tick.stripe })).settled).toEqual([batch.id]);
    expect(tick.transfersCreate).not.toHaveBeenCalled();
    // And never twice.
    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { keptTransferId: keep.id }, stripe),
    ).toBe('not_in_duplicate_review');
  });

  it('keep refuses while another transfer for the intent still holds money', async () => {
    const { partnerId, intent, keep, dup } = await parkedIntent();
    const partial = { ...dup, amount_reversed: 1000 };
    const { stripe } = listingOnly(async () => ({ data: [keep, partial], has_more: false }));
    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { keptTransferId: keep.id }, stripe),
    ).toBe('transfers_still_live');
    expect((await intentOf(partnerId)).state).toBe('duplicate_review');
    expect(await db(TABLES.Payout).where({ partnerId }).first()).toBeUndefined();
  });

  it.each<[string, (keep: ReturnType<typeof listedTransfer>) => Record<string, unknown>]>([
    ['is partly reversed', (k) => ({ amount_reversed: 1, id: k.id })],
    ['is not this payment’s amount', (k) => ({ amount: 1, id: k.id })],
    ['pays another destination', (k) => ({ destination: 'acct_elsewhere', metadata: k.metadata })],
  ])('keep refuses a kept transfer that %s', async (_label, patch) => {
    const { partnerId, intent, keep, dup } = await parkedIntent();
    const bad = { ...keep, ...patch(keep) };
    const { stripe } = listingOnly(async () => ({ data: [bad, reversed(dup)], has_more: false }));
    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { keptTransferId: keep.id }, stripe),
    ).toBe('kept_transfer_invalid');
    expect((await intentOf(partnerId)).state).toBe('duplicate_review');
  });

  it('keep refuses a transfer that belongs to another partner in the batch', async () => {
    const { intent, keep, dup } = await parkedIntent();
    const otherPartners = listedTransfer(intent, {
      destination: 'acct_someone_else',
      metadata: { openpartner_transfer_intent_id: ulid() },
    });
    const { stripe } = listingOnly(async () => ({
      data: [keep, reversed(dup), otherPartners],
      has_more: false,
    }));
    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { keptTransferId: otherPartners.id }, stripe),
    ).toBe('kept_transfer_invalid');
    // …and another partner's live transfer does not block keeping ours.
    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { keptTransferId: keep.id }, stripe),
    ).toBe('resolved');
  });

  it('all reversed: allocations canceled, nothing recorded paid, the batch settles with a residual', async () => {
    const { partnerId, commissionIds, batch, intent, keep, dup } = await parkedIntent();
    const live = listingOnly(async () => ({ data: [keep, reversed(dup)], has_more: false }));
    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { allReversed: true }, live.stripe),
    ).toBe('transfers_still_live');

    const { stripe } = listingOnly(async () => ({ data: [reversed(keep), reversed(dup)], has_more: false }));
    expect(await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { allReversed: true }, stripe)).toBe(
      'resolved',
    );
    const after = await intentOf(partnerId);
    expect(after.state).toBe('failed');
    expect(after.lastError).toBe('operator_all_reversed:ops@test');
    expect(after.payoutId).toBeNull();
    expect(await db(TABLES.Payout).where({ partnerId }).first()).toBeUndefined();
    const allocations = await db(TABLES.HostedFundingAllocation).where({ batchId: batch.id });
    expect(allocations.every((a: { state: string }) => a.state === 'canceled')).toBe(true);
    const commissions = await db(TABLES.Commission).whereIn('id', commissionIds);
    expect(commissions.every((c: { status: string }) => c.status === 'approved')).toBe(true);

    const tick = listingOnly(async () => ({ data: [], has_more: false }));
    await runTransferExecutor(db, { stripe: tick.stripe });
    const settled = await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first();
    expect(settled.status).toBe('settled_with_residual');
    expect(Number(settled.residualMinor)).toBe(5000);
  });

  it('refuses what it cannot verify', async () => {
    const { partnerId, intent, keep } = await parkedIntent();
    const down = listingOnly(async () => {
      throw new Error('stripe unreachable');
    });
    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { keptTransferId: keep.id }, down.stripe),
    ).toBe('cannot_verify');
    expect((await intentOf(partnerId)).state).toBe('duplicate_review');
  });

  it('refuses an intent that is not parked — a held one is the re-arm’s business', async () => {
    const { intent } = await heldIntent();
    const { stripe } = listingOnly(async () => ({ data: [], has_more: false }));
    expect(await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { allReversed: true }, stripe)).toBe(
      'not_in_duplicate_review',
    );
    expect(await resolveFundedDuplicateReview(db, ulid(), 'ops@test', { allReversed: true }, stripe)).toBe(
      'not_in_duplicate_review',
    );
  });

  it('a reversal recorded by the webhook mid-resolution makes the commit lose — re-verify, never record a reversed transfer as kept', async () => {
    const { partnerId, intent, keep, dup } = await parkedIntent();
    const before = (await intentOf(partnerId)).reviewNonce;
    const listing = listingOnly(async () => {
      // The transfer about to be kept is reversed while the operator's
      // listing is in flight; the listing still shows it whole.
      const outcome = await handleFundingEvent(
        db,
        listing.stripe,
        stripeEvent('transfer.reversed', { ...reversed(keep), reversals: { data: [] } }),
      );
      expect(outcome).toBe('transfer_reversal_in_duplicate_review');
      return { data: [keep, reversed(dup)], has_more: false };
    });
    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { keptTransferId: keep.id }, listing.stripe),
    ).toBe('review_moved');
    const after = await intentOf(partnerId);
    expect(after.state).toBe('duplicate_review');
    expect(after.reviewNonce).not.toBe(before);
    expect(await db(TABLES.Payout).where({ partnerId }).first()).toBeUndefined();

    // The retry sees the world as it now is.
    const now = listingOnly(async () => ({ data: [reversed(keep), reversed(dup)], has_more: false }));
    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { keptTransferId: keep.id }, now.stripe),
    ).toBe('kept_transfer_invalid');
  });

  it('a new transfer created mid-resolution alarms and makes the commit lose too', async () => {
    const { partnerId, intent, keep, dup } = await parkedIntent();
    const before = (await intentOf(partnerId)).reviewNonce;
    const third = listedTransfer(intent);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listing = listingOnly(async () => {
      // A third transfer lands while the operator's listing is in flight;
      // the listing predates it.
      const outcome = await handleFundingEvent(db, listing.stripe, stripeEvent('transfer.created', third));
      expect(outcome).toBe(`transfer_created_orphan:${intent.id}`);
      return { data: [keep, reversed(dup)], has_more: false };
    });
    const result = await resolveFundedDuplicateReview(
      db,
      intent.id,
      'ops@test',
      { keptTransferId: keep.id },
      listing.stripe,
    );
    errors.mockRestore();
    expect(result).toBe('review_moved');
    const after = await intentOf(partnerId);
    expect(after.state).toBe('duplicate_review');
    expect(after.reviewNonce).not.toBe(before);

    // Re-verified with the third transfer visible and live: refused.
    const now = listingOnly(async () => ({ data: [keep, reversed(dup), third], has_more: false }));
    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { keptTransferId: keep.id }, now.stripe),
    ).toBe('transfers_still_live');
  });
});

describe.skipIf(skipIntegration)('funding webhook — reversals around a duplicate review', () => {
  it('a reversal on a parked intent is acknowledged and moves the review nonce; nothing is recorded', async () => {
    const { partnerId, intent, dup } = await parkedIntent();
    const { stripe } = mockStripe();
    const outcome = await handleFundingEvent(
      db,
      stripe,
      stripeEvent('transfer.reversed', { ...reversed(dup), reversals: { data: [{ id: 'trr_dup', amount: 5000, created: 1 }] } }),
    );
    expect(outcome).toBe('transfer_reversal_in_duplicate_review');
    const after = await intentOf(partnerId);
    expect(after.state).toBe('duplicate_review');
    expect(after.reviewNonce).not.toBe(intent.reviewNonce);
    expect(await db(TABLES.PayoutReversal).first()).toBeUndefined();
    const inbox = await db(TABLES.StripeWebhookInbox).first();
    expect(inbox.outcome).toBe('transfer_reversal_in_duplicate_review');
  });

  it('after keeping one transfer, a late reversal of the surplus never touches the payout', async () => {
    const { partnerId, intent, keep, dup } = await parkedIntent();
    const { stripe } = listingOnly(async () => ({ data: [keep, reversed(dup)], has_more: false }));
    expect(
      await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { keptTransferId: keep.id }, stripe),
    ).toBe('resolved');

    const outcome = await handleFundingEvent(
      db,
      stripe,
      stripeEvent('transfer.reversed', { ...reversed(dup), reversals: { data: [{ id: 'trr_dup', amount: 5000, created: 1 }] } }),
    );
    expect(outcome).toBe('reversal_of_unrecorded_transfer');
    const payout = await db(TABLES.Payout).where({ partnerId }).first();
    expect(payout.status).toBe('paid');
    expect(await db(TABLES.PayoutReversal).first()).toBeUndefined();
    expect(await db(TABLES.CommissionAdjustment).first()).toBeUndefined();
  });

  it('after resolving all reversed, a late reversal is acknowledged rather than redelivered forever', async () => {
    const { intent, keep, dup } = await parkedIntent();
    const { stripe } = listingOnly(async () => ({ data: [reversed(keep), reversed(dup)], has_more: false }));
    expect(await resolveFundedDuplicateReview(db, intent.id, 'ops@test', { allReversed: true }, stripe)).toBe(
      'resolved',
    );
    const outcome = await handleFundingEvent(
      db,
      stripe,
      stripeEvent('transfer.reversed', { ...reversed(keep), reversals: { data: [{ id: 'trr_keep', amount: 5000, created: 1 }] } }),
    );
    expect(outcome).toBe('reversal_on_closed_intent');
    expect(await db(TABLES.PayoutReversal).first()).toBeUndefined();
  });
});

describe.skipIf(skipIntegration)('operator recovery — hosted duplicate resolution', () => {
  const app = createApp();

  it('POST /funding/transfers/:id/recovery resolves through the apply loop and schedules the recheck', async () => {
    const { partnerId, intent, keep, dup } = await parkedIntent();
    const res = await request(app)
      .post(`/funding/transfers/${intent.id}/recovery`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ kind: 'resolve_duplicate_review', keptTransferId: keep.id, note: 'reversed the dup in the dashboard' });
    expect(res.status).toBe(201);
    expect(res.body.request.status).toBe('pending');
    const row = await db(TABLES.OperatorRecoveryRequest).where({ targetId: intent.id }).first();
    expect(row.rail).toBe('hosted_funding');
    expect(row.kind).toBe('resolve_duplicate_review');
    expect(row.params).toEqual({ keptTransferId: keep.id });

    const { stripe } = listingOnly(async () => ({ data: [keep, reversed(dup)], has_more: false }));
    await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe });
    const settled = await db(TABLES.OperatorRecoveryRequest).where({ id: row.id }).first();
    expect(settled.status).toBe('applied');
    expect(settled.outcome).toBe('resolved');
    expect(settled.recheckDueAt).not.toBeNull();
    expect((await intentOf(partnerId)).stripeTransferId).toBe(keep.id);

    // The recheck is quiet while only the kept transfer is live…
    await db(TABLES.OperatorRecoveryRequest).where({ id: row.id }).update({ recheckDueAt: new Date(Date.now() - 60_000) });
    const quiet = await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe });
    expect(quiet.recheck.orphaned).toEqual([]);
    expect((await db(TABLES.OperatorRecoveryRequest).where({ id: row.id }).first()).recheckOutcome).toBe('clear');
  });

  it('the recheck alarms when a third transfer lands after the resolution', async () => {
    const { intent, keep, dup } = await parkedIntent();
    const id = ulid();
    await db(TABLES.OperatorRecoveryRequest).insert({
      id,
      tenantId: TENANT,
      rail: 'hosted_funding',
      kind: 'resolve_duplicate_review',
      targetId: intent.id,
      params: JSON.stringify({ keptTransferId: keep.id }),
      requestedBy: 'ops@test',
      status: 'pending',
    });
    const before = listingOnly(async () => ({ data: [keep, reversed(dup)], has_more: false }));
    await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe: before.stripe });
    expect((await db(TABLES.OperatorRecoveryRequest).where({ id }).first()).outcome).toBe('resolved');

    const late = listedTransfer(intent, { metadata: {} });
    await db(TABLES.OperatorRecoveryRequest).where({ id }).update({ recheckDueAt: new Date(Date.now() - 60_000) });
    const after = listingOnly(async () => ({ data: [keep, reversed(dup), late], has_more: false }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe: after.stripe });
    errors.mockRestore();
    expect(result.recheck.orphaned).toEqual([intent.id]);
    expect((await db(TABLES.OperatorRecoveryRequest).where({ id }).first()).recheckOutcome).toBe(
      `orphan_transfers:${late.id}`,
    );
  });

  it('a taken-over claim whose interrupted attempt already resolved it settles applied, by its marker', async () => {
    const { intent, keep, dup } = await parkedIntent();
    const id = ulid();
    const { stripe } = listingOnly(async () => ({ data: [keep, reversed(dup)], has_more: false }));
    // The dead attempt: resolved under this request's operator string, then
    // died before settling its request row.
    expect(
      await resolveFundedDuplicateReview(db, intent.id, `ops@test/req_${id}`, { keptTransferId: keep.id }, stripe),
    ).toBe('resolved');
    await db(TABLES.OperatorRecoveryRequest).insert({
      id,
      tenantId: TENANT,
      rail: 'hosted_funding',
      kind: 'resolve_duplicate_review',
      targetId: intent.id,
      params: JSON.stringify({ keptTransferId: keep.id }),
      requestedBy: 'ops@test',
      status: 'pending',
      attempts: 1,
      leaseAt: new Date(Date.now() - 60 * 60 * 1000),
      leaseToken: 'dead-claim',
    });
    await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe });
    const row = await db(TABLES.OperatorRecoveryRequest).where({ id }).first();
    expect(row.status).toBe('applied');
    expect(row.outcome).toBe('resolved:by_interrupted_attempt');
  });

  it('the route wants exactly one disposition', async () => {
    const { intent, keep } = await parkedIntent();
    for (const body of [
      { kind: 'resolve_duplicate_review' },
      { kind: 'resolve_duplicate_review', keptTransferId: keep.id, allReversed: true },
    ]) {
      const res = await request(app)
        .post(`/funding/transfers/${intent.id}/recovery`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send(body);
      expect(res.status).toBe(400);
    }
    expect(await db(TABLES.OperatorRecoveryRequest).first()).toBeUndefined();
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
