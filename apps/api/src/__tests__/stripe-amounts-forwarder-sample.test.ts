/**
 * The Payment Link forwarder sample (examples/stripe-payment-link-forwarder)
 * converts Stripe's amount_total to major units itself: it's a
 * copy-and-run server with no dependencies, so it can't import
 * stripe-amounts.ts. Hold its lists and its arithmetic to the API's, so the
 * value a brand forwards is the value the API would have stored from Stripe.
 * The sample once divided UGX by 1, which reported a 5 UGX sale as 500.
 */

import { describe, expect, it } from 'vitest';
import { fromStripeMinor, THREE_DECIMAL, WHOLE_UNITS_TWO_DECIMAL, ZERO_DECIMAL } from '../stripe-amounts.js';

interface ForwarderAmounts {
  ZERO_DECIMAL: ReadonlySet<string>;
  THREE_DECIMAL: ReadonlySet<string>;
  fromStripeAmount(amount: number, currency: string): number;
}

// Outside the package and plain JS, so loaded by URL rather than a static import.
const sample = (await import(
  new URL('../../../../examples/stripe-payment-link-forwarder/stripe-amount.mjs', import.meta.url).href
)) as ForwarderAmounts;

const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe('Payment Link forwarder sample amounts', () => {
  it('has the API zero- and three-decimal lists', () => {
    expect(sorted(sample.ZERO_DECIMAL)).toEqual(sorted(ZERO_DECIMAL));
    expect(sorted(sample.THREE_DECIMAL)).toEqual(sorted(THREE_DECIMAL));
  });

  it('converts each Stripe amount to the major units the API stores', () => {
    const codes = [...ZERO_DECIMAL, ...THREE_DECIMAL, ...WHOLE_UNITS_TWO_DECIMAL, 'USD', 'EUR', 'HUF', 'TWD'];
    // Stripe charges three-decimal currencies in whole tens, so amount_total ends in 0.
    for (const code of codes) {
      for (const amount of [0, 500, 4990, 12350, 1_000_000]) {
        // Stripe sends the code lower-case.
        expect(sample.fromStripeAmount(amount, code.toLowerCase()), `${amount} ${code}`).toBe(fromStripeMinor(amount, code));
      }
    }
  });

  it('reads UGX and ISK in hundredths, as Stripe sends them', () => {
    expect(sample.fromStripeAmount(500, 'ugx')).toBe(5);
    expect(sample.fromStripeAmount(500, 'isk')).toBe(5);
    expect(sample.fromStripeAmount(500, 'jpy')).toBe(500);
    expect(sample.fromStripeAmount(12350, 'kwd')).toBe(12.35);
  });
});
