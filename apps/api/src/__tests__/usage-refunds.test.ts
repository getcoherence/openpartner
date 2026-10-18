/**
 * The platform fee honours refunds ("Refunded transactions don't count").
 *
 * The billable basis is attributed revenue less refunds (partial refunds in
 * proportion), and nothing for a conversion whose commissions were all
 * reversed. Each report diffs that basis against the UsageLedger: a refund
 * in the same window is never billed, and one recorded after its revenue
 * was reported is credited against the next report, carried forward when
 * the credit is larger than that report's new GMV.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type CommissionStatus } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.STRIPE_SECRET_KEY = 'sk_test_usage_refunds';

const h = vi.hoisted(() => ({ calls: [] as Array<{ identifier: string; value: string }>, failNext: false }));

vi.mock('../stripe.js', async () => {
  const actual = await vi.importActual<typeof import('../stripe.js')>('../stripe.js');
  return {
    ...actual,
    requireStripe: () => ({
      billing: {
        meterEvents: {
          create: async (args: { identifier: string; payload: { value: string } }) => {
            h.calls.push({ identifier: args.identifier, value: args.payload.value });
            if (h.failNext) {
              h.failNext = false;
              throw new Error('stripe boom (simulated crash after accept)');
            }
            return { id: 'mbe_' + ulid() };
          },
        },
      },
    }),
  };
});

const { db } = await import('../db.js');
const { reportUsageToStripe, aggregateAttributedGmv } = await import('../usage-billing.js');
const { getConfig, setConfig, CONFIG_KEYS } = await import('../config.js');
const { clearFxRateCache, ECB_DAILY_URL } = await import('../fx.js');
const { ECB_XML, stubEcbFetch } = await import('./ecb-fixture.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const T = DEFAULT_TENANT_ID;
const CUSTOMER = 'cus_usage_refunds';

let ecb: { restore: () => void; calls: () => number } | null = null;
afterEach(() => {
  ecb?.restore();
  ecb = null;
});

/** Serve an ECB table where 1 EUR = 110 INR, so 1 INR = 0.01 USD. */
function stubEcbInrAt110() {
  clearFxRateCache();
  const realFetch = globalThis.fetch;
  let calls = 0;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== ECB_DAILY_URL) return realFetch(input, init);
    calls += 1;
    return new Response(ECB_XML.replace("rate='88.00'", "rate='110.00'"), { status: 200 });
  });
  return { calls: () => calls, restore: () => (spy.mockRestore(), clearFxRateCache()) };
}

interface Conversion {
  eventId: string;
  userId: string;
  currency: string;
  commissionId: string | null;
}

async function seedConversion(
  value: number,
  opts: {
    currency?: string;
    commission?: CommissionStatus | null;
    ts?: Date;
    attributedAt?: Date;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<Conversion> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  const eventId = ulid();
  const attributionId = ulid();
  const userId = `u-${eventId}`;
  const currency = opts.currency ?? 'USD';
  const ts = opts.ts ?? new Date(Date.now() - 1000);
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: T, name: 'P', email: `p-${partnerId}@x.com` });
  await db(TABLES.Program).insert({
    id: programId, tenantId: T, name: 'Prog', attributionModel: 'last_click',
    attributionWindowDays: 60, commissionRule: { type: 'percent', value: 20 }, destinationUrl: 'https://x/',
  });
  await db(TABLES.Link).insert({ id: linkId, tenantId: T, partnerId, programId, linkKey: `lk-${linkId}`, destinationUrl: 'https://x/' });
  await db(TABLES.Click).insert({ id: clickId, tenantId: T, linkId, partnerId, programId, landingUrl: 'https://x/', ipHash: 'h', ts });
  await db(TABLES.Event).insert({
    id: eventId, tenantId: T, userId, type: 'invoice_paid', value: value.toFixed(2), currency,
    metadata: opts.metadata ?? {}, ts,
  });
  await db(TABLES.Attribution).insert({
    id: attributionId, tenantId: T, eventId, partnerId, programId, clickId, model: 'last_click', weight: '1',
    computedAt: opts.attributedAt ?? ts,
  });
  let commissionId: string | null = null;
  const status = opts.commission === undefined ? 'accrued' : opts.commission;
  if (status) {
    commissionId = ulid();
    await db(TABLES.Commission).insert({
      id: commissionId, tenantId: T, attributionId, partnerId, amount: (value * 0.2).toFixed(2), currency,
      status, accruedAt: ts, ...(status === 'paid' ? { paidAt: new Date() } : {}),
    });
  }
  return { eventId, userId, currency, commissionId };
}

