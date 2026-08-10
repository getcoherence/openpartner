/**
 * Direct-Connect payout intents (audit #10) — the planner freezes, the
 * executor moves money. DB-backed; Stripe is a hand-rolled mock so every
 * test asserts exactly which calls reached the money API.
 *
 * The scenarios that motivated the rework, all of which used to double-pay:
 *   - the transfer succeeds and the surrounding COMMIT then fails
 *   - Stripe answers ambiguously (timeout) and the run is retried
 *   - more commissions get approved between the failed attempt and the retry
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';
import { db } from '../db.js';
import { runPayouts } from '../payouts.js';
import { executePayoutTransfers } from '../payout-transfers.js';
import { interlockCommissionReversal, whereNotClaimedByOpenIntent } from '../funding/interlocks.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;

// ---- Stripe mock ----------------------------------------------------------

interface FakeTransfer {
  id: string;
  amount: number;
  currency: string;
  transfer_group?: string;
  metadata: Record<string, string>;
}

function mockStripe(opts: { onCreate?: (n: number) => void; listed?: FakeTransfer[] } = {}) {
  let calls = 0;
  const created: FakeTransfer[] = [];
  const transfersCreate = vi.fn(
    async (params: {
      amount: number;
      currency: string;
      transfer_group?: string;
      metadata: Record<string, string>;
    }) => {
      calls += 1;
      opts.onCreate?.(calls);
      const t: FakeTransfer = {
        id: `tr_${ulid()}`,
        amount: params.amount,
        currency: params.currency,
        transfer_group: params.transfer_group,
        metadata: params.metadata,
      };
      created.push(t);
      return t;
    },
  );
  const transfersList = vi.fn(async ({ transfer_group }: { transfer_group?: string }) => ({
    data: (opts.listed ?? []).filter((t) => !transfer_group || t.transfer_group === transfer_group),
    has_more: false,
  }));
  const stripe = {
    transfers: { create: transfersCreate, list: transfersList },
  } as unknown as Stripe;
  return { stripe, transfersCreate, transfersList, created };
}

/** Stripe answered with 4xx semantics — the transfer certainly doesn't exist. */
function definiteError(message = 'No such destination'): Error {
  return Object.assign(new Error(message), { statusCode: 400, type: 'StripeInvalidRequestError' });
}
/** No response at all — the transfer may or may not have been created. */
function ambiguousError(message = 'socket hang up'): Error {
  return Object.assign(new Error(message), { type: 'StripeConnectionError' });
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

async function seedApproved(partnerId: string, n: number, amount = '40.00'): Promise<string[]> {
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

/** Plan payouts the way every caller does: inside a tenant transaction. */
async function plan() {
  return db.transaction((trx) => runPayouts(trx, TENANT));
}

/** The intent metadata, typed loosely enough for assertions. */
async function payoutOf(payoutId: string) {
  const row = (await db(TABLES.Payout).where({ id: payoutId }).first()) as {
    id: string;
    status: string;
    stripeTransferId: string | null;
    amount: string;
    metadata: { transferState?: string; amountMinor?: number; postedAt?: string; lastError?: string };
  };
  return row;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of [
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
    for (const t of [TABLES.Commission, TABLES.Payout]) await db(t).del();
  }
  await db.destroy();
});

// ---- Planning -------------------------------------------------------------

describe.skipIf(skipIntegration)('payout planner', () => {
  it('writes a committed intent and freezes its commissions — no Stripe call', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 2, '40.00');

    const result = await plan();
    expect(result.payouts).toHaveLength(1);
    expect(result.payouts[0]!.status).toBe('pending');
    expect(result.payouts[0]!.method).toBe('stripe_connect');
    expect(result.payouts[0]!.amount).toBe(80);

    const payout = await payoutOf(result.payouts[0]!.payoutId);
    expect(payout.status).toBe('pending');
    expect(payout.metadata.transferState).toBe('intent');
    expect(payout.metadata.amountMinor).toBe(8000);
    expect(payout.stripeTransferId).toBeNull();

    // Frozen: claimed by the intent but not yet paid.
    const commissions = await db(TABLES.Commission).whereIn('id', commissionIds);
    expect(
      commissions.every(
        (c: { status: string; payoutId: string | null }) =>
          c.status === 'approved' && c.payoutId === payout.id,
      ),
    ).toBe(true);
  });

  it('a second planning run cannot re-group commissions already frozen on an intent', async () => {
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 2, '40.00');

    const first = await plan();
    const second = await plan();

    expect(first.payouts).toHaveLength(1);
    expect(second.payouts).toHaveLength(0);
    expect(await db(TABLES.Payout).count({ n: '*' })).toEqual([{ n: '1' }]);
  });

  it('commissions approved after the intent form their OWN intent — no overlap', async () => {
    // This is the scenario that makes a "deterministic key over the
    // commission set" unsafe: the set changes between attempt and retry.
    // With a frozen intent, the new commission simply gets its own.
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 2, '40.00');
    const first = await plan();
    await seedApproved(partnerId, 1, '25.00');
    const second = await plan();

    expect(first.payouts[0]!.amount).toBe(80);
    expect(second.payouts[0]!.amount).toBe(25);
    expect(first.payouts[0]!.payoutId).not.toBe(second.payouts[0]!.payoutId);

    const { stripe, transfersCreate } = mockStripe();
    await executePayoutTransfers(db, { stripe, tenantId: TENANT });
    expect(transfersCreate).toHaveBeenCalledTimes(2);
    const amounts = transfersCreate.mock.calls
      .map((c) => (c[0] as { amount: number }).amount)
      .sort((a, b) => a - b);
    expect(amounts).toEqual([2500, 8000]); // 105.00 total, nothing paid twice
  });

  it('manual-rail payouts are unaffected — still marked paid at plan time', async () => {
    const partnerId = await seedPartner(false); // no Connect account
    const commissionIds = await seedApproved(partnerId, 1, '30.00');

    const result = await plan();
    expect(result.payouts[0]!.method).toBe('manual');
    const commission = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(commission.status).toBe('paid');
    const payout = await payoutOf(result.payouts[0]!.payoutId);
    expect(payout.metadata.transferState).toBeUndefined();
  });
});

