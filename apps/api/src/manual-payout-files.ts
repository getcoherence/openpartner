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
 * Every other pending payout is listed with the reason it's in no file (no
 * payout details, a UPI ID or free-text instructions the brand pays one by
 * one, a currency PayPal can't send, a blocked country, a confirmed
 * sanctions match). Partners on a sanctions review or still waiting for
 * screening stay in their file, with the warning shown next to them,
 * because the manual rail is the brand's own money (payouts.ts).
 *
 * Downloading a file stamps its payouts (`metadata.manualExport`), so the
 * batch page can say a payout already went into a file. Confirming them
 * (POST /payouts/confirm) is still the brand's call: only the brand knows
 * whether its upload went through.
 *
 * Formats were checked against PayPal's and Wise's documentation on
 * 2026-10-19; see the doc for sources and for the Wise columns no public
 * Wise page lists.
 */

import type { Knex } from 'knex';
import {
  TABLES,
  type PartnerRow,
  type PayoutRow,
  type PayoutStatus,
  type PayoutProfileMethod,
  type PayoutProfileUpdatedBy,
} from '@openpartner/db';
import { db as platformDb } from './db.js';
import { getCountryAccessSettings } from './country-access.js';
import { partnerPayoutHolds, type PayoutHoldReason } from './sanctions-screening.js';
import { getTenancyMode } from './tenancy.js';
import { resolveBrandName } from './brand-name.js';
import { stripeExponent } from './stripe-amounts.js';
import {
  bankRoute,
  getPayoutProfiles,
  summarizeDetails,
  type BankDetails,
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
  // PayPal Payouts can't send this currency (INR, for one).
  'currency_not_supported',
  // OpenPartner Cloud: the partner's declared country, or their account's,
  // is one the platform doesn't serve (country-access.ts).
  'country_not_supported',
  // OpenPartner Cloud: an operator confirmed a sanctions-list match.
  'screening_confirmed',
] as const;
export type ManualExclusionReason = (typeof MANUAL_EXCLUSION_REASONS)[number];

/**
 * Currencies PayPal's REST API lists (developer.paypal.com/api/rest/
 * reference/currency-codes, checked 2026-10-19). Not INR: since April 2021
 * Indian PayPal accounts receive international payments in USD only.
 */
export const PAYPAL_CURRENCIES: ReadonlySet<string> = new Set([
  'AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS', 'JPY', 'MYR', 'MXN',
  'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'RUB', 'SGD', 'SEK', 'CHF', 'THB', 'USD',
]);
/** PayPal rejects a decimal amount in these. */
const PAYPAL_NO_DECIMALS: ReadonlySet<string> = new Set(['HUF', 'JPY', 'TWD']);
/** PayPal's upload format writes these with a decimal comma, quoted ("100,50"). */
const PAYPAL_COMMA_DECIMALS: ReadonlySet<string> = new Set(['EUR', 'BRL']);
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

export interface ManualRunPayout {
  payoutId: string;
  partnerId: string;
  partnerName: string;
  partnerEmail: string;
  amount: string;
  currency: string;
  status: PayoutStatus;
  createdAt: Date;
  completedAt: Date | null;
  /** The partner's payout details, masked. Null when they have none. */
  destination: {
    method: PayoutProfileMethod;
    country: string | null;
    /** Null when the details can't be opened. */
    summary: string | null;
    updatedAt: Date;
    updatedBy: PayoutProfileUpdatedBy;
  } | null;
  /** The file this payout is in. Only pending payouts are in a file. */
  file: { provider: ManualPayoutProvider; currency: string; part: number; reference: string | null } | null;
  /** Why a pending payout is in no file. */
  excluded: ManualExclusionReason | null;
  /** OpenPartner Cloud: the partner is on a compliance hold. */
  complianceWarning: PayoutHoldReason | null;
  /** When a file holding this payout was last downloaded, and which. */
  lastExport: { provider: ManualPayoutProvider; at: string } | null;
}

export interface ManualRunFile {
  provider: ManualPayoutProvider;
  /** PayPal: the payout currency. Wise: the source currency (what the
   *  brand pays in); one file can pay into several target currencies. */
  currency: string;
  part: number;
  count: number;
  /** Sum of the payouts in it, in `currency`. */
  total: string;
}

export interface ManualRun {
  runId: string;
  createdAt: Date;
  payouts: ManualRunPayout[];
  files: ManualRunFile[];
}

