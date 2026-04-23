import { describe, it, expect } from 'vitest';
import { applyModel, computeCommissionAmount } from '../attribution.js';

describe('computeCommissionAmount', () => {
  it('percent rule scales revenue', () => {
    expect(computeCommissionAmount({ type: 'percent', value: 10 }, { value: '100.00' })).toBe(10);
    expect(computeCommissionAmount({ type: 'percent', value: 25 }, { value: '99.99' })).toBeCloseTo(25, 2);
  });

  it('fixed rule ignores revenue', () => {
    expect(computeCommissionAmount({ type: 'fixed', value: 5 }, { value: '100.00' })).toBe(5);
    expect(computeCommissionAmount({ type: 'fixed', value: 5 }, { value: null })).toBe(5);
  });

  it('percent rule with null revenue earns nothing', () => {
    expect(computeCommissionAmount({ type: 'percent', value: 10 }, { value: null })).toBe(0);
  });

  it('rounds to cents', () => {
    // 33.33 * 10% should round to 3.33, not 3.333
    expect(computeCommissionAmount({ type: 'percent', value: 10 }, { value: '33.33' })).toBe(3.33);
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
