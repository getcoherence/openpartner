/**
 * The hosted platform fee's billable basis, and the ledger of what has been
 * billed against it (UsageLedger, migration 20261017010000_usage_ledger).
 *
 * Billable basis of a conversion, as of now:
 *
 *   - It must be a revenue event (a type in the billable set, never a
 *     refund, chargeback, dispute or failed payment) with at least one
 *     Attribution: a partner was credited for it.
 *   - Its value, less what has been refunded of it. Partial refunds count in
 *     proportion. Refunds come from the raw refund Events:
 *       * POST /attribution/refunds records `refund` / `chargeback` Events
 *         naming the conversion in metadata.conversionEventId, each with
 *         its own NEGATIVE amount as value (null = a full refund of a
 *         value-less conversion). They add up.
 *       * The self-host Stripe webhook records `charge.refunded` as a
 *         `refund` Event matched to the invoice_paid conversion by
 *         metadata.stripeInvoiceId / stripePaymentIntentId, carrying the
 *         charge's CUMULATIVE amountRefunded and chargeCollected (minor
 *         units) and fullRefund. The largest share reported wins.
 *     When both report a refund of one conversion, the larger share wins
 *     (refunds.ts reapplyRecordedRefunds measures it the same way).
 *   - Zero once every commission it earned has been reversed: a full
 *     refund, a chargeback, or an admin reverse (for fraud, a self-referral,
 *     a partner terms breach). No partner keeps credit for it, so it is no
 *     longer attributed revenue, and the affiliate-network norm is that a
 *     declined action carries no network fee. A conversion that never
 *     earned a commission row (no matching rule) stays billable: the
 *     attribution still happened.
 *   - A Stripe dispute (`dispute_created`) alone doesn't change anything: a
 *     dispute can be won. It leaves the basis once the brand reverses the
 *     commission or reports a chargeback.
 *
 * Commission status is NOT the refund signal. A paid commission stays
 * `paid` after a refund (it gets a refund_clawback adjustment), and one in
 * a payout in flight is left live until the refund is retried; the refund
 * Events are what say how much of the revenue was given back.
 *
 * Every report diffs each conversion's basis against the sum of its ledger
 * rows and records the difference: positive rows bill new (or newly
 * attributed) revenue, negative rows credit revenue that was refunded or
 * reversed after it was billed. The diff doesn't care when an event
 * happened, so a refund recorded weeks later, a backdated event, or an
 * event attributed late by a backlog replay all land in the next report.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES } from '@openpartner/db';
import { CONFIG_KEYS, getConfig, setConfig } from './config.js';
import { convertToUsd, METER_CURRENCY, type FxSnapshot } from './fx.js';
import type { AmountsByCurrency } from './usage-billing.js';

/** Event types that correct a conversion rather than being one. Never
 *  billable, whatever the billable set says. Mirrors the webhook's
 *  CORRECTIVE_EVENT_TYPES, plus the API's `chargeback`. */
const CORRECTIVE_TYPES = ['refund', 'chargeback', 'dispute_created', 'invoice_payment_failed'];
/** Types POST /attribution/refunds records against a named conversion. */
const API_REFUND_TYPES = ['refund', 'chargeback'];

export type LedgerReason = 'opening' | 'billed' | 'refunded' | 'reversed' | 'removed';

export interface LedgerEntry {
  eventId: string;
  currency: string;
  /** Signed, in the conversion's currency. */
  amount: number;
  /** Null: no published rate, held out of the meter. */
  usdPerUnit: number | null;
  amountUsd: number;
  reason: LedgerReason;
}

/** A conversion whose basis differs from what has been billed for it. */
export interface LedgerDelta {
  eventId: string;
  currency: string;
  target: number;
  billed: number;
  billedUsd: number;
  /** No longer a billable conversion at all (attribution gone, type no
   *  longer in the billable set). */
  gone: boolean;
  reversed: boolean;
  refunded: boolean;
}

export interface PricedRun {
  entries: LedgerEntry[];
  /** New billable GMV, per currency (positive). */
  gmvByCurrency: AmountsByCurrency;
  /** Refunded or reversed GMV credited back, per currency (negative). */
  creditsByCurrency: AmountsByCurrency;
  /** Rates the new GMV was converted at, when any of it wasn't USD. */
  fx?: FxSnapshot;
  /** New GMV in currencies with no published rate: not metered. */
  heldOut: AmountsByCurrency;
  /** Sum of the entries' amountUsd, before carry and rounding. */
  usd: number;
  /** The credit part of `usd` (≤ 0). */
  creditUsd: number;
}

