/**
 * Stripe's integer amounts are not always hundredths. ¥1,000 arrives as
 * 1000 and KWD 12.350 as 12350, and a transfer has to go back out in the
 * same form. The webhook used to divide every amount by 100 and the payout
 * side multiply by 100, which cancelled for JPY (a ¥1,000 sale stored as
 * ¥10 paid its ¥2 commission as 200, i.e. ¥200) and so hid both bugs.
 *
 * These tests drive real webhook deliveries through to a manual payout and
 * a Connect transfer, and check the reconciliation compare against the
 * frozen intent, including intents frozen in hundredths before the fix.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import Stripe from 'stripe';
import {
  centsToStripeMinor,
  fromStripeMinor,
  stripeExponent,
  stripeMinorToCents,
  stripeMinorToMajorString,
  toStripeMinor,
} from '../stripe-amounts.js';

const STRIPE_SECRET = 'sk_test_dummy_for_currency_exponent_tests';
const WEBHOOK_SECRET = 'whsec_test_secret_for_currency_exponent_tests';

process.env.STRIPE_SECRET_KEY = STRIPE_SECRET;
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
// Self-host: a Connect payout transfers directly (no hosted funding guard),
// and the platform account is the brand's own Stripe.
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const stripeApi = vi.hoisted(() => ({
  customersRetrieve: vi.fn(),
  customersUpdate: vi.fn(),
  checkoutSessionsList: vi.fn(),
}));

vi.mock('stripe', async () => {
  const actual = await vi.importActual<typeof import('stripe')>('stripe');
  const Real = actual.default;
  function MockedStripe(this: unknown, key: string, opts?: Stripe.StripeConfig) {
    const instance = new Real(key, opts) as Stripe;
    (instance as unknown as { customers: unknown }).customers = {
      update: stripeApi.customersUpdate,
      retrieve: stripeApi.customersRetrieve,
    };
    (instance as unknown as { checkout: unknown }).checkout = {
      sessions: { list: stripeApi.checkoutSessionsList },
    };
    return instance;
  }
  (MockedStripe as unknown as { webhooks: unknown }).webhooks = (Real as unknown as { webhooks: unknown }).webhooks;
  return { default: MockedStripe };
});

vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn() };
});

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { runPayouts } = await import('../payouts.js');
const { executePayoutTransfers } = await import('../payout-transfers.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;
const app = createApp({ enableLogger: false });
const stripeForSigning = new Stripe(STRIPE_SECRET);

// ---- The helper itself ------------------------------------------------------

describe('stripe-amounts', () => {
  it("follows Stripe's currency lists, case-insensitively, defaulting to two decimals", () => {
    for (const c of ['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']) {
      expect(stripeExponent(c)).toBe(0);
    }
    for (const c of ['BHD', 'JOD', 'KWD', 'OMR', 'TND']) expect(stripeExponent(c)).toBe(3);
    // Stripe's special cases: two-decimal in the API.
    for (const c of ['ISK', 'UGX', 'HUF', 'TWD']) expect(stripeExponent(c)).toBe(2);
    expect(stripeExponent('jpy')).toBe(0);
    expect(stripeExponent(' Kwd ')).toBe(3);
    expect(stripeExponent('USD')).toBe(2);
    expect(stripeExponent('ZZZ')).toBe(2);
    expect(stripeExponent(null)).toBe(2);
    expect(stripeExponent(undefined)).toBe(2);
  });

  it('round-trips 0-, 2- and 3-decimal amounts between Stripe and storage', () => {
    // [Stripe integer, currency, stored major]
    const cases: Array<[number, string, string]> = [
      [1000, 'jpy', '1000.00'],
      [50, 'KRW', '50.00'],
      [4900, 'usd', '49.00'],
      [1099, 'EUR', '10.99'],
      [12350, 'kwd', '12.35'],
      [1230, 'BHD', '1.23'],
      [500, 'isk', '5.00'],
      [80045, 'TWD', '800.45'],
    ];
    for (const [minor, currency, major] of cases) {
      expect(stripeMinorToMajorString(minor, currency)).toBe(major);
      expect(fromStripeMinor(minor, currency)).toBe(Number(major));
      expect(toStripeMinor(major, currency)).toBe(minor);
    }
  });

  it('rounds where Stripe has no unit for the stored fraction', () => {
    // Zero-decimal: ¥100.50 can only be paid as ¥101.
    expect(toStripeMinor('100.50', 'JPY')).toBe(101);
    expect(toStripeMinor('100.49', 'JPY')).toBe(100);
    // ISK/UGX: two-decimal form, whole units only.
    expect(toStripeMinor('12.34', 'ISK')).toBe(1200);
    expect(toStripeMinor('12.50', 'UGX')).toBe(1300);
    // HUF/TWD fractions are chargeable and transferable.
    expect(toStripeMinor('10.45', 'HUF')).toBe(1045);
    // A third decimal Stripe didn't send in tens lands on the nearest hundredth.
    expect(stripeMinorToCents(12345, 'KWD')).toBe(1235);
    // Refunds round symmetrically.
    expect(toStripeMinor(-100.5, 'JPY')).toBe(-101);
    expect(fromStripeMinor(-400, 'jpy')).toBe(-400);
    expect(centsToStripeMinor(-1235, 'KWD')).toBe(-12350);
  });

  it('refuses a non-integer Stripe amount or a non-numeric stored one', () => {
    expect(() => fromStripeMinor(10.5, 'usd')).toThrow(/non-integer/);
    expect(() => toStripeMinor('abc', 'usd')).toThrow(/non-numeric/);
  });
});

// ---- Through the webhook to a payout ----------------------------------------

function postWebhook(eventPayload: object) {
  const body = JSON.stringify(eventPayload);
  const sig = stripeForSigning.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET });
  return request(app)
    .post('/webhooks/stripe')
    .set('content-type', 'application/json')
    .set('stripe-signature', sig)
    .send(body);
}

const now = () => Math.floor(Date.now() / 1000);

interface FakeTransfer {
  id: string;
  amount: number;
  currency: string;
  destination?: string;
  transfer_group?: string;
  metadata: Record<string, string>;
  created?: number;
}

/** A Connect API that records every transfer and can list a group. */
function mockTransfers(listed: FakeTransfer[] = []) {
  const created: FakeTransfer[] = [];
  const create = vi.fn(
    async (params: { amount: number; currency: string; destination?: string; transfer_group?: string; metadata: Record<string, string> }) => {
      const t: FakeTransfer = { id: `tr_${ulid()}`, ...params, created: now() };
      created.push(t);
      return t;
    },
  );
  const list = vi.fn(async ({ transfer_group }: { transfer_group?: string }) => ({
    data: listed.filter((t) => !transfer_group || t.transfer_group === transfer_group),
    has_more: false,
  }));
  const retrieve = vi.fn(async (id: string) => [...created, ...listed].find((t) => t.id === id));
  const stripe = { transfers: { create, list, retrieve } } as unknown as Stripe;
  return { stripe, create, list };
}

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.Program,
  TABLES.Payout,
  TABLES.Partner,
  TABLES.Config,
  // Every brand event the pipeline processes is logged (stripe-event-catchup.ts).
  TABLES.StripeEventLog,
];