/** What POST /attribution/refunds records (refunds.ts): the refund's own
 *  amount, negative, naming the conversion. Null amount = a full refund of
 *  a value-less conversion. */
async function apiRefund(c: Conversion, amount: number, kind: 'refund' | 'chargeback' = 'refund'): Promise<void> {
  await db(TABLES.Event).insert({
    id: ulid(), tenantId: T, userId: c.userId, type: kind, value: (-amount).toFixed(2), currency: c.currency,
    externalEventId: `rf-${ulid()}`, metadata: { conversionEventId: c.eventId, reason: null }, ts: new Date(),
  });
}

/** What the self-host webhook records for charge.refunded: the charge's
 *  CUMULATIVE refund, matched to the conversion by invoice. */
async function stripeRefund(c: Conversion, invoiceId: string, refundedMinor: number, collectedMinor: number): Promise<void> {
  await db(TABLES.Event).insert({
    id: ulid(), tenantId: T, userId: c.userId, type: 'refund', value: (-refundedMinor / 100).toFixed(2), currency: c.currency,
    externalEventId: `evt_${ulid()}`,
    metadata: {
      stripeChargeId: `ch_${ulid()}`, stripeInvoiceId: invoiceId, amountRefunded: refundedMinor,
      chargeCollected: collectedMinor, fullRefund: refundedMinor >= collectedMinor,
    },
    ts: new Date(),
  });
}

async function reverse(c: Conversion): Promise<void> {
  await db(TABLES.Commission).where({ id: c.commissionId! }).update({ status: 'reversed' });
}

async function ledger(eventId?: string) {
  const q = db(TABLES.UsageLedger).where({ tenantId: T }).orderBy('createdAt').orderBy('id');
  if (eventId) q.where({ eventId });
  return (await q).map((r: { eventId: string; reason: string; amount: string; amountUsd: string; usdPerUnit: string | null }) => ({
    eventId: r.eventId,
    reason: r.reason,
    amount: Number(r.amount),
    amountUsd: Number(r.amountUsd),
    usdPerUnit: r.usdPerUnit === null ? null : Number(r.usdPerUnit),
  }));
}

const report = () => reportUsageToStripe(db, T);
const carry = () => getConfig<number>(db, T, CONFIG_KEYS.UsageCarryUsd);

const CLEAN = [
  TABLES.UsageLedger, TABLES.CommissionAdjustment, TABLES.Commission, TABLES.Attribution, TABLES.Event,
  TABLES.Identity, TABLES.Click, TABLES.Link, TABLES.Program, TABLES.Partner, TABLES.Config,
];

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of CLEAN) await db(t).del();
    await db(TABLES.Tenant).where({ id: T }).update({ billingPlan: null, stripeCustomerId: null });
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  h.calls.length = 0;
  h.failNext = false;
  for (const t of CLEAN) await db(t).del();
  await db(TABLES.Tenant).where({ id: T }).update({ billingPlan: 'revshare', stripeCustomerId: CUSTOMER });
});