interface BasisOptions {
  /** Null: rely on the caller's tenant scope (RLS GUC). */
  tenantId: string | null;
  eventTypes: string[];
  until: Date;
  since?: Date | null;
  /** Only conversions first attributed at or before this time. */
  attributedBy?: Date;
}

/** A refund Event's share of its Stripe charge, 0..1. Nested CASEs, because
 *  SQL doesn't promise to evaluate AND operands in order and the casts must
 *  only see numbers. */
const STRIPE_SHARE = `case
    when r.metadata->>'fullRefund' = 'true' then 1
    when coalesce(jsonb_typeof(r.metadata->'amountRefunded'), '') <> 'number'
      or coalesce(jsonb_typeof(r.metadata->'chargeCollected'), '') <> 'number' then 0
    when (r.metadata->>'chargeCollected')::numeric <= 0 then 0
    else least(1, greatest(0, (r.metadata->>'amountRefunded')::numeric / (r.metadata->>'chargeCollected')::numeric))
  end`;

/**
 * One row per billable conversion: eventId, currency, its refund and
 * reversal state, and `basis` (numeric, 2 dp).
 */
function basisSql(o: BasisOptions): { sql: string; bindings: Knex.RawBinding[] } {
  const bindings: Knex.RawBinding[] = [];
  // Placeholders are emitted in text order, so bindings line up.
  const p = (v: Knex.RawBinding) => {
    bindings.push(v);
    return '?';
  };
  const tenant = (alias: string) => (o.tenantId ? ` and ${alias}."tenantId" = ${p(o.tenantId)}` : '');
  const stripeShareBy = (key: 'stripeInvoiceId' | 'stripePaymentIntentId') => `(
      select r.metadata->>'${key}' as k, max(${STRIPE_SHARE}) as share
      from "Event" r
      where r.type = 'refund'
        and r.metadata->>'conversionEventId' is null
        and r.metadata->>'${key}' is not null${tenant('r')}
      group by 1
    )`;

  const sql = `
    select x.*,
      case
        when x.gross is null or x.gross <= 0 or x.reversed or x."apiNullRefund" then 0
        else greatest(0, round(least(x.gross - x."apiRefunded", x.gross * (1 - x."stripeShare")), 2))
      end as basis
    from (
      select
        e.id as "eventId",
        upper(coalesce(e.currency, 'USD')) as currency,
        e.value as gross,
        coalesce(api.refunded, 0) as "apiRefunded",
        coalesce(api."nullRefund", false) as "apiNullRefund",
        case when e.type = 'invoice_paid' then greatest(coalesce(inv.share, 0), coalesce(pi.share, 0)) else 0 end
          as "stripeShare",
        coalesce(cm.n, 0) > 0 and coalesce(cm.live, 0) = 0 as reversed
      from "Event" e
      left join (
        select r.metadata->>'conversionEventId' as id,
          sum(greatest(-coalesce(r.value, 0), 0)) as refunded,
          bool_or(r.value is null) as "nullRefund"
        from "Event" r
        where r.type = any(${p(API_REFUND_TYPES)}::text[])
          and r.metadata->>'conversionEventId' is not null${tenant('r')}
        group by 1
      ) api on api.id = e.id
      left join ${stripeShareBy('stripeInvoiceId')} inv on inv.k = e.metadata->>'stripeInvoiceId'
      left join ${stripeShareBy('stripePaymentIntentId')} pi on pi.k = e.metadata->>'stripePaymentIntentId'
      left join (
        select a."eventId",
          count(c.id) as n,
          count(c.id) filter (where c.status <> 'reversed') as live
        from "Attribution" a
        join "Commission" c on c."attributionId" = a.id
        where true${tenant('a')}
        group by a."eventId"
      ) cm on cm."eventId" = e.id
      where e.type = any(${p(o.eventTypes)}::text[])
        and not (e.type = any(${p(CORRECTIVE_TYPES)}::text[]))
        and e.ts <= ${p(o.until)}${o.since ? ` and e.ts > ${p(o.since)}` : ''}${tenant('e')}
        and exists (select 1 from "Attribution" a where a."eventId" = e.id)${
          o.attributedBy
            ? ` and (select min(a."computedAt") from "Attribution" a where a."eventId" = e.id) <= ${p(o.attributedBy)}`
            : ''
        }
    ) x`;
  return { sql, bindings };
}

/**
 * Billable basis per currency for conversions with `since < ts <= until`.
 * Tenant scope comes from the caller.
 */