beforeEach(async () => {
  stripeApi.customersRetrieve.mockReset().mockResolvedValue({ id: 'cus_mocked', metadata: {}, deleted: false });
  stripeApi.customersUpdate.mockReset().mockResolvedValue({ id: 'cus_mocked' });
  stripeApi.checkoutSessionsList.mockReset().mockResolvedValue({ object: 'list', data: [], has_more: false });
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
});

afterAll(async () => {
  if (!skipIntegration) for (const t of TABLES_TO_CLEAN) await db(t).del();
  await db.destroy();
});

/** A partner, a 20% program, a click, and a checkout that stitches the
 *  customer to it. Returns the Stripe customer id later events name. */
async function seedReferredCustomer(opts: { connect: boolean }) {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  const destination = `acct_${partnerId.slice(0, 10)}`;
  await db(TABLES.Partner).insert({
    id: partnerId,
    tenantId: TENANT,
    name: 'Partner',
    email: `p-${partnerId}@example.com`,
    stripeConnectAccountId: opts.connect ? destination : null,
    metadata: opts.connect ? { stripe: { payoutsEnabled: true } } : {},
  });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: TENANT,
    name: 'Default',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
    destinationUrl: 'https://example.com/signup',
  });
  await db(TABLES.Link).insert({
    id: linkId,
    tenantId: TENANT,
    partnerId,
    programId,
    linkKey: `lk-${linkId}`,
    destinationUrl: 'https://example.com',
  });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: TENANT,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://example.com/landing',
    ipHash: 'h',
    ts: new Date(),
  });
  const customerId = `cus_${ulid()}`;
  const stitched = await postWebhook({
    id: `evt_${ulid()}`,
    type: 'checkout.session.completed',
    created: now(),
    data: {
      object: {
        id: `cs_${ulid()}`,
        mode: 'subscription',
        client_reference_id: clickId,
        customer: customerId,
        subscription: `sub_${ulid()}`,
      },
    },
  });
  expect(stitched.status).toBe(200);
  return { partnerId, customerId, destination };
}