describe.skipIf(skipIntegration)('refunds in the same billing period', () => {
  it('never bills a conversion refunded in full before it was reported', async () => {
    const refunded = await seedConversion(100);
    await seedConversion(50);
    await apiRefund(refunded, 100);

    const res = await report();
    expect(res.reported).toBe(true);
    expect(h.calls.map((c) => c.value)).toEqual(['50.00']);
    expect(res.gmvByCurrency).toEqual({ USD: 50 });
    expect(res.creditsByCurrency).toBeUndefined();
    expect(await ledger(refunded.eventId)).toEqual([]);
  });

  it('bills what was kept after a partial refund', async () => {
    const c = await seedConversion(200);
    await apiRefund(c, 30);
    await apiRefund(c, 20);

    const res = await report();
    expect(h.calls.map((x) => x.value)).toEqual(['150.00']);
    expect(await ledger(c.eventId)).toEqual([{ eventId: c.eventId, reason: 'billed', amount: 150, amountUsd: 150, usdPerUnit: 1 }]);
    expect(res.gmvByCurrency).toEqual({ USD: 150 });
  });

  it('measures a Stripe refund against the charge, cumulatively, as a share of the conversion', async () => {
    // $100 invoice; Stripe reports the charge's running refund total, so a
    // $30 refund then a $20 one arrive as 3000 then 5000 of 10000.
    const c = await seedConversion(100, { metadata: { stripeInvoiceId: 'in_cum' } });
    await stripeRefund(c, 'in_cum', 3000, 10000);
    await stripeRefund(c, 'in_cum', 5000, 10000);

    await report();
    expect(h.calls.map((x) => x.value)).toEqual(['50.00']);
  });

  it('takes the larger share when the API and Stripe both report a refund of one conversion', async () => {
    const c = await seedConversion(100, { metadata: { stripeInvoiceId: 'in_both' } });
    await stripeRefund(c, 'in_both', 2500, 10000);
    await apiRefund(c, 40);
    await report();
    expect(h.calls.map((x) => x.value)).toEqual(['60.00']);
  });

  it('nets refunds and reversals out of aggregateAttributedGmv, per currency', async () => {
    const partial = await seedConversion(100);
    await apiRefund(partial, 25);
    const full = await seedConversion(80);
    await apiRefund(full, 80);
    const reversed = await seedConversion(60);
    await reverse(reversed);
    await seedConversion(40, { commission: null });
    const inr = await seedConversion(1000, { currency: 'INR' });
    await apiRefund(inr, 400);

    expect(await aggregateAttributedGmv(db, T, null, new Date())).toEqual({ USD: 115, INR: 600 });
  });
});

describe.skipIf(skipIntegration)('refunds after the period was reported', () => {
  it('credits the refunded amount against the next report', async () => {
    const c = await seedConversion(100);
    await report();
    expect(h.calls.map((x) => x.value)).toEqual(['100.00']);

    await apiRefund(c, 40);
    await seedConversion(70);
    const res = await report();
    expect(h.calls.map((x) => x.value)).toEqual(['100.00', '30.00']);
    expect(res.gmvByCurrency).toEqual({ USD: 70 });
    expect(res.creditsByCurrency).toEqual({ USD: -40 });
    expect(res.creditUsd).toBe(-40);
    expect(res.carriedForwardUsd).toBeUndefined();
    expect((await ledger(c.eventId)).map((r) => [r.reason, r.amount])).toEqual([
      ['billed', 100],
      ['refunded', -40],
    ]);
  });

  it('carries a credit larger than the next report forward until GMV covers it', async () => {
    const c = await seedConversion(100);
    await report();
    await apiRefund(c, 100);

    // Nothing new: the meter gets nothing (it rejects negatives) and the
    // whole credit waits.
    const first = await report();
    expect(first.reported).toBe(false);
    expect(first.reason).toBe('refund credits cover the new GMV; the rest is carried forward');
    expect(first.carriedForwardUsd).toBe(-100);
    expect(await carry()).toBe(-100);

    await seedConversion(30);
    const second = await report();
    expect(second.reported).toBe(false);
    expect(second.carriedInUsd).toBe(-100);
    expect(second.carriedForwardUsd).toBe(-70);
    expect(await carry()).toBe(-70);

    await seedConversion(90);
    const third = await report();
    expect(third.reported).toBe(true);
    expect(third.amount).toBe(20);
    expect(third.carriedInUsd).toBe(-70);
    expect(third.carriedForwardUsd).toBeUndefined();
    expect(await carry()).toBeNull();
    // Only the first and last reports reached the meter.
    expect(h.calls.map((x) => x.value)).toEqual(['100.00', '20.00']);
  });

  it('credits a chargeback like a refund, and leaves a Stripe dispute alone until it is decided', async () => {
    const charged = await seedConversion(100);
    const disputed = await seedConversion(80, { metadata: { stripePaymentIntentId: 'pi_disputed' } });
    await report();
    expect(h.calls.map((x) => x.value)).toEqual(['180.00']);

    await apiRefund(charged, 100, 'chargeback');
    // A dispute can be won: on its own it changes nothing.
    await db(TABLES.Event).insert({
      id: ulid(), tenantId: T, userId: disputed.userId, type: 'dispute_created', value: '-80.00', currency: 'USD',
      metadata: { stripeDisputeId: 'dp_1', stripePaymentIntentId: 'pi_disputed' }, ts: new Date(),
    });
    await seedConversion(150);
    const res = await report();
    expect(h.calls.map((x) => x.value)).toEqual(['180.00', '50.00']);
    expect(res.creditsByCurrency).toEqual({ USD: -100 });
    expect(await ledger(disputed.eventId)).toHaveLength(1);
  });

  it('credits a paid commission’s refunded revenue even though the commission stays paid', async () => {
    // refunds.ts never reverses a paid commission: it records a clawback
    // adjustment instead. The refund Event is what takes the revenue out.
    const c = await seedConversion(100, { commission: 'paid' });
    await report();
    await apiRefund(c, 100);
    await db(TABLES.CommissionAdjustment).insert({
      id: ulid(), tenantId: T, commissionId: c.commissionId!, amount: '-20.00', currency: 'USD',
      reason: 'refund_clawback', metadata: {}, createdAt: new Date(),
    });
    await seedConversion(130);
    await report();
    expect(h.calls.map((x) => x.value)).toEqual(['100.00', '30.00']);
  });
});

