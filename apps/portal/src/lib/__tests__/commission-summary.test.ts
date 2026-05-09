import { describe, it, expect } from 'vitest';
import { renderCommissionSummary } from '../commission-summary.js';

describe('renderCommissionSummary', () => {
  it('returns "—" for missing or empty rules', () => {
    expect(renderCommissionSummary(null)).toBe('—');
    expect(renderCommissionSummary([])).toBe('—');
  });

  it('renders a single percent recurring rule with no event filter', () => {
    expect(
      renderCommissionSummary([{ trigger: 'every', type: 'percent', value: 20, recurring: true }]),
    ).toBe('20% recurring');
  });

  it('renders a fixed rule on first event', () => {
    expect(
      renderCommissionSummary([
        { trigger: 'first', eventType: 'subscription_created', type: 'fixed', value: 200 },
      ]),
    ).toBe('$200 on first subscription');
  });

  it('combines a first-sale bonus with a capped recurring percent', () => {
    expect(
      renderCommissionSummary([
        { trigger: 'first', eventType: 'subscription_created', type: 'fixed', value: 200 },
        {
          trigger: 'every',
          eventType: 'invoice_paid',
          type: 'percent',
          value: 20,
          recurring: true,
          recurringMonths: 12,
        },
      ]),
    ).toBe('$200 on first subscription + 20% recurring on every invoice for 12 months');
  });

  it('appends a customer-side reward', () => {
    expect(
      renderCommissionSummary(
        [{ trigger: 'every', type: 'percent', value: 20, recurring: true }],
        { type: 'percent_off', value: 25, duration: 'repeating', durationInMonths: 6 },
      ),
    ).toBe('20% recurring — customers get 25% off for 6 months');
  });

  it('renders free-months reward', () => {
    expect(
      renderCommissionSummary(
        [{ trigger: 'every', type: 'percent', value: 30 }],
        { type: 'free_months', value: 1, duration: 'repeating' },
      ),
    ).toBe('30% — customers get 1 month free');
  });

  it('renders amount_off with non-USD currency', () => {
    expect(
      renderCommissionSummary(
        [{ trigger: 'every', type: 'percent', value: 10 }],
        { type: 'amount_off', value: 50, currency: 'eur', duration: 'once' },
      ),
    ).toBe('10% — customers get $50 EUR off on first invoice');
  });

  it('trims trailing zeros from non-integer values', () => {
    expect(
      renderCommissionSummary([{ trigger: 'every', type: 'percent', value: 12.5, recurring: true }]),
    ).toBe('12.5% recurring');
  });
});
