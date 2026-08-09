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
