/**
 * Commission slabs through the live attribution path: value bands and
 * performance tiers evaluated by attributeEvent, combined with triggers,
 * recurringMonths, multi-touch weights and per-partner overrides, plus
 * the API validation and the Network-snapshot guard.
 *
 * Pure arithmetic (band edges, marginal slices, windows, summaries) is in
 * commission-slabs.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type EventRow } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { attributeEvent } from '../attribution.js';

const ADMIN_KEY = 'op_test_commission_slabs_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const TABLES_TO_CLEAN = [
  TABLES.PartnerCommission,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.Partner,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) {
    await db(t).del();
  }
});

/** Clicks sit just before the first event in each test; every event stays
 *  inside the 365-day attribution window these programs use. */
const CLICK_TS = new Date('2025-12-31T23:59:00Z');

interface CommissionWithMeta {
  partnerId: string;
  amount: string;
  metadata: { slab?: Record<string, unknown> };
}

describe.skipIf(skipIntegration)('value bands', () => {
  it('whole-event bands: the threshold itself pays base, a cent above pays the band', async () => {
    const { userId } = await setup([
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        bands: { levels: [{ above: 50000, value: 15 }] }, // mode defaults to whole
      },
    ]);
    await accrue(userId, 'invoice_paid', '50000.00', '2026-01-01');
    await accrue(userId, 'invoice_paid', '50000.01', '2026-01-02');

    const rows = await commissions();
    expect(rows.map((r) => r.amount)).toEqual(['5000.00', '7500.00']);
    expect(rows[0]!.metadata.slab).toMatchObject({ kind: 'band', mode: 'whole', level: 0, threshold: null, value: 10 });
    expect(rows[1]!.metadata.slab).toMatchObject({
      kind: 'band',
      ruleIndex: 0,
      level: 1,
      threshold: 50000,
      value: 15,
      basis: 50000.01,
      currency: 'USD',
    });
  });

  it('marginal bands pay each slice at its own rate', async () => {
    const { userId } = await setup([
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        bands: { mode: 'marginal', levels: [{ above: 50000, value: 15 }] },
      },
    ]);
    await accrue(userId, 'invoice_paid', '60000.00', '2026-01-01');
    const [row] = await commissions();
    expect(row!.amount).toBe('6500.00');
    expect(row!.metadata.slab).toMatchObject({ mode: 'marginal', level: 1 });
  });

  it('a multi-touch weight scales the banded amount, and the band reads the full event value', async () => {
    const program = await createProgram(
      [{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 10, bands: { levels: [{ above: 50000, value: 15 }] } }],
      { attributionModel: 'linear' },
    );
    const a = await createPartner();
    const b = await createPartner();
    const userId = `u-${ulid()}`;
    await click(a.id, program.id, userId, CLICK_TS);
    await click(b.id, program.id, userId, new Date(CLICK_TS.getTime() + 1000));

    // 60,000 is past the 50,000 step even though each partner's half is not.
    await accrue(userId, 'invoice_paid', '60000.00', '2026-01-01');
    const rows = await commissions();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amount).sort()).toEqual(['4500.00', '4500.00']); // 15% × 60,000 × 0.5
    for (const r of rows) expect(r.metadata.slab).toMatchObject({ level: 1, basis: 60000 });
  });

  it('first + subsequent triggers each apply their own bands', async () => {
    const { userId } = await setup([
      { trigger: 'first', eventType: 'invoice_paid', type: 'percent', value: 50, bands: { levels: [{ above: 1000, value: 60 }] } },
      { trigger: 'subsequent', eventType: 'invoice_paid', type: 'percent', value: 20, bands: { levels: [{ above: 1000, value: 25 }] } },
    ]);
    await accrue(userId, 'invoice_paid', '2000.00', '2026-01-01'); // first, banded: 60%
    await accrue(userId, 'invoice_paid', '500.00', '2026-02-01'); // subsequent, base: 20%
    await accrue(userId, 'invoice_paid', '1500.00', '2026-03-01'); // subsequent, banded: 25%

    const rows = await commissions();
    expect(rows.map((r) => r.amount)).toEqual(['1200.00', '100.00', '375.00']);
    expect(rows.map((r) => r.metadata.slab?.ruleIndex)).toEqual([0, 1, 1]);
  });

  it('recurringMonths still caps a banded recurring rule', async () => {
    const { userId } = await setup([
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        recurring: true,
        recurringMonths: 2,
        bands: { levels: [{ above: 100, value: 20 }] },
      },
    ]);
    await accrue(userId, 'invoice_paid', '200.00', '2026-01-01');
    await accrue(userId, 'invoice_paid', '200.00', '2026-02-15');
    await accrue(userId, 'invoice_paid', '200.00', '2026-04-01'); // past 2 months
    expect((await commissions()).map((r) => r.amount)).toEqual(['40.00', '40.00']);
  });

  it('thresholds in another currency are not compared — the base rate applies and the row says why', async () => {
    const { userId } = await setup([
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        currency: 'INR',
        bands: { levels: [{ above: 50000, value: 15 }] },
      },
    ]);
    await accrue(userId, 'invoice_paid', '60000.00', '2026-01-01', 'USD');
    await accrue(userId, 'invoice_paid', '60000.00', '2026-01-02', 'INR');
    const rows = await commissions();
    expect(rows.map((r) => r.amount)).toEqual(['6000.00', '9000.00']);
    expect(rows[0]!.metadata.slab).toMatchObject({ level: 0, currency: 'INR', currencyMismatch: true });
    expect(rows[1]!.metadata.slab).toMatchObject({ level: 1, currency: 'INR' });
    expect(rows[1]!.metadata.slab).not.toHaveProperty('currencyMismatch');
  });
});

