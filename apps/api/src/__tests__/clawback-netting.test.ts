/**
 * Netting refund clawbacks off a partner's next payout
 * (clawback-netting.ts, docs/refund-clawback-netting.md). DB-backed;
 * Stripe is a hand-rolled mock, as in payout-transfer-intent.test.ts.
 * These lock in:
 *
 *   - manual and direct-Connect payouts deduct the partner's outstanding
 *     refund_clawback adjustments and stamp the payout on them, keeping
 *     payout = Σ commissions − Σ netted clawbacks
 *   - owing at least what's due holds the whole group: no zero or negative
 *     payout, nothing stamped, and a later run nets it
 *   - the threshold applies to the net amount
 *   - transfer_reversed is never netted, and a clawback can't take more
 *     than the partner still holds from its commission
 *   - currencies don't mix
 *   - every way the direct-Connect executor abandons an intent releases the
 *     stamps (preflight, definite failure, operator dispose, all-reversed);
 *     a kept transfer and an operator re-arm keep them
 *   - one clawback can't be stamped onto two payouts
 *   - the hosted funding rail and connect-blocked failure rows never net
 *   - end to end: a refund of a paid commission comes off the next payout
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { ulid } from 'ulid';

// Real dispatch, observed; partner postbacks captured instead of fired.
vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn(actual.dispatchEvent) };
});
vi.mock('../partner-postback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../partner-postback.js')>();
  return { ...actual, dispatchPartnerPostbacks: vi.fn() };
});

const { TABLES, DEFAULT_TENANT_ID } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { runPayouts } = await import('../payouts.js');
const {
  disposeIntent,
  executePayoutTransfers,
  idempotencyKeyFor,
  releaseIntentForRetry,
  resolveDuplicateReview,
} = await import('../payout-transfers.js');
const { stampClawbacks } = await import('../clawback-netting.js');
const { recordRefund } = await import('../refunds.js');
const { dispatchEvent } = await import('../webhook-dispatcher.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;

// ---- Stripe mock ----------------------------------------------------------

interface FakeTransfer {
  id: string;
  amount: number;
  currency: string;
  transfer_group?: string;
  destination?: string;
  metadata: Record<string, string>;
  amount_reversed?: number;
  reversed?: boolean;
}

function mockStripe(opts: { listed?: FakeTransfer[]; createError?: Error } = {}) {
  const created: FakeTransfer[] = [];
  const transfersCreate = vi.fn(
    async (params: { amount: number; currency: string; destination?: string; transfer_group?: string; metadata: Record<string, string> }) => {
      if (opts.createError) throw opts.createError;
      const t: FakeTransfer = { id: `tr_${ulid()}`, ...params };
      created.push(t);
      return t;
    },
  );
  const transfersList = vi.fn(async ({ transfer_group }: { transfer_group?: string }) => ({
    data: (opts.listed ?? []).filter((t) => !transfer_group || t.transfer_group === transfer_group),
    has_more: false,
  }));
  const transfersRetrieve = vi.fn(
    async (id: string) =>
      [...created, ...(opts.listed ?? [])].find((t) => t.id === id) ?? { id, amount: 0, currency: 'usd', metadata: {} },
  );
  const stripe = {
    transfers: { create: transfersCreate, list: transfersList, retrieve: transfersRetrieve },
  } as unknown as Stripe;
  return { stripe, transfersCreate };
}

function definiteError(message = 'No such destination'): Error {
  return Object.assign(new Error(message), { statusCode: 400, type: 'StripeInvalidRequestError' });
}

// ---- Seeding --------------------------------------------------------------

const TABLES_TO_CLEAN = [
  TABLES.CommissionAdjustment,
  TABLES.HostedFundingAllocation,
  TABLES.HostedFundingTransfer,
  TABLES.HostedFundingBatch,
  TABLES.HostedFundingAuthorization,
  TABLES.Commission,
  TABLES.Payout,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Click,
  TABLES.Program,
  TABLES.Partner,
];

async function clean() {
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: TENANT }).del();
}

let tenantBefore: Record<string, unknown> | undefined;
const fundingFlagBefore = process.env.HOSTED_FUNDING_ENABLED;

beforeAll(async () => {
  if (skipIntegration) return;
  tenantBefore = await db(TABLES.Tenant)
    .where({ id: TENANT })
    .first('payoutRailPreference', 'payoutThresholdCents', 'billingPlan', 'stripeCustomerId', 'stripeSubscriptionId');
});

beforeEach(async () => {
  if (skipIntegration) return;
  await clean();
  await db(TABLES.Tenant).where({ id: TENANT }).update({ payoutRailPreference: 'auto', payoutThresholdCents: 0 });
  vi.mocked(dispatchEvent).mockClear();
});

afterAll(async () => {
  if (!skipIntegration) {
    // Announcements are fire-and-forget; let the last ones land first.
    await new Promise((r) => setTimeout(r, 50));
    await clean();
    if (tenantBefore) await db(TABLES.Tenant).where({ id: TENANT }).update(tenantBefore);
  }
  if (fundingFlagBefore === undefined) delete process.env.HOSTED_FUNDING_ENABLED;
  else process.env.HOSTED_FUNDING_ENABLED = fundingFlagBefore;
  await db.destroy();
});

async function seedPartner(transferReady: boolean): Promise<string> {
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

/** One conversion credited to `partnerId`, with one commission on it. */
async function seedCommission(
  partnerId: string,
  amount: string,
  opts: { status?: 'approved' | 'paid'; currency?: string } = {},
): Promise<{ commissionId: string; eventId: string }> {
  const currency = opts.currency ?? 'USD';
  const programId = ulid();
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: TENANT,
    name: 'prog',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 100 }]),
    destinationUrl: 'https://x.test',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  const clickId = ulid();
  await db(TABLES.Click).insert({ id: clickId, tenantId: TENANT, partnerId, programId, landingUrl: 'https://x.test/', ts: new Date() });
  const eventId = ulid();
  await db(TABLES.Event).insert({
    id: eventId,
    tenantId: TENANT,
    userId: `u-${clickId}`,
    type: 'invoice_paid',
    value: amount,
    currency,
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
  const paid = opts.status === 'paid';
  await db(TABLES.Commission).insert({
    id: commissionId,
    tenantId: TENANT,
    partnerId,
    attributionId,
    amount,
    currency,
    status: opts.status ?? 'approved',
    ...(paid ? { paidAt: new Date(), payoutId: `pay_${ulid()}` } : {}),
  });
  return { commissionId, eventId };
}

async function adjust(
  commissionId: string,
  amount: string,
  reason: 'refund_clawback' | 'transfer_reversed' | 'admin_correction' = 'refund_clawback',
  extra: { currency?: string; appliedPayoutId?: string } = {},
): Promise<string> {
  const id = ulid();
  await db(TABLES.CommissionAdjustment).insert({
    id,
    tenantId: TENANT,
    commissionId,
    amount,
    currency: extra.currency ?? 'USD',
    reason,
    metadata: {},
    appliedPayoutId: extra.appliedPayoutId ?? null,
    createdAt: new Date(),
  });
  return id;
}

/** A partner already paid `paidAmount`, then a refund clawback of `clawback`. */
async function seedClawback(partnerId: string, paidAmount: string, clawback: string, currency = 'USD') {
  const { commissionId } = await seedCommission(partnerId, paidAmount, { status: 'paid', currency });
  const adjustmentId = await adjust(commissionId, clawback, 'refund_clawback', { currency });
  return { commissionId, adjustmentId };
}

async function plan() {
  return db.transaction((trx) => runPayouts(trx, TENANT));
}

async function appliedTo(adjustmentId: string): Promise<string | null> {
  const row = await db(TABLES.CommissionAdjustment).where({ id: adjustmentId }).first('appliedPayoutId');
  return row.appliedPayoutId;
}

async function payoutRow(payoutId: string) {
  return (await db(TABLES.Payout).where({ id: payoutId }).first()) as {
    id: string;
    amount: string;
    status: string;
    stripeTransferId: string | null;
    metadata: Record<string, unknown> & { transferState?: string; amountMinor?: number };
  };
}

/** Invariant N: amount = Σ its commissions − Σ the clawbacks stamped with it. */
async function expectNetInvariant(payoutId: string) {
  const payout = await payoutRow(payoutId);
  const commissions = (await db(TABLES.Commission).where({ payoutId }).select('amount')) as Array<{ amount: string }>;
  const netted = (await db(TABLES.CommissionAdjustment).where({ appliedPayoutId: payoutId }).select('amount')) as Array<{ amount: string }>;
  const minor = (rows: Array<{ amount: string }>) => rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);
  const expected = minor(commissions) + minor(netted);
  expect(Math.round(Number(payout.amount) * 100)).toBe(expected);
  if (payout.metadata.amountMinor !== undefined) expect(payout.metadata.amountMinor).toBe(expected);
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

async function markPostedLongAgo(payoutId: string) {
  await db(TABLES.Payout)
    .where({ id: payoutId })
    .update({
      metadata: db.raw(`"metadata" || ?::jsonb`, [
        JSON.stringify({ transferState: 'posted', postedAt: hoursAgo(25).toISOString() }),
      ]),
    });
}

// ---- Manual rail ----------------------------------------------------------

describe.skipIf(skipIntegration)('manual rail', () => {
  it('nets an outstanding refund clawback off the next payout and stamps the payout on it', async () => {
    const partnerId = await seedPartner(false);
    const { adjustmentId } = await seedClawback(partnerId, '40.00', '-15.00');
    const { commissionId: a } = await seedCommission(partnerId, '30.00');
    const { commissionId: b } = await seedCommission(partnerId, '20.00');

    const result = await plan();

    expect(result.heldForClawback).toEqual([]);
    expect(result.payouts).toHaveLength(1);
    const p = result.payouts[0]!;
    expect(p).toMatchObject({ method: 'manual', amount: 35, clawbackAmount: 15 });
    const payout = await payoutRow(p.payoutId);
    expect(payout.amount).toBe('35.00');
    expect(payout.metadata.netting).toEqual({ grossCents: 5000, clawbackCents: 1500, adjustmentIds: [adjustmentId] });
    expect(await appliedTo(adjustmentId)).toBe(p.payoutId);
    const commissions = await db(TABLES.Commission).whereIn('id', [a, b]);
    expect(commissions.every((c) => c.status === 'paid' && c.payoutId === p.payoutId)).toBe(true);
    await expectNetInvariant(p.payoutId);

    // The announcement says how amount relates to the commissions it lists.
    expect(result.pendingNotifications[0]!.payout).toMatchObject({
      amount: '35.00',
      grossAmount: '50.00',
      clawbackAmount: '15.00',
      clawbackAdjustmentIds: [adjustmentId],
    });

    // Netted once: the next run has nothing to deduct, or pay.
    const again = await plan();
    expect(again.payouts).toEqual([]);
    expect(again.heldForClawback).toEqual([]);
  });

  it('holds a partner who owes at least what they are due, then nets once enough accrues', async () => {
    const partnerId = await seedPartner(false);
    const { adjustmentId } = await seedClawback(partnerId, '100.00', '-60.00');
    const { commissionId: first } = await seedCommission(partnerId, '50.00');

    const owesMore = await plan();
    expect(owesMore.payouts).toEqual([]);
    expect(owesMore.heldForClawback).toEqual([{ partnerId, currency: 'USD', amount: 50, clawbackAmount: 60 }]);
    expect(await db(TABLES.Payout).where({ tenantId: TENANT })).toHaveLength(0);
    expect(await db(TABLES.Commission).where({ id: first }).first()).toMatchObject({ status: 'approved', payoutId: null });
    expect(await appliedTo(adjustmentId)).toBeNull();

    // Owing exactly what's due would be a zero payout: still held.
    await seedCommission(partnerId, '10.00');
    const even = await plan();
    expect(even.payouts).toEqual([]);
    expect(even.heldForClawback).toEqual([{ partnerId, currency: 'USD', amount: 60, clawbackAmount: 60 }]);

    await seedCommission(partnerId, '15.00');
    const covered = await plan();
    expect(covered.heldForClawback).toEqual([]);
    expect(covered.payouts).toHaveLength(1);
    expect(covered.payouts[0]).toMatchObject({ amount: 15, clawbackAmount: 60 });
    expect(await appliedTo(adjustmentId)).toBe(covered.payouts[0]!.payoutId);
    await expectNetInvariant(covered.payouts[0]!.payoutId);
  });

  it('measures the payout threshold on the net amount', async () => {
    await db(TABLES.Tenant).where({ id: TENANT }).update({ payoutThresholdCents: 5000 });
    const partnerId = await seedPartner(false);
    const { adjustmentId } = await seedClawback(partnerId, '40.00', '-20.00');
    await seedCommission(partnerId, '60.00');

    const result = await plan();

    expect(result.payouts).toEqual([]);
    expect(result.skippedBelowThreshold).toEqual([{ partnerId, currency: 'USD', amount: 40 }]);
    expect(await appliedTo(adjustmentId)).toBeNull();
  });

  it('never nets transfer_reversed, nor a clawback on a commission whose transfer came back', async () => {
    const partnerId = await seedPartner(false);
    // Clawback recorded, then the whole transfer was reversed: the partner
    // returned everything, so taking the clawback too would take it twice.
    const { commissionId: returned } = await seedCommission(partnerId, '40.00', { status: 'paid' });
    const stale = await adjust(returned, '-10.00', 'refund_clawback');
    const reversal = await adjust(returned, '-40.00', 'transfer_reversed');
    // A reversal on its own is never a deduction either.
    const { commissionId: other } = await seedCommission(partnerId, '25.00', { status: 'paid' });
    const otherReversal = await adjust(other, '-25.00', 'transfer_reversed');
    await seedCommission(partnerId, '30.00');

    const result = await plan();

    expect(result.payouts).toHaveLength(1);
    expect(result.payouts[0]!.amount).toBe(30);
    expect(result.payouts[0]!.clawbackAmount).toBeUndefined();
    expect((await payoutRow(result.payouts[0]!.payoutId)).metadata.netting).toBeUndefined();
    for (const id of [stale, reversal, otherReversal]) expect(await appliedTo(id)).toBeNull();
  });

  it('nets a clawback only while it fits in what the partner still holds from its commission', async () => {
    const partnerId = await seedPartner(false);
    const { commissionId } = await seedCommission(partnerId, '40.00', { status: 'paid' });
    await adjust(commissionId, '-35.00', 'admin_correction'); // the partner holds 5.00 of it now
    const tooBig = await adjust(commissionId, '-10.00');
    const fits = await adjust(commissionId, '-5.00');
    await seedCommission(partnerId, '30.00');

    const result = await plan();

    expect(result.payouts[0]).toMatchObject({ amount: 25, clawbackAmount: 5 });
    expect(await appliedTo(tooBig)).toBeNull();
    expect(await appliedTo(fits)).toBe(result.payouts[0]!.payoutId);
  });

  it('nets clawbacks only off a payout in their own currency', async () => {
    const partnerId = await seedPartner(false);
    const { adjustmentId } = await seedClawback(partnerId, '40.00', '-10.00', 'EUR');
    await seedCommission(partnerId, '30.00');
    await seedCommission(partnerId, '50.00', { currency: 'EUR' });

    const result = await plan();

    const byCurrency = Object.fromEntries(result.payouts.map((p) => [p.currency, p]));
    expect(byCurrency.USD).toMatchObject({ amount: 30 });
    expect(byCurrency.USD!.clawbackAmount).toBeUndefined();
    expect(byCurrency.EUR).toMatchObject({ amount: 40, clawbackAmount: 10 });
    expect(await appliedTo(adjustmentId)).toBe(byCurrency.EUR!.payoutId);
  });

  it('end to end: a refund of a paid commission comes off the next payout, and refunds after it add up', async () => {
    const partnerId = await seedPartner(false);
    const { commissionId, eventId } = await seedCommission(partnerId, '40.00');
    const paidRun = await plan();
    expect(paidRun.payouts[0]!.amount).toBe(40);

    const refundOf = (amount: number, key: string) =>
      db.transaction((trx) =>
        recordRefund(trx, TENANT, { conversionEventId: eventId, amount, kind: 'refund', externalEventId: key }),
      );
    const first = await refundOf(10, 'rf-net-1');
    if (!first.ok) throw new Error(first.error);
    expect(first.body.commissions[0]).toMatchObject({ commissionId, status: 'clawback_recorded', clawbackAmount: '-10.00' });

    await seedCommission(partnerId, '30.00');
    const nettingRun = await plan();
    expect(nettingRun.payouts[0]).toMatchObject({ amount: 20, clawbackAmount: 10 });
    await expectNetInvariant(nettingRun.payouts[0]!.payoutId);

    // A netted clawback still counts toward what the partner holds, so a
    // second refund claws back only its own share.
    const second = await refundOf(10, 'rf-net-2');
    if (!second.ok) throw new Error(second.error);
    expect(second.body.commissions[0]).toMatchObject({ keptAmount: '20.00', clawbackAmount: '-20.00' });
    const open = await db(TABLES.CommissionAdjustment).where({ commissionId }).whereNull('appliedPayoutId');
    expect(open.map((a) => a.amount)).toEqual(['-10.00']);

    await seedCommission(partnerId, '25.00');
    const third = await plan();
    expect(third.payouts[0]).toMatchObject({ amount: 15, clawbackAmount: 10 });
  });
});

// ---- Direct-Connect rail --------------------------------------------------

describe.skipIf(skipIntegration)('direct-Connect rail', () => {
  async function plannedIntent() {
    const partnerId = await seedPartner(true);
    const { adjustmentId } = await seedClawback(partnerId, '40.00', '-15.00');
    const { commissionId } = await seedCommission(partnerId, '50.00');
    const { payouts } = await plan();
    expect(payouts).toHaveLength(1);
    return { partnerId, adjustmentId, commissionId, payoutId: payouts[0]!.payoutId };
  }

  it('freezes the net amount on the intent and transfers exactly that', async () => {
    const { adjustmentId, commissionId, payoutId } = await plannedIntent();
    const intent = await payoutRow(payoutId);
    expect(intent.metadata).toMatchObject({ transferState: 'intent', amountMinor: 3500 });
    expect(await appliedTo(adjustmentId)).toBe(payoutId);
    await expectNetInvariant(payoutId);

    const { stripe, transfersCreate } = mockStripe();
    const result = await executePayoutTransfers(db, { stripe, tenantId: TENANT });

    expect(result.confirmed).toHaveLength(1);
    expect(transfersCreate).toHaveBeenCalledOnce();
    expect((transfersCreate.mock.calls[0]![0] as { amount: number }).amount).toBe(3500);
    const paid = await payoutRow(payoutId);
    expect(paid).toMatchObject({ status: 'paid', amount: '35.00' });
    expect(await db(TABLES.Commission).where({ id: commissionId }).first()).toMatchObject({ status: 'paid', payoutId });
    expect(await appliedTo(adjustmentId)).toBe(payoutId);
    await expectNetInvariant(payoutId);
    expect(vi.mocked(dispatchEvent).mock.calls.filter((c) => c[1] === 'payout.created').map((c) => c[2])).toEqual([
      expect.objectContaining({
        payoutId,
        amount: '35.00',
        grossAmount: '50.00',
        clawbackAmount: '15.00',
        clawbackAdjustmentIds: [adjustmentId],
      }),
    ]);
  });

  it('nets in hundredths and freezes Stripe\'s integer form for a zero-decimal currency', async () => {
    const partnerId = await seedPartner(true);
    const { adjustmentId } = await seedClawback(partnerId, '1000.00', '-300.00', 'JPY');
    await seedCommission(partnerId, '1000.00', { currency: 'JPY' });
    // ¥100 due against a ¥99.60 clawback is ¥0.40 net, which is ¥0 to
    // Stripe: held, like any other non-positive net.
    const tiny = await seedPartner(true);
    await seedClawback(tiny, '100.00', '-99.60', 'JPY');
    await seedCommission(tiny, '100.00', { currency: 'JPY' });

    const { payouts, heldForClawback } = await plan();

    expect(heldForClawback).toEqual([{ partnerId: tiny, currency: 'JPY', amount: 100, clawbackAmount: 99.6 }]);
    expect(payouts).toHaveLength(1);
    const payoutId = payouts[0]!.payoutId;
    expect(payouts[0]).toMatchObject({ partnerId, currency: 'JPY', amount: 700, clawbackAmount: 300 });
    const intent = await payoutRow(payoutId);
    expect(intent.amount).toBe('700.00');
    // ¥700 is 700 to Stripe, not 70000.
    expect(intent.metadata).toMatchObject({ transferState: 'intent', amountMinor: 700 });
    expect(intent.metadata.netting).toEqual({ grossCents: 100000, clawbackCents: 30000, adjustmentIds: [adjustmentId] });

    const { stripe, transfersCreate } = mockStripe();
    const result = await executePayoutTransfers(db, { stripe, tenantId: TENANT });

    expect(result.confirmed).toHaveLength(1);
    expect((transfersCreate.mock.calls[0]![0] as { amount: number; currency: string }).amount).toBe(700);
    expect(await payoutRow(payoutId)).toMatchObject({ status: 'paid', amount: '700.00' });
    expect(vi.mocked(dispatchEvent).mock.calls.filter((c) => c[1] === 'payout.created').map((c) => c[2])).toEqual([
      expect.objectContaining({ payoutId, amount: '700.00', grossAmount: '1000.00', clawbackAmount: '300.00' }),
    ]);
  });

  it('preflight drops an intent whose netted clawbacks no longer match its frozen amount', async () => {
    const { adjustmentId, commissionId, payoutId } = await plannedIntent();
    await db(TABLES.CommissionAdjustment).where({ id: adjustmentId }).update({ appliedPayoutId: null });

    const { stripe, transfersCreate } = mockStripe();
    const result = await executePayoutTransfers(db, { stripe, tenantId: TENANT });

    expect(transfersCreate).not.toHaveBeenCalled();
    expect(result.canceled).toEqual([{ payoutId, reason: 'commission_amount_changed' }]);
    expect(await db(TABLES.Commission).where({ id: commissionId }).first()).toMatchObject({ status: 'approved', payoutId: null });
    // The next run regroups and nets it again.
    const { payouts } = await plan();
    expect(payouts[0]).toMatchObject({ amount: 35, clawbackAmount: 15 });
    expect(await appliedTo(adjustmentId)).toBe(payouts[0]!.payoutId);
  });

  it('a definite Stripe failure releases the clawbacks with the commissions', async () => {
    const { adjustmentId, commissionId, payoutId } = await plannedIntent();

    const { stripe } = mockStripe({ createError: definiteError() });
    const result = await executePayoutTransfers(db, { stripe, tenantId: TENANT });

    expect(result.failed.map((f) => f.payoutId)).toEqual([payoutId]);
    expect((await payoutRow(payoutId)).metadata.transferState).toBe('canceled');
    expect(await db(TABLES.Commission).where({ id: commissionId }).first()).toMatchObject({ payoutId: null });
    expect(await appliedTo(adjustmentId)).toBeNull();
    const { payouts } = await plan();
    expect(payouts[0]).toMatchObject({ amount: 35, clawbackAmount: 15 });
  });

  it('abandoning an intent before Stripe (partner no longer ready) releases them', async () => {
    const { partnerId, adjustmentId, payoutId } = await plannedIntent();
    await db(TABLES.Partner).where({ id: partnerId }).update({ metadata: { stripe: { payoutsEnabled: false } } });

    const { stripe, transfersCreate } = mockStripe();
    const result = await executePayoutTransfers(db, { stripe, tenantId: TENANT });

    expect(transfersCreate).not.toHaveBeenCalled();
    expect(result.canceled).toEqual([{ payoutId, reason: 'stripe_onboarding_incomplete' }]);
    expect(await appliedTo(adjustmentId)).toBeNull();
  });

  it('an operator re-arm keeps the deduction; an operator dispose releases it', async () => {
    const rearm = await plannedIntent();
    await markPostedLongAgo(rearm.payoutId);
    const empty = mockStripe({ listed: [] });
    await executePayoutTransfers(db, { stripe: empty.stripe, tenantId: TENANT });
    expect((await payoutRow(rearm.payoutId)).metadata.transferState).toBe('reconcile_required');

    expect(await releaseIntentForRetry(db, rearm.payoutId, 0, 'keith', empty.stripe)).toBe('rearmed');
    expect(await appliedTo(rearm.adjustmentId)).toBe(rearm.payoutId);
    await executePayoutTransfers(db, { stripe: empty.stripe, tenantId: TENANT });
    expect(empty.transfersCreate).toHaveBeenCalledOnce();
    const [params, options] = empty.transfersCreate.mock.calls[0]! as unknown as [{ amount: number }, { idempotencyKey: string }];
    expect(params.amount).toBe(3500);
    expect(options.idempotencyKey).toBe(idempotencyKeyFor(rearm.payoutId, 1));
    expect(await appliedTo(rearm.adjustmentId)).toBe(rearm.payoutId);

    await clean();
    const dispose = await plannedIntent();
    await markPostedLongAgo(dispose.payoutId);
    await executePayoutTransfers(db, { stripe: mockStripe({ listed: [] }).stripe, tenantId: TENANT });
    expect(await disposeIntent(db, dispose.payoutId, 'keith', 'confirmed_no_transfer', mockStripe({ listed: [] }).stripe)).toBe('disposed');
    expect(await appliedTo(dispose.adjustmentId)).toBeNull();
    expect(await db(TABLES.Commission).where({ id: dispose.commissionId }).first()).toMatchObject({ payoutId: null });
  });

  it('duplicate review: a kept transfer keeps the deduction, all-reversed releases it', async () => {
    const parkInReview = (payoutId: string) =>
      db(TABLES.Payout)
        .where({ id: payoutId })
        .update({ metadata: db.raw(`"metadata" || ?::jsonb`, [JSON.stringify({ transferState: 'duplicate_review' })]) });
    const transfer = (partnerId: string, payoutId: string, over: Partial<FakeTransfer> = {}): FakeTransfer => ({
      id: `tr_${ulid()}`,
      amount: 3500, // the frozen NET amount
      currency: 'usd',
      destination: `acct_${partnerId.slice(0, 10)}`,
      transfer_group: payoutId,
      metadata: { openpartner_payout_id: payoutId },
      ...over,
    });

    const kept = await plannedIntent();
    await parkInReview(kept.payoutId);
    const keep = transfer(kept.partnerId, kept.payoutId);
    const surplus = transfer(kept.partnerId, kept.payoutId, { amount_reversed: 3500, reversed: true });
    const { stripe } = mockStripe({ listed: [keep, surplus] });
    expect(await resolveDuplicateReview(db, kept.payoutId, 'keith', { keptTransferId: keep.id }, stripe)).toBe('resolved');
    expect(await appliedTo(kept.adjustmentId)).toBe(kept.payoutId);
    await expectNetInvariant(kept.payoutId);

    await clean();
    const reversed = await plannedIntent();
    await parkInReview(reversed.payoutId);
    const gone = transfer(reversed.partnerId, reversed.payoutId, { amount_reversed: 3500, reversed: true });
    expect(
      await resolveDuplicateReview(db, reversed.payoutId, 'keith', { allReversed: true }, mockStripe({ listed: [gone] }).stripe),
    ).toBe('resolved');
    expect(await appliedTo(reversed.adjustmentId)).toBeNull();
  });
});

// ---- Cross-cutting --------------------------------------------------------

describe.skipIf(skipIntegration)('netting guards', () => {
  it('one clawback cannot be stamped onto two payouts', async () => {
    const partnerId = await seedPartner(false);
    const { adjustmentId } = await seedClawback(partnerId, '40.00', '-10.00');

    await db.transaction((trx) => stampClawbacks(trx, 'pay_first', [adjustmentId]));
    await expect(db.transaction((trx) => stampClawbacks(trx, 'pay_second', [adjustmentId]))).rejects.toThrow(
      /netted 0\/1 refund clawbacks/,
    );
    expect(await appliedTo(adjustmentId)).toBe('pay_first');
  });

  it('a connect-blocked failure row pays nothing, so it nets nothing', async () => {
    await db(TABLES.Tenant).where({ id: TENANT }).update({ payoutRailPreference: 'stripe_connect' });
    const partnerId = await seedPartner(false); // no Connect account
    const { adjustmentId } = await seedClawback(partnerId, '40.00', '-15.00');
    await seedCommission(partnerId, '50.00');

    const result = await plan();

    expect(result.payouts[0]).toMatchObject({ amount: 50, error: 'stripe_connect_account_missing' });
    expect((await payoutRow(result.payouts[0]!.payoutId)).metadata.netting).toBeUndefined();
    expect(await appliedTo(adjustmentId)).toBeNull();
  });

  it('the hosted funding rail never nets: refused or reserved, the group is gross', async () => {
    await db(TABLES.Tenant)
      .where({ id: TENANT })
      .update({ billingPlan: 'flex', stripeCustomerId: 'cus_test', stripeSubscriptionId: 'sub_test' });
    const partnerId = await seedPartner(true);
    const { adjustmentId } = await seedClawback(partnerId, '40.00', '-15.00');
    const { commissionId } = await seedCommission(partnerId, '50.00');

    // Funding off: hosted Connect is refused, at the gross amount.
    delete process.env.HOSTED_FUNDING_ENABLED;
    const refused = await plan();
    expect(refused.skippedUnfunded).toEqual([{ partnerId, currency: 'USD', amount: 50 }]);
    expect(await appliedTo(adjustmentId)).toBeNull();

    // Funding on: the batch reserves the commissions at full value.
    process.env.HOSTED_FUNDING_ENABLED = '1';
    await db(TABLES.HostedFundingAuthorization).insert({
      id: ulid(),
      tenantId: TENANT,
      adminId: null,
      termsVersion: 'test',
      stripePaymentMethodId: 'pm_x',
      paymentMethodType: 'us_bank_account',
      acceptedAt: new Date(),
      revokedAt: null,
    });
    const reserved = await plan();
    expect(reserved.payouts).toEqual([]);
    const batch = await db(TABLES.HostedFundingBatch).where({ tenantId: TENANT }).first();
    expect(Number(batch.principalMinor)).toBe(5000);
    const allocations = await db(TABLES.HostedFundingAllocation).where({ batchId: batch.id });
    expect(allocations.map((a) => [a.commissionId, Number(a.amountMinor)])).toEqual([[commissionId, 5000]]);
    expect(await appliedTo(adjustmentId)).toBeNull();
  });
});
