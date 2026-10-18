// Stripe's integer amount → major units, by Stripe's currency rules: https://docs.stripe.com/currencies
// The same lists as the API's apps/api/src/stripe-amounts.ts. A test there fails if the two disagree.
export const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
export const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
// ISK and UGX are whole units, but Stripe still writes them with two decimals: 5 UGX is 500. UGX is on
// Stripe's zero-decimal list too; its special-cases entry, which states the API form, wins. So both divide by 100.

export function fromStripeAmount(amount, currency) {
  const code = currency.toUpperCase();
  return amount / (ZERO_DECIMAL.has(code) ? 1 : THREE_DECIMAL.has(code) ? 1000 : 100);
}
