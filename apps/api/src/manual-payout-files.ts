/**
 * Batch files for manual-rail payouts (docs/manual-payout-files.md).
 *
 * A payout run writes one `manual` Payout per partner and currency, all
 * `pending` (payouts.ts). The brand then sends the money itself. This
 * module turns a run's pending payouts into files the brand uploads to its
 * OWN PayPal or Wise account, so the money goes from the brand straight to
 * the partner and never through OpenPartner:
 *
 *   - PayPal Payouts (Send Money → Make a Mass Payment): partners whose
 *     payout details are a PayPal email;
 *   - Wise batch payments ("Send to bank accounts" template): partners
 *     whose payout details are a bank account.
 *
 * **A file is an export, and its membership is frozen.** Creating a file
 * stamps each payout in it (`metadata.manualExport`, with the export id)
 * in the same step that builds the CSV, so the file and the stamp list the
 * same payouts. A stamped payout:
 *   - is in no other file, whatever happens to the partner's details later
 *     (a partner switching from PayPal to a bank after the PayPal file was
 *     uploaded is not paid again through Wise);
 *   - is confirmed with its export (POST /payouts/exports/:id/confirm),
 *     which acts on exactly the stamped payouts, never on what a fresh
 *     look at the run would put in a file;
 *   - is released only by discarding the export, for a file that was never
 *     uploaded.
 * There are no live "parts": each new file takes the next payouts nobody
 * has exported yet, up to what one upload takes.
 *
 * Pending payouts in no file say why (`excluded`). Two reasons mean "do not
 * pay" (`doNotPay`) and are refused by every confirm path too: a partner or
 * payout account in a country the platform doesn't serve, and a confirmed
 * sanctions match. A sanctions review or a pending screening stays payable,
 * with its warning shown, because the manual rail is the brand's own money
 * (payouts.ts).
 *
 * Scale: runs are read in id-ordered chunks of CHUNK payouts, so no lookup
 * binds more than CHUNK ids (Postgres caps a statement at 65,535), and only
 * pending manual payouts are ever read (a partial index covers them).
 *
 * Formats were checked against PayPal's and Wise's documentation; see the
 * doc for sources and for the Wise columns no public Wise page lists.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type PartnerRow,
  type PayoutRow,
  type PayoutProfileMethod,
  type PayoutProfileUpdatedBy,
} from '@openpartner/db';
import { db as platformDb } from './db.js';
import { getCountryAccessSettings } from './country-access.js';
import { partnerPayoutHolds, type PayoutHold, type PayoutHoldReason } from './sanctions-screening.js';
import { getTenancyMode } from './tenancy.js';
import { resolveBrandName } from './brand-name.js';
import { majorToCents, stripeExponent } from './stripe-amounts.js';
import {
  bankRoute,
  getPayoutProfiles,
  summarizeDetails,
  type BankDetails,
  type OpenedPayoutProfile,
  type PayoutDetails,
  type PaypalDetails,
} from './payout-profile.js';

export const MANUAL_PAYOUT_PROVIDERS = ['paypal', 'wise'] as const;
export type ManualPayoutProvider = (typeof MANUAL_PAYOUT_PROVIDERS)[number];

/** Why a pending payout is in no file. */
export const MANUAL_EXCLUSION_REASONS = [
  // The partner hasn't given payout details.
  'no_payout_details',
  // Their details can't be opened (sealed under another deployment's key).
  'details_unreadable',
  // A UPI ID or free-text instructions: the brand pays these one by one.
  'pay_individually',
  // The provider can't send it: PayPal and INR; Wise from a source
  // currency it can't send from, or to INR (no purpose of payment yet).
  'currency_not_supported',
  // Wise needs something the details lack for this payout: the holder's
  // address, for one sent in USD or AUD. The partner adds it.
  'details_incomplete',
  // More than PayPal sends in one payment in this currency
  // (PAYPAL_ITEM_LIMITS). Pay it another way.
  'over_paypal_limit',
  // OpenPartner Cloud: the partner's declared country, or their payout
  // account's, is one the platform doesn't serve (country-access.ts).
  'country_not_supported',
  // OpenPartner Cloud: an operator confirmed a sanctions-list match.
  'screening_confirmed',
] as const;
export type ManualExclusionReason = (typeof MANUAL_EXCLUSION_REASONS)[number];

/** Reasons a payout must not be paid at all: in no file, and refused by
 *  every confirm. */
export const DO_NOT_PAY_REASONS = ['country_not_supported', 'screening_confirmed'] as const;
export type DoNotPayReason = (typeof DO_NOT_PAY_REASONS)[number];

/** Ids per lookup: far under Postgres's 65,535 bind parameters. An
 *  object so tests can shrink it to exercise the chunked paths. */
export const CHUNK = { size: 1000 };

/**
 * Currencies PayPal's REST API lists (developer.paypal.com/api/rest/
 * reference/currency-codes, checked 2026-10-19). Not INR: since April 2021
 * Indian PayPal accounts receive international payments in USD only.
 */
export const PAYPAL_CURRENCIES: ReadonlySet<string> = new Set([
  'AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS', 'JPY', 'MYR', 'MXN',
  'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'RUB', 'SGD', 'SEK', 'CHF', 'THB', 'USD',
]);
/**
 * The most PayPal sends in one payout item, per currency, to a recipient
 * with a PayPal account (developer.paypal.com/payouts/fees, "Payout
 * transaction limits", checked 2026-10-22). A recipient without one can
 * receive about a third of this (USD 20,000, EUR 17,000…); PayPal refuses
 * such an item and returns its money, and the batch releases it. CNY has
 * no published limit. Above the limit a payout is in no PayPal file or
 * batch (`over_paypal_limit`).
 */
export const PAYPAL_ITEM_LIMITS: Readonly<Record<string, number>> = {
  AUD: 95_000, BRL: 300_000, CAD: 80_000, CZK: 1_500_000, DKK: 450_000, EUR: 55_000, HKD: 500_000,
  HUF: 22_000_000, ILS: 220_000, JPY: 9_000_000, MYR: 300_000, MXN: 1_100_000, TWD: 2_000_000,
  NZD: 100_000, NOK: 650_000, PHP: 3_500_000, PLN: 250_000, GBP: 50_000, RUB: 5_500_000, SGD: 85_000,
  SEK: 650_000, CHF: 55_000, THB: 2_200_000, USD: 60_000,
};
/** PayPal rejects a decimal amount in these. */
const PAYPAL_NO_DECIMALS: ReadonlySet<string> = new Set(['HUF', 'JPY', 'TWD']);
/** PayPal's upload format writes these with a decimal comma, quoted ("100,50"). */
const PAYPAL_COMMA_DECIMALS: ReadonlySet<string> = new Set(['EUR', 'BRL']);