describe.skipIf(skipIntegration)('reversed commissions', () => {
  it('never bills a conversion whose commission was reversed before it was reported', async () => {
    const c = await seedConversion(100);
    await reverse(c);
    await seedConversion(25);
    await report();
    expect(h.calls.map((x) => x.value)).toEqual(['25.00']);
  });

  it('credits an admin reversal after the conversion was reported', async () => {
    const c = await seedConversion(100);
    await report();
    await reverse(c);
    await seedConversion(140);
    const res = await report();
    expect(h.calls.map((x) => x.value)).toEqual(['100.00', '40.00']);
    expect((await ledger(c.eventId)).map((r) => r.reason)).toEqual(['billed', 'reversed']);
    expect(res.creditsByCurrency).toEqual({ USD: -100 });
  });

  it('names a refund that also reversed the commissions as the refund', async () => {
    const c = await seedConversion(100);
    await report();
    // What refunds.ts does for a full refund of an unpaid commission.
    await apiRefund(c, 100);
    await reverse(c);
    await report();
    expect((await ledger(c.eventId)).map((r) => [r.reason, r.amount])).toEqual([
      ['billed', 100],
      ['refunded', -100],
    ]);
  });

  it('keeps billing a conversion while any of its commissions is live, and one that never had a commission', async () => {
    // A partial refund reverses the root commission and accrues a
    // replacement for the kept share: still attributed, billed at the kept share.
    const c = await seedConversion(100);
    await apiRefund(c, 60);
    await reverse(c);
    const attribution = await db(TABLES.Attribution).where({ eventId: c.eventId }).first();
    await db(TABLES.Commission).insert({
      id: ulid(), tenantId: T, attributionId: attribution.id, partnerId: attribution.partnerId, amount: '8.00',
      currency: 'USD', status: 'accrued', accruedAt: new Date(),
      metadata: { refund: { rootCommissionId: c.commissionId, replacesCommissionId: c.commissionId, refundEventId: 'x' } },
    });
    await seedConversion(10, { commission: null });
    await report();
    expect(h.calls.map((x) => x.value)).toEqual(['50.00']);
  });
});

describe.skipIf(skipIntegration)('idempotency', () => {
  it('a re-run after a report with credits bills and credits nothing again', async () => {
    const c = await seedConversion(100);
    await report();
    await apiRefund(c, 100);
    await report();
    const rows = (await ledger()).length;
    const carried = await carry();

    const again = await report();
    expect(again.reported).toBe(false);
    expect(again.creditsByCurrency).toBeUndefined();
    expect(again.carriedInUsd).toBe(-100);
    expect(again.carriedForwardUsd).toBe(-100);
    expect((await ledger()).length).toBe(rows);
    expect(await carry()).toBe(carried);
    expect(h.calls).toHaveLength(1);
  });

  it('crash recovery settles the carry from the frozen report, so a credit is never applied twice', async () => {
    const c = await seedConversion(100);
    await report();
    await apiRefund(c, 100);
    await report(); // carry -100
    await seedConversion(130);

    h.failNext = true; // Stripe accepts the 30.00, then the run dies
    await expect(report()).rejects.toThrow();
    expect(await carry()).toBe(-100);
    expect(await getConfig(db, T, CONFIG_KEYS.PendingUsageReport)).toMatchObject({ amount: 30, carryOutUsd: 0 });

    const res = await report();
    expect(res.reason).toBe('resent frozen report (crash recovery)');
    expect(h.calls.map((x) => x.value)).toEqual(['100.00', '30.00', '30.00']);
    expect(h.calls[2]!.identifier).toBe(h.calls[1]!.identifier);
    expect(await carry()).toBeNull();

    // And the next run finds nothing left to do.
    const next = await report();
    expect(next.reported).toBe(false);
    expect(next.carriedInUsd).toBeUndefined();
    expect(h.calls).toHaveLength(3);
  });
});