describe.skipIf(skipIntegration)('performance tiers', () => {
  it('lifetime revenue: crossing a threshold is not retroactive', async () => {
    const { userId } = await setup([
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        tiers: { metric: 'revenue', window: 'lifetime', levels: [{ atLeast: 1000, value: 20 }] },
      },
    ]);
    await accrue(userId, 'invoice_paid', '600.00', '2026-01-01'); // prior 0
    await accrue(userId, 'invoice_paid', '600.00', '2026-01-02'); // prior 600 — this one crosses
    await accrue(userId, 'invoice_paid', '600.00', '2026-01-03'); // prior 1,200 — tier applies

    const rows = await commissions();
    expect(rows.map((r) => r.amount)).toEqual(['60.00', '60.00', '120.00']);
    expect(rows.map((r) => r.metadata.slab?.metricValue)).toEqual([0, 600, 1200]);
    expect(rows[2]!.metadata.slab).toMatchObject({
      kind: 'tier',
      metric: 'revenue',
      window: 'lifetime',
      windowStart: null,
      countedEventType: 'invoice_paid',
      level: 1,
      threshold: 1000,
      value: 20,
    });
  });

  it('calendar month resets at the UTC month boundary', async () => {
    const { userId } = await setup([
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        tiers: { metric: 'revenue', window: 'calendar_month', levels: [{ atLeast: 1000, value: 20 }] },
      },
    ]);
    await accrue(userId, 'invoice_paid', '1000.00', '2026-01-10T00:00:00Z');
    await accrue(userId, 'invoice_paid', '100.00', '2026-01-31T23:59:59Z'); // January: 1,000 before it
    await accrue(userId, 'invoice_paid', '100.00', '2026-02-01T00:00:00Z'); // February: nothing yet

    const rows = await commissions();
    expect(rows.map((r) => r.amount)).toEqual(['100.00', '20.00', '10.00']);
    expect(rows[1]!.metadata.slab).toMatchObject({ windowStart: '2026-01-01T00:00:00.000Z', metricValue: 1000 });
    expect(rows[2]!.metadata.slab).toMatchObject({ windowStart: '2026-02-01T00:00:00.000Z', metricValue: 0 });
  });

  it('a rolling window drops events older than windowDays', async () => {
    const { userId } = await setup([
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        tiers: { metric: 'revenue', window: 'rolling_days', windowDays: 30, levels: [{ atLeast: 1000, value: 20 }] },
      },
    ]);
    await accrue(userId, 'invoice_paid', '1000.00', '2026-01-01');
    await accrue(userId, 'invoice_paid', '100.00', '2026-01-20'); // Jan 1 is 19 days back
    await accrue(userId, 'invoice_paid', '100.00', '2026-02-15'); // Jan 1 is 45 days back; Jan 20 isn't

    const rows = await commissions();
    expect(rows.map((r) => r.amount)).toEqual(['100.00', '20.00', '10.00']);
    expect(rows[2]!.metadata.slab).toMatchObject({ metricValue: 100, windowDays: 30 });
  });

  it('conversions count attribution weight — a shared conversion is half of one', async () => {
    const program = await createProgram(
      [
        {
          trigger: 'every',
          eventType: 'invoice_paid',
          type: 'fixed',
          value: 10,
          tiers: { metric: 'conversions', window: 'lifetime', levels: [{ atLeast: 1, value: 30 }] },
        },
      ],
      { attributionModel: 'linear' },
    );
    const a = await createPartner();
    const b = await createPartner();
    const userId = `u-${ulid()}`;
    await click(a.id, program.id, userId, CLICK_TS);
    await click(b.id, program.id, userId, new Date(CLICK_TS.getTime() + 1000));

    await accrue(userId, 'invoice_paid', '100.00', '2026-01-01'); // prior 0
    await accrue(userId, 'invoice_paid', '100.00', '2026-01-02'); // prior 0.5
    await accrue(userId, 'invoice_paid', '100.00', '2026-01-03'); // prior 1.0 → tier

    const forA = (await commissions()).filter((r) => r.partnerId === a.id);
    expect(forA.map((r) => r.amount)).toEqual(['5.00', '5.00', '15.00']); // × weight 0.5
    expect(forA.map((r) => r.metadata.slab?.metricValue)).toEqual([0, 0.5, 1]);
  });

  it('counts only this partner, this program, the counted event type and clean clicks', async () => {
    const rule = {
      trigger: 'every',
      eventType: 'invoice_paid',
      type: 'percent',
      value: 10,
      tiers: { metric: 'conversions', eventType: 'subscription_created', window: 'lifetime', levels: [{ atLeast: 1, value: 20 }] },
    };
    const partner = await createPartner();
    const other = await createPartner();
    const program = await createProgram([rule]);
    const otherProgram = await createProgram([{ trigger: 'every', type: 'percent', value: 10 }]);

    // Noise the metric must ignore:
    const u1 = `u-${ulid()}`;
    await click(other.id, program.id, u1, CLICK_TS); // another partner's subscription
    await accrue(u1, 'subscription_created', null, '2026-01-01');
    const u2 = `u-${ulid()}`;
    await click(partner.id, otherProgram.id, u2, CLICK_TS); // same partner, other program
    await accrue(u2, 'subscription_created', null, '2026-01-01');
    const u3 = `u-${ulid()}`;
    const flagged = await click(partner.id, program.id, u3, CLICK_TS); // later flagged as fraud
    await accrue(u3, 'subscription_created', null, '2026-01-01');
    await db(TABLES.Click).where({ id: flagged }).update({ fraudFlag: 'manual' });

    const buyer = `u-${ulid()}`;
    await click(partner.id, program.id, buyer, CLICK_TS);
    await accrue(buyer, 'invoice_paid', '100.00', '2026-01-02'); // its own type doesn't count either
    await accrue(buyer, 'invoice_paid', '100.00', '2026-01-03');
    let mine = (await commissions()).filter((r) => r.partnerId === partner.id && r.metadata.slab);
    expect(mine.map((r) => r.amount)).toEqual(['10.00', '10.00']);
    expect(mine[1]!.metadata.slab).toMatchObject({ countedEventType: 'subscription_created', metricValue: 0 });

    // One real subscription from this partner in this program → next invoice tiers up.
    await accrue(buyer, 'subscription_created', null, '2026-01-04');
    await accrue(buyer, 'invoice_paid', '100.00', '2026-01-05');
    mine = (await commissions()).filter((r) => r.partnerId === partner.id && r.metadata.slab);
    expect(mine.map((r) => r.amount)).toEqual(['10.00', '10.00', '20.00']);
  });

  it('revenue only adds up the threshold currency', async () => {
    const { userId } = await setup([
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        currency: 'USD',
        tiers: { metric: 'revenue', window: 'lifetime', levels: [{ atLeast: 1000, value: 20 }] },
      },
    ]);
    await accrue(userId, 'invoice_paid', '5000.00', '2026-01-01', 'EUR');
    await accrue(userId, 'invoice_paid', '500.00', '2026-01-02', 'USD');
    await accrue(userId, 'invoice_paid', '100.00', '2026-01-03', 'USD');
    const rows = await commissions();
    expect(rows[2]!.amount).toBe('10.00');
    expect(rows[2]!.metadata.slab).toMatchObject({ metricValue: 500, currency: 'USD', level: 0 });
  });

  it('of two events at the same instant, the lower id counts toward the higher', async () => {
    const { userId } = await setup([
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        tiers: { metric: 'conversions', window: 'lifetime', levels: [{ atLeast: 1, value: 20 }] },
      },
    ]);
    const at = new Date('2026-01-01T00:00:00Z');
    const [lo, hi] = [
      await insertEvent(userId, 'invoice_paid', '100.00', at),
      await insertEvent(userId, 'invoice_paid', '100.00', at),
    ].sort((x, y) => (x.id < y.id ? -1 : 1));
    await attributeEvent(db, lo!);
    await attributeEvent(db, hi!);
    const rows = (await db(TABLES.Commission)
      .join(TABLES.Attribution, `${TABLES.Attribution}.id`, `${TABLES.Commission}.attributionId`)
      .select(`${TABLES.Attribution}.eventId`, `${TABLES.Commission}.amount`)) as Array<{ eventId: string; amount: string }>;
    const byEvent = Object.fromEntries(rows.map((r) => [r.eventId, r.amount]));
    expect(byEvent[lo!.id]).toBe('10.00');
    expect(byEvent[hi!.id]).toBe('20.00');
  });

  // Review finding: weights are stored to 4 decimals, so three linear
  // touches of one partner summed to 0.9999 per conversion and the partner
  // never reached "at least 2" after two whole conversions.
  it('a conversion owned through several touches counts as exactly one', async () => {
    const program = await createProgram(
      [
        {
          trigger: 'every',
          eventType: 'invoice_paid',
          type: 'fixed',
          value: 10,
          tiers: { metric: 'conversions', window: 'lifetime', levels: [{ atLeast: 2, value: 30 }] },
        },
      ],
      { attributionModel: 'linear' },
    );
    const partner = await createPartner();
    const userId = `u-${ulid()}`;
    for (let i = 0; i < 3; i += 1) await click(partner.id, program.id, userId, new Date(CLICK_TS.getTime() + i * 1000));

    await accrue(userId, 'invoice_paid', '100.00', '2026-01-01');
    await accrue(userId, 'invoice_paid', '100.00', '2026-01-02');
    const third = await accrue(userId, 'invoice_paid', '100.00', '2026-01-03');

    const rows = (await db(TABLES.Commission)
      .join(TABLES.Attribution, `${TABLES.Attribution}.id`, `${TABLES.Commission}.attributionId`)
      .where(`${TABLES.Attribution}.eventId`, third.id)
      .select(`${TABLES.Commission}.amount`, `${TABLES.Commission}.metadata`)) as CommissionWithMeta[];
    expect(rows).toHaveLength(3); // one per touch
    for (const r of rows) {
      expect(r.metadata.slab).toMatchObject({ level: 1, metricValue: 2 }); // not 1.9998
      expect(r.amount).toBe('10.00'); // 30 × ⅓
    }
  });
});