/**
 * Currencies a business's Wise batch can be paid in, so the payout currency
 * of a Wise file. Wise's "send to and from" list
 * (wise.com/help/articles/2571907, checked 2026-10-20) less three it rules
 * out for a business batch: INR (a business can't send from INR; guide to
 * INR transfers), BRL (only Brazilian tax residents hold it, and batches
 * aren't available to Brazilian businesses) and MXN (only Mexican citizens
 * sending from their own Mexican account). Wise limits holding some of the
 * rest (HKD, IDR, ILS, MYR, PHP) by where the business is; an ineligible
 * brand's upload is refused by Wise, never paid wrongly.
 */
export const WISE_SOURCE_CURRENCIES: ReadonlySet<string> = new Set([
  'AUD', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'JPY',
  'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD',
]);
/** Targets the Wise file can't pay yet: every INR transfer needs a purpose
 *  of payment (Wise's INR purpose codes), and the file has no column for
 *  it until a real template shows how Wise takes one. */
const WISE_UNSUPPORTED_TARGETS: ReadonlySet<string> = new Set(['INR']);
/** Wise needs the recipient's address when the payout is sent in one of
 *  these (docs.wise.com recipient create: "required only if target
 *  currency is USD, PHP, THB or TRY, or if the source currency is USD or
 *  AUD"). The target side is checked when the details are saved. */
const WISE_ADDRESS_SOURCES: ReadonlySet<string> = new Set(['USD', 'AUD']);

/** Rows per file: PayPal takes 5,000 per upload, Wise 1,000 per batch. */
export const MAX_ROWS: Record<ManualPayoutProvider, number> = { paypal: 5000, wise: 1000 };
/** PayPal's note-to-recipient limit. */
const PAYPAL_NOTE_MAX = 400;
/** Wise's payment-reference limit varies by route; 10 letters and digits
 *  fits the strictest (US ACH). */
const WISE_REFERENCE_LENGTH = 10;
/** Wise sends no reference on these routes. */
const WISE_NO_REFERENCE: ReadonlySet<string> = new Set(['JPY', 'COP']);

/**
 * The Wise "Send to bank accounts" columns, in order. Wise lets the columns
 * be reordered but not renamed.
 *
 * Wise's help centre names recipientEmail, sourceCurrency, targetCurrency,
 * amountCurrency (values `source` / `target`), and recipientType (a person
 * or an institution). The bank-detail and address columns come from Wise's
 * template builder, which needs a Wise login; these are the field names of
 * Wise's recipient API, which the builder's columns follow. Check them
 * against a template downloaded from your Wise account
 * (docs/manual-payout-files.md "Wise columns").
 */
export const WISE_COLUMNS = [
  'name',
  'recipientEmail',
  'paymentReference',
  'recipientType',
  'amountCurrency',
  'amount',
  'sourceCurrency',
  'targetCurrency',
  'IBAN',
  'BIC',
  'accountNumber',
  'sortCode',
  'abartn',
  'accountType',
  'ifscCode',
  'addressCountryCode',
  'addressCity',
  'addressFirstLine',
  'addressPostCode',
  'addressState',
] as const;

/** What PayPal last said about one payout's item in a PayPal Payouts batch
 *  (paypal-payouts.ts), written on each sync. */
export interface PaypalItemStamp {
  itemId: string;
  /** PayPal's transaction_status: SUCCESS, PENDING, UNCLAIMED, ONHOLD… */
  status: string;
  transactionId: string | null;
  /** What PayPal sent, which differs from the payout amount only where
   *  PayPal takes no decimals (HUF, TWD). */
  amount: string | null;
  currency: string | null;
  /** PayPal's error name, for an item that didn't go through. */
  error: string | null;
}

/** Stamped on each payout a file holds (`Payout.metadata.manualExport`). */
export interface ManualExportStamp {
  exportId: string;
  provider: ManualPayoutProvider;
  /** The file's currency: PayPal's payout currency, Wise's source currency. */
  currency: string;
  /** When the file was made. */
  at: string;
  /** An admin in the portal, or an API key. */
  by: 'admin' | 'api';
  /** 'api': not a file but a PayPal Payouts batch OpenPartner sent with
   *  the brand's credentials (paypal-payouts.ts), whose status comes from
   *  PayPal. Its exportId is the PaypalPayoutBatch id. Absent on files. */
  via?: 'api';
  /** API batches: PayPal's id for the batch, once PayPal accepted it. */
  payoutBatchId?: string;
  /** API batches: this payout's item, once PayPal has listed it. */
  paypal?: PaypalItemStamp;
}

function stampOf(payout: Pick<PayoutRow, 'metadata'>): ManualExportStamp | null {
  const s = (payout.metadata as { manualExport?: Partial<ManualExportStamp> }).manualExport;
  return s && typeof s.exportId === 'string' && (s.provider === 'paypal' || s.provider === 'wise')
    ? (s as ManualExportStamp)
    : null;
}

/** A stamp from a PayPal Payouts batch rather than a file. */
export function isApiStamp(stamp: Pick<ManualExportStamp, 'via'> | null): boolean {
  return stamp?.via === 'api';
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface Classified {
  payout: PayoutRow;
  partner: Pick<PartnerRow, 'id' | 'name' | 'email'>;
  profile: OpenedPayoutProfile | null;
  details: PayoutDetails | null;
  hold: PayoutHold | null;
  doNotPay: DoNotPayReason | null;
  stamp: ManualExportStamp | null;
  /** The provider a new file would put this payout in. Null when it's in
   *  a file already, or in none (`excluded`). */
  ready: ManualPayoutProvider | null;
  excluded: ManualExclusionReason | null;
}

function chunks<T>(items: readonly T[], size = CHUNK.size): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** OpenPartner Cloud's blocked countries, or none on a self-host (the
 *  country list is a hosted-platform control, like partnerPayoutHolds). */
async function blockedCountries(): Promise<ReadonlySet<string>> {
  if (getTenancyMode() !== 'multi') return new Set();
  const settings = await getCountryAccessSettings(platformDb);
  return settings.enforce ? new Set(settings.blocked.map((b) => b.code)) : new Set();
}

