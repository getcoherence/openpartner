/**
 * Currency conversion for platform billing — and only for that.
 *
 * OpenPartner's own prices are in USD: the Stripe metered prices behind
 * the attributed-GMV meter, and the Network's fee on Network-originated
 * payouts. A brand's GMV is in whatever currency its customers pay, so
 * before it is metered it is converted to USD here.
 *
 * Rate source: the European Central Bank's euro foreign exchange reference
 * rates (https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html),
 * published around 16:00 CET on TARGET business days. Free, keyless, and
 * documented; covers ~30 currencies including INR. Rates are quoted per
 * EUR, so a USD rate is a cross: 1 X = (EUR→USD) / (EUR→X) USD.
 *
 * Fails closed. A currency the ECB doesn't publish is never converted at a
 * guessed rate — callers hold it out of the meter and alert. A feed that
 * can't be read throws FxUnavailableError, and callers skip the run
 * without advancing their high-water mark, so the next run bills it.
 *
 * Partner commissions never go through here: the attribution engine has no
 * FX (see commission-slabs.ts). A commission is in the event's currency.
 */

export const METER_CURRENCY = 'USD';

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

const FETCH_TIMEOUT_MS = 10_000;
/** The feed changes once a business day; a few hours' reuse spares it a
 *  request per tenant in the scheduler's loop. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export class FxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FxUnavailableError';
  }
}

/** ECB reference rates: units of each currency per 1 EUR. */
export interface EcbRates {
  /** Reference date the rates were published for (YYYY-MM-DD). */
  date: string;
  perEur: Record<string, number>;
}

/** The rates a conversion used, stamped on the usage report for audit. */
export interface FxSnapshot {
  source: 'ecb';
  date: string;
  /** USD per one unit of each converted currency. */
  usdPerUnit: Record<string, number>;
}

export interface UsdConversion {
  /** Every convertible amount, in USD, rounded once to the cent. */
  amountUsd: number;
  /** Present when any non-USD amount was converted. */
  fx?: FxSnapshot;
  /** Amounts in currencies the rate source doesn't publish: neither
   *  converted nor included in amountUsd. */
  heldOut: Record<string, number>;
}

/** Parse the ECB daily XML. Throws on anything that isn't a usable table. */
export function parseEcbDailyXml(xml: string): EcbRates {
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const perEur: Record<string, number> = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9]+(?:\.[0-9]+)?)['"]/g)) {
    const rate = Number(m[2]);
    if (Number.isFinite(rate) && rate > 0) perEur[m[1]!] = rate;
  }
  if (!date || !perEur.USD) throw new FxUnavailableError('ECB feed had no reference date or no USD rate');
  return { date, perEur };
}

let cache: { rates: EcbRates; fetchedAt: number } | null = null;

/** Drop the cached table (tests). */
export function clearFxRateCache(): void {
  cache = null;
}

export async function getEcbRates(): Promise<EcbRates> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rates;
  let res: Response;
  try {
    res = await fetch(ECB_DAILY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new FxUnavailableError(`ECB feed unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new FxUnavailableError(`ECB feed returned ${res.status}`);
  const rates = parseEcbDailyXml(await res.text());
  cache = { rates, fetchedAt: Date.now() };
  return rates;
}

/** USD per one unit of `currency`, or null when the table has no rate. */
export function usdPerUnit(rates: EcbRates, currency: string): number | null {
  const c = currency.toUpperCase();
  if (c === METER_CURRENCY) return 1;
  const perEur = rates.perEur[c];
  return perEur ? rates.perEur.USD! / perEur : null;
}

/**
 * Convert per-currency amounts to one USD figure. USD-only input never
 * touches the feed. Throws FxUnavailableError when a conversion is needed
 * and the feed can't be read.
 */
export async function convertToUsd(byCurrency: Record<string, number>): Promise<UsdConversion> {
  const foreign = Object.entries(byCurrency).filter(([c, amount]) => c !== METER_CURRENCY && amount !== 0);
  let total = byCurrency[METER_CURRENCY] ?? 0;
  if (foreign.length === 0) return { amountUsd: roundCents(total), heldOut: {} };

  const rates = await getEcbRates();
  const used: Record<string, number> = {};
  const heldOut: Record<string, number> = {};
  for (const [currency, amount] of foreign) {
    const rate = usdPerUnit(rates, currency);
    if (rate === null) {
      heldOut[currency] = amount;
      continue;
    }
    used[currency] = rate;
    total += amount * rate;
  }
  return {
    amountUsd: roundCents(total),
    ...(Object.keys(used).length > 0 ? { fx: { source: 'ecb' as const, date: rates.date, usdPerUnit: used } } : {}),
    heldOut,
  };
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}