describe.skipIf(skipIntegration)('ledger metadata + overrides', () => {
  it('a slab-less rule writes {} metadata', async () => {
    const { userId } = await setup([{ trigger: 'every', type: 'percent', value: 10 }]);
    await accrue(userId, 'invoice_paid', '100.00', '2026-01-01');
    const [row] = await commissions();
    expect(row!.amount).toBe('10.00');
    expect(row!.metadata).toEqual({});
  });

  it('a per-partner override with tiers is what accrues', async () => {
    const { userId, partner } = await setup([{ trigger: 'every', type: 'percent', value: 5 }]);
    const override = [
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        tiers: { metric: 'revenue', window: 'lifetime', levels: [{ atLeast: 1000, value: 25 }] },
      },
    ];
    const put = await putOverride(partner.id, override);
    expect(put.status).toBe(200);
    expect(put.body.snapshot.commissionRules).toEqual(override);

    await accrue(userId, 'invoice_paid', '1000.00', '2026-01-01');
    await accrue(userId, 'invoice_paid', '100.00', '2026-01-02');
    const rows = await commissions();
    expect(rows.map((r) => r.amount)).toEqual(['100.00', '25.00']); // the override's tiers, not the program's 5%
    expect(rows[1]!.metadata.slab).toMatchObject({ kind: 'tier', level: 1 });
  });

  it('the override route rejects a slab table the program route would', async () => {
    const partner = await createPartner();
    const res = await putOverride(partner.id, [
      {
        trigger: 'every',
        type: 'percent',
        value: 10,
        tiers: { metric: 'revenue', window: 'lifetime', levels: [{ atLeast: 1000, value: 20 }] },
      },
    ]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.detail)).toContain('tiers need an eventType');
  });
});

