/**
 * Commission slabs — the pure parts: band arithmetic, tier windows, the
 * marketplace summary and the Network terms payload. The engine path
 * (tiers read from the database, triggers, weights, overrides) is in
 * commission-slabs.integration.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { renderCommissionSummary, type CommissionSubRule, type ProgramRow } from '@openpartner/db';
import { bandAccrual, commissionMetadata, rulesHaveSlabs, tierWindowStart } from '../commission-slabs.js';
import { buildTermsPayload, NETWORK_DESCRIPTION_MAX } from '../campaign-marketplace-sync.js';

const tenToFifteen: Pick<CommissionSubRule, 'type' | 'value' | 'bands'> = {
  type: 'percent',
  value: 10,
  bands: { mode: 'whole', levels: [{ above: 50000, value: 15 }] },
};

describe('value bands — whole event', () => {
  it('a value AT the threshold stays in the band below it', () => {
    const r = bandAccrual(tenToFifteen, 50000, 'INR');
    expect(r.amount).toBe(5000);
    expect(r.slab).toMatchObject({ kind: 'band', mode: 'whole', level: 0, threshold: null, value: 10, basis: 50000 });
  });

  it('a value just above the threshold pays the whole event at the band rate', () => {
    const r = bandAccrual(tenToFifteen, 50000.01, 'INR');
    expect(r.amount).toBe(7500); // 15% of 50,000.01 = 7,500.0015 → 7,500.00
    expect(r.slab).toMatchObject({ level: 1, threshold: 50000, value: 15 });
  });

  it('walks several steps and picks the highest one exceeded', () => {
    const rule = {
      type: 'percent' as const,
      value: 10,
      bands: { mode: 'whole' as const, levels: [{ above: 50000, value: 15 }, { above: 100000, value: 20 }] },
    };
    expect(bandAccrual(rule, 100000, 'USD').amount).toBe(15000);
    expect(bandAccrual(rule, 250000, 'USD').amount).toBe(50000);
    expect(bandAccrual(rule, 250000, 'USD').slab).toMatchObject({ level: 2, threshold: 100000 });
  });

  it('value-less and negative events sit in the base band', () => {
    expect(bandAccrual(tenToFifteen, 0, 'USD').amount).toBe(0);
    expect(bandAccrual(tenToFifteen, 0, 'USD').slab).toMatchObject({ level: 0 });
    expect(bandAccrual(tenToFifteen, -60000, 'USD').amount).toBe(-6000);
  });

  it('fixed bands pay the band amount regardless of the value inside it', () => {
    const rule = {
      type: 'fixed' as const,
      value: 50,
      bands: { mode: 'whole' as const, levels: [{ above: 1000, value: 100 }] },
    };
    expect(bandAccrual(rule, 999, 'USD').amount).toBe(50);
    expect(bandAccrual(rule, 1000.01, 'USD').amount).toBe(100);
    expect(bandAccrual(rule, 0, 'USD').amount).toBe(50);
  });
});

describe('value bands — marginal', () => {
  const marginal = { ...tenToFifteen, bands: { mode: 'marginal' as const, levels: tenToFifteen.bands!.levels } };

  it('pays each slice at its own rate', () => {
    const r = bandAccrual(marginal, 60000, 'INR');
    expect(r.amount).toBe(6500); // 50,000 × 10% + 10,000 × 15%
    expect(r.slab).toMatchObject({ mode: 'marginal', level: 1, threshold: 50000, value: 15 });
    expect(r.slab!.slices).toEqual([
      { level: 0, from: 0, to: 50000, portion: 50000, value: 10 },
      { level: 1, from: 50000, to: null, portion: 10000, value: 15 },
    ]);
  });

  it('below the first threshold it is a flat base-rate percent', () => {
    expect(bandAccrual(marginal, 40000, 'INR').amount).toBe(4000);
    expect(bandAccrual(marginal, 40000, 'INR').slab!.slices).toHaveLength(1);
  });

  it('rounds once, to the cent, without float drift at the slice edge', () => {
    // 5,000 + 10,000.10 × 15% = 6,500.015 → 6,500.02. Float subtraction
    // (60000.10 − 50000 = 10000.0999…) would have rounded it down.
    expect(bandAccrual(marginal, 60000.1, 'INR').amount).toBe(6500.02);
  });

  // Review finding: the slice bounds were integer cents but the rate
  // multiply was still a float, so a rate that isn't a binary fraction lost
  // a cent on exact half-cents.
  it('is exact for rates that are not binary fractions', () => {
    const rule = {
      type: 'percent' as const,
      value: 5,
      bands: { mode: 'marginal' as const, levels: [{ above: 100, value: 8.7 }] },
    };
    // 100 × 5% + 205 × 8.7% = 5 + 17.835 = 22.835 → 22.84 (float: 22.83)
    expect(bandAccrual(rule, 305, 'USD').amount).toBe(22.84);
    // Below the first threshold: 12.5% of 1.16 = 0.145 → 0.15
    const eighth = { ...rule, value: 12.5 };
    expect(bandAccrual(eighth, 1.16, 'USD').amount).toBe(0.15);
  });

  it('a value too small to hold a whole cent pays the base rate instead of throwing', () => {
    expect(() => bandAccrual(marginal, 0.004, 'USD')).not.toThrow();
    expect(bandAccrual(marginal, 0.004, 'USD').slab).toMatchObject({ level: 0 });
  });

  it('three slices', () => {
    const rule = {
      type: 'percent' as const,
      value: 10,
      bands: { mode: 'marginal' as const, levels: [{ above: 1000, value: 20 }, { above: 5000, value: 30 }] },
    };
    // 1,000 × 10% + 4,000 × 20% + 3,000 × 30%
    expect(bandAccrual(rule, 8000, 'USD').amount).toBe(1800);
  });

  it('tolerates a stored table that bypassed validation (unordered, junk steps)', () => {
    const rule = {
      type: 'percent' as const,
      value: 10,
      bands: {
        mode: 'whole' as const,
        levels: [{ above: 100, value: 30 }, { above: 'x', value: 99 }, { above: 50, value: 20 }] as never,
      },
    };
    expect(bandAccrual(rule, 75, 'USD').amount).toBe(15); // the 50 step, read in order
  });
});

describe('tier windows', () => {
  const at = new Date('2026-03-15T10:30:00Z');

  it('lifetime has no start', () => {
    expect(tierWindowStart({ window: 'lifetime' }, at)).toBeNull();
  });

  it('calendar_month starts at 00:00 UTC on the 1st', () => {
    expect(tierWindowStart({ window: 'calendar_month' }, at)?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(tierWindowStart({ window: 'calendar_month' }, new Date('2026-03-31T23:59:59Z'))?.toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );
  });

  it('rolling_days counts back windowDays', () => {
    expect(tierWindowStart({ window: 'rolling_days', windowDays: 30 }, at)?.toISOString()).toBe(
      '2026-02-13T10:30:00.000Z',
    );
  });
});

describe('audit metadata', () => {
  it('records the slab with the rule position; plain rules stay {}', () => {
    const banded = bandAccrual(tenToFifteen, 60000, 'USD');
    expect(commissionMetadata(banded, 2)).toEqual({ slab: { ruleIndex: 2, ...banded.slab } });
    expect(commissionMetadata({ amount: 10 }, 0)).toEqual({});
  });

  it('rulesHaveSlabs spots bands or tiers anywhere in the array', () => {
    expect(rulesHaveSlabs([{ trigger: 'every', type: 'percent', value: 10 }])).toBe(false);
    expect(rulesHaveSlabs([{ trigger: 'every', type: 'percent', value: 10 }, { ...tenToFifteen, trigger: 'every' }])).toBe(true);
    expect(rulesHaveSlabs(null)).toBe(false);
    expect(rulesHaveSlabs({ type: 'percent', value: 10 })).toBe(false); // legacy single object
  });
});

describe('renderCommissionSummary with slabs', () => {
  it('leaves slab-less rules exactly as before', () => {
    expect(
      renderCommissionSummary([
        { trigger: 'first', eventType: 'subscription_created', type: 'fixed', value: 200 },
        { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 20, recurring: true, recurringMonths: 12 },
      ]),
    ).toBe('$200 on first subscription + 20% recurring on every invoice for 12 months');
  });

  it('shows a band rule as the range it pays, never the top rate alone', () => {
    expect(
      renderCommissionSummary([{ trigger: 'every', eventType: 'invoice_paid', ...tenToFifteen }]),
    ).toBe('10–15% on every invoice (slabs by invoice value)');
    expect(
      renderCommissionSummary([
        { trigger: 'every', type: 'percent', value: 10, bands: { mode: 'marginal', levels: [{ above: 100, value: 12.5 }] } },
      ]),
    ).toBe('10–12.5% (marginal slabs by event value)');
  });

  it('names the tier metric and window', () => {
    const tiers = { metric: 'revenue' as const, levels: [{ atLeast: 1000, value: 20 }] };
    const rule = { trigger: 'every' as const, eventType: 'invoice_paid', type: 'percent' as const, value: 10, recurring: true };
    expect(renderCommissionSummary([{ ...rule, tiers: { ...tiers, window: 'lifetime' } }])).toBe(
      '10–20% recurring on every invoice (tiers by lifetime partner revenue)',
    );
    expect(renderCommissionSummary([{ ...rule, tiers: { ...tiers, window: 'calendar_month' } }])).toBe(
      '10–20% recurring on every invoice (tiers by monthly partner revenue)',
    );
    expect(
      renderCommissionSummary([
        {
          trigger: 'first',
          eventType: 'subscription_created',
          type: 'fixed',
          value: 50,
          tiers: { metric: 'conversions', window: 'rolling_days', windowDays: 30, levels: [{ atLeast: 10, value: 100 }] },
        },
      ]),
    ).toBe('$50–$100 on first subscription (tiers by partner conversions, last 30 days)');
  });

  it('a decreasing table still reads low–high', () => {
    expect(
      renderCommissionSummary([
        { trigger: 'every', type: 'percent', value: 20, bands: { mode: 'whole', levels: [{ above: 1e6, value: 5 }] } },
      ]),
    ).toBe('5–20% (slabs by event value)');
  });
});

describe('marketplace terms payload', () => {
  function program(rules: CommissionSubRule[]): ProgramRow {
    return {
      commissionRule: rules,
      holdbackDays: 0,
      attributionWindowDays: 60,
      attributionModel: 'last_click',
      customerReward: null,
      categories: [],
      endsAt: null,
    } as unknown as ProgramRow;
  }

  it('sends tiered rules verbatim and mirrors the BASE rate into the legacy fields', () => {
    const rules: CommissionSubRule[] = [
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        tiers: { metric: 'revenue', window: 'calendar_month', levels: [{ atLeast: 100000, value: 15 }] },
      },
    ];
    const terms = buildTermsPayload(program(rules), renderCommissionSummary(rules));
    expect(terms.commissionRules).toEqual(rules);
    expect(terms.commissionType).toBe('percent');
    expect(terms.commissionValue).toBe(10);
    expect(terms.commissionDescription).toBe('10–15% on every invoice (tiers by monthly partner revenue)');
  });

  it('trims a summary past the Network limit instead of failing the whole write', () => {
    const long = 'x'.repeat(NETWORK_DESCRIPTION_MAX + 50);
    const terms = buildTermsPayload(program([{ trigger: 'every', type: 'percent', value: 10 }]), long);
    expect(terms.commissionDescription!.length).toBe(NETWORK_DESCRIPTION_MAX);
    expect(terms.commissionDescription!.endsWith('…')).toBe(true);
  });

  it('never cuts an emoji in half — a lone surrogate would fail the Network’s jsonb write', () => {
    // '🚀' is two UTF-16 units; put its first half at the last kept index.
    const long = `${'x'.repeat(NETWORK_DESCRIPTION_MAX - 2)}🚀${'y'.repeat(20)}`;
    const out = buildTermsPayload(program([{ trigger: 'every', type: 'percent', value: 10 }]), long).commissionDescription!;
    expect(out.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });
});
