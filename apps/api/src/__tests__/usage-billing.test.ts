/**
 * Usage reporting exactly-once. The reporter freezes {rangeStart, rangeEnd,
 * amount, identifier} to a pending Config row BEFORE the Stripe meter call and
 * clears it only after the high-water mark advances. A crash after Stripe
 * accepts re-sends the SAME identifier (Stripe dedupes) instead of
 * re-aggregating an overlapping window and double-billing.
 */

import { afterAll, afterEach, beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.STRIPE_SECRET_KEY = 'sk_test_usage';

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
              throw new Error('stripe boom (simulated crash mid-call)');
            }
            return { id: 'mbe_' + ulid() };
          },
        },
      },
    }),
  };
});

const { db } = await import('../db.js');
const { reportUsageToStripe } = await import('../usage-billing.js');
const { getConfig, setConfig, CONFIG_KEYS } = await import('../config.js');
const { ECB_DATE, USD_PER_INR, stubEcbFetch } = await import('./ecb-fixture.js');

let ecb: import('./ecb-fixture.js').EcbStub | null = null;
afterEach(() => {
  ecb?.restore();
  ecb = null;
});

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const CUSTOMER = 'cus_usage_test';

async function seedGmv(value: number, currency: string | null = 'USD'): Promise<void> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  const eventId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: DEFAULT_TENANT_ID, name: 'P', email: `p-${partnerId}@x.com` });
  await db(TABLES.Program).insert({
    id: programId, tenantId: DEFAULT_TENANT_ID, name: 'Prog', attributionModel: 'last_click',
    attributionWindowDays: 60, commissionRule: { type: 'percent', value: 20 }, destinationUrl: 'https://x/',
  });
  await db(TABLES.Link).insert({ id: linkId, tenantId: DEFAULT_TENANT_ID, partnerId, programId, linkKey: `lk-${linkId}`, destinationUrl: 'https://x/' });
  await db(TABLES.Click).insert({ id: clickId, tenantId: DEFAULT_TENANT_ID, linkId, partnerId, programId, landingUrl: 'https://x/', ipHash: 'h', ts: new Date() });
  await db(TABLES.Event).insert({ id: eventId, tenantId: DEFAULT_TENANT_ID, userId: `u-${eventId}`, type: 'invoice_paid', value: value.toFixed(2), currency, ts: new Date() });
  await db(TABLES.Attribution).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, eventId, partnerId, programId, clickId, model: 'last_click', weight: '1', computedAt: new Date() });
}

const CLEAN = [TABLES.Attribution, TABLES.Event, TABLES.Identity, TABLES.Click, TABLES.Link, TABLES.Program, TABLES.Partner, TABLES.Config];

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of CLEAN) await db(t).del();
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ billingPlan: null, stripeCustomerId: null });
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  h.calls.length = 0;
  h.failNext = false;
  for (const t of CLEAN) await db(t).del();
  await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ billingPlan: 'revshare', stripeCustomerId: CUSTOMER });
});

describe.skipIf(skipIntegration)('reportUsageToStripe exactly-once', () => {
  it('freezes then clears the pending report on a clean run', async () => {
    await seedGmv(50);
    const res = await reportUsageToStripe(db, DEFAULT_TENANT_ID);
    expect(res.reported).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.value).toBe('50.00');
    // Pending cleared, high-water mark advanced.
    expect(await getConfig(db, DEFAULT_TENANT_ID, CONFIG_KEYS.PendingUsageReport)).toBeNull();
    expect(await getConfig(db, DEFAULT_TENANT_ID, CONFIG_KEYS.LastUsageReportedAt)).toBeTruthy();
  });

  it('a crash after Stripe accepts re-sends the SAME identifier exactly once', async () => {
    await seedGmv(80);

    // First run: Stripe "accepts" but the call then throws (crash after the
    // meter event landed). The frozen pending row survives.
    h.failNext = true;
    await expect(reportUsageToStripe(db, DEFAULT_TENANT_ID)).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
    const pending = await getConfig<{ identifier: string }>(db, DEFAULT_TENANT_ID, CONFIG_KEYS.PendingUsageReport);
    expect(pending).toBeTruthy();

    // Add MORE GMV before the retry — the recovery must NOT pick it up; it
    // re-sends the frozen window verbatim.
    await seedGmv(999);

    const res = await reportUsageToStripe(db, DEFAULT_TENANT_ID);
    expect(res.reported).toBe(true);
    expect(h.calls).toHaveLength(2);
    // Same identifier + same amount as the first attempt → Stripe dedupes.
    expect(h.calls[1]!.identifier).toBe(h.calls[0]!.identifier);
    expect(h.calls[1]!.value).toBe('80.00');
    expect(await getConfig(db, DEFAULT_TENANT_ID, CONFIG_KEYS.PendingUsageReport)).toBeNull();
  });

  it('keys the identifier on the period start so concurrent runs dedupe', async () => {
    await seedGmv(30);
    const res = await reportUsageToStripe(db, DEFAULT_TENANT_ID);
    expect(res.reported).toBe(true);
    // First period: rangeStart is null → deterministic "genesis" suffix, so
    // two runs racing the same (still-open) period produce the same key.
    expect(h.calls[0]!.identifier).toMatch(/-genesis$/);
    expect(h.calls[0]!.identifier).not.toContain(res.rangeEnd.toISOString());
  });

  it('abandons a too-stale pending report instead of wedging the tenant', async () => {
    const staleEnd = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await setConfig(db, DEFAULT_TENANT_ID, CONFIG_KEYS.PendingUsageReport, {
      rangeStartIso: null,
      rangeEndIso: staleEnd,
      amount: 12.5,
      identifier: 'op-usage-revshare-stale',
      meterEventName: 'openpartner_attributed_gmv',
      customerId: CUSTOMER,
    });

    const res = await reportUsageToStripe(db, DEFAULT_TENANT_ID);
    expect(res.reason).toBe('stale_pending_abandoned');
    expect(h.calls).toHaveLength(0); // never re-sent to Stripe
    expect(await getConfig(db, DEFAULT_TENANT_ID, CONFIG_KEYS.PendingUsageReport)).toBeNull();
    // Mark advanced past the abandoned window so the tenant isn't stuck.
    expect(await getConfig(db, DEFAULT_TENANT_ID, CONFIG_KEYS.LastUsageReportedAt)).toBe(staleEnd);
  });
});