describe.skipIf(skipIntegration)('Network approval snapshots', () => {
  const tiered = {
    trigger: 'every',
    eventType: 'invoice_paid',
    type: 'percent',
    value: 10,
    tiers: { metric: 'revenue', window: 'calendar_month', levels: [{ atLeast: 100000, value: 15 }] },
  };

  it('a snapshot that lost the program\'s tiers is not grandfathered', async () => {
    const program = await createProgram([tiered]);
    // What a Network that predates slabs sends back: the base rate alone.
    const res = await federatedPartner(program.id, [{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 10 }]);
    expect(res.status).toBe(201);
    expect(await db(TABLES.PartnerCommission).where({ partnerId: res.body.id }).first()).toBeUndefined();
  });

  it('a snapshot that carries the tiers is stored with them', async () => {
    const program = await createProgram([tiered]);
    const res = await federatedPartner(program.id, [tiered]);
    expect(res.status).toBe(201);
    const row = await db(TABLES.PartnerCommission).where({ partnerId: res.body.id }).first();
    expect(row.commissionRules).toEqual([tiered]);
  });

  it('flat programs still snapshot exactly as before', async () => {
    const program = await createProgram([{ trigger: 'every', type: 'percent', value: 20 }]);
    const res = await federatedPartner(program.id, [{ trigger: 'every', type: 'percent', value: 20 }]);
    expect(res.status).toBe(201);
    const row = await db(TABLES.PartnerCommission).where({ partnerId: res.body.id }).first();
    expect(row.commissionRules).toEqual([{ trigger: 'every', type: 'percent', value: 20 }]);
  });

  // Review finding: the guard dropped ANY slab-less snapshot when a granted
  // program had slabs — including terms the partner really applied to.
  it('keeps a snapshot that differs from the stripped program rule (a stale offering, say)', async () => {
    const program = await createProgram([tiered]);
    // The offering still shows an older flat 20%: a sync failed after the
    // brand moved to a tiered 10% base. 20% is what the creator applied to.
    const stale = [{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 20 }];
    const res = await federatedPartner(program.id, stale);
    expect(res.status).toBe(201);
    const row = await db(TABLES.PartnerCommission).where({ partnerId: res.body.id }).first();
    expect(row.commissionRules).toEqual(stale);
  });

  it('a legacy single-rule snapshot equal to the base rate is dropped; any other is kept', async () => {
    const program = await createProgram([tiered]);
    const base = await federate({ commissionType: 'percent', commissionValue: 10 }, [program.id]);
    expect(base.status).toBe(201);
    expect(await db(TABLES.PartnerCommission).where({ partnerId: base.body.id }).first()).toBeUndefined();

    const other = await federate({ commissionType: 'percent', commissionValue: 20 }, [program.id]);
    expect(other.status).toBe(201);
    const row = await db(TABLES.PartnerCommission).where({ partnerId: other.body.id }).first();
    expect(Number(row.commissionValue)).toBe(20);
  });

  it('the grant-all default keeps a flat snapshot that matches no tiered program', async () => {
    await createProgram([tiered]);
    await createProgram([{ trigger: 'every', type: 'percent', value: 20 }]);
    const res = await federate({ commissionType: 'percent', commissionValue: 20, commissionRules: [{ trigger: 'every', type: 'percent', value: 20 }] });
    expect(res.status).toBe(201);
    expect(await db(TABLES.PartnerCommission).where({ partnerId: res.body.id }).first()).toBeDefined();
  });

  // Review finding: this route had no slab checks, so any of these would
  // have been stored — and outranked the program rule for good.
  it.each([
    ['a 500% step', { ...tiered, tiers: undefined, bands: { levels: [{ above: 100, value: 500 }] } }],
    ['bands and tiers together', { ...tiered, bands: { levels: [{ above: 100, value: 15 }] } }],
    ['marginal on a fixed rule', { trigger: 'every', eventType: 'invoice_paid', type: 'fixed', value: 5, bands: { mode: 'marginal', levels: [{ above: 100, value: 10 }] } }],
    ['a tier with nothing to count', { trigger: 'every', type: 'percent', value: 10, tiers: { metric: 'conversions', window: 'lifetime', levels: [{ atLeast: 1, value: 15 }] } }],
    ['rolling_days without windowDays', { ...tiered, tiers: { ...tiered.tiers, window: 'rolling_days' } }],
    ['descending thresholds', { ...tiered, tiers: { ...tiered.tiers, levels: [{ atLeast: 5, value: 15 }, { atLeast: 1, value: 20 }] } }],
  ])('a snapshot with %s is not stored, and the approval still succeeds', async (_name, rule) => {
    const program = await createProgram([tiered]);
    const res = await federatedPartner(program.id, [rule]);
    expect(res.status).toBe(201);
    expect(await db(TABLES.PartnerCommission).where({ partnerId: res.body.id }).first()).toBeUndefined();
  });

  it('a stored slab snapshot is parsed like a program rule (bands.mode defaulted)', async () => {
    const banded = { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 10, bands: { levels: [{ above: 100, value: 15 }] } };
    const program = await createProgram([banded]);
    const res = await federatedPartner(program.id, [banded]);
    expect(res.status).toBe(201);
    const row = await db(TABLES.PartnerCommission).where({ partnerId: res.body.id }).first();
    expect(row.commissionRules).toEqual([{ ...banded, bands: { mode: 'whole', levels: [{ above: 100, value: 15 }] } }]);
  });
});

