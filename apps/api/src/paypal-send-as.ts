/**
 * Balances PayPal can't send (docs/paypal-payouts.md "Balances PayPal
 * can't send").
 *
 * A payout's currency is its commissions' currency, and PayPal can't send
 * some of them: INR isn't a PayPal API currency at all (Indian PayPal
 * accounts take international payments in the sender's currency, and
 * PayPal converts them to INR on the way to the bank). A brand that
 * turns on "Pay balances PayPal can't send in: USD" (the `paypal_payouts`
 * Config key, off by default) can pay an INR payout to a partner's PayPal
 * email through Pay with PayPal in USD:
 *
 *   - **Quote first.** The brand asks for a quote: the ECB reference rate
 *     (fx.ts, the source the usage meter uses), its date, each payout's
 *     USD amount rounded on its own, and the source and sent totals. The
 *     quote id is signed and lasts QUOTE_TTL_MS; nothing is held.
 *   - **Send at that rate.** Sending with the quote id freezes exactly that
 *     rate into the batch, for exactly the payouts the quote showed
 *     (paypal-payouts.ts sendRunWithPaypal). An expired quote, a forged
 *     one, or a run whose payouts changed since is refused; the brand
 *     quotes again.
 *   - **The ledger doesn't move.** `Payout.amount` and `currency` stay INR,
 *     so commissions, clawback netting and reporting are unchanged. What
 *     was sent is on the payout's stamp (`manualExport.conversion`), which
 *     travels in exports, and on the partner's payout views (`sent`).
 *   - **PayPal's limits are on what PayPal sends**: a payout over PayPal's
 *     per-item limit in USD is left out of the quote.
 *
 * The brand pays the ECB mid-market amount. PayPal's own conversion of the
 * USD into INR for the partner's bank, at PayPal's rate, is between the
 * partner and PayPal, and every place that shows a converted amount says
 * so.
 */

import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import type { PayoutRow } from '@openpartner/db';
import { getConfig, setConfig } from './config.js';
import { macValue, verifyMac } from './crypto.js';
import { majorToCents } from './stripe-amounts.js';

export const PAYPAL_PAYOUTS_CONFIG_KEY = 'paypal_payouts';

/** Currencies PayPal can't send that Pay with PayPal converts when the
 *  brand opts in. The ECB must publish each (fx.ts). INR first; add one
 *  only after checking PayPal really can't send it and how its
 *  recipients' accounts receive. */
export const PAYPAL_CONVERTIBLE_CURRENCIES: ReadonlySet<string> = new Set(['INR']);

/** PayPal currencies a converted balance can be sent in. */
export const PAYPAL_SEND_AS_CURRENCIES = ['USD'] as const;
export type PaypalSendAsCurrency = (typeof PAYPAL_SEND_AS_CURRENCIES)[number];

/** How long a quote can be sent with. */
export const QUOTE_TTL_MS = 15 * 60 * 1000;

const QUOTE_MAC_PURPOSE = 'paypal-send-as-quote';
/** A rate is kept to this many decimals: 10 significant digits for INR→USD,
 *  far more than a cent on any payout. */
const RATE_DECIMALS = 12;
/** PayPal takes no decimals in these (manual-payout-files.ts). */
const NO_DECIMALS: ReadonlySet<string> = new Set(['HUF', 'JPY', 'TWD']);

export interface PaypalPayoutSettings {
  /** Send balances in a currency PayPal can't send (INR) in this PayPal
   *  currency instead. Null: off, and those payouts stay out of PayPal. */
  sendUnsupportedAs: PaypalSendAsCurrency | null;
}

export async function readPaypalPayoutSettings(db: Knex, tenantId: string): Promise<PaypalPayoutSettings> {
  const value = await getConfig<Partial<PaypalPayoutSettings>>(db, tenantId, PAYPAL_PAYOUTS_CONFIG_KEY);
  const as = value?.sendUnsupportedAs;
  return { sendUnsupportedAs: (PAYPAL_SEND_AS_CURRENCIES as readonly string[]).includes(as ?? '') ? (as as PaypalSendAsCurrency) : null };
}