// ---- Execution ------------------------------------------------------------

describe.skipIf(skipIntegration)('payout transfer executor', () => {
  it('posts the transfer with the frozen key, then marks payout + commissions paid', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 2, '40.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    const { stripe, transfersCreate } = mockStripe();

    const result = await executePayoutTransfers(db, { stripe });
    expect(result.confirmed).toHaveLength(1);
    expect(transfersCreate).toHaveBeenCalledOnce();
    const [params, options] = transfersCreate.mock.calls[0]! as unknown as [
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(params.amount).toBe(8000);
    expect(params.transfer_group).toBe(payoutId);
    expect((params.metadata as Record<string, string>).openpartner_payout_id).toBe(payoutId);
    expect(options.idempotencyKey).toBe(`payout_${payoutId}`);

    const payout = await payoutOf(payoutId);
    expect(payout.status).toBe('paid');
    expect(payout.metadata.transferState).toBe('confirmed');
    expect(payout.stripeTransferId).toMatch(/^tr_/);
    const commissions = await db(TABLES.Commission).whereIn('id', commissionIds);
    expect(commissions.every((c: { status: string }) => c.status === 'paid')).toBe(true);
  });

  it('re-running the executor is idempotent — no second transfer, no second payout', async () => {
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    await plan();
    const { stripe, transfersCreate } = mockStripe();

    await executePayoutTransfers(db, { stripe });
    await executePayoutTransfers(db, { stripe });

    expect(transfersCreate).toHaveBeenCalledOnce();
    expect(await db(TABLES.Payout).count({ n: '*' })).toEqual([{ n: '1' }]);
  });

  it('the transfer succeeded but our bookkeeping did not: the retry replays the SAME key', async () => {
    // "Commit failed after the transfer left Stripe." The intent is
    // durable, so the retry reuses payout_<id>; Stripe replays the
    // original transfer instead of creating a second one.
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;

    const replayed: FakeTransfer = {
      id: 'tr_replayed',
      amount: 5000,
      currency: 'usd',
      transfer_group: payoutId,
      metadata: { openpartner_payout_id: payoutId },
    };
    const transfersCreate = vi.fn(async () => replayed);
    const stripe = { transfers: { create: transfersCreate, list: vi.fn() } } as unknown as Stripe;

    // Simulate the lost outcome: the intent was posted 3 minutes ago and
    // nothing finalized it.
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({ transferState: 'posted', postedAt: hoursAgo(0.05).toISOString() }),
        ]),
      });

    const result = await executePayoutTransfers(db, { stripe });
    expect(transfersCreate).toHaveBeenCalledOnce();
    expect(result.confirmed).toEqual([{ payoutId, stripeTransferId: 'tr_replayed' }]);
    const payout = await payoutOf(payoutId);
    expect(payout.status).toBe('paid');
    expect(payout.stripeTransferId).toBe('tr_replayed');
  });

  it('an ambiguous error leaves the intent posted — commissions stay frozen, not released', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    const transfersCreate = vi.fn(async () => {
      throw ambiguousError();
    });
    const stripe = { transfers: { create: transfersCreate, list: vi.fn() } } as unknown as Stripe;

    const result = await executePayoutTransfers(db, { stripe });
    expect(result.ambiguous).toEqual([payoutId]);

    const payout = await payoutOf(payoutId);
    expect(payout.status).toBe('pending');
    expect(payout.metadata.transferState).toBe('posted');
    // Still claimed: releasing here would let the next run re-pay them.
    const commission = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(commission.status).toBe('approved');
    expect(commission.payoutId).toBe(payoutId);
    // And nothing new can be planned for that partner.
    expect((await plan()).payouts).toHaveLength(0);
  });

  it('past the idempotency window an ambiguous intent reconciles by listing — never re-POSTs', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;

    // The transfer DID land 25 hours ago; our key is pruned by now.
    const landed: FakeTransfer = {
      id: 'tr_landed',
      amount: 5000,
      currency: 'usd',
      transfer_group: payoutId,
      metadata: { openpartner_payout_id: payoutId },
    };
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({ transferState: 'posted', postedAt: hoursAgo(25).toISOString() }),
        ]),
      });
    const { stripe, transfersCreate, transfersList } = mockStripe({ listed: [landed] });

    const result = await executePayoutTransfers(db, { stripe });
    expect(transfersCreate).not.toHaveBeenCalled();
    expect(transfersList).toHaveBeenCalledOnce();
    expect(result.confirmed).toEqual([{ payoutId, stripeTransferId: 'tr_landed' }]);

    const payout = await payoutOf(payoutId);
    expect(payout.status).toBe('paid');
    expect(payout.stripeTransferId).toBe('tr_landed');
    const commission = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(commission.status).toBe('paid');
  });

  it('reconcile that proves absence re-arms the intent for a fresh post', async () => {
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({ transferState: 'posted', postedAt: hoursAgo(25).toISOString() }),
        ]),
      });
    const { stripe, transfersCreate } = mockStripe({ listed: [] });

    await executePayoutTransfers(db, { stripe });
    expect(transfersCreate).not.toHaveBeenCalled();
    let payout = await payoutOf(payoutId);
    expect(payout.metadata.transferState).toBe('intent');
    expect(payout.metadata.postedAt).toBeUndefined();

    // Next tick posts it for real — exactly once.
    await executePayoutTransfers(db, { stripe });
    expect(transfersCreate).toHaveBeenCalledOnce();
    payout = await payoutOf(payoutId);
    expect(payout.status).toBe('paid');
  });

  it('a definite 4xx fails the payout and releases the claim so the next run regroups', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    const transfersCreate = vi.fn(async () => {
      throw definiteError();
    });
    const stripe = { transfers: { create: transfersCreate, list: vi.fn() } } as unknown as Stripe;

    const result = await executePayoutTransfers(db, { stripe });
    expect(result.failed[0]!.payoutId).toBe(payoutId);

    const payout = await payoutOf(payoutId);
    expect(payout.status).toBe('failed');
    expect(payout.metadata.transferState).toBe('canceled');
    const commission = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(commission.status).toBe('approved');
    expect(commission.payoutId).toBeNull();

    // Released, so the next planning run can try again under a new intent.
    const retry = await plan();
    expect(retry.payouts).toHaveLength(1);
    expect(retry.payouts[0]!.payoutId).not.toBe(payoutId);
  });

  it('a commission reversed between plan and post cancels the intent before any Stripe call', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 2, '40.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    await db(TABLES.Commission).where({ id: commissionIds[0]! }).update({ status: 'reversed' });
    const { stripe, transfersCreate } = mockStripe();

    const result = await executePayoutTransfers(db, { stripe });
    expect(transfersCreate).not.toHaveBeenCalled();
    expect(result.canceled).toEqual([{ payoutId, reason: 'commission_set_changed' }]);

    const payout = await payoutOf(payoutId);
    expect(payout.status).toBe('failed');
    // The survivor is released and regroups on its own next run.
    const survivor = await db(TABLES.Commission).where({ id: commissionIds[1]! }).first();
    expect(survivor.payoutId).toBeNull();
    const retry = await plan();
    expect(retry.payouts[0]!.amount).toBe(40);
  });

  it('a partner who lost Connect readiness cancels the intent instead of posting', async () => {
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    await db(TABLES.Partner).where({ id: partnerId }).update({ metadata: {} });
    const { stripe, transfersCreate } = mockStripe();

    const result = await executePayoutTransfers(db, { stripe });
    expect(transfersCreate).not.toHaveBeenCalled();
    expect(result.canceled).toEqual([
      { payoutId: payouts[0]!.payoutId, reason: 'stripe_onboarding_incomplete' },
    ]);
  });

  it('two executors racing one intent post exactly one transfer', async () => {
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    await plan();
    // A slow Stripe call keeps the first worker inside the POST while the
    // second worker scans — the CAS on transferState is what saves us.
    const { stripe, transfersCreate } = mockStripe({
      onCreate: () => {
        const until = Date.now() + 50;
        while (Date.now() < until) {
          /* hold the intent in-flight */
        }
      },
    });

    await Promise.all([
      executePayoutTransfers(db, { stripe }),
      executePayoutTransfers(db, { stripe }),
    ]);

    expect(transfersCreate).toHaveBeenCalledOnce();
    expect(await db(TABLES.Payout).count({ n: '*' })).toEqual([{ n: '1' }]);
  });

  it('a transfer that came back reversed is never recorded as paid', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    const transfersCreate = vi.fn(async () => ({
      id: 'tr_reversed',
      amount: 5000,
      currency: 'usd',
      reversed: true,
      amount_reversed: 5000,
      metadata: { openpartner_payout_id: payoutId },
    }));
    const stripe = { transfers: { create: transfersCreate, list: vi.fn() } } as unknown as Stripe;

    const result = await executePayoutTransfers(db, { stripe });
    expect(result.failed).toEqual([{ payoutId, error: 'transfer_reversed' }]);

    const payout = await payoutOf(payoutId);
    expect(payout.status).toBe('failed');
    expect(payout.metadata.transferState).toBe('confirmed'); // closed, not retried
    const commission = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(commission.status).toBe('approved');
    expect(commission.payoutId).toBe(payoutId); // held, not re-payable
    expect((await plan()).payouts).toHaveLength(0);
  });

  it('scopes to one tenant when asked', async () => {
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    await plan();
    const { stripe, transfersCreate } = mockStripe();

    await executePayoutTransfers(db, { stripe, tenantId: 'some-other-tenant' });
    expect(transfersCreate).not.toHaveBeenCalled();
  });
});