async function invoicePaid(customerId: string, amountPaid: number, currency: string) {
  const invoiceId = `in_${ulid()}`;
  const res = await postWebhook({
    id: `evt_${ulid()}`,
    type: 'invoice.paid',
    created: now(),
    data: {
      object: {
        id: invoiceId,
        customer: { id: customerId, metadata: {}, object: 'customer' },
        amount_paid: amountPaid,
        currency,
        charge: `ch_${ulid()}`,
      },
    },
  });
  expect(res.status).toBe(200);
  const event = await db(TABLES.Event).where({ userId: customerId, type: 'invoice_paid' }).orderBy('id', 'desc').first();
  return { event: event as { id: string; value: string; currency: string }, invoiceId };
}

/** Approve the invoice's commissions the way the holdback sweep would. */
async function approveCommissionsFor(eventId: string) {
  const attributionIds = await db(TABLES.Attribution).where({ eventId }).pluck('id');
  await db(TABLES.Commission).whereIn('attributionId', attributionIds).update({ status: 'approved' });
  return (await db(TABLES.Commission).whereIn('attributionId', attributionIds)) as Array<{
    id: string;
    amount: string;
    currency: string;
  }>;
}

async function plan() {
  return db.transaction((trx) => runPayouts(trx, TENANT));
}

async function payoutRow(payoutId: string) {
  return (await db(TABLES.Payout).where({ id: payoutId }).first()) as {
    id: string;
    amount: string;
    currency: string;
    method: string;
    status: string;
    stripeTransferId: string | null;
    metadata: { transferState?: string; amountMinor?: number; lastError?: string };
  };
}

describe.skipIf(skipIntegration)('zero-decimal (JPY) — webhook to payout', () => {
  it('a ¥1,000 invoice is stored as ¥1,000 and a manual payout pays its ¥200 commission', async () => {
    const { customerId } = await seedReferredCustomer({ connect: false });
    const { event } = await invoicePaid(customerId, 1000, 'jpy');

    expect(event.value).toBe('1000.00'); // was '10.00'
    expect(event.currency).toBe('JPY');
    const commissions = await approveCommissionsFor(event.id);
    expect(commissions.map((c) => [c.amount, c.currency])).toEqual([['200.00', 'JPY']]);

    const result = await plan();
    expect(result.payouts).toHaveLength(1);
    expect(result.payouts[0]).toMatchObject({ method: 'manual', amount: 200, currency: 'JPY' });
    const payout = await payoutRow(result.payouts[0]!.payoutId);
    expect(payout.amount).toBe('200.00');
    expect(result.pendingNotifications[0]!.payout.amount).toBe('200.00');
  });

  it('the same sale reaches a Connect partner as a ¥200 transfer, not ¥20,000', async () => {
    const { customerId, destination } = await seedReferredCustomer({ connect: true });
    const { event } = await invoicePaid(customerId, 1000, 'jpy');
    await approveCommissionsFor(event.id);

    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    expect((await payoutRow(payoutId)).metadata).toMatchObject({ transferState: 'intent', amountMinor: 200 });

    const { stripe, create } = mockTransfers();
    const result = await executePayoutTransfers(db, { stripe, tenantId: TENANT });
    expect(result.confirmed).toHaveLength(1);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toMatchObject({ amount: 200, currency: 'jpy', destination });

    const paid = await payoutRow(payoutId);
    expect(paid.status).toBe('paid');
    expect(paid.amount).toBe('200.00');
  });

  it('refunds and one-time Checkout revenue come back in whole yen', async () => {
    const { customerId } = await seedReferredCustomer({ connect: false });
    const refund = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'charge.refunded',
      created: now(),
      data: {
        object: {
          id: `ch_${ulid()}`,
          customer: { id: customerId, metadata: {}, object: 'customer' },
          amount: 1000,
          amount_captured: 1000,
          amount_refunded: 400,
          currency: 'jpy',
        },
      },
    });
    expect(refund.status).toBe(200);
    const refundEvent = await db(TABLES.Event).where({ type: 'refund' }).first();
    expect(refundEvent).toMatchObject({ value: '-400.00', currency: 'JPY' });

    const checkout = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: now(),
      data: {
        object: {
          id: `cs_${ulid()}`,
          object: 'checkout.session',
          mode: 'payment',
          status: 'complete',
          payment_status: 'paid',
          amount_total: 3000,
          currency: 'jpy',
          customer: customerId,
          payment_intent: `pi_${ulid()}`,
          invoice: null,
        },
      },
    });
    expect(checkout.status).toBe(200);
    const revenue = await db(TABLES.Event).where({ userId: customerId, type: 'invoice_paid' }).first();
    expect(revenue).toMatchObject({ value: '3000.00', currency: 'JPY' });
  });

  it('fractional yen commissions pay the rounded total, and the Payout row records it', async () => {
    const { customerId } = await seedReferredCustomer({ connect: true });
    // 20% of ¥1,003 = ¥200.60 — a commission Stripe cannot pay exactly.
    const { event } = await invoicePaid(customerId, 1003, 'jpy');
    const commissions = await approveCommissionsFor(event.id);
    expect(commissions.map((c) => c.amount)).toEqual(['200.60']);

    const { payouts } = await plan();
    expect(payouts[0]!.amount).toBe(201);
    const payout = await payoutRow(payouts[0]!.payoutId);
    expect(payout.amount).toBe('201.00');
    expect(payout.metadata.amountMinor).toBe(201);
  });
});