describe.skipIf(skipIntegration)('reportUsageToStripe currencies', () => {
  it('meters INR at the ECB rate instead of adding it as dollars', async () => {
    // The Oct 17 verification mix, which was metered as $1,108,377.
    ecb = stubEcbFetch('ok');
    await seedGmv(963_377, 'INR');
    await seedGmv(85_000, 'USD');
    await seedGmv(60_000, 'inr');

    const res = await reportUsageToStripe(db, DEFAULT_TENANT_ID);
    expect(res.reported).toBe(true);
    expect(res.gmvByCurrency).toEqual({ INR: 1_023_377, USD: 85_000 });
    // 85,000 + 1,023,377 × 0.0125 = 97,792.2125
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.value).toBe('97792.21');
    expect(res.amount).toBe(97_792.21);
    expect(res.fx).toEqual({ source: 'ecb', date: ECB_DATE, usdPerUnit: { INR: expect.closeTo(USD_PER_INR, 12) } });
    expect(res.heldOut).toBeUndefined();
  });

  it('counts a null-currency event as USD and never reads the feed for USD-only GMV', async () => {
    ecb = stubEcbFetch('down');
    await seedGmv(40, null);
    await seedGmv(2, 'usd');
    const res = await reportUsageToStripe(db, DEFAULT_TENANT_ID);
    expect(res.reported).toBe(true);
    expect(h.calls[0]!.value).toBe('42.00');
    expect(ecb.calls()).toBe(0);
  });

  it('skips the run and keeps the window when the rate feed is down', async () => {
    ecb = stubEcbFetch('down');
    await seedGmv(500, 'INR');
    await seedGmv(10, 'USD');

    const skipped = await reportUsageToStripe(db, DEFAULT_TENANT_ID);
    expect(skipped.reported).toBe(false);
    expect(skipped.reason).toBe('fx_rates_unavailable');
    expect(h.calls).toHaveLength(0);
    expect(await getConfig(db, DEFAULT_TENANT_ID, CONFIG_KEYS.LastUsageReportedAt)).toBeNull();
    expect(await getConfig(db, DEFAULT_TENANT_ID, CONFIG_KEYS.PendingUsageReport)).toBeNull();

    // Feed back: the next run bills the same window, once.
    ecb.restore();
    ecb = stubEcbFetch('ok');
    const res = await reportUsageToStripe(db, DEFAULT_TENANT_ID);
    expect(res.reported).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.value).toBe('16.25');
    expect(h.calls[0]!.identifier).toMatch(/-genesis$/);
  });

  it('holds out a currency with no reference rate, meters the rest, and moves on', async () => {
    ecb = stubEcbFetch('ok');
    await seedGmv(100, 'USD');
    await seedGmv(700, 'AED');
    const res = await reportUsageToStripe(db, DEFAULT_TENANT_ID);
    expect(res.reported).toBe(true);
    expect(h.calls[0]!.value).toBe('100.00');
    expect(res.heldOut).toEqual({ AED: 700 });
    expect(await getConfig(db, DEFAULT_TENANT_ID, CONFIG_KEYS.LastUsageReportedAt)).toBe(res.rangeEnd.toISOString());
  });

  it('meters nothing when every currency is held out', async () => {
    ecb = stubEcbFetch('ok');
    await seedGmv(700, 'AED');
    const res = await reportUsageToStripe(db, DEFAULT_TENANT_ID);
    expect(res.reported).toBe(false);
    expect(res.reason).toBe('only GMV with no reference rate in range');
    expect(res.heldOut).toEqual({ AED: 700 });
    expect(h.calls).toHaveLength(0);
  });

  it('freezes the rates with the report, so crash recovery resends without the feed', async () => {
    ecb = stubEcbFetch('ok');
    await seedGmv(800, 'INR');
    h.failNext = true;
    await expect(reportUsageToStripe(db, DEFAULT_TENANT_ID)).rejects.toThrow();
    const pending = await getConfig<{ amount: number; gmvByCurrency: unknown; fx: { date: string } }>(
      db,
      DEFAULT_TENANT_ID,
      CONFIG_KEYS.PendingUsageReport,
    );
    expect(pending).toMatchObject({ amount: 10, gmvByCurrency: { INR: 800 }, fx: { date: ECB_DATE } });

    ecb.restore();
    ecb = stubEcbFetch('down');
    const res = await reportUsageToStripe(db, DEFAULT_TENANT_ID);
    expect(res.reported).toBe(true);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toEqual(h.calls[0]);
    expect(h.calls[1]!.value).toBe('10.00');
    expect(res.fx).toMatchObject({ date: ECB_DATE });
  });
});