// ---- Adversarial-review fixes (Codex, 2026-08-09) --------------------------

describe.skipIf(skipIntegration)('concurrency and staleness hardening', () => {
  /** Stripe's answer when a second request uses a key the first still holds. */
  function idempotencyConflict(): Error {
    return Object.assign(new Error('There is currently another in-progress request using this Idempotent Key'), {
      statusCode: 409,
      type: 'idempotency_error',
      code: 'idempotency_key_in_use',
    });
  }

  it('an idempotency conflict does NOT release the claim (it would double-pay)', async () => {
    // 409 means another request holds the key RIGHT NOW — its transfer may
    // land. Releasing here let the planner regroup under a new key while
    // the first transfer succeeded.
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    const transfersCreate = vi.fn(async () => {
      throw idempotencyConflict();
    });
    const stripe = { transfers: { create: transfersCreate, list: vi.fn() } } as unknown as Stripe;

    const result = await executePayoutTransfers(db, { stripe });
    expect(result.failed).toHaveLength(0);
    expect(result.ambiguous).toEqual([payoutId]);

    const payout = await payoutOf(payoutId);
    expect(payout.status).toBe('pending');
    expect(payout.metadata.transferState).toBe('posted'); // held, not canceled
    const commission = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(commission.payoutId).toBe(payoutId); // still frozen
    expect((await plan()).payouts).toHaveLength(0); // cannot be re-planned
  });

  it('a rate-limit answer is ambiguous too', async () => {
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const transfersCreate = vi.fn(async () => {
      throw Object.assign(new Error('Too many requests'), { statusCode: 429, type: 'rate_limit_error' });
    });
    const stripe = { transfers: { create: transfersCreate, list: vi.fn() } } as unknown as Stripe;

    const result = await executePayoutTransfers(db, { stripe });
    expect(result.ambiguous).toEqual([payouts[0]!.payoutId]);
    expect((await payoutOf(payouts[0]!.payoutId)).metadata.transferState).toBe('posted');
  });

  it('two workers retrying one posted intent: only one POSTs', async () => {
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    // An intent posted 10 minutes ago: past the cooldown, inside the window.
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({ transferState: 'posted', postedAt: hoursAgo(0.17).toISOString() }),
        ]),
      });
    const { stripe, transfersCreate } = mockStripe({
      onCreate: () => {
        const until = Date.now() + 50;
        while (Date.now() < until) {
          /* hold the key in flight */
        }
      },
    });

    await Promise.all([
      executePayoutTransfers(db, { stripe }),
      executePayoutTransfers(db, { stripe }),
    ]);

    // The retry lease swaps the exact postedAt it read, so only one worker
    // can claim it — the other backs off rather than racing the key.
    expect(transfersCreate).toHaveBeenCalledOnce();
  });

  it('a retry re-reads the transfer instead of trusting the replayed body', async () => {
    // Stripe replays the response it STORED at creation time, so a
    // transfer reversed since then still says reversed:false there.
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({ transferState: 'posted', postedAt: hoursAgo(0.17).toISOString(), attempts: 1 }),
        ]),
      });

    const staleReplay = { id: 'tr_replay', amount: 5000, currency: 'usd', reversed: false, metadata: {} };
    const liveRetrieve = vi.fn(async () => ({ ...staleReplay, reversed: true, amount_reversed: 5000 }));
    const stripe = {
      transfers: { create: vi.fn(async () => staleReplay), list: vi.fn(), retrieve: liveRetrieve },
    } as unknown as Stripe;

    const result = await executePayoutTransfers(db, { stripe });
    expect(liveRetrieve).toHaveBeenCalledWith('tr_replay');
    expect(result.failed).toEqual([{ payoutId, error: 'transfer_reversed' }]);

    const payout = await payoutOf(payoutId);
    expect(payout.status).toBe('failed'); // NOT resurrected as paid
    const commission = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(commission.status).toBe('approved'); // never marked paid
  });

  it('a commission frozen on an open intent cannot be reversed out from under it', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 2, '40.00');
    await plan();

    const interlock = await interlockCommissionReversal(db, commissionIds);
    expect(interlock.held.sort()).toEqual([...commissionIds].sort());
    expect(interlock.flippable).toHaveLength(0);
  });

  it('once the intent is done with them, commissions are reversible again', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const transfersCreate = vi.fn(async () => {
      throw definiteError();
    });
    const stripe = { transfers: { create: transfersCreate, list: vi.fn() } } as unknown as Stripe;
    await executePayoutTransfers(db, { stripe });

    // Intent canceled, claims released → reversal is allowed once more.
    expect((await payoutOf(payouts[0]!.payoutId)).metadata.transferState).toBe('canceled');
    const interlock = await interlockCommissionReversal(db, commissionIds);
    expect(interlock.flippable).toEqual(commissionIds);
  });
});

