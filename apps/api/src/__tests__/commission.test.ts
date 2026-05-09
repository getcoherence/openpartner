import { describe, it, expect } from 'vitest';
import { applyModel, computeSubRuleAmount, parseCommissionRule } from '../attribution.js';

describe('computeSubRuleAmount', () => {
  it('percent rule scales revenue', () => {
    expect(computeSubRuleAmount({ trigger: 'every', type: 'percent', value: 10 }, { value: '100.00' })).toBe(10);
    expect(computeSubRuleAmount({ trigger: 'every', type: 'percent', value: 25 }, { value: '99.99' })).toBeCloseTo(25, 2);
  });

  it('fixed rule ignores revenue', () => {
    expect(computeSubRuleAmount({ trigger: 'every', type: 'fixed', value: 5 }, { value: '100.00' })).toBe(5);
    expect(computeSubRuleAmount({ trigger: 'every', type: 'fixed', value: 5 }, { value: null })).toBe(5);
  });

  it('percent rule with null revenue earns nothing', () => {
    expect(computeSubRuleAmount({ trigger: 'every', type: 'percent', value: 10 }, { value: null })).toBe(0);
  });

  it('rounds to cents', () => {
    // 33.33 * 10% should round to 3.33, not 3.333
    expect(computeSubRuleAmount({ trigger: 'every', type: 'percent', value: 10 }, { value: '33.33' })).toBe(3.33);
  });
});

describe('parseCommissionRule', () => {
  it('passes array shape through unchanged', () => {
    const rules = [
      { trigger: 'first' as const, eventType: 'subscription_created', type: 'fixed' as const, value: 200 },
      { trigger: 'every' as const, eventType: 'invoice_paid', type: 'percent' as const, value: 20, recurring: true, recurringMonths: 12 },
    ];
    expect(parseCommissionRule(rules)).toEqual(rules);
  });

  it('wraps legacy single-object shape in a 1-element array', () => {
    expect(parseCommissionRule({ type: 'percent', value: 50, recurring: true })).toEqual([
      { trigger: 'every', type: 'percent', value: 50, currency: undefined, recurring: true },
    ]);
  });

  it('preserves currency on legacy fixed rules', () => {
    expect(parseCommissionRule({ type: 'fixed', value: 25, currency: 'USD' })).toEqual([
      { trigger: 'every', type: 'fixed', value: 25, currency: 'USD', recurring: undefined },
    ]);
  });

  it('throws on unrecognized shapes', () => {
    expect(() => parseCommissionRule(null)).toThrow();
    expect(() => parseCommissionRule({})).toThrow();
    expect(() => parseCommissionRule('20%')).toThrow();
  });
});

describe('applyModel', () => {
  it('last_click puts full weight on the final touch', () => {
    expect(applyModel('last_click', 3)).toEqual([0, 0, 1]);
  });
  it('first_click puts full weight on the first touch', () => {
    expect(applyModel('first_click', 3)).toEqual([1, 0, 0]);
  });
  it('linear splits evenly', () => {
    const w = applyModel('linear', 4);
    expect(w).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
  it('position: 40/20/40 with middle split', () => {
    expect(applyModel('position', 4)).toEqual([0.4, 0.1, 0.1, 0.4]);
    expect(applyModel('position', 2)).toEqual([0.5, 0.5]);
    expect(applyModel('position', 1)).toEqual([1]);
  });
  it('empty input returns empty', () => {
    expect(applyModel('linear', 0)).toEqual([]);
  });
});