export async function sumBillableBasis(
  db: Knex,
  since: Date | null,
  until: Date,
  eventTypes: string[],
): Promise<AmountsByCurrency> {
  const { sql, bindings } = basisSql({ tenantId: null, eventTypes, until, since });
  const res = (await db.raw(`select currency, sum(basis) as total from (${sql}) b group by currency`, bindings)) as {
    rows: Array<{ currency: string; total: string | null }>;
  };
  const out: AmountsByCurrency = {};
  for (const r of res.rows) {
    const total = Number(r.total ?? 0);
    if (total !== 0) out[r.currency] = total;
  }
  return out;
}

/** Every conversion whose basis differs from what its ledger rows add up to. */
export async function ledgerDeltas(
  db: Knex,
  tenantId: string,
  until: Date,
  eventTypes: string[],
): Promise<LedgerDelta[]> {
  const { sql, bindings } = basisSql({ tenantId, eventTypes, until });
  const res = (await db.raw(
    `with b as (${sql}),
    l as (
      select "eventId", currency, sum(amount) as amount, sum("amountUsd") as usd
      from "UsageLedger"
      where "tenantId" = ?
      group by "eventId", currency
    )
    select
      coalesce(b."eventId", l."eventId") as "eventId",
      coalesce(b.currency, l.currency) as currency,
      coalesce(b.basis, 0) as target,
      coalesce(l.amount, 0) as billed,
      coalesce(l.usd, 0) as "billedUsd",
      b."eventId" is null as gone,
      coalesce(b.reversed, false) as reversed,
      coalesce(b."apiRefunded" > 0 or b."apiNullRefund" or b."stripeShare" > 0, false) as refunded
    from b
    full outer join l on l."eventId" = b."eventId" and l.currency = b.currency
    where coalesce(b.basis, 0) <> coalesce(l.amount, 0)
    order by 1, 2`,
    [...bindings, tenantId],
  )) as {
    rows: Array<{
      eventId: string;
      currency: string;
      target: string;
      billed: string;
      billedUsd: string;
      gone: boolean;
      reversed: boolean;
      refunded: boolean;
    }>;
  };
  return res.rows.map((r) => ({
    eventId: r.eventId,
    currency: r.currency,
    target: Number(r.target),
    billed: Number(r.billed),
    billedUsd: Number(r.billedUsd),
    gone: r.gone,
    reversed: r.reversed,
    refunded: r.refunded,
  }));
}

/**
 * Turn deltas into ledger entries. New GMV is converted at today's ECB rate
 * (convertToUsd, which throws FxUnavailableError when it needs the feed and
 * can't read it). A credit is converted at the rate its conversion was
 * billed at, so it never needs the feed, and a full refund nets the
 * conversion's USD to exactly zero.
 */
export async function priceDeltas(deltas: LedgerDelta[]): Promise<PricedRun> {
  const { gmvByCurrency, creditsByCurrency } = deltaTotals(deltas);
  const amounts = deltas.map(deltaAmount);

  const conversion = Object.keys(gmvByCurrency).length > 0 ? await convertToUsd(gmvByCurrency) : null;
  const rateFor = (currency: string): number | null =>
    currency === METER_CURRENCY ? 1 : conversion?.fx?.usdPerUnit[currency] ?? null;

  const entries: LedgerEntry[] = [];
  let usd = 0;
  let creditUsd = 0;
  deltas.forEach((d, i) => {
    const amount = amounts[i]!;
    if (amount === 0) return;
    let usdPerUnit: number | null;
    let amountUsd: number;
    if (amount > 0) {
      usdPerUnit = rateFor(d.currency);
      amountUsd = usdPerUnit === null ? 0 : round6(amount * usdPerUnit);
    } else if (d.billed !== 0 && d.billedUsd !== 0) {
      usdPerUnit = d.billedUsd / d.billed;
      amountUsd = round6((d.billedUsd * amount) / d.billed);
      creditUsd += amountUsd;
    } else {
      // Its billing was held out (no rate), so there's no USD to give back.
      usdPerUnit = null;
      amountUsd = 0;
    }
    usd += amountUsd;
    entries.push({
      eventId: d.eventId,
      currency: d.currency,
      amount,
      usdPerUnit: usdPerUnit === null ? null : round12(usdPerUnit),
      amountUsd,
      // A refund usually reverses the commissions too; it's the cause, so
      // it names the row.
      reason: amount > 0 ? 'billed' : d.gone ? 'removed' : d.refunded ? 'refunded' : d.reversed ? 'reversed' : 'removed',
    });
  });

  return {
    entries,
    gmvByCurrency,
    creditsByCurrency,
    ...(conversion?.fx ? { fx: conversion.fx } : {}),
    heldOut: conversion?.heldOut ?? {},
    usd: round6(usd),
    creditUsd: round6(creditUsd),
  };
}

