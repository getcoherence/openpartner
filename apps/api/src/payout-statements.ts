/**
 * Payout statements: remittance advice for one payout, what it paid and
 * what for (docs/payout-statements.md).
 *
 * A statement is a view over rows that already exist, never a record of
 * its own:
 *   - the Payout: id, status, method, amount, the Stripe transfer, or the
 *     reference the brand recorded when it confirmed a manual payout
 *     (`metadata.externalReference`);
 *   - its commissions (Commission.payoutId), bonuses' among them;
 *   - the refund clawbacks it netted (CommissionAdjustment.appliedPayoutId,
 *     clawback-netting.ts);
 *   - Stripe transfer reversals after it was paid (PayoutReversal);
 *   - the brand's statement settings (Config `payout_statements`) and, on
 *     OpenPartner Cloud, the GSTIN on its billing profile.
 * So a statement can be printed again at any time and always agrees with
 * the ledger, and an export carries everything needed to rebuild it.
 *
 * It is not a tax invoice. Whether a brand needs a GST invoice, or tax
 * deducted at source shown, is for its accountant to say. Until then tax
 * lines are a stub behind a flag (`taxLines.enabled`, off by default):
 * labelled rows with no amount, since nothing records one yet.
 *
 * Payout details are shown masked (payout-profile.ts summarizeDetails),
 * never in full. Every read names the tenant: RLS scopes `db`, but a pool
 * that bypasses RLS must not print another tenant's payout.
 */

import type { Knex } from 'knex';
import {
  TABLES,
  type HostedBillingProfileRow,
  type HostedFundingTransferRow,
  type PartnerRow,
  type PayoutReversalRow,
  type PayoutRow,
  type TenantRow,
} from '@openpartner/db';
import { getConfig, setConfig } from './config.js';
import { resolveBrandName } from './brand-name.js';
import { getPayoutProfile, summarizeDetails, type OpenedPayoutProfile } from './payout-profile.js';
import { manualExportOf } from './manual-payout-files.js';
import { WHOLE_UNITS_TWO_DECIMAL, majorToCents, stripeExponent, stripeMinorToMajorString } from './stripe-amounts.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const PAYOUT_STATEMENTS_CONFIG_KEY = 'payout_statements';

export interface PayoutStatementSettings {
  /** The registered business name statements are issued in. Null: the
   *  brand name. */
  legalName: string | null;
  /** The brand's postal address, one line per line. */
  address: string | null;
  /** Printed at the foot of every statement. */
  footer: string | null;
  /** Goes before the payout id to make the statement number. */
  numberPrefix: string | null;
  /** A stub for tax lines (tax withheld, say), off by default: each label
   *  prints as a row with no amount, because nothing records one yet. */
  taxLines: { enabled: boolean; labels: string[] };
}

export const DEFAULT_TAX_LINE_LABELS = ['Tax withheld'];

const MAX_TAX_LINES = 5;

/** Text from a stored value: a non-blank string, or null. The row may come
 *  from an imported bundle, so its shape isn't trusted. */
function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function labels(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((l): l is string => typeof l === 'string' && !!l.trim()).slice(0, MAX_TAX_LINES);
  return out.length > 0 ? out : null;
}

export async function readStatementSettings(db: Knex, tenantId: string): Promise<PayoutStatementSettings> {
  const v = await getConfig<Record<string, unknown>>(db, tenantId, PAYOUT_STATEMENTS_CONFIG_KEY);
  const tax = (v?.taxLines ?? {}) as Record<string, unknown>;
  return {
    legalName: text(v?.legalName),
    address: text(v?.address),
    footer: text(v?.footer),
    numberPrefix: text(v?.numberPrefix),
    taxLines: { enabled: tax.enabled === true, labels: labels(tax.labels) ?? DEFAULT_TAX_LINE_LABELS },
  };
}

/** A validated change: a field left out keeps its value, null clears it. */
export interface PayoutStatementSettingsPatch {
  legalName?: string | null;
  address?: string | null;
  footer?: string | null;
  numberPrefix?: string | null;
  taxLines?: { enabled?: boolean; labels?: string[] };
}