describe.skipIf(skipIntegration)('the idempotency window survives repeated retries', () => {
  it('retrying does not push the 24h window out — it still reconciles', async () => {
    // Regression: the retry lease bumped `postedAt`, which is also what
    // the window is measured from. A steadily-retried intent refreshed its
    // own window forever, never reconciled, and would eventually re-POST a
    // key Stripe had pruned — creating a SECOND transfer.
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;

    // First post was 25h ago; a retry claimed it 2 minutes ago.
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({
            transferState: 'posted',
            postedAt: hoursAgo(25).toISOString(),
            leaseAt: hoursAgo(0.03).toISOString(),
            attempts: 4,
          }),
        ]),
      });
    const { stripe, transfersCreate, transfersList } = mockStripe({ listed: [] });

    await executePayoutTransfers(db, { stripe });

    // Past the window ⇒ reconcile by listing, never a blind re-POST.
    expect(transfersList).toHaveBeenCalledOnce();
    expect(transfersCreate).not.toHaveBeenCalled();
    expect((await payoutOf(payoutId)).metadata.transferState).toBe('intent'); // proven absent, re-armed
  });

  it('the cooldown reads the lease clock, not the first post', async () => {
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    // Posted 3h ago (inside the window), last attempt 5 seconds ago.
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({
            transferState: 'posted',
            postedAt: hoursAgo(3).toISOString(),
            leaseAt: new Date(Date.now() - 5_000).toISOString(),
          }),
        ]),
      });
    const { stripe, transfersCreate } = mockStripe();

    const result = await executePayoutTransfers(db, { stripe });
    expect(transfersCreate).not.toHaveBeenCalled(); // cooling down
    expect(result.skipped).toBe(1);
  });
});