export async function savePaypalPayoutSettings(db: Knex, tenantId: string, patch: Partial<PaypalPayoutSettings>): Promise<PaypalPayoutSettings> {
  const current = await readPaypalPayoutSettings(db, tenantId);
  const next: PaypalPayoutSettings = {
    sendUnsupportedAs: patch.sendUnsupportedAs !== undefined ? patch.sendUnsupportedAs : current.sendUnsupportedAs,
  };
  await setConfig(db, tenantId, PAYPAL_PAYOUTS_CONFIG_KEY, next);
  return next;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/** What one payout's stamp records about its conversion
 *  (`Payout.metadata.manualExport.conversion`). Exported with the payout. */
export interface PaypalConversionStamp {
  /** The payout's own amount and currency (its INR balance). */
  sourceAmount: string;
  sourceCurrency: string;
  /** What PayPal was asked to send. */
  sentAmount: string;
  sentCurrency: string;
  /** Units of sentCurrency per unit of sourceCurrency. */
  rate: string;
  rateSource: 'ecb';
  /** The ECB reference date (YYYY-MM-DD). */
  rateDate: string;
}

/** A rate as the decimal string every amount is computed from. */
export function formatRate(rate: number): string {
  const out = Number.isFinite(rate) && rate > 0 ? rate.toFixed(RATE_DECIMALS).replace(/0+$/, '').replace(/\.$/, '') : '0';
  if (out === '0') throw new Error(`not a usable rate: ${rate}`);
  return out;
}

function rateScaled(rate: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,12}))?$/.exec(rate);
  if (!m) throw new Error(`not a rate: ${rate}`);
  return BigInt(m[1]!) * 10n ** BigInt(RATE_DECIMALS) + BigInt((m[2] ?? '').padEnd(RATE_DECIMALS, '0') || '0');
}

/**
 * `amount` (major units, two decimals) converted at `rate` into
 * `sendAs`, rounded half up to what PayPal takes in it (cents, or whole
 * units for HUF, JPY, TWD). Exact: integers only, so the same amount and
 * rate always give the same result.
 */
export function convertAmount(amount: string, rate: string, sendAs: string): string {
  const cents = BigInt(majorToCents(amount));
  if (cents < 0n) throw new Error('a payout to send is never negative');
  const step = NO_DECIMALS.has(sendAs) ? 100n : 1n;
  const den = 10n ** BigInt(RATE_DECIMALS) * step;
  const sent = ((cents * rateScaled(rate) * 2n + den) / (2n * den)) * step;
  return (Number(sent) / 100).toFixed(2);
}

/** "22 Oct 2026" from an ECB date, without a time zone to shift it. */
export function formatRateDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

/** What a partner's payout views show about a converted payout. */
export interface PayoutSent {
  amount: string;
  currency: string;
  rate: string;
  rateSource: 'ecb';
  rateDate: string;
}

/** The payout's conversion, if a PayPal batch sends (or sent) it in
 *  another currency. Gone once a failed or returned item releases it. */
export function conversionOf(payout: Pick<PayoutRow, 'metadata'>): PaypalConversionStamp | null {
  const c = (payout.metadata as { manualExport?: { conversion?: Partial<PaypalConversionStamp> } } | null)?.manualExport?.conversion;
  return c && typeof c.sentAmount === 'string' && typeof c.sentCurrency === 'string' && typeof c.rate === 'string' && typeof c.rateDate === 'string'
    ? (c as PaypalConversionStamp)
    : null;
}

export function sentOf(payout: Pick<PayoutRow, 'metadata'>): PayoutSent | null {
  const c = conversionOf(payout);
  return c ? { amount: c.sentAmount, currency: c.sentCurrency, rate: c.rate, rateSource: 'ecb', rateDate: c.rateDate } : null;
}

/** A payout row as the payout lists return it: with `sent`. */
export function withSent<T extends Pick<PayoutRow, 'metadata'>>(payout: T): T & { sent: PayoutSent | null } {
  return { ...payout, sent: sentOf(payout) };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/** What a quote id carries, signed. */
export interface QuoteClaims {
  tenantId: string;
  runId: string;
  /** The PayPal app (live, or sandbox) the brand was asked to send from. */
  connectionId: string;
  currency: string;
  sendAs: PaypalSendAsCurrency;
  rate: string;
  rateDate: string;
  quotedAt: string;
  expiresAt: string;
  /** The quoted payouts and amounts (itemsDigest): a send whose payouts
   *  differ is refused rather than sent at totals nobody saw. */
  items: string;
}

/**
 * A digest of exactly which payouts, at which amounts, to which PayPal
 * account, on which attempt (`releases`: how many times PayPal has given
 * each one back). A payout released since its quote counts as changed, so
 * it is always sent again on a fresh quote, and a quote can't be spent
 * twice. Only the digest is in the quote id, never an email.
 */
export function itemsDigest(
  items: ReadonlyArray<{ payoutId: string; amount: string; sentAmount: string; releases: number; destination: string }>,
): string {
  const h = createHash('sha256');
  for (const i of items) h.update(`${i.payoutId}:${i.amount}:${i.sentAmount}:${i.releases}:${i.destination}\n`);
  return h.digest('base64url');
}

export function signQuote(claims: QuoteClaims): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...claims })).toString('base64url');
  return `${payload}.${macValue(QUOTE_MAC_PURPOSE, payload)}`;
}

/** The claims of a quote id this deployment signed, or null. */
export function openQuote(quoteId: string): QuoteClaims | null {
  const dot = quoteId.indexOf('.');
  if (dot <= 0) return null;
  const payload = quoteId.slice(0, dot);
  if (!verifyMac(QUOTE_MAC_PURPOSE, payload, quoteId.slice(dot + 1))) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as QuoteClaims & { v?: number };
    return c.v === 1 ? c : null;
  } catch {
    return null;
  }
}