interface PlannedRow {
  payout: PayoutRow;
  partner: Pick<PartnerRow, 'id' | 'name' | 'email'>;
  details: PayoutDetails | null;
  view: ManualRunPayout;
}

interface ManualExportMeta {
  provider: ManualPayoutProvider;
  at: string;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface ManualRunSummary {
  runId: string;
  createdAt: Date;
  /** Manual payouts in the run. */
  payoutCount: number;
  /** Of those, still waiting to be sent and confirmed. */
  pendingCount: number;
  /** What the pending ones add up to, per currency. */
  pendingTotals: Array<{ currency: string; amount: string }>;
}

/** Payout runs with manual payouts still pending, newest first. */
export async function listManualRuns(db: Knex, tenantId: string, limit = 50): Promise<ManualRunSummary[]> {
  const runs = (await db(TABLES.Payout)
    .where({ tenantId, method: 'manual' })
    .whereRaw(`metadata->>'runId' is not null`)
    .groupByRaw(`metadata->>'runId'`)
    .havingRaw(`count(*) filter (where status = 'pending') > 0`)
    .select(
      db.raw(`metadata->>'runId' as "runId"`),
      db.raw(`min("createdAt") as "createdAt"`),
      db.raw(`count(*)::int as "payoutCount"`),
      db.raw(`(count(*) filter (where status = 'pending'))::int as "pendingCount"`),
    )
    .orderBy('createdAt', 'desc')
    .limit(limit)) as Array<{ runId: string; createdAt: Date; payoutCount: number; pendingCount: number }>;
  if (runs.length === 0) return [];
  const totals = (await db(TABLES.Payout)
    .where({ tenantId, method: 'manual', status: 'pending' })
    .whereRaw(`metadata->>'runId' = any(?)`, [runs.map((r) => r.runId)])
    .groupByRaw(`metadata->>'runId', currency`)
    .select(db.raw(`metadata->>'runId' as "runId"`), 'currency', db.raw(`sum(amount)::text as amount`))) as Array<{
    runId: string;
    currency: string;
    amount: string;
  }>;
  return runs.map((r) => ({
    ...r,
    pendingTotals: totals
      .filter((t) => t.runId === r.runId)
      .map((t) => ({ currency: t.currency, amount: Number(t.amount).toFixed(2) }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  }));
}

/**
 * One run's manual payouts: where each pending one goes (which file, or
 * why none), with compliance warnings and masked payout details. Null when
 * the run has no manual payouts in this tenant.
 */
export async function getManualRun(db: Knex, tenantId: string, runId: string): Promise<ManualRun | null> {
  const plan = await planManualRun(db, tenantId, runId);
  return plan ? plan.run : null;
}

async function planManualRun(
  db: Knex,
  tenantId: string,
  runId: string,
): Promise<{ run: ManualRun; rows: PlannedRow[] } | null> {
  const payouts = await db<PayoutRow>(TABLES.Payout)
    .where({ tenantId, method: 'manual' })
    .whereRaw(`metadata->>'runId' = ?`, [runId])
    .orderBy('id', 'asc');
  if (payouts.length === 0) return null;

  const partnerIds = [...new Set(payouts.map((p) => p.partnerId))];
  const partners = new Map(
    ((await db<PartnerRow>(TABLES.Partner)
      .where({ tenantId })
      .whereIn('id', partnerIds)
      .select('id', 'name', 'email')) as Array<Pick<PartnerRow, 'id' | 'name' | 'email'>>).map((p) => [p.id, p]),
  );
  const profiles = await getPayoutProfiles(db, tenantId, partnerIds);
  // Platform tables (holds, the country list): the privileged pool, scoped
  // to this tenant by the calls themselves. Both are hosted-only and come
  // back empty on a self-host.
  const holds = await partnerPayoutHolds(platformDb, tenantId, [...partners.values()]);
  const blocked = await blockedCountries();

  const rows: PlannedRow[] = [];
  for (const payout of payouts) {
    const partner = partners.get(payout.partnerId) ?? { id: payout.partnerId, name: '', email: '' };
    const profile = profiles.get(payout.partnerId) ?? null;
    const details = profile?.details ?? null;
    const hold = holds.get(payout.partnerId) ?? null;
    const currency = payout.currency.toUpperCase();
    const exported = (payout.metadata as { manualExport?: ManualExportMeta }).manualExport ?? null;

    let excluded: ManualExclusionReason | null = null;
    let provider: ManualPayoutProvider | null = null;
    if (payout.status === 'pending') {
      if (hold?.reason === 'country_not_supported') excluded = 'country_not_supported';
      else if (hold?.reason === 'screening_confirmed') excluded = 'screening_confirmed';
      else if (!profile) excluded = 'no_payout_details';
      else if (!details) excluded = 'details_unreadable';
      else if (accountCountries(details).some((c) => blocked.has(c))) excluded = 'country_not_supported';
      else if (details.method === 'paypal') {
        if (PAYPAL_CURRENCIES.has(currency)) provider = 'paypal';
        else excluded = 'currency_not_supported';
      } else if (details.method === 'bank') provider = 'wise';
      else excluded = 'pay_individually';
    }

    rows.push({
      payout,
      partner,
      details,
      view: {
        payoutId: payout.id,
        partnerId: payout.partnerId,
        partnerName: partner.name,
        partnerEmail: partner.email,
        amount: Number(payout.amount).toFixed(2),
        currency,
        status: payout.status,
        createdAt: payout.createdAt,
        completedAt: payout.completedAt,
        destination: profile
          ? {
              method: profile.method,
              country: profile.country,
              summary: details ? summarizeDetails(details) : null,
              updatedAt: profile.updatedAt,
              updatedBy: profile.updatedBy,
            }
          : null,
        file: provider
          ? { provider, currency, part: 0, reference: reference(provider, payout.id, details) }
          : null,
        excluded,
        complianceWarning: hold?.reason ?? null,
        lastExport: exported,
      },
    });
  }

  // Split each (provider, currency) into files of at most MAX_ROWS, in
  // payout-id order so the split is stable while nothing is confirmed.
  const files = new Map<string, ManualRunFile>();
  const placed = new Map<string, number>();
  for (const { view } of rows) {
    if (!view.file) continue;
    const key = `${view.file.provider}:${view.file.currency}`;
    const index = placed.get(key) ?? 0;
    placed.set(key, index + 1);
    const part = Math.floor(index / MAX_ROWS[view.file.provider]) + 1;
    view.file.part = part;
    const fileKey = `${key}:${part}`;
    const file = files.get(fileKey) ?? { provider: view.file.provider, currency: view.file.currency, part, count: 0, total: '0.00' };
    file.count += 1;
    file.total = (Number(file.total) + Number(view.amount)).toFixed(2);
    files.set(fileKey, file);
  }

  return {
    run: {
      runId,
      createdAt: payouts.reduce((min, p) => (p.createdAt < min ? p.createdAt : min), payouts[0]!.createdAt),
      payouts: rows.map((r) => r.view),
      files: [...files.values()],
    },
    rows,
  };
}

/** OpenPartner Cloud's blocked countries, or none on a self-host (the
 *  country list is a hosted-platform control, like partnerPayoutHolds). */
async function blockedCountries(): Promise<ReadonlySet<string>> {
  if (getTenancyMode() !== 'multi') return new Set();
  const settings = await getCountryAccessSettings(platformDb);
  return settings.enforce ? new Set(settings.blocked.map((b) => b.code)) : new Set();
}

/** Every country a destination names: the account's, and the holder's
 *  address for a bank account. */
function accountCountries(details: PayoutDetails): string[] {
  const out: string[] = [];
  if (details.method === 'upi') out.push('IN');
  else if (details.country) out.push(details.country);
  if (details.method === 'bank' && details.address) out.push(details.address.country);
  return out;
}

function reference(provider: ManualPayoutProvider, payoutId: string, details: PayoutDetails | null): string | null {
  // PayPal's Customer ID: unique, no spaces, at most 30 characters. A
  // ULID is 26.
  if (provider === 'paypal') return payoutId;
  const target = details?.method === 'bank' ? details.currency : '';
  return WISE_NO_REFERENCE.has(target) ? null : payoutId.slice(-WISE_REFERENCE_LENGTH);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface ManualPayoutFile {
  filename: string;
  body: string;
  payoutIds: string[];
}

/**
 * Build one file of a run, and stamp its payouts as exported. Null when
 * the run has no such file (nothing pending for that provider, currency and
 * part).
 */
export async function buildManualPayoutFile(
  db: Knex,
  tenantId: string,
  runId: string,
  provider: ManualPayoutProvider,
  currency: string,
  part: number,
): Promise<ManualPayoutFile | null> {
  const plan = await planManualRun(db, tenantId, runId);
  if (!plan) return null;
  const rows = plan.rows.filter(
    (r) => r.view.file?.provider === provider && r.view.file.currency === currency && r.view.file.part === part,
  );
  if (rows.length === 0) return null;

  const body =
    provider === 'paypal'
      ? paypalCsv(rows, paypalNote(await resolveBrandName(db, tenantId)))
      : wiseCsv(rows);
  const payoutIds = rows.map((r) => r.payout.id);

  const stamp: ManualExportMeta = { provider, at: new Date().toISOString() };
  await db(TABLES.Payout)
    .where({ tenantId, method: 'manual', status: 'pending' })
    .whereIn('id', payoutIds)
    .update({ metadata: db.raw(`metadata || jsonb_build_object('manualExport', ?::jsonb)`, [JSON.stringify(stamp)]) });

  const suffix = plan.run.files.filter((f) => f.provider === provider && f.currency === currency).length > 1 ? `-part${part}` : '';
  return {
    filename: `${provider}-payouts-${runId.replace(/[^A-Za-z0-9_-]/g, '')}-${currency}${suffix}.csv`,
    body,
    payoutIds,
  };
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
function plainText(v: string, max: number): string {
  return v.replace(/[\r\n\t]+/g, ' ').replace(/^[=+\-@\s]+/, '').trim().slice(0, max);
}

function paypalNote(brandName: string | null): string {
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
function paypalCsv(rows: PlannedRow[], note: string): string {
  const lines = rows.map((r) => {
    const d = r.details as PaypalDetails;
    return csvLine([
      d.email,
      paypalAmount(r.view.amount, r.view.currency),
      r.view.currency,
      r.view.file!.reference ?? '',
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
function wiseCsv(rows: PlannedRow[]): string {
  const lines = [csvLine(WISE_COLUMNS)];
  for (const r of rows) {
    const d = r.details as BankDetails;
    const sameCurrency = d.currency === r.view.currency;
    const route = bankRoute(d);
    const cells: Record<(typeof WISE_COLUMNS)[number], string> = {
      name: d.accountHolderName,
      recipientEmail: d.email ?? r.partner.email,
      paymentReference: r.view.file!.reference ?? '',
      recipientType: d.accountHolderType === 'business' ? 'institution' : 'person',
      amountCurrency: sameCurrency ? 'target' : 'source',
      amount: wiseAmount(r.view.amount, r.view.currency),
      sourceCurrency: r.view.currency,
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
// Bulk confirm
// ---------------------------------------------------------------------------

export interface BulkConfirmResult {
  confirmed: PayoutRow[];
  notConfirmable: Array<{ payoutId: string; error: 'payout_not_found' | 'not_confirmable'; detail?: string }>;
}

/**
 * Mark pending manual payouts as sent, as POST /payouts/:id/confirm does
 * for one. Each id is confirmed or reported; one that can't be confirmed
 * doesn't stop the rest. No webhooks: payout.created and commission.paid
 * fired when the run wrote the payouts.
 */
export async function confirmManualPayouts(db: Knex, tenantId: string, payoutIds: readonly string[]): Promise<BulkConfirmResult> {
  const ids = [...new Set(payoutIds)];
  const confirmed = (await db<PayoutRow>(TABLES.Payout)
    .where({ tenantId, method: 'manual', status: 'pending' })
    .whereIn('id', ids)
    .update({ status: 'paid', completedAt: new Date() })
    .returning('*')) as PayoutRow[];
  const done = new Set(confirmed.map((p) => p.id));
  const rest = ids.filter((id) => !done.has(id));
  const existing = rest.length
    ? new Map(
        ((await db<PayoutRow>(TABLES.Payout)
          .where({ tenantId })
          .whereIn('id', rest)
          .select('id', 'method', 'status')) as Array<Pick<PayoutRow, 'id' | 'method' | 'status'>>).map((p) => [p.id, p]),
      )
    : new Map<string, Pick<PayoutRow, 'id' | 'method' | 'status'>>();
  return {
    confirmed,
    notConfirmable: rest.map((payoutId) => {
      const p = existing.get(payoutId);
      return p
        ? {
            payoutId,
            error: 'not_confirmable' as const,
            detail: `only pending manual payouts can be confirmed (this one is ${p.method}/${p.status})`,
          }
        : { payoutId, error: 'payout_not_found' as const };
    }),
  };
}