/** Signed amount a delta bills (positive) or credits (negative). */
function deltaAmount(d: LedgerDelta): number {
  return (toCents(d.target) - toCents(d.billed)) / 100;
}

/** New GMV and credits, per currency. */
export function deltaTotals(deltas: LedgerDelta[]): {
  gmvByCurrency: AmountsByCurrency;
  creditsByCurrency: AmountsByCurrency;
} {
  const gmvByCurrency: AmountsByCurrency = {};
  const creditsByCurrency: AmountsByCurrency = {};
  for (const d of deltas) {
    const amount = deltaAmount(d);
    if (amount === 0) continue;
    const bucket = amount > 0 ? gmvByCurrency : creditsByCurrency;
    bucket[d.currency] = (toCents(bucket[d.currency] ?? 0) + toCents(amount)) / 100;
  }
  return { gmvByCurrency, creditsByCurrency };
}

export async function insertLedgerEntries(
  db: Knex,
  tenantId: string,
  reportKey: string,
  entries: LedgerEntry[],
): Promise<void> {
  const createdAt = new Date();
  // 9 columns a row: well under Postgres's 65535-parameter cap.
  for (let i = 0; i < entries.length; i += 1000) {
    await db(TABLES.UsageLedger).insert(
      entries.slice(i, i + 1000).map((e) => ({
        id: ulid(),
        tenantId,
        eventId: e.eventId,
        reportKey,
        reason: e.reason,
        currency: e.currency,
        amount: e.amount.toFixed(2),
        usdPerUnit: e.usdPerUnit === null ? null : e.usdPerUnit.toFixed(12),
        amountUsd: e.amountUsd.toFixed(6),
        createdAt,
      })),
    );
  }
}

/**
 * Open the ledger for a tenant that was reporting usage before it existed.
 *
 * The old reporter billed every attributed revenue event up to its last
 * report (`cutoff`) at full value. Those events get an `opening` row for
 * their basis TODAY, so the ledger starts from what is billable now: refunds
 * and reversals recorded before the cutover are not credited automatically
 * (they're reconciled by hand, once), while anything that changes from now
 * on is. Events first attributed after the last report never were billed,
 * so they get no opening row and the first report bills them.
 *
 * Opening rows take today's rate: the old reporter's rate for a non-USD
 * event isn't recorded anywhere. Production had no non-USD billable events
 * at cutover.
 *
 * Idempotent: marked done in Config, and skipped for a tenant that already
 * has ledger rows.
 */
export async function openLedger(
  db: Knex,
  tenantId: string,
  cutoff: Date | null,
  eventTypes: string[],
): Promise<number> {
  if (await getConfig<string>(db, tenantId, CONFIG_KEYS.UsageLedgerOpenedAt)) return 0;
  const existing = await db(TABLES.UsageLedger).where({ tenantId }).first('id');
  let entries: LedgerEntry[] = [];
  if (cutoff && !existing) {
    const { sql, bindings } = basisSql({ tenantId, eventTypes, until: cutoff, attributedBy: cutoff });
    const res = (await db.raw(`select "eventId", currency, basis from (${sql}) b where basis > 0 order by 1`, bindings)) as {
      rows: Array<{ eventId: string; currency: string; basis: string }>;
    };
    const totals: AmountsByCurrency = {};
    for (const r of res.rows) totals[r.currency] = (toCents(totals[r.currency] ?? 0) + toCents(Number(r.basis))) / 100;
    const conversion = res.rows.length > 0 ? await convertToUsd(totals) : null;
    entries = res.rows.map((r) => {
      const amount = Number(r.basis);
      const usdPerUnit = r.currency === METER_CURRENCY ? 1 : conversion?.fx?.usdPerUnit[r.currency] ?? null;
      return {
        eventId: r.eventId,
        currency: r.currency,
        amount,
        usdPerUnit: usdPerUnit === null ? null : round12(usdPerUnit),
        amountUsd: usdPerUnit === null ? 0 : round6(amount * usdPerUnit),
        reason: 'opening' as const,
      };
    });
  }
  await insertLedgerEntries(db, tenantId, `op-usage-opening-${tenantId}`, entries);
  await setConfig(db, tenantId, CONFIG_KEYS.UsageLedgerOpenedAt, new Date().toISOString());
  return entries.length;
}

function toCents(n: number): number {
  return Math.round(n * 100);
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function round12(n: number): number {
  return Math.round(n * 1e12) / 1e12;
}
