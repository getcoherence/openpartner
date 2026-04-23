import { describe, it, expect } from 'vitest';
import { computeCommissionAmount } from '../attribution.js';

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