describe.skipIf(skipIntegration)('currencies', () => {
  it('credits at the rate the conversion was billed at, without reading the feed', async () => {
    ecb = stubEcbFetch('ok');
    const inr = await seedConversion(8000, { currency: 'INR' });
    await report();
    expect(h.calls.map((x) => x.value)).toEqual(['100.00']); // 8000 × 0.0125

    ecb.restore();
    ecb = stubEcbFetch('down');
    await apiRefund(inr, 4000);
    await seedConversion(80);
    const res = await report();
    // Credit at the billed 0.0125, not whatever the rate is today.
    expect(h.calls.map((x) => x.value)).toEqual(['100.00', '30.00']);
    expect(res.creditsByCurrency).toEqual({ INR: -4000 });
    expect(res.creditUsd).toBe(-50);
    expect(ecb.calls()).toBe(0);
  });

  it('nets a full refund to exactly zero USD after the rate moved', async () => {
    ecb = stubEcbFetch('ok');
    const inr = await seedConversion(8000, { currency: 'INR' });
    await report();
    ecb.restore();
    ecb = stubEcbInrAt110();
    await apiRefund(inr, 8000);
    await seedConversion(8000, { currency: 'INR' }); // new GMV at today's 0.01
    const res = await report();
    expect(res.creditUsd).toBe(-100);
    expect(res.amount).toBe(0);
    expect(res.carriedForwardUsd).toBe(-20);
    const rows = await ledger(inr.eventId);
    expect(rows.reduce((s, r) => s + r.amountUsd, 0)).toBe(0);
  });
});

describe.skipIf(skipIntegration)('cutover and late attribution', () => {
  it('opens the ledger from what is billable now, without crediting pre-cutover refunds or re-billing', async () => {
    const lastReport = new Date(Date.now() - 60 * 60 * 1000);
    const before = new Date(lastReport.getTime() - 60 * 60 * 1000);
    await setConfig(db, T, CONFIG_KEYS.LastUsageReportedAt, lastReport.toISOString());

    const billed = await seedConversion(100, { ts: before });
    const refundedBefore = await seedConversion(60, { ts: before });
    await apiRefund(refundedBefore, 60);
    // Recorded before the last report but attributed after it: the old
    // window reporter never billed it.
    const lateAttributed = await seedConversion(40, { ts: before, attributedAt: new Date(Date.now() - 10 * 60 * 1000) });
    const fresh = await seedConversion(25);

    const res = await report();
    expect(h.calls.map((x) => x.value)).toEqual(['65.00']);
    expect(res.creditsByCurrency).toBeUndefined();
    expect(await ledger(billed.eventId)).toEqual([
      { eventId: billed.eventId, reason: 'opening', amount: 100, amountUsd: 100, usdPerUnit: 1 },
    ]);
    expect(await ledger(refundedBefore.eventId)).toEqual([]);
    expect((await ledger(lateAttributed.eventId)).map((r) => r.reason)).toEqual(['billed']);
    expect((await ledger(fresh.eventId)).map((r) => r.reason)).toEqual(['billed']);
    expect(await getConfig(db, T, CONFIG_KEYS.UsageLedgerOpenedAt)).toBeTruthy();

    // From here on a refund of a pre-cutover conversion is credited.
    await apiRefund(billed, 100);
    const after = await report();
    expect(after.creditsByCurrency).toEqual({ USD: -100 });
    expect((await ledger()).filter((r) => r.reason === 'opening')).toHaveLength(1);
  });

  it('bills an old conversion that a backlog replay attributes after it was last reported', async () => {
    await seedConversion(10);
    await report();
    // Recorded two days ago, stitched to a click only now.
    await seedConversion(55, { ts: new Date(Date.now() - 2 * 86_400_000), attributedAt: new Date() });
    await report();
    expect(h.calls.map((x) => x.value)).toEqual(['10.00', '55.00']);
  });
});