// ---- Round-2 review fixes (Codex, 2026-08-09) ------------------------------

describe.skipIf(skipIntegration)('round-2 hardening', () => {
  it('a warm lease is never stolen by the expiry path', async () => {
    // The window check used to run first and CAS on transferState alone,
    // so a worker that had just leased and was inside transfers.create
    // could have its intent reconciled and finalized underneath it — then
    // its POST landed on a pruned key and created a SECOND transfer.
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({
            transferState: 'posted',
            postedAt: hoursAgo(30).toISOString(), // long past the window
            leaseAt: new Date(Date.now() - 5_000).toISOString(), // but just leased
          }),
        ]),
      });
    const { stripe, transfersList, transfersCreate } = mockStripe({ listed: [] });

    const result = await executePayoutTransfers(db, { stripe });

    expect(transfersList).not.toHaveBeenCalled();
    expect(transfersCreate).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect((await payoutOf(payoutId)).metadata.transferState).toBe('posted');
  });

  it('stops trusting the key before Stripe can prune it, not exactly at 24h', async () => {
    const partnerId = await seedPartner();
    await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    // 23.5h old: inside Stripe's retention, but inside the safety margin.
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({
            transferState: 'posted',
            postedAt: hoursAgo(23.5).toISOString(),
            leaseAt: hoursAgo(23.5).toISOString(),
          }),
        ]),
      });
    const { stripe, transfersList, transfersCreate } = mockStripe({ listed: [] });

    await executePayoutTransfers(db, { stripe });

    expect(transfersCreate).not.toHaveBeenCalled(); // no race against the expiry
    expect(transfersList).toHaveBeenCalledOnce();
  });

  it('classifies a 400-level idempotency error as ambiguous', async () => {
    // stripe-node puts 'idempotency_error' on rawType; the wrapper class
    // name is on type. Matching type against the API string never fired.
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 1, '50.00');
    const { payouts } = await plan();
    const transfersCreate = vi.fn(async () => {
      throw Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
        statusCode: 400,
        type: 'StripeIdempotencyError',
        rawType: 'idempotency_error',
      });
    });
    const stripe = { transfers: { create: transfersCreate, list: vi.fn() } } as unknown as Stripe;

    const result = await executePayoutTransfers(db, { stripe });

    expect(result.failed).toHaveLength(0);
    expect(result.ambiguous).toEqual([payouts[0]!.payoutId]);
    const commission = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(commission.payoutId).toBe(payouts[0]!.payoutId); // claim held
  });

  it('a commission claimed after the interlock check cannot still be reversed', async () => {
    // The interlock read and the status flip are separate statements. The
    // planner can claim the commission in between, so the UPDATE itself
    // re-asserts the guard.
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 1, '50.00');
    // Interlock says flippable (nothing claims it yet).
    const before = await interlockCommissionReversal(db, commissionIds);
    expect(before.flippable).toEqual(commissionIds);

    // …planner commits an intent in the gap…
    await plan();

    // …and the reversal that was already authorized must now refuse.
    const reversed = await whereNotClaimedByOpenIntent(
      db,
      db(TABLES.Commission).where({ [`${TABLES.Commission}.id`]: commissionIds[0]! }).whereIn('status', ['accrued', 'approved']),
    ).update({ status: 'reversed' });
    expect(reversed).toBe(0);
    expect((await db(TABLES.Commission).where({ id: commissionIds[0]! }).first()).status).toBe('approved');
  });

  it('holds a commission whose payout row cannot be resolved (fails closed)', async () => {
    const partnerId = await seedPartner();
    const commissionIds = await seedApproved(partnerId, 1, '50.00');
    // payoutId pointing at nothing — no FK exists on this column.
    await db(TABLES.Commission).where({ id: commissionIds[0]! }).update({ payoutId: 'missing-payout' });

    const interlock = await interlockCommissionReversal(db, commissionIds);
    expect(interlock.held).toEqual(commissionIds);
    expect(interlock.flippable).toHaveLength(0);
  });

  it('processes least-recently-attempted first so stuck intents cannot starve the rest', async () => {
    const stuckPartner = await seedPartner();
    await seedApproved(stuckPartner, 1, '50.00');
    const { payouts: stuckPayouts } = await plan();
    // An old intent that has been retried very recently.
    await db(TABLES.Payout)
      .where({ id: stuckPayouts[0]!.payoutId })
      .update({
        createdAt: hoursAgo(72),
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({
            transferState: 'posted',
            postedAt: hoursAgo(2).toISOString(),
            leaseAt: new Date().toISOString(),
          }),
        ]),
      });

    const freshPartner = await seedPartner();
    await seedApproved(freshPartner, 1, '25.00');
    const { payouts: freshPayouts } = await plan();

    const { stripe, transfersCreate } = mockStripe();
    await executePayoutTransfers(db, { stripe });

    // The newer, never-attempted intent is served even though an older
    // row exists — it sorts first because it has no lease timestamp.
    expect(transfersCreate).toHaveBeenCalledOnce();
    expect((await payoutOf(freshPayouts[0]!.payoutId)).status).toBe('paid');
  });
});