/** Every country a destination names: the account's, and the holder's
 *  address for a bank account. The clear `country` column counts even when
 *  the details themselves can't be opened. */
function destinationCountries(profile: OpenedPayoutProfile | null, details: PayoutDetails | null): string[] {
  const out: string[] = [];
  if (profile?.country) out.push(profile.country);
  if (details?.method === 'upi') out.push('IN');
  else if (details?.country) out.push(details.country);
  if (details?.method === 'bank' && details.address) out.push(details.address.country);
  return out;
}

/** Can the Wise file send `source` to an account in `target`? */
export function wiseCanPay(source: string, target: string): boolean {
  return WISE_SOURCE_CURRENCIES.has(source) && !WISE_UNSUPPORTED_TARGETS.has(target);
}

/** Is `amount` (major units) more than PayPal sends in one item? */
export function overPaypalItemLimit(amount: string, currency: string): boolean {
  const limit = PAYPAL_ITEM_LIMITS[currency];
  return limit !== undefined && Number(amount) > limit;
}

/** The file these details go in, for a payout of `amount` in `currency`,
 *  or why none. */
function providerFor(
  details: PayoutDetails,
  currency: string,
  amount: string,
): { provider: ManualPayoutProvider } | { excluded: ManualExclusionReason } {
  if (details.method === 'paypal') {
    if (!PAYPAL_CURRENCIES.has(currency)) return { excluded: 'currency_not_supported' };
    return overPaypalItemLimit(amount, currency) ? { excluded: 'over_paypal_limit' } : { provider: 'paypal' };
  }
  if (details.method === 'bank') {
    if (!wiseCanPay(currency, details.currency)) return { excluded: 'currency_not_supported' };
    if (WISE_ADDRESS_SOURCES.has(currency) && !details.address) return { excluded: 'details_incomplete' };
    return { provider: 'wise' };
  }
  return { excluded: 'pay_individually' };
}

/**
 * Where each of these payouts stands: its partner, payout details,
 * compliance hold, file, or why it's in none. Reads in chunks of CHUNK.
 * Partners, profiles and holds are read in the tenant's transaction (`db`)
 * and on the privileged pool (holds and the country list are platform
 * tables), both scoped to `tenantId`.
 */
async function classify(
  db: Knex,
  tenantId: string,
  payouts: readonly PayoutRow[],
  blocked: ReadonlySet<string>,
): Promise<Classified[]> {
  const out: Classified[] = [];
  for (const chunk of chunks(payouts)) {
    const partnerIds = [...new Set(chunk.map((p) => p.partnerId))];
    const partners = new Map(
      ((await db<PartnerRow>(TABLES.Partner)
        .where({ tenantId })
        .whereIn('id', partnerIds)
        .select('id', 'name', 'email')) as Array<Pick<PartnerRow, 'id' | 'name' | 'email'>>).map((p) => [p.id, p]),
    );
    const profiles = await getPayoutProfiles(db, tenantId, partnerIds);
    const holds = await partnerPayoutHolds(platformDb, tenantId, [...partners.values()]);

    for (const payout of chunk) {
      const partner = partners.get(payout.partnerId) ?? { id: payout.partnerId, name: '', email: '' };
      const profile = profiles.get(payout.partnerId) ?? null;
      const details = profile?.details ?? null;
      const hold = holds.get(payout.partnerId) ?? null;
      const stamp = stampOf(payout);
      const doNotPay: DoNotPayReason | null =
        hold?.reason === 'screening_confirmed'
          ? 'screening_confirmed'
          : hold?.reason === 'country_not_supported' || destinationCountries(profile, details).some((c) => blocked.has(c))
            ? 'country_not_supported'
            : null;

      let ready: ManualPayoutProvider | null = null;
      let excluded: ManualExclusionReason | null = null;
      if (payout.status === 'pending' && !stamp) {
        if (doNotPay) excluded = doNotPay;
        else if (!profile) excluded = 'no_payout_details';
        else if (!details) excluded = 'details_unreadable';
        else {
          const where = providerFor(details, payout.currency.toUpperCase(), payout.amount);
          if ('provider' in where) ready = where.provider;
          else excluded = where.excluded;
        }
      }
      out.push({ payout, partner, profile, details, hold, doNotPay, stamp, ready, excluded });
    }
  }
  return out;
}

/**
 * A run's pending manual payouts, in id order, CHUNK at a time. `filter`
 * narrows the query (one currency, unexported only).
 */
async function* pendingRunPayouts(
  db: Knex,
  tenantId: string,
  runId: string,
  filter?: (q: Knex.QueryBuilder) => void,
): AsyncGenerator<PayoutRow[]> {
  let after: string | null = null;
  for (;;) {
    const rows: PayoutRow[] = await db<PayoutRow>(TABLES.Payout)
      .where({ tenantId, method: 'manual', status: 'pending' })
      .whereRaw(`metadata->>'runId' = ?`, [runId])
      .modify((q) => {
        if (after) q.where('id', '>', after);
        filter?.(q);
      })
      .orderBy('id', 'asc')
      .limit(CHUNK.size);
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < CHUNK.size) return;
    after = rows[rows.length - 1]!.id;
  }
}

/** The pending manual payouts a file holds, in id order. Never a PayPal
 *  Payouts batch's: PayPal reports what happened to those, so the file
 *  routes (download again, confirm, discard) can't reach them. */
