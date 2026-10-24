/**
 * Currency codes at the ingest boundary.
 *
 * Every stored money amount carries an ISO 4217 code in upper case. Codes
 * arrive in whatever case the sender used (Stripe sends "inr"; a CRM might
 * send "Inr"), and an un-normalised "inr" became a currency of its own:
 * its own commission currency, its own payout. Each ingest path upper-cases
 * on the way in, and a conversion with no currency is stored in the
 * tenant's default currency (Tenant.defaultCurrency), not assumed USD.
 *
 * Readers still meet legacy rows: lower-case codes, and coupon redemptions
 * stored with a null currency. Those compare upper-cased, and null means
 * USD, which is what it meant when it was written.
 */

import type { Knex } from 'knex';
import { z } from './zod.js';
import { TABLES, type TenantRow } from '@openpartner/db';

/** What a null currency on a stored row means. */
export const LEGACY_NULL_CURRENCY = 'USD';

/** A 3-letter currency code, returned upper case: "inr" → "INR". */
export const currencyInputSchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter ISO 4217 code')
  .transform((c) => c.toUpperCase());

/** Upper-case a stored or incoming code; null stays null. */
export function normalizeCurrency(code: string | null | undefined): string | null {
  return code ? code.trim().toUpperCase() : null;
}

/** The currency a stored row is in: its code upper-cased, or USD for a legacy null. */
export function rowCurrency(code: string | null | undefined): string {
  return normalizeCurrency(code) ?? LEGACY_NULL_CURRENCY;
}

/** SQL for a stored row's currency: upper-cased, null as USD (rowCurrency). */
export function currencySql(column: string): string {
  return `upper(coalesce(${column}, '${LEGACY_NULL_CURRENCY}'))`;
}

/** Fold `{ currency, amount }` rows into `{ [currency]: amount }`, dropping zeros. */
export function byCurrency(rows: ReadonlyArray<{ currency: string; amount: string | number | null }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const n = Number(r.amount ?? 0);
    if (n !== 0) out[r.currency] = (out[r.currency] ?? 0) + n;
  }
  return out;
}

/** Fold `{ currency, status, amount }` rows into `{ [currency]: { [status]: amount } }`. */
export function byCurrencyAndStatus(
  rows: ReadonlyArray<{ currency: string; status: string; amount: string | number | null }>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const n = Number(r.amount ?? 0);
    if (n === 0) continue;
    const bucket = (out[r.currency] ??= {});
    bucket[r.status] = (bucket[r.status] ?? 0) + n;
  }
  return out;
}

/** Tenant.defaultCurrency, USD when the row can't be read. */
export async function tenantDefaultCurrency(db: Knex, tenantId: string): Promise<string> {
  const row = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first('defaultCurrency');
  return normalizeCurrency(row?.defaultCurrency) ?? LEGACY_NULL_CURRENCY;
}

/** The code to store for an incoming conversion: the sender's, upper-cased,
 *  or the tenant's default when it sent none. */
export async function ingestCurrency(db: Knex, tenantId: string, sent: string | null | undefined): Promise<string> {
  return normalizeCurrency(sent) ?? (await tenantDefaultCurrency(db, tenantId));
}