describe.skipIf(skipIntegration)('program rule validation', () => {
  const base = { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 10 };
  const levels = (n: number) => Array.from({ length: n }, (_, i) => ({ above: (i + 1) * 1000, value: 10 + i }));

  it('stores bands and tiers as sent, defaulting bands.mode to whole', async () => {
    const rules = [
      { ...base, bands: { levels: [{ above: 50000, value: 15 }] } },
      {
        ...base,
        trigger: 'first',
        type: 'fixed',
        value: 50,
        currency: 'INR',
        tiers: { metric: 'conversions', window: 'rolling_days', windowDays: 90, levels: [{ atLeast: 10, value: 100 }] },
      },
    ];
    const res = await postProgram(rules);
    expect(res.status).toBe(201);
    const row = await db(TABLES.Program).where({ id: res.body.id }).first();
    expect(row.commissionRule).toEqual([
      { ...base, bands: { mode: 'whole', levels: [{ above: 50000, value: 15 }] } },
      rules[1],
    ]);
  });

  it('accepts the legacy single-object shape and the currency on a percent rule', async () => {
    const legacy = await postProgram({ type: 'percent', value: 20, recurring: true });
    expect(legacy.status).toBe(201);
    const row = await db(TABLES.Program).where({ id: legacy.body.id }).first();
    expect(row.commissionRule).toEqual([{ trigger: 'every', type: 'percent', value: 20, recurring: true }]);

    const withCurrency = await postProgram([{ ...base, currency: 'INR', bands: { levels: [{ above: 1, value: 12 }] } }]);
    expect(withCurrency.status).toBe(201);
  });

  it.each([
    ['descending thresholds', { ...base, bands: { levels: [{ above: 2000, value: 15 }, { above: 1000, value: 20 }] } }, 'strictly ascending'],
    ['equal thresholds', { ...base, tiers: { metric: 'revenue', window: 'lifetime', levels: [{ atLeast: 5, value: 15 }, { atLeast: 5, value: 20 }] } }, 'strictly ascending'],
    ['more than ten steps', { ...base, bands: { levels: levels(11) } }, 'at most 10'],
    ['an empty table', { ...base, bands: { levels: [] } }, 'at least 1'],
    ['a zero threshold', { ...base, bands: { levels: [{ above: 0, value: 15 }] } }, 'greater than 0'],
    ['bands and tiers together', { ...base, bands: { levels: [{ above: 1, value: 15 }] }, tiers: { metric: 'revenue', window: 'lifetime', levels: [{ atLeast: 1, value: 15 }] } }, 'bands or tiers, not both'],
    ['marginal on a fixed rule', { ...base, type: 'fixed', value: 5, bands: { mode: 'marginal', levels: [{ above: 1, value: 15 }] } }, 'marginal bands need a percent rule'],
    ['a percent step over 100', { ...base, bands: { levels: [{ above: 1, value: 150 }] } }, 'cannot exceed 100'],
    ['rolling_days without windowDays', { ...base, tiers: { metric: 'revenue', window: 'rolling_days', levels: [{ atLeast: 1, value: 15 }] } }, 'require windowDays'],
    ['windowDays on another window', { ...base, tiers: { metric: 'revenue', window: 'lifetime', windowDays: 30, levels: [{ atLeast: 1, value: 15 }] } }, 'only applies to rolling_days'],
    ['tiers with nothing to count', { trigger: 'every', type: 'percent', value: 10, tiers: { metric: 'conversions', window: 'lifetime', levels: [{ atLeast: 1, value: 15 }] } }, 'tiers need an eventType'],
    ['a currency that is not three letters', { ...base, currency: '$$$', bands: { levels: [{ above: 1, value: 15 }] } }, 'currency must be a 3-letter code'],
  ])('rejects %s', async (_name, rule, message) => {
    const res = await postProgram([rule]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.detail)).toContain(message);
  });

  // Review finding: the legacy object schema stripped unknown keys, so
  // slabs sent that way saved as a flat rule.
  it('rejects slabs on the legacy single-object shape instead of saving it flat', async () => {
    const res = await postProgram({ type: 'percent', value: 10, bands: { levels: [{ above: 100, value: 15 }] } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.detail)).toContain('bands and tiers need the array form');
  });

  it('the override route refuses a currency that is not three letters too', async () => {
    const partner = await createPartner();
    const res = await putOverride(partner.id, [{ ...base, currency: '$$$', bands: { levels: [{ above: 1, value: 15 }] } }]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.detail)).toContain('currency must be a 3-letter code');
  });
});