async function pendingExportPayouts(db: Knex, tenantId: string, exportId: string): Promise<PayoutRow[]> {
  return db<PayoutRow>(TABLES.Payout)
    .where({ tenantId, method: 'manual', status: 'pending' })
    .whereRaw(`metadata->'manualExport'->>'exportId' = ?`, [exportId])
    .whereRaw(`metadata->'manualExport'->>'via' is distinct from 'api'`)
    .orderBy('id', 'asc');
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface ManualRunSummary {
  runId: string;
  createdAt: Date;
  /** Manual payouts in the run not yet confirmed as sent. */
  pendingCount: number;
  /** What they add up to, per currency. */
  pendingTotals: Array<{ currency: string; amount: string }>;
}

const RUN_CURSOR_ALIAS = '_cursorTs';

function encodeRunCursor(ts: string, runId: string): string {
  return Buffer.from(`${ts}|${runId}`).toString('base64url');
}

function decodeRunCursor(cursor: string): { ts: string; runId: string } | null {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = raw.indexOf('|');
  const ts = raw.slice(0, sep);
  const runId = raw.slice(sep + 1);
  if (sep < 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(ts) || !/^[A-Za-z0-9_-]{1,64}$/.test(runId)) {
    return null;
  }
  return { ts, runId };
}

/**
 * Payout runs with manual payouts still to send, newest first, a page at a
 * time (keyset on the run's first payout time, then its id). Null for a
 * cursor that doesn't decode.
 */
export async function listManualRuns(
  db: Knex,
  tenantId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ runs: ManualRunSummary[]; nextCursor: string | null } | null> {
  const after = opts.cursor ? decodeRunCursor(opts.cursor) : null;
  if (opts.cursor && !after) return null;
  const grouped = db(TABLES.Payout)
    .where({ tenantId, method: 'manual', status: 'pending' })
    .whereRaw(`metadata->>'runId' is not null`)
    .groupByRaw(`metadata->>'runId'`)
    .select(
      db.raw(`metadata->>'runId' as "runId"`),
      db.raw(`min("createdAt") as "createdAt"`),
      db.raw(`count(*)::int as "pendingCount"`),
    );
  const rows = (await db
    .select(
      'runId',
      'createdAt',
      'pendingCount',
      db.raw(`to_char("createdAt" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ??`, [RUN_CURSOR_ALIAS]),
    )
    .from(grouped.as('runs'))
    .modify((q) => {
      if (after) q.whereRaw(`("createdAt", "runId") < (?::timestamptz, ?)`, [after.ts, after.runId]);
    })
    .orderBy([
      { column: 'createdAt', order: 'desc' },
      { column: 'runId', order: 'desc' },
    ])
    .limit(opts.limit + 1)) as Array<{ runId: string; createdAt: Date; pendingCount: number; [RUN_CURSOR_ALIAS]: string }>;

  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > opts.limit && last ? encodeRunCursor(last[RUN_CURSOR_ALIAS], last.runId) : null;
  if (page.length === 0) return { runs: [], nextCursor: null };

  const totals = (await db(TABLES.Payout)
    .where({ tenantId, method: 'manual', status: 'pending' })
    .whereRaw(`metadata->>'runId' = any(?)`, [page.map((r) => r.runId)])
    .groupByRaw(`metadata->>'runId', upper(currency)`)
    .select(db.raw(`metadata->>'runId' as "runId"`), db.raw('upper(currency) as currency'), db.raw('sum(amount)::text as amount'))) as Array<{
    runId: string;
    currency: string;
    amount: string;
  }>;
  return {
    runs: page.map((r) => ({
      runId: r.runId,
      createdAt: r.createdAt,
      pendingCount: r.pendingCount,
      pendingTotals: totals
        .filter((t) => t.runId === r.runId)
        .map((t) => ({ currency: t.currency, amount: Number(t.amount).toFixed(2) }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    })),
    nextCursor,
  };
}

export interface ManualRunExport {
  exportId: string;
  provider: ManualPayoutProvider;
  currency: string;
  createdAt: string;
  createdBy: 'admin' | 'api';
  /** Payouts in the file not confirmed yet. */
  pendingCount: number;
  /** What they add up to, in `currency`. */
  pendingTotal: string;
  /** Of those, whose partner changed or removed their payout details after
   *  the file was made. A re-download carries the new details, or leaves
   *  the payout out when they no longer fit the file. */
  changedCount: number;
  /** Of those, now on a do-not-pay hold. Confirming refuses them. */
  doNotPayCount: number;
}

export interface ManualRun {
  runId: string;
  createdAt: Date;
  pendingCount: number;
  /** Payouts no file holds yet that a new file would take, per provider
   *  and currency. Each new file takes up to MAX_ROWS of them. */
  ready: Array<{ provider: ManualPayoutProvider; currency: string; count: number; total: string }>;
  /** Files made from this run that still hold payouts to confirm. */
  exports: ManualRunExport[];
  /** Pending payouts in a PayPal Payouts batch OpenPartner sent
   *  (paypal-payouts.ts); the route lists the batches. */
  inPaypalBatches: number;
  /** Pending payouts in no file, per reason. */
  excluded: Array<{ reason: ManualExclusionReason; count: number }>;
}

export const centsToString = (cents: number) => (cents / 100).toFixed(2);

/**
 * One run's manual payouts to send, summarised: what's ready for a new
 * file, the files already made, and why the rest are in none. Reads the
 * run CHUNK payouts at a time. Null when nothing in the run is pending.
 */
export async function getManualRun(db: Knex, tenantId: string, runId: string): Promise<ManualRun | null> {
  const blocked = await blockedCountries();
  let createdAt: Date | null = null;
  let pendingCount = 0;
  const ready = new Map<string, { provider: ManualPayoutProvider; currency: string; count: number; cents: number }>();
  const exports = new Map<string, ManualRunExport & { cents: number }>();
  const excluded = new Map<ManualExclusionReason, number>();
  let inPaypalBatches = 0;

  for await (const chunk of pendingRunPayouts(db, tenantId, runId)) {
    for (const c of await classify(db, tenantId, chunk, blocked)) {
      pendingCount += 1;
      if (!createdAt || c.payout.createdAt < createdAt) createdAt = c.payout.createdAt;
      const currency = c.payout.currency.toUpperCase();
      const cents = majorToCents(c.payout.amount);
      if (isApiStamp(c.stamp)) {
        inPaypalBatches += 1;
      } else if (c.stamp) {
        const e = exports.get(c.stamp.exportId) ?? {
          exportId: c.stamp.exportId,
          provider: c.stamp.provider,
          currency: c.stamp.currency,
          createdAt: c.stamp.at,
          createdBy: c.stamp.by,
          pendingCount: 0,
          pendingTotal: '0.00',
          changedCount: 0,
          doNotPayCount: 0,
          cents: 0,
        };
        e.pendingCount += 1;
        e.cents += cents;
        if (destinationChanged(c)) e.changedCount += 1;
        if (c.doNotPay) e.doNotPayCount += 1;
        exports.set(c.stamp.exportId, e);
      } else if (c.ready) {
        const key = `${c.ready}:${currency}`;
        const r = ready.get(key) ?? { provider: c.ready, currency, count: 0, cents: 0 };
        r.count += 1;
        r.cents += cents;
        ready.set(key, r);
      } else if (c.excluded) {
        excluded.set(c.excluded, (excluded.get(c.excluded) ?? 0) + 1);
      }
    }
  }
  if (!createdAt) return null;

  return {
    runId,
    createdAt,
    pendingCount,
    ready: [...ready.values()]
      .map(({ cents, ...r }) => ({ ...r, total: centsToString(cents) }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.currency.localeCompare(b.currency)),
    exports: [...exports.values()]
      .map(({ cents, ...e }) => ({ ...e, pendingTotal: centsToString(cents) }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    inPaypalBatches,
    excluded: [...excluded.entries()].map(([reason, count]) => ({ reason, count })),
  };
}

/** The partner changed or removed their payout details after the payout
 *  went into its file. */
function destinationChanged(c: Classified): boolean {
  if (!c.stamp) return false;
  return !c.profile || c.profile.updatedAt.getTime() > Date.parse(c.stamp.at);
}

export interface ManualRunPayout {
  payoutId: string;
  partnerId: string;
  partnerName: string;
  partnerEmail: string;
  amount: string;
  currency: string;
  createdAt: Date;
  /** The partner's payout details, masked. Null when they have none. */
  destination: {
    method: PayoutProfileMethod;
    country: string | null;
    /** Null when the details can't be opened. */
    summary: string | null;
    updatedAt: Date;
    updatedBy: PayoutProfileUpdatedBy;
  } | null;
  /** The file this payout is in, if any, or the PayPal Payouts batch
   *  (`via: 'api'`). */
  export: {
    exportId: string;
    provider: ManualPayoutProvider;
    via: 'file' | 'api';
    createdAt: string;
    /** What identifies the payout in that file. */
    reference: string | null;
    /** The partner changed or removed their details after the file was made. */
    destinationChanged: boolean;
    /** A PayPal Payouts batch: what PayPal last said about this payout. */
    paypal: PaypalItemStamp | null;
  } | null;
  /** The file a new export would put this payout in. */
  ready: ManualPayoutProvider | null;
  /** Why it's in no file. */
  excluded: ManualExclusionReason | null;
  /** OpenPartner Cloud: the partner is on a compliance hold. */
  complianceWarning: PayoutHoldReason | null;
  /** Set when the payout must not be paid; every confirm refuses it. */
  doNotPay: DoNotPayReason | null;
}

function payoutView(c: Classified): ManualRunPayout {
  return {
    payoutId: c.payout.id,
    partnerId: c.payout.partnerId,
    partnerName: c.partner.name,
    partnerEmail: c.partner.email,
    amount: Number(c.payout.amount).toFixed(2),
    currency: c.payout.currency.toUpperCase(),
    createdAt: c.payout.createdAt,
    destination: c.profile
      ? {
          method: c.profile.method,
          country: c.profile.country,
          summary: c.details ? summarizeDetails(c.details) : null,
          updatedAt: c.profile.updatedAt,
          updatedBy: c.profile.updatedBy,
        }
      : null,
    export: c.stamp
      ? {
          exportId: c.stamp.exportId,
          provider: c.stamp.provider,
          via: isApiStamp(c.stamp) ? 'api' : 'file',
          createdAt: c.stamp.at,
          reference: reference(c.stamp.provider, c.payout.id, c.details),
          destinationChanged: destinationChanged(c),
          paypal: isApiStamp(c.stamp) ? (c.stamp.paypal ?? null) : null,
        }
      : null,
    ready: c.ready,
    excluded: c.excluded,
    complianceWarning: c.hold?.reason ?? null,
    doNotPay: c.doNotPay,
  };
}

const PAYOUT_CURSOR = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One page of a run's pending manual payouts, in id order. Null for a
 * cursor that doesn't decode, or a run with nothing pending.
 */
export async function listManualRunPayouts(
  db: Knex,
  tenantId: string,
  runId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ payouts: ManualRunPayout[]; nextCursor: string | null } | 'invalid_cursor' | null> {
  const after = opts.cursor ? Buffer.from(opts.cursor, 'base64url').toString('utf8') : null;
  if (opts.cursor && (!after || !PAYOUT_CURSOR.test(after))) return 'invalid_cursor';
  const rows = await db<PayoutRow>(TABLES.Payout)
    .where({ tenantId, method: 'manual', status: 'pending' })
    .whereRaw(`metadata->>'runId' = ?`, [runId])
    .modify((q) => {
      if (after) q.where('id', '>', after);
    })
    .orderBy('id', 'asc')
    .limit(opts.limit + 1);
  if (rows.length === 0 && !after) return null;
  const page = rows.slice(0, opts.limit);
  const classified = await classify(db, tenantId, page, await blockedCountries());
  const last = page[page.length - 1];
  return {
    payouts: classified.map(payoutView),
    nextCursor: rows.length > opts.limit && last ? Buffer.from(last.id).toString('base64url') : null,
  };
}

function reference(provider: ManualPayoutProvider, payoutId: string, details: PayoutDetails | null): string | null {
  // PayPal's Customer ID: unique, no spaces, at most 30 characters. A
  // ULID is 26.
  if (provider === 'paypal') return payoutId;
  const target = details?.method === 'bank' ? details.currency : '';
  return WISE_NO_REFERENCE.has(target) ? null : payoutId.slice(-WISE_REFERENCE_LENGTH);
}

/**
 * The PayPal or Wise file a payout is in, and what identifies the payout
 * in it, for the payout's statement (payout-statements.ts). Null when no
 * file holds it.
 */
export function manualExportOf(
  payout: Pick<PayoutRow, 'id' | 'metadata'>,
  details: PayoutDetails | null,
): { exportId: string; provider: ManualPayoutProvider; at: string; reference: string | null } | null {
  const stamp = stampOf(payout);
  if (!stamp) return null;
  return { exportId: stamp.exportId, provider: stamp.provider, at: stamp.at, reference: reference(stamp.provider, payout.id, details) };
}

// ---------------------------------------------------------------------------
// Exports (files)
// ---------------------------------------------------------------------------

export interface ManualExport {
  exportId: string;
  runId: string;
  provider: ManualPayoutProvider;
  currency: string;
  createdAt: string;
  createdBy: 'admin' | 'api';
  /** Exactly the payouts in the file, and what POST
   *  /payouts/exports/:exportId/confirm confirms. */
  payoutIds: string[];
  count: number;
  total: string;
}

export interface ManualExportFile {
  export: ManualExport;
  filename: string;
  csv: string;
}

/**
 * Make the next file for one provider and currency of a run: the first
 * MAX_ROWS pending payouts nobody has exported that belong in it, in id
 * order. Stamps them and builds the CSV from the same rows, so the file
 * and its membership can't disagree. A payout another export stamped in
 * the meantime is left out (compare-and-set). Null when nothing is ready.
 */
/** A payout picked for a file or a PayPal Payouts batch, with the
 *  partner's PayPal or bank details opened. */
export interface PickedPayout {
  payout: PayoutRow;
  partner: Pick<PartnerRow, 'id' | 'name' | 'email'>;
  details: PayoutDetails;
}

/**
 * The first `max` pending payouts of a run, in one currency, that no file
 * or batch holds and that belong with `provider`, in id order. Nothing is
 * stamped yet: stampManualPayouts does that, and keeps only the ones no
 * other export took in the meantime.
 */
export async function pickReadyPayouts(
  db: Knex,
  tenantId: string,
  runId: string,
  provider: ManualPayoutProvider,
  currency: string,
  max: number,
): Promise<PickedPayout[]> {
  const blocked = await blockedCountries();
  const picked: PickedPayout[] = [];
  const unexportedInCurrency = (q: Knex.QueryBuilder) =>
    q.whereRaw('upper(currency) = ?', [currency]).whereRaw(`metadata->'manualExport' is null`);
  for await (const chunk of pendingRunPayouts(db, tenantId, runId, unexportedInCurrency)) {
    for (const c of await classify(db, tenantId, chunk, blocked)) {
      if (c.ready === provider && c.details) picked.push({ payout: c.payout, partner: c.partner, details: c.details });
      if (picked.length === max) break;
    }
    if (picked.length === max) break;
  }
  return picked;
}

/**
 * Stamp these payouts with an export, compare-and-set: only a pending
 * manual payout that no file or batch holds takes the stamp. Returns the
 * ids that did, so the caller builds its file or batch from exactly those.
 */
export async function stampManualPayouts(
  db: Knex,
  tenantId: string,
  payoutIds: readonly string[],
  stamp: ManualExportStamp,
): Promise<Set<string>> {
  const stamped = new Set<string>();
  for (const ids of chunks(payoutIds)) {
    const rows = (await db(TABLES.Payout)
      .where({ tenantId, method: 'manual', status: 'pending' })
      .whereIn('id', ids)
      .whereRaw(`metadata->'manualExport' is null`)
      .update({ metadata: db.raw(`metadata || jsonb_build_object('manualExport', ?::jsonb)`, [JSON.stringify(stamp)]) })
      .returning('id')) as Array<{ id: string }>;
    for (const r of rows) stamped.add(r.id);
  }
  return stamped;
}

export async function createManualExport(
  db: Knex,
  tenantId: string,
  runId: string,
  provider: ManualPayoutProvider,
  currency: string,
  by: 'admin' | 'api',
): Promise<ManualExportFile | null> {
  const picked = await pickReadyPayouts(db, tenantId, runId, provider, currency, MAX_ROWS[provider]);
  if (picked.length === 0) return null;

  const stamp: ManualExportStamp = { exportId: ulid(), provider, currency, at: new Date().toISOString(), by };
  const stamped = await stampManualPayouts(
    db,
    tenantId,
    picked.map((c) => c.payout.id),
    stamp,
  );
  const rows = picked
    .filter((c) => stamped.has(c.payout.id))
    .map((c): Classified => ({ ...c, profile: null, hold: null, doNotPay: null, stamp, ready: null, excluded: null }));
  if (rows.length === 0) return null;

  return {
    export: {
      exportId: stamp.exportId,
      runId,
      provider,
      currency,
      createdAt: stamp.at,
      createdBy: by,
      payoutIds: rows.map((r) => r.payout.id),
      count: rows.length,
      total: centsToString(rows.reduce((s, r) => s + majorToCents(r.payout.amount), 0)),
    },
    filename: exportFilename(stamp),
    csv: await buildCsv(db, tenantId, provider, rows),
  };
}

function exportFilename(stamp: Pick<ManualExportStamp, 'provider' | 'exportId' | 'currency'>): string {
  return `${stamp.provider}-payouts-${stamp.exportId}-${stamp.currency}.csv`;
}

/** Does this payout still belong in a `provider` file of its currency? */
function stillFits(c: Classified, provider: ManualPayoutProvider): boolean {
  if (c.doNotPay || !c.details) return false;
  const where = providerFor(c.details, c.payout.currency.toUpperCase(), c.payout.amount);
  return 'provider' in where && where.provider === provider;
}

/**
 * Download a file again: its payouts that are still pending, with the
 * partners' current details. A payout whose details no longer fit the file
 * (switched method, removed, now unreadable) or that is now on a do-not-pay
 * hold is left out and listed in `omitted`. Null when the file holds
 * nothing pending, or nothing that can still be paid.
 */
export async function rebuildManualExportFile(
  db: Knex,
  tenantId: string,
  exportId: string,
): Promise<{ filename: string; csv: string; payoutIds: string[]; omitted: string[] } | null> {
  const payouts = await pendingExportPayouts(db, tenantId, exportId);
  const stamp = payouts[0] ? stampOf(payouts[0]) : null;
  if (!stamp) return null;
  const classified = await classify(db, tenantId, payouts, await blockedCountries());
  const rows = classified.filter((c) => stillFits(c, stamp.provider));
  if (rows.length === 0) return null;
  return {
    filename: exportFilename(stamp),
    csv: await buildCsv(db, tenantId, stamp.provider, rows),
    payoutIds: rows.map((r) => r.payout.id),
    omitted: classified.filter((c) => !rows.includes(c)).map((c) => c.payout.id),
  };
}

/**
 * Confirm a file: every payout it still holds is marked sent, except those
 * now on a do-not-pay hold (reported, as confirmManualPayouts does). Never
 * touches a payout outside the file. Null when the file holds nothing
 * pending.
 */
export async function confirmManualExport(db: Knex, tenantId: string, exportId: string): Promise<BulkConfirmResult | null> {
  const payouts = await pendingExportPayouts(db, tenantId, exportId);
  if (payouts.length === 0) return null;
  return confirmManualPayouts(
    db,
    tenantId,
    payouts.map((p) => p.id),
  );
}

/**
 * Discard a file that was never uploaded: its pending payouts lose their
 * stamp and can go into a new file. Payouts already confirmed keep theirs.
 * Returns how many were released, or null when the file holds nothing
 * pending.
 */
export async function discardManualExport(db: Knex, tenantId: string, exportId: string): Promise<number | null> {
  // Never a PayPal Payouts batch's payouts: that batch may have paid them,
  // or may still, and only PayPal's answer (or the admin's resolve) frees
  // them. That holds even when the batch row isn't here (a bundle restored
  // onto another deployment): the batch can still pay at PayPal, so its
  // payouts can be marked sent once checked there, never released.
  const released = await db(TABLES.Payout)
    .where({ tenantId, method: 'manual', status: 'pending' })
    .whereRaw(`metadata->'manualExport'->>'exportId' = ?`, [exportId])
    .whereRaw(`metadata->'manualExport'->>'via' is distinct from 'api'`)
    .update({ metadata: db.raw(`metadata - 'manualExport'`) });
  return released > 0 ? released : null;
}

async function buildCsv(db: Knex, tenantId: string, provider: ManualPayoutProvider, rows: Classified[]): Promise<string> {
  return provider === 'paypal' ? paypalCsv(rows, paypalNote(await resolveBrandName(db, tenantId))) : wiseCsv(rows);
}

/** RFC 4180: quote a field holding a comma, quote or line break. */
function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function csvLine(values: readonly string[]): string {
  return values.map(csvField).join(',');
}

/** Payment files must not carry a line break or a leading formula
 *  character in text we write ourselves (partner input is refused at
 *  entry: payout-profile.ts fileSafeName). */
export function plainText(v: string, max: number): string {
  return v.replace(/[\r\n\t]+/g, ' ').replace(/^[=+\-@\s]+/, '').trim().slice(0, max);
}

export function paypalNote(brandName: string | null): string {
  return plainText(brandName ? `Commission payout from ${brandName}` : 'Commission payout', PAYPAL_NOTE_MAX);
}

/** PayPal's amount format: no decimals for HUF, JPY and TWD (rounded to
 *  the nearest whole unit), a decimal comma for EUR and BRL, a point for
 *  the rest; never a thousands separator. */
export function paypalAmount(amount: string, currency: string): string {
  const n = Number(amount);
  if (PAYPAL_NO_DECIMALS.has(currency)) return String(Math.round(n));
  const fixed = n.toFixed(2);
  return PAYPAL_COMMA_DECIMALS.has(currency) ? fixed.replace('.', ',') : fixed;
}

/**
 * PayPal Payouts upload (developer.paypal.com/payouts/use-payouts/
 * send-money/use-web-ui, checked 2026-10-19). No header row, ten columns
 * in a fixed order, every row the same width, one currency per file:
 *
 *   recipient, amount, currency, customer ID, note, recipient wallet,
 *   social feed privacy, Holler URL, logo URL, purpose
 *
 * The three Venmo-only columns stay empty. Purpose is SERVICES: a
 * commission pays for marketing (PayPal's default is GOODS).
 */
function paypalCsv(rows: Classified[], note: string): string {
  const lines = rows.map((r) => {
    const d = r.details as PaypalDetails;
    const currency = r.payout.currency.toUpperCase();
    return csvLine([
      d.email,
      paypalAmount(r.payout.amount, currency),
      currency,
      reference('paypal', r.payout.id, d) ?? '',
      note,
      'PAYPAL',
      '',
      '',
      '',
      'SERVICES',
    ]);
  });
  return `${lines.join('\r\n')}\r\n`;
}

/** A plain decimal: Wise wants digits and a point only. No decimals in a
 *  currency that has none. */
function wiseAmount(amount: string, currency: string): string {
  const n = Number(amount);
  return stripeExponent(currency) === 0 ? String(Math.round(n)) : n.toFixed(2);
}

/**
 * Wise "Send to bank accounts" batch template, with a header row
 * (WISE_COLUMNS). One source currency per file (the payout currency);
 * the target is the partner's account currency.
 *
 * Same currency both sides: `amountCurrency` is `target`, so the partner
 * receives exactly what they're owed and Wise's fee is the brand's.
 * Different currencies: `source`, because the payout is denominated in
 * what the brand pays; Wise's fee and conversion come out of it.
 */
function wiseCsv(rows: Classified[]): string {
  const lines = [csvLine(WISE_COLUMNS)];
  for (const r of rows) {
    const d = r.details as BankDetails;
    const currency = r.payout.currency.toUpperCase();
    const sameCurrency = d.currency === currency;
    const route = bankRoute(d);
    const cells: Record<(typeof WISE_COLUMNS)[number], string> = {
      name: d.accountHolderName,
      recipientEmail: d.email ?? r.partner.email,
      paymentReference: reference('wise', r.payout.id, d) ?? '',
      recipientType: d.accountHolderType === 'business' ? 'institution' : 'person',
      amountCurrency: sameCurrency ? 'target' : 'source',
      amount: wiseAmount(r.payout.amount, currency),
      sourceCurrency: currency,
      targetCurrency: d.currency,
      IBAN: route === 'iban' ? d.iban! : '',
      BIC: d.bic ?? '',
      accountNumber: route === 'iban' ? '' : (d.accountNumber ?? ''),
      sortCode: route === 'gbp_local' ? (d.sortCode ?? '') : '',
      abartn: route === 'usd_local' ? (d.routingNumber ?? '') : '',
      accountType: route === 'usd_local' && d.accountType ? d.accountType.toUpperCase() : '',
      ifscCode: route === 'inr_local' ? (d.ifsc ?? '') : '',
      addressCountryCode: d.address?.country ?? '',
      addressCity: d.address?.city ?? '',
      addressFirstLine: d.address?.line1 ?? '',
      addressPostCode: d.address?.postCode ?? '',
      addressState: d.address?.state ?? '',
    };
    lines.push(csvLine(WISE_COLUMNS.map((c) => cells[c])));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

export interface BulkConfirmResult {
  confirmed: PayoutRow[];
  notConfirmable: Array<{
    payoutId: string;
    error: 'payout_not_found' | 'not_confirmable';
    /** Set when the payout is on a do-not-pay hold, or in a PayPal
     *  Payouts batch whose outcome PayPal reports (`in_paypal_batch`). */
    reason?: DoNotPayReason | 'in_paypal_batch';
    detail?: string;
  }>;
}

/** PayPal Payouts batches still in flight (paypal-payouts.ts OPEN_STATES). */
const OPEN_PAYPAL_BATCH_STATES = ['intent', 'posted', 'submitted', 'reconcile_required'];

export const IN_PAYPAL_BATCH_DETAIL =
  'this payout is in a PayPal Payouts batch OpenPartner sent; PayPal reports whether it was paid, so it is confirmed or released from there';

/**
 * Where these payouts stand against PayPal Payouts batches:
 *
 *   - `held`: payouts in a batch still in flight. Marking one as sent by
 *     hand would race PayPal's own answer: a payout PayPal then reports as
 *     failed would already read as paid.
 *   - `settled`: the batch ids of API stamps a confirm may go ahead on: a
 *     batch that ended (failed, denied, released) or isn't on this
 *     deployment (a bundle restored elsewhere, checked in PayPal by the
 *     admin). The confirm UPDATE allows an API stamp only from this list,
 *     so a batch that stamps the payout after this read is never
 *     overruled.
 */
export async function paypalBatchStanding(
  db: Knex,
  tenantId: string,
  payouts: readonly PayoutRow[],
): Promise<{ held: Set<string>; settled: string[] }> {
  const byBatch = new Map<string, string[]>();
  for (const p of payouts) {
    const s = stampOf(p);
    if (!s || !isApiStamp(s)) continue;
    byBatch.set(s.exportId, [...(byBatch.get(s.exportId) ?? []), p.id]);
  }
  const held = new Set<string>();
  const open = new Set<string>();
  for (const ids of chunks([...byBatch.keys()])) {
    const rows = (await db(TABLES.PaypalPayoutBatch)
      .where({ tenantId })
      .whereIn('id', ids)
      .whereIn('state', OPEN_PAYPAL_BATCH_STATES)
      .select('id')) as Array<{ id: string }>;
    for (const b of rows) {
      open.add(b.id);
      for (const id of byBatch.get(b.id) ?? []) held.add(id);
    }
  }
  return { held, settled: [...byBatch.keys()].filter((id) => !open.has(id)) };
}

const DO_NOT_PAY_DETAIL: Record<DoNotPayReason, string> = {
  country_not_supported: 'the partner, or their payout account, is in a country OpenPartner does not serve; do not pay this payout',
  screening_confirmed: 'the partner is a confirmed sanctions-list match; do not pay this payout',
};

/** Why this pending manual payout must not be paid, or null. */
export async function doNotPayReason(db: Knex, tenantId: string, payout: PayoutRow): Promise<DoNotPayReason | null> {
  const [c] = await classify(db, tenantId, [payout], await blockedCountries());
  return c?.doNotPay ?? null;
}

export function doNotPayDetail(reason: DoNotPayReason): string {
  return DO_NOT_PAY_DETAIL[reason];
}

/**
 * Mark pending manual payouts as sent, as POST /payouts/:id/confirm does
 * for one. Each id is confirmed or reported; one that can't be confirmed
 * doesn't stop the rest. A payout on a do-not-pay hold is refused. No
 * webhooks: payout.created and commission.paid fired when the run wrote
 * the payouts.
 */
export async function confirmManualPayouts(
  db: Knex,
  tenantId: string,
  payoutIds: readonly string[],
  /** Single confirm only: how the brand sent the money (UTR, UPI txn id),
   *  kept as metadata.externalReference for the statement. Bulk and file
   *  confirms pass none. */
  opts: { reference?: string | null } = {},
): Promise<BulkConfirmResult> {
  const ids = [...new Set(payoutIds)];
  const found = new Map<string, PayoutRow>();
  for (const chunk of chunks(ids)) {
    for (const p of await db<PayoutRow>(TABLES.Payout).where({ tenantId }).whereIn('id', chunk)) found.set(p.id, p);
  }
  const candidates = [...found.values()].filter((p) => p.method === 'manual' && p.status === 'pending');
  const refused = new Map<string, DoNotPayReason | 'in_paypal_batch'>();
  for (const c of await classify(db, tenantId, candidates, await blockedCountries())) {
    if (c.doNotPay) refused.set(c.payout.id, c.doNotPay);
  }
  const standing = await paypalBatchStanding(db, tenantId, candidates);
  for (const id of standing.held) {
    if (!refused.has(id)) refused.set(id, 'in_paypal_batch');
  }

  const confirmed: PayoutRow[] = [];
  for (const chunk of chunks(candidates.filter((p) => !refused.has(p.id)).map((p) => p.id))) {
    confirmed.push(
      ...((await db<PayoutRow>(TABLES.Payout)
        .where({ tenantId, method: 'manual', status: 'pending' })
        .whereIn('id', chunk)
        // Decided on the row being updated, not on the read above: a
        // PayPal batch that stamped it since (or is stamping it now: the
        // UPDATE waits for that row lock, then re-checks this) wins.
        .andWhere((q) =>
          q
            .whereRaw(`metadata->'manualExport'->>'via' is distinct from 'api'`)
            .orWhereRaw(`metadata->'manualExport'->>'exportId' = any(?::text[])`, [standing.settled]),
        )
        .update({
          status: 'paid',
          completedAt: new Date(),
          ...(opts.reference
            ? { metadata: db.raw(`metadata || jsonb_build_object('externalReference', ?::text)`, [opts.reference]) }
            : {}),
        })
        .returning('*')) as PayoutRow[]),
    );
  }
  const done = new Set(confirmed.map((p) => p.id));
  // A candidate the UPDATE skipped changed under it: say why from its row now.
  const changed = candidates.filter((p) => !done.has(p.id) && !refused.has(p.id)).map((p) => p.id);
  for (const chunk of chunks(changed)) {
    for (const p of await db<PayoutRow>(TABLES.Payout).where({ tenantId }).whereIn('id', chunk)) {
      found.set(p.id, p);
      if (p.status === 'pending' && isApiStamp(stampOf(p))) refused.set(p.id, 'in_paypal_batch');
    }
  }
  return {
    confirmed,
    notConfirmable: ids
      .filter((id) => !done.has(id))
      .map((payoutId) => {
        const p = found.get(payoutId);
        if (!p) return { payoutId, error: 'payout_not_found' as const };
        const reason = refused.get(payoutId);
        if (reason) {
          const detail = reason === 'in_paypal_batch' ? IN_PAYPAL_BATCH_DETAIL : DO_NOT_PAY_DETAIL[reason];
          return { payoutId, error: 'not_confirmable' as const, reason, detail };
        }
        return {
          payoutId,
          error: 'not_confirmable' as const,
          detail: `only pending manual payouts can be confirmed (this one is ${p.method}/${p.status})`,
        };
      }),
  };
}