describe.skipIf(skipIntegration)('three-decimal (KWD) — webhook to transfer', () => {
  it('KWD 12.350 is stored as 12.35 and its 2.47 commission transfers as 2470', async () => {
    const { customerId } = await seedReferredCustomer({ connect: true });
    const { event } = await invoicePaid(customerId, 12350, 'kwd');
    expect(event.value).toBe('12.35'); // was '123.50'
    expect(event.currency).toBe('KWD');
    const commissions = await approveCommissionsFor(event.id);
    expect(commissions.map((c) => c.amount)).toEqual(['2.47']);

    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    expect((await payoutRow(payoutId)).metadata.amountMinor).toBe(2470); // was 247: a tenth

    const { stripe, create } = mockTransfers();
    await executePayoutTransfers(db, { stripe, tenantId: TENANT });
    expect(create.mock.calls[0]![0]).toMatchObject({ amount: 2470, currency: 'kwd' });
    expect((await payoutRow(payoutId)).amount).toBe('2.47');
  });
});

describe.skipIf(skipIntegration)('reconciliation compares in the frozen unit', () => {
  // Seeded as stored rows, not through the webhook: through the old webhook
  // a ¥200 commission was stored as ¥2, which the old planner froze as 200,
  // so the two bugs cancelled and these cases could not tell them apart.

  /** A transfer-ready partner owed one approved ¥200 commission. */
  async function seedApprovedYen(): Promise<{ commissionId: string; destination: string }> {
    const partnerId = ulid();
    const programId = ulid();
    const clickId = ulid();
    const eventId = ulid();
    const attributionId = ulid();
    const commissionId = ulid();
    const destination = `acct_${partnerId.slice(0, 10)}`;
    await db(TABLES.Partner).insert({
      id: partnerId,
      tenantId: TENANT,
      name: 'Partner',
      email: `p-${partnerId}@example.com`,
      stripeConnectAccountId: destination,
      metadata: { stripe: { payoutsEnabled: true } },
    });
    await db(TABLES.Program).insert({
      id: programId,
      tenantId: TENANT,
      name: 'Default',
      attributionModel: 'last_click',
      attributionWindowDays: 60,
      commissionRule: { type: 'percent', value: 20 },
      destinationUrl: 'https://example.com/signup',
    });
    await db(TABLES.Click).insert({ id: clickId, tenantId: TENANT, partnerId, programId, landingUrl: 'https://example.com/', ts: new Date() });
    await db(TABLES.Event).insert({
      id: eventId,
      tenantId: TENANT,
      userId: `u-${clickId}`,
      type: 'invoice_paid',
      value: '1000.00',
      currency: 'JPY',
      ts: new Date(),
    });
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
    await db(TABLES.Commission).insert({
      id: commissionId,
      tenantId: TENANT,
      partnerId,
      attributionId,
      amount: '200.00',
      currency: 'JPY',
      status: 'approved',
    });
    return { commissionId, destination };
  }

  /** A JPY intent whose POST went ambiguous 25h ago, so the next run lists. */
  async function postedJpyIntent() {
    const { destination } = await seedApprovedYen();
    const { payouts } = await plan();
    const payoutId = payouts[0]!.payoutId;
    const postedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({ transferState: 'posted', postedAt: postedAt.toISOString(), attempts: 1 }),
        ]),
      });
    const landed = (amount: number): FakeTransfer => ({
      id: `tr_${ulid()}`,
      amount,
      currency: 'jpy',
      destination,
      transfer_group: payoutId,
      metadata: { openpartner_payout_id: payoutId, openpartner_key_generation: '0' },
      created: Math.floor(postedAt.getTime() / 1000),
    });
    return { payoutId, landed };
  }

  it('a found ¥200 transfer matches the ¥200 intent and finalizes it', async () => {
    const { payoutId, landed } = await postedJpyIntent();
    const transfer = landed(200);
    const { stripe, create } = mockTransfers([transfer]);

    const result = await executePayoutTransfers(db, { stripe, tenantId: TENANT });
    expect(create).not.toHaveBeenCalled();
    expect(result.confirmed).toEqual([{ payoutId, stripeTransferId: transfer.id }]);
    expect((await payoutRow(payoutId)).status).toBe('paid');
  });

  it('a found transfer in hundredths (20000) is not this payment — parked for review', async () => {
    const { payoutId, landed } = await postedJpyIntent();
    const { stripe } = mockTransfers([landed(20000)]);

    const result = await executePayoutTransfers(db, { stripe, tenantId: TENANT });
    expect(result.confirmed).toEqual([]);
    expect(result.failed).toEqual([{ payoutId, error: 'unauthenticated_group_transfer' }]);
    expect((await payoutRow(payoutId)).metadata.transferState).toBe('duplicate_review');
  });

  it('without a frozen amountMinor, the payout row converts in the currency (¥200 → 200)', async () => {
    const { payoutId, landed } = await postedJpyIntent();
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({ metadata: db.raw(`"metadata" - 'amountMinor'`) });
    const transfer = landed(200);
    const { stripe } = mockTransfers([transfer]);

    const result = await executePayoutTransfers(db, { stripe, tenantId: TENANT });
    expect(result.confirmed).toEqual([{ payoutId, stripeTransferId: transfer.id }]);
  });

  it('a legacy intent frozen in hundredths is abandoned before posting, then replanned in yen', async () => {
    const { commissionId } = await seedApprovedYen();
    const { payouts } = await plan();
    const legacyId = payouts[0]!.payoutId;
    // What the pre-fix planner froze for a ¥200 commission.
    await db(TABLES.Payout)
      .where({ id: legacyId })
      .update({ metadata: db.raw(`jsonb_set("metadata", '{amountMinor}', '20000'::jsonb)`) });

    const first = mockTransfers();
    const result = await executePayoutTransfers(db, { stripe: first.stripe, tenantId: TENANT });
    expect(first.create).not.toHaveBeenCalled();
    expect(result.canceled).toContainEqual(expect.objectContaining({ payoutId: legacyId }));
    const legacy = await payoutRow(legacyId);
    expect(legacy.metadata.transferState).toBe('canceled');
    expect(legacy.metadata.lastError).toBe('commission_amount_changed');
    const released = await db(TABLES.Commission).where({ id: commissionId }).first();
    expect(released).toMatchObject({ status: 'approved', payoutId: null });

    const replanned = await plan();
    expect(replanned.payouts).toHaveLength(1);
    expect((await payoutRow(replanned.payouts[0]!.payoutId)).metadata.amountMinor).toBe(200);
    const second = mockTransfers();
    await executePayoutTransfers(db, { stripe: second.stripe, tenantId: TENANT });
    expect(second.create.mock.calls[0]![0]).toMatchObject({ amount: 200, currency: 'jpy' });
  });
});