// -------- helpers --------

async function setup(rules: unknown[]) {
  const partner = await createPartner();
  const program = await createProgram(rules);
  const userId = `u-${ulid()}`;
  await click(partner.id, program.id, userId, CLICK_TS);
  return { partner, program, userId };
}

async function commissions(): Promise<CommissionWithMeta[]> {
  // accruedAt ties within one transaction-less test are rare but possible;
  // the ULID id is the tiebreaker that matches insertion order.
  return (await db(TABLES.Commission).orderBy([{ column: 'accruedAt' }, { column: 'id' }])) as CommissionWithMeta[];
}

async function accrue(userId: string, type: string, value: string | null, ts: string, currency = 'USD') {
  const event = await insertEvent(userId, type, value, new Date(ts), currency);
  await attributeEvent(db, event);
  return event;
}

async function createPartner() {
  const res = await request(app)
    .post('/partners')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({ email: `p+${ulid()}@example.com`, name: 'Slab test', sendInvite: false, programIds: [] });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function federatedPartner(programId: string, commissionRules: unknown[]) {
  return federate({ commissionType: 'percent', commissionValue: 10, commissionRules }, [programId]);
}

/** POST /partners with a commission snapshot. No programIds = the
 *  grant-every-program default. */
async function federate(commissionSnapshot: Record<string, unknown>, programIds?: string[]) {
  return request(app)
    .post('/partners')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({
      email: `p+${ulid()}@example.com`,
      name: 'Network creator',
      sendInvite: false,
      ...(programIds ? { programIds } : {}),
      campaignGrantSource: 'offering',
      commissionSnapshot,
    });
}

function postProgram(commissionRule: unknown) {
  return request(app)
    .post('/programs')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({
      name: 'Slabs',
      commissionRule,
      attributionWindowDays: 365,
      destinationUrl: 'https://example.com/signup',
      deepLinkAllowedDomains: 'example.com',
    });
}

async function createProgram(rules: unknown[], extra: Record<string, unknown> = {}) {
  const res = await postProgram(rules);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  if (Object.keys(extra).length > 0) {
    await db(TABLES.Program).where({ id: res.body.id }).update(extra);
  }
  return res.body as { id: string };
}

async function putOverride(partnerId: string, commissionRules: unknown[]) {
  return request(app)
    .put(`/partners/${partnerId}/commission-snapshot`)
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({ commissionType: 'percent', commissionValue: 10, commissionRules });
}

/** A click by `partnerId` on `programId`, stitched to `userId`. */
async function click(partnerId: string, programId: string, userId: string, ts: Date): Promise<string> {
  const linkId = ulid();
  await db(TABLES.Link).insert({
    id: linkId,
    tenantId: DEFAULT_TENANT_ID,
    linkKey: `k${linkId.toLowerCase()}`,
    partnerId,
    programId,
    destinationUrl: 'https://example.com/',
  });
  const clickId = ulid();
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: DEFAULT_TENANT_ID,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://example.com/',
    ts,
  });
  await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });
  return clickId;
}

async function insertEvent(userId: string, type: string, value: string | null, ts: Date, currency = 'USD') {
  const id = ulid();
  await db(TABLES.Event).insert({
    id,
    tenantId: DEFAULT_TENANT_ID,
    userId,
    type,
    value,
    currency,
    externalEventId: `evt_${ulid()}`,
    metadata: {},
    ts,
  });
  return (await db(TABLES.Event).where({ id }).first()) as EventRow;
}
