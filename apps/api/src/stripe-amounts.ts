/**
 * Stripe's integer amounts ↔ the amounts we store.
 *
 * Event.value, Commission.amount and Payout.amount are major units with two
 * decimals (decimal(14,2)), whatever the currency. Stripe takes and returns
 * every amount as an integer in the currency's smallest unit AS STRIPE
 * DEFINES IT (https://docs.stripe.com/currencies), which is not always
 * "hundredths":
 *
 *   zero-decimal   ¥1,000 is 1000, not 100000. Fixing only one side of
 *                  this is worse than neither: dividing every webhook amount
 *                  by 100 stored a ¥1,000 sale as ¥10, and multiplying every
 *                  transfer by 100 sent that sale's ¥2 commission as ¥200.
 *   three-decimal  KWD 1.230 is 1230. Stripe only charges these in whole
 *                  tens (the last digit is 0), so two stored decimals hold
 *                  every amount Stripe collects exactly.
 *   ISK, UGX       whole units, but Stripe keeps the two-decimal form for
 *                  backwards compatibility: 5 ISK is 500, and fractions
 *                  can't be charged. UGX is also on Stripe's zero-decimal
 *                  list; the special-cases table, which states the API form
 *                  explicitly, wins. Amounts we send round to whole units.
 *   HUF, TWD       two-decimal in the API; whole units only for the bank
 *                  payouts a Standard account makes itself, which we never
 *                  create. Treated as plain two-decimal.
 *
 * Conversions go through integer hundredths, the storage precision, so no
 * float ever crosses the boundary unrounded. Rounding is half away from
 * zero, which matches Math.round for the positive amounts that dominate and
 * keeps refunds (negative) symmetric.
 *
 * Unknown and missing codes are two-decimal, which is Stripe's default and
 * what a legacy null currency (USD) needs.
 *
 * The Payment Link forwarder sample (examples/stripe-payment-link-forwarder)
 * keeps its own copy of these lists, because it runs with no dependencies.
 * stripe-amounts-forwarder-sample.test.ts fails when the two disagree.
 */

export const ZERO_DECIMAL: ReadonlySet<string> = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
export const THREE_DECIMAL: ReadonlySet<string> = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
/** Two-decimal in Stripe's API, whole units in practice. */
export const WHOLE_UNITS_TWO_DECIMAL: ReadonlySet<string> = new Set(['ISK', 'UGX']);

/** Digits after the point in Stripe's integer form of `currency`. */
export function stripeExponent(currency: string | null | undefined): 0 | 2 | 3 {
  const code = currency?.trim().toUpperCase() ?? '';
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

function roundHalfAway(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

function requireInteger(n: number, what: string): number {
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`non-integer ${what}: ${n}`);
  return n;
}

/** Stripe's integer amount → integer hundredths of the major unit. */
export function stripeMinorToCents(minor: number, currency: string | null | undefined): number {
  requireInteger(minor, 'Stripe amount');
  switch (stripeExponent(currency)) {
    case 0:
      return minor * 100;
    case 3:
      return roundHalfAway(minor / 10);
    default:
      return minor;
  }
}

/** Integer hundredths of the major unit → Stripe's integer amount. */
export function centsToStripeMinor(cents: number, currency: string | null | undefined): number {
  requireInteger(cents, 'hundredths amount');
  const code = currency?.trim().toUpperCase() ?? '';
  switch (stripeExponent(code)) {
    case 0:
      return roundHalfAway(cents / 100);
    case 3:
      return cents * 10;
    default:
      return WHOLE_UNITS_TWO_DECIMAL.has(code) ? roundHalfAway(cents / 100) * 100 : cents;
  }
}

/** A stored major amount ("12.34", 12.34) → integer hundredths. Throws on NaN. */
export function majorToCents(amount: string | number): number {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) throw new Error(`non-numeric amount: ${amount}`);
  return roundHalfAway(n * 100);
}

/** Stripe's integer amount → major units, rounded to the two stored decimals. */
export function fromStripeMinor(minor: number, currency: string | null | undefined): number {
  return stripeMinorToCents(minor, currency) / 100;
}

/** A stored major amount → Stripe's integer amount. */
export function toStripeMinor(amount: string | number, currency: string | null | undefined): number {
  return centsToStripeMinor(majorToCents(amount), currency);
}

/** Stripe's integer amount → the decimal string a money column stores. */
export function stripeMinorToMajorString(minor: number | string, currency: string | null | undefined): string {
  const n = typeof minor === 'string' ? Number(minor) : minor;
  return (stripeMinorToCents(n, currency) / 100).toFixed(2);
}