export async function saveStatementSettings(
  db: Knex,
  tenantId: string,
  patch: PayoutStatementSettingsPatch,
): Promise<PayoutStatementSettings> {
  const current = await readStatementSettings(db, tenantId);
  const pick = <K extends 'legalName' | 'address' | 'footer' | 'numberPrefix'>(k: K) =>
    patch[k] === undefined ? current[k] : patch[k] || null;
  const next: PayoutStatementSettings = {
    legalName: pick('legalName'),
    address: pick('address'),
    footer: pick('footer'),
    numberPrefix: pick('numberPrefix'),
    taxLines: {
      enabled: patch.taxLines?.enabled ?? current.taxLines.enabled,
      labels: patch.taxLines?.labels ?? current.taxLines.labels,
    },
  };
  await setConfig(db, tenantId, PAYOUT_STATEMENTS_CONFIG_KEY, next);
  return next;
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

export interface StatementLine {
  /** The commission, bonus, adjustment or reversal id. */
  id: string;
  /** The commission's or bonus's id, on every line but a reversal. */
  commissionId: string | null;
  /** When it was earned (commission, bonus) or recorded (clawback, reversal). */
  date: string;
  programName: string | null;
  /** What it is, in words: "Invoice paid", "Bonus: launch week", "Refund
   *  clawback: Invoice paid (earned 2026-09-14)". */
  description: string;
  /** Signed, major units, two decimals. Deductions are negative. */
  amount: string;
  currency: string;
}

export interface StatementTotal {
  currency: string;
  commissions: string;
  bonuses: string;
  /** Refund clawbacks netted off the payout: zero or negative. */
  clawbacks: string;
  /** commissions + bonuses + clawbacks. */
  net: string;
}

export interface PayoutStatement {
  /** numberPrefix + the payout id: unique and the same every time. */
  statementNumber: string;
  generatedAt: string;
  issuer: {
    /** The legal name from the statement settings, else the brand name. */
    name: string;
    /** The brand name when it differs from `name`. */
    tradingName: string | null;
    address: string | null;
    /** OpenPartner Cloud: the GSTIN on the brand's billing profile. */
    gstin: string | null;
    logoUrl: string | null;
  };
  partner: {
    id: string;
    /** Null when the partner record is gone. */
    name: string | null;
    email: string | null;
    /** Masked: never a full account number, email or UPI ID. Null when
     *  there's nothing on file. */
    destination: string | null;
    /** The partner changed their payout details after this payout. */
    destinationChanged: boolean;
  };
  payout: {
    id: string;
    status: PayoutRow['status'];
    method: PayoutRow['method'];
    /** How it was sent, in words: "Stripe Connect transfer", "Manual · Wise batch payment". */
    methodLabel: string;
    /** What identifies it at the provider, when there is one: the Stripe
     *  transfer, the batch file's reference, or what the brand recorded
     *  when it confirmed a payout sent one at a time. */
    reference: { label: string; value: string } | null;
    /** What was paid (or is to be), in the payout's currency. */
    amount: string;
    currency: string;
    createdAt: string;
    completedAt: string | null;
  };
  commissions: StatementLine[];
  bonuses: StatementLine[];
  clawbacks: StatementLine[];
  /** Taken back from the partner after the transfer landed. Not in `net`. */
  reversals: StatementLine[];
  /** Empty unless the brand turned tax lines on; `amount` is always null
   *  for now. */
  taxLines: Array<{ label: string; amount: string | null; currency: string }>;
  /** One per currency the lines are in; a payout has one. */
  totals: StatementTotal[];
  /** Plain sentences: a pending, failed or reversed payout, rounding. */
  notes: string[];
  footer: string | null;
}

const cents = (amount: string | number) => majorToCents(amount);
const major = (c: number) => (c / 100).toFixed(2);
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** An event type in words: `trial_started` → "Trial started". Same as the
 *  portal's commission lists (lib/commission-source.ts). */
export function eventTypeLabel(type: string): string {
  const words = type.replace(/[_.-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : type;
}

interface CommissionSource {
  bonusId: string | null;
  eventType: string | null;
  bonusSource: string | null;
  bonusNote: string | null;
  bountyName: string | null;
}

/** What a commission was earned on: the portal's commissionSourceLabel. */
function sourceLabel(c: CommissionSource): string {
  if (!c.bonusId) return c.eventType ? eventTypeLabel(c.eventType) : 'Sale';
  if (c.bonusSource === 'performance_bounty') return c.bountyName ? `Bounty: ${c.bountyName}` : 'Bounty';
  const kind = c.bonusSource === 'network' ? 'Network bounty' : 'Bonus';
  return c.bonusNote ? `${kind}: ${c.bonusNote}` : kind;
}

/** A commission (or a clawback's commission) with what names it: its
 *  event, bonus and program. Every join names the tenant too. */
function withSource(db: Knex, q: Knex.QueryBuilder, commissionAlias: string): Knex.QueryBuilder {
  const c = commissionAlias;
  return q
    .leftJoin(`${TABLES.Attribution} as a`, (j) => j.on('a.id', `${c}.attributionId`).andOn('a.tenantId', `${c}.tenantId`))
    .leftJoin(`${TABLES.Event} as e`, (j) => j.on('e.id', 'a.eventId').andOn('e.tenantId', `${c}.tenantId`))
    .leftJoin(`${TABLES.Bonus} as b`, (j) => j.on('b.id', `${c}.bonusId`).andOn('b.tenantId', `${c}.tenantId`))
    .leftJoin(`${TABLES.Bounty} as bt`, (j) => j.on('bt.id', 'b.bountyId').andOn('bt.tenantId', `${c}.tenantId`))
    .leftJoin(`${TABLES.Program} as pr`, (j) =>
      // A commission has exactly one of the two (a CHECK says so).
      j.on('pr.id', '=', db.raw('coalesce(a."programId", b."programId")')).andOn('pr.tenantId', `${c}.tenantId`),
    )
    .select(
      `${c}.bonusId as bonusId`,
      'e.type as eventType',
      'b.source as bonusSource',
      'b.note as bonusNote',
      'bt.name as bountyName',
      'pr.name as programName',
    );
}

const STATUS_LABEL: Record<PayoutRow['status'], string> = {
  pending: 'Pending',
  paid: 'Paid',
  failed: 'Failed',
  partially_reversed: 'Partially reversed',
  reversed: 'Reversed',
};

const PROFILE_METHOD_LABEL: Record<OpenedPayoutProfile['method'], string> = {
  paypal: 'PayPal',
  bank: 'bank transfer',
  upi: 'UPI',
  other: 'as the partner asked',
};

/** Why a connect-blocked payout failed (payouts.ts blockReason). */
const FAILURE_REASON: Record<string, string> = {
  stripe_onboarding_incomplete: 'the partner’s Stripe account wasn’t ready for payouts',
  stripe_connect_account_missing: 'the partner hadn’t connected a Stripe account',
};

/**
 * The statement for one of this tenant's payouts, or null when the tenant
 * has no such payout. Who may see it is the caller's to decide.
 */
export async function buildPayoutStatement(db: Knex, tenantId: string, payoutId: string): Promise<PayoutStatement | null> {
  const payout = await db<PayoutRow>(TABLES.Payout).where({ id: payoutId, tenantId }).first();
  if (!payout) return null;
  const currency = payout.currency.toUpperCase();
  const meta = (payout.metadata ?? {}) as {
    destinationAccountId?: unknown;
    transferIntentId?: unknown;
    transferState?: unknown;
    error?: unknown;
    externalReference?: unknown;
  };

  // One after another: `db` is usually the request's transaction, a single
  // connection that runs one query at a time.
  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first('displayName', 'logoUrl');
  const brandName = await resolveBrandName(db, tenantId);
  const settings = await readStatementSettings(db, tenantId);
  const billing = await db<HostedBillingProfileRow>(TABLES.HostedBillingProfile).where({ tenantId }).first('gstin');
  const partner = await db<PartnerRow>(TABLES.Partner)
    .where({ id: payout.partnerId, tenantId })
    .first('id', 'name', 'email');

  // ---- line items
  const commissionRows = (await withSource(
    db,
    db(`${TABLES.Commission} as c`)
      .where('c.tenantId', tenantId)
      .where('c.payoutId', payout.id)
      .select('c.id', 'c.amount', 'c.currency', 'c.accruedAt')
      .orderBy([{ column: 'c.accruedAt' }, { column: 'c.id' }]),
    'c',
  )) as Array<CommissionSource & { id: string; amount: string; currency: string; accruedAt: Date; programName: string | null }>;

  const clawbackRows = (await withSource(
    db,
    db(`${TABLES.CommissionAdjustment} as adj`)
      .where('adj.tenantId', tenantId)
      .where('adj.appliedPayoutId', payout.id)
      .where('adj.reason', 'refund_clawback')
      .leftJoin(`${TABLES.Commission} as c`, (j) => j.on('c.id', 'adj.commissionId').andOn('c.tenantId', 'adj.tenantId'))
      .select('adj.id', 'adj.commissionId', 'adj.amount', 'adj.currency', 'adj.createdAt', 'c.accruedAt as earnedAt')
      .orderBy([{ column: 'adj.createdAt' }, { column: 'adj.id' }]),
    'c',
  )) as Array<
    CommissionSource & {
      id: string;
      commissionId: string;
      amount: string;
      currency: string;
      createdAt: Date;
      earnedAt: Date | null;
      programName: string | null;
    }
  >;

  const reversalRows = (await db<PayoutReversalRow>(TABLES.PayoutReversal)
    .where({ tenantId, payoutId: payout.id })
    .orderBy([{ column: 'createdAt' }, { column: 'id' }])) as PayoutReversalRow[];

  const commissions: StatementLine[] = [];
  const bonuses: StatementLine[] = [];
  for (const r of commissionRows) {
    (r.bonusId ? bonuses : commissions).push({
      id: r.bonusId ?? r.id,
      commissionId: r.id,
      date: day(r.accruedAt),
      programName: r.programName,
      description: sourceLabel(r),
      amount: major(cents(r.amount)),
      currency: r.currency.toUpperCase(),
    });
  }
  const clawbacks: StatementLine[] = clawbackRows.map((r) => ({
    id: r.id,
    commissionId: r.commissionId,
    date: day(r.createdAt),
    programName: r.programName,
    description: `Refund clawback: ${sourceLabel(r)}${r.earnedAt ? ` (earned ${day(r.earnedAt)})` : ''}`,
    amount: major(cents(r.amount)),
    currency: r.currency.toUpperCase(),
  }));
  const reversals: StatementLine[] = reversalRows.map((r) => ({
    id: r.id,
    commissionId: null,
    date: day(r.createdAt),
    programName: null,
    description: 'Stripe transfer reversed',
    amount: major(-cents(stripeMinorToMajorString(r.amountMinor, currency))),
    currency,
  }));

  // ---- totals, per currency, in hundredths so they add up exactly
  const sums = new Map<string, { commissions: number; bonuses: number; clawbacks: number }>();
  const add = (lines: StatementLine[], key: 'commissions' | 'bonuses' | 'clawbacks') => {
    for (const l of lines) {
      const s = sums.get(l.currency) ?? { commissions: 0, bonuses: 0, clawbacks: 0 };
      s[key] += cents(l.amount);
      sums.set(l.currency, s);
    }
  };
  add(commissions, 'commissions');
  add(bonuses, 'bonuses');
  add(clawbacks, 'clawbacks');
  const totals: StatementTotal[] = [...sums.entries()]
    .sort(([a], [b]) => (a === currency ? -1 : b === currency ? 1 : a.localeCompare(b)))
    .map(([cur, s]) => ({
      currency: cur,
      commissions: major(s.commissions),
      bonuses: major(s.bonuses),
      clawbacks: major(s.clawbacks),
      net: major(s.commissions + s.bonuses + s.clawbacks),
    }));

  // ---- where and how it was sent
  const profile = payout.method === 'stripe_connect' ? null : await getPayoutProfile(db, tenantId, payout.partnerId);
  const exported = payout.method === 'manual' ? manualExportOf(payout, profile?.details ?? null) : null;
  let destination: string | null = null;
  let destinationChanged = false;
  if (payout.method === 'stripe_connect') {
    // The account the transfer was frozen to: on the payout for a direct
    // Connect intent, on its funding transfer for a funded one. The
    // partner's account now may not be the one paid, so a payout that
    // records neither (older ones) says so rather than guessing.
    let account = typeof meta.destinationAccountId === 'string' ? meta.destinationAccountId : null;
    if (!account && typeof meta.transferIntentId === 'string') {
      const intent = await db<HostedFundingTransferRow>(TABLES.HostedFundingTransfer)
        .where({ id: meta.transferIntentId, tenantId })
        .first('destinationAccountId');
      account = intent?.destinationAccountId ?? null;
    }
    destination = account ? `Stripe account •••• ${account.slice(-4)}` : 'Stripe account (not recorded on this payout)';
  } else if (profile) {
    destination = profile.details ? summarizeDetails(profile.details) : 'Payout details on file can’t be read';
    // A payout goes where the details said when its batch file was made,
    // or, sent one at a time, when it was confirmed. Until then it goes to
    // whatever is on file, so only details saved after that are a change.
    const sentAt = exported ? new Date(exported.at) : payout.completedAt;
    destinationChanged = sentAt !== null && profile.updatedAt.getTime() > new Date(sentAt).getTime();
  }

  const brand = brandName ?? tenant?.displayName ?? 'the brand';
  let methodLabel: string;
  let reference: PayoutStatement['payout']['reference'] = null;
  if (payout.method === 'stripe_connect') {
    methodLabel = 'Stripe Connect transfer';
    if (payout.stripeTransferId) reference = { label: 'Stripe transfer', value: payout.stripeTransferId };
  } else if (payout.method === 'manual') {
    methodLabel = exported
      ? `Manual · ${exported.provider === 'paypal' ? 'PayPal Payouts' : 'Wise batch payment'}`
      : profile
        ? `Manual · ${PROFILE_METHOD_LABEL[profile.method]}`
        : 'Manual';
    // A Wise reference depends on the account's currency (none for JPY or
    // COP), read from the details on file: once those changed after the
    // file was made, it can't be told what the file carried.
    if (exported?.reference && (exported.provider === 'paypal' || !destinationChanged)) {
      reference = { label: exported.provider === 'paypal' ? 'PayPal Customer ID' : 'Wise payment reference', value: exported.reference };
    }
    // Sent one at a time: what the brand said identifies it when it
    // confirmed the payout (a bank UTR, a UPI transaction id, a cheque
    // number). A file's own reference wins.
    const external = text(meta.externalReference);
    if (!reference && external) reference = { label: 'Payment reference', value: external.trim() };
  } else {
    methodLabel = 'Recorded outside the payout run';
  }

  // ---- notes
  const notes: string[] = [];
  if (payout.status === 'pending') {
    notes.push(
      payout.method === 'stripe_connect'
        ? 'The Stripe transfer hasn’t completed yet.'
        : `${brand} sends this payout itself, and hasn’t confirmed sending it yet.`,
    );
  } else if (payout.status === 'failed') {
    // Only two failures are known to have paid nothing: a Connect payout
    // the partner couldn't receive (payouts.ts blockReason), and an intent
    // cancelled with its commissions released (payout-transfers.ts). A
    // failed transfer under review, or reversed and not yet disposed of,
    // may have moved money.
    const why = typeof meta.error === 'string' ? FAILURE_REASON[meta.error] : undefined;
    if (why) {
      notes.push(`This payout failed because ${why}, and nothing was sent. Its commissions stay approved and are paid in a later payout.`);
    } else if (meta.transferState === 'canceled') {
      notes.push('This payout failed, and the partner wasn’t paid by it. Its commissions are paid in a later payout.');
    } else {
      notes.push(`This payout is marked failed while it’s looked into. Ask ${brand} what was paid.`);
    }
  } else if (payout.status === 'partially_reversed' || payout.status === 'reversed') {
    notes.push(`${payout.status === 'reversed' ? 'This transfer was' : 'Part of this transfer was'} reversed after it was paid.`);
  }
  const own = totals.find((t) => t.currency === currency);
  if (own && cents(own.net) !== cents(payout.amount)) {
    notes.push(
      stripeExponent(currency) === 0 || WHOLE_UNITS_TWO_DECIMAL.has(currency)
        ? `The amount paid is the net rounded to whole ${currency}: ${currency} is paid without fractions.`
        : `The amount paid differs from the net of the lines above.`,
    );
  }
  if (settings.taxLines.enabled) {
    notes.push('Tax lines show only amounts recorded for this payout. A line with no amount has none recorded.');
  }

  const issuerName = settings.legalName ?? brand;
  return {
    statementNumber: `${settings.numberPrefix ?? ''}${payout.id}`,
    generatedAt: new Date().toISOString(),
    issuer: {
      name: issuerName,
      tradingName: brandName && brandName !== issuerName ? brandName : null,
      address: settings.address,
      gstin: billing?.gstin ?? null,
      logoUrl: tenant?.logoUrl ?? null,
    },
    partner: {
      id: payout.partnerId,
      name: partner?.name ?? null,
      email: partner?.email ?? null,
      destination,
      destinationChanged,
    },
    payout: {
      id: payout.id,
      status: payout.status,
      method: payout.method,
      methodLabel,
      reference,
      amount: major(cents(payout.amount)),
      currency,
      createdAt: new Date(payout.createdAt).toISOString(),
      completedAt: payout.completedAt ? new Date(payout.completedAt).toISOString() : null,
    },
    commissions,
    bonuses,
    clawbacks,
    reversals,
    taxLines: settings.taxLines.enabled ? settings.taxLines.labels.map((label) => ({ label, amount: null, currency })) : [],
    totals,
    notes,
    footer: settings.footer,
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** The statement's own policy, sent as a header and repeated in a meta tag
 *  so it also holds where the portal opens the page from a blob. No
 *  scripts at all; images only for the brand's logo. */
export const STATEMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'";

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);

/**
 * An amount in its currency's own format: ₹1,23,456.00, $1,234.50, ¥1,235.
 * Stored amounts have two decimals in every currency, so a currency
 * written without fractions shows them when there are some (¥100.50).
 */
export function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  try {
    const base = new Intl.NumberFormat(locale, { style: 'currency', currency });
    if ((base.resolvedOptions().maximumFractionDigits ?? 2) < 2 && cents(amount) % 100 !== 0) {
      return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    }
    return base.format(n);
  } catch {
    // Not a currency Intl knows.
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** A logo URL safe to put in an img tag: http(s) only. */
function logoSrc(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const multiline = (s: string) => esc(s).replace(/\r?\n/g, '<br>');

function linesTable(title: string, kind: string, lines: StatementLine[]): string {
  if (lines.length === 0) return '';
  const rows = lines
    .map(
      (l) =>
        `<tr><td class="date">${esc(l.date)}</td><td>${l.programName ? esc(l.programName) : '<span class="muted">—</span>'}</td>` +
        `<td>${esc(l.description)}</td><td class="num">${esc(formatMoney(l.amount, l.currency))}</td></tr>`,
    )
    .join('');
  return `<section><h2>${esc(title)}</h2><table class="lines"><colgroup><col class="c-date"><col class="c-program"><col><col class="c-amount"></colgroup><thead><tr><th class="date">Date</th><th>Program</th><th>${esc(kind)}</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

const STYLE = `
*{box-sizing:border-box}
html{background:#f3f4f6}
body{margin:0;color:#111827;font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Helvetica Neue",Arial,sans-serif}
.sheet{max-width:820px;margin:24px auto;background:#fff;padding:40px 44px;border:1px solid #e5e7eb;border-radius:8px}
.hint{max-width:820px;margin:16px auto 0;padding:0 4px;color:#6b7280;font-size:12px}
header.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:2px solid #111827;padding-bottom:18px}
.issuer img{max-height:48px;max-width:200px;display:block;margin-bottom:10px}
.issuer .name{font-size:16px;font-weight:700}
.issuer .addr,.muted{color:#4b5563}
.doc{text-align:right}
h1{font-size:20px;margin:0 0 8px;letter-spacing:.01em}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#4b5563;margin:26px 0 8px}
dl{margin:0;display:grid;grid-template-columns:auto auto;gap:2px 14px}
.doc dl{justify-content:end}
dt{color:#6b7280}
dd{margin:0;font-weight:500;overflow-wrap:anywhere}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.parties dl{grid-template-columns:max-content 1fr}
.note{margin-top:22px;padding:10px 12px;border:1px solid #f59e0b;background:#fffbeb;border-radius:6px}
.note p{margin:0}
.note p+p{margin-top:4px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:600}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.date{white-space:nowrap}
table.lines{table-layout:fixed}
.lines td{overflow-wrap:break-word}
.c-date{width:96px}.c-program{width:26%}.c-amount{width:140px}
tr{break-inside:avoid}
.totals td{border-bottom:none;padding:3px 8px}
.totals tr.net td{border-top:1px solid #111827;font-weight:700;padding-top:6px}
.totals tr.paid td{font-size:15px;font-weight:700;padding-top:10px}
.totals .label{text-align:right;color:#374151}
.small{font-size:11px}
footer{margin-top:32px;padding-top:12px;border-top:1px solid #e5e7eb;color:#4b5563;font-size:11.5px}
footer .custom{color:#111827;font-size:12px;margin-bottom:8px}
@page{size:A4;margin:14mm}
@media print{html{background:#fff}.sheet{margin:0;max-width:none;border:none;border-radius:0;padding:0}.hint{display:none}.note{background:none}}
@media (max-width:640px){.sheet{margin:0;border:none;border-radius:0;padding:20px 16px}header.top,.parties{display:block}.doc{text-align:left;margin-top:16px}.doc dl{justify-content:start}}
`;

/** The statement as a printable page. Every value from the database is
 *  escaped; the page has no script. */
export function renderStatementHtml(s: PayoutStatement): string {
  const logo = logoSrc(s.issuer.logoUrl);
  const issuer = [
    logo ? `<img src="${esc(logo)}" alt="">` : '',
    `<div class="name">${esc(s.issuer.name)}</div>`,
    s.issuer.tradingName ? `<div class="muted">${esc(s.issuer.tradingName)}</div>` : '',
    s.issuer.address ? `<div class="addr">${multiline(s.issuer.address)}</div>` : '',
    s.issuer.gstin ? `<div>GSTIN: ${esc(s.issuer.gstin)}</div>` : '',
  ].join('');

  const status = STATUS_LABEL[s.payout.status] ?? s.payout.status;
  const dd = (label: string, value: string | null, raw = false) =>
    value ? `<dt>${esc(label)}</dt><dd>${raw ? value : esc(value)}</dd>` : '';

  const partner = [
    dd('Name', s.partner.name ?? 'Partner record removed'),
    dd('Email', s.partner.email),
    dd('Partner ID', s.partner.id),
    dd(
      'Paid to',
      s.partner.destination
        ? esc(s.partner.destination) +
            (s.partner.destinationChanged ? '<div class="muted small">Details on file now; they changed after this payout.</div>' : '')
        : '<span class="muted">No payout details on file</span>',
      true,
    ),
  ].join('');

  const payout = [
    dd('Payout ID', s.payout.id),
    dd('Method', s.payout.methodLabel),
    s.payout.reference ? dd(s.payout.reference.label, s.payout.reference.value) : '',
    dd('Created', day(s.payout.createdAt)),
    dd(s.payout.status === 'pending' || s.payout.status === 'failed' ? 'Completed' : 'Paid', s.payout.completedAt ? day(s.payout.completedAt) : '—'),
  ].join('');

  const notes = s.notes.length > 0 ? `<div class="note">${s.notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>` : '';

  const taxLines =
    s.taxLines.length > 0
      ? `<section><h2>Tax</h2><table><tbody>${s.taxLines
          .map(
            (t) =>
              `<tr><td>${esc(t.label)}</td><td class="num">${t.amount === null ? '<span class="muted">Not recorded</span>' : esc(formatMoney(t.amount, t.currency))}</td></tr>`,
          )
          .join('')}</tbody></table></section>`
      : '';

  const totalRows = s.totals
    .map((t) => {
      const cur = s.totals.length > 1 ? ` (${esc(t.currency)})` : '';
      const row = (label: string, amount: string, cls = '') =>
        `<tr class="${cls}"><td class="label">${esc(label)}${cur}</td><td class="num">${esc(formatMoney(amount, t.currency))}</td></tr>`;
      return [
        Number(t.commissions) !== 0 || Number(t.bonuses) === 0 ? row('Commissions', t.commissions) : '',
        Number(t.bonuses) !== 0 ? row('Bonuses', t.bonuses) : '',
        Number(t.clawbacks) !== 0 ? row('Refund clawbacks', t.clawbacks) : '',
        row('Net', t.net, 'net'),
      ].join('');
    })
    .join('');
  const reversed = s.reversals.reduce((sum, r) => sum + cents(r.amount), 0);
  // A failed payout's note says what is known about it; the label doesn't guess.
  const paidLabel = s.payout.status === 'pending' ? 'Amount to be paid' : s.payout.status === 'failed' ? 'Payout amount' : 'Amount paid';
  const totals =
    `<section class="totals"><h2>Totals</h2><table><tbody>${totalRows}` +
    `<tr class="paid"><td class="label">${paidLabel}</td><td class="num">${esc(formatMoney(s.payout.amount, s.payout.currency))}</td></tr>` +
    (reversed !== 0
      ? `<tr><td class="label">Reversed after payment</td><td class="num">${esc(formatMoney(major(reversed), s.payout.currency))}</td></tr>` +
        `<tr class="net"><td class="label">Kept after reversals</td><td class="num">${esc(formatMoney(major(cents(s.payout.amount) + reversed), s.payout.currency))}</td></tr>`
      : '') +
    `</tbody></table></section>`;

  const empty =
    s.commissions.length + s.bonuses.length + s.clawbacks.length === 0
      ? '<section><h2>Line items</h2><p class="muted">No commissions are recorded on this payout.</p></section>'
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${esc(STATEMENT_CSP)}">
<meta name="robots" content="noindex">
<title>Payout statement ${esc(s.statementNumber)}</title>
<style>${STYLE}</style>
</head>
<body>
<p class="hint">To keep a PDF, print this page and choose “Save as PDF”.</p>
<main class="sheet">
<header class="top">
<div class="issuer">${issuer}</div>
<div class="doc"><h1>Payout statement</h1><dl>${dd('Statement no.', s.statementNumber)}${dd('Date', day(s.payout.completedAt ?? s.payout.createdAt))}${dd('Status', status)}</dl></div>
</header>
<div class="parties">
<section><h2>Partner</h2><dl>${partner}</dl></section>
<section><h2>Payout</h2><dl>${payout}</dl></section>
</div>
${notes}
${linesTable('Commissions', 'Earned on', s.commissions)}
${linesTable('Bonuses', 'Bonus', s.bonuses)}
${linesTable('Deductions', 'Deduction', s.clawbacks)}
${linesTable('Reversed after payment', 'Reversal', s.reversals)}
${empty}
${taxLines}
${totals}
<footer>
${s.footer ? `<div class="custom">${multiline(s.footer)}</div>` : ''}
<div>This statement records a payment to a partner. It is not a tax invoice. Dates are in UTC. Generated ${esc(day(s.generatedAt))}.</div>
</footer>
</main>
</body>
</html>
`;
}
