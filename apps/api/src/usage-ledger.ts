/**
 * The hosted platform fee's billable basis, and the ledger of what has been
 * billed against it (UsageLedger, migrations 20261017010000_usage_ledger and
 * 20261017020000_platform_fee_rule). docs/platform-fee.md is the reference.
 *
 * Every attributed conversion (a non-corrective event with at least one
 * Attribution: a partner was credited) has two amounts, as of now:
 *
 *   revenue      Its value, when it counts as revenue (below), less what
 *                has been refunded of it. Partial refunds count in
 *                proportion. Refunds come from the raw refund Events:
 *                  * POST /attribution/refunds records `refund` /
 *                    `chargeback` Events naming the conversion in
 *                    metadata.conversionEventId, each with its own NEGATIVE
 *                    amount as value (null = a full refund of a value-less
 *                    conversion). They add up.
 *                  * The self-host Stripe webhook records `charge.refunded`
 *                    as a `refund` Event matched to the invoice_paid
 *                    conversion by metadata.stripeInvoiceId /
 *                    stripePaymentIntentId, carrying the charge's CUMULATIVE
 *                    amountRefunded and chargeCollected (minor units) and
 *                    fullRefund. The largest share reported wins.
 *                When both report a refund of one conversion, the larger
 *                share wins (refunds.ts reapplyRecordedRefunds measures it
 *                the same way).
 *
 *                A refund only takes revenue out as far as the partner lost
 *                commission on it too: a conversion that earned commission
 *                keeps at least the share of its value the partner still
 *                holds commission on (live commissions net of refund
 *                clawbacks, over what was first credited). Otherwise a brand
 *                could report refunds it never reversed commissions for and
 *                cut its fee while the partner kept the money.
 *
 *   commissions  What the partner holds on it: its live (not reversed)
 *                Commission amounts, every touch, net of refund_clawback
 *                adjustments.
 *
 * Both are zero once every commission it earned has been reversed: a full
 * refund, a chargeback, or an admin reverse (fraud, a self-referral, a
 * terms breach). No partner keeps credit for it, so it is no longer
 * attributed revenue, and the affiliate-network norm is that a declined
 * action carries no network fee. A Stripe dispute (`dispute_created`) alone
 * changes nothing: a dispute can be won.
 *
 * Commission status is NOT the refund signal. A paid commission stays
 * `paid` after a refund (it gets a refund_clawback adjustment), and one in
 * a payout in flight is left live until the refund is retried; the refund
 * Events say how much of the revenue was given back, the commissions say
 * how much of that the partner gave back with it.
 *
 * What it bills, by rule (FeeTerms.v):
 *
 *   1 (old)  revenue, for invoice_paid / subscription_created and the types
 *            its program declares (Program.revenueEventTypes); 0 otherwise.
 *   2 (new)  max(revenueRate × revenue, commissionRate × commissions) /
 *            meterRate, where revenue counts when the type is one of
 *            those, OR the conversion paid a PERCENT commission: you can't
 *            pay a percentage of something that isn't an amount, so
 *            renaming a sale doesn't take it off the revenue basis.
 *            Dividing the fee by the metered price's per-unit rate puts it
 *            in revenue-equivalent units, so the one meter and its
 *            existing prices bill exactly the fee.
 *
 * A conversion is on rule 2 when it was first attributed at or after its
 * tenant's effective date (fee-terms.ts). The terms it was first billed
 * under are frozen on its ledger rows, so a later rate change, a program
 * declaring or dropping a revenue type, or a moved effective date never
 * re-bills or credits a conversion already billed.
 *
 * Every report diffs each conversion's basis against the sum of its ledger
 * rows and records the difference: positive rows bill new (or newly
 * attributed) usage, negative rows credit usage refunded or reversed after
 * it was billed. The diff doesn't care when the event happened, so a refund
 * recorded weeks later, a backdated event, or an event attributed late by a
 * backlog replay all land in the next report. A conversion with no ledger
 * rows is only picked up when it was first attributed after the previous
 * report (less a day's grace for transactions that committed late): one
 * that was worth nothing then isn't billed later because a setting changed.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES } from '@openpartner/db';
import { CONFIG_KEYS, getConfig, setConfig } from './config.js';
import { convertToUsd, METER_CURRENCY, type FxSnapshot } from './fx.js';
import type { AmountsByCurrency } from './usage-billing.js';

/** Event types that correct a conversion rather than being one. Never
 *  billable. Mirrors the webhook's CORRECTIVE_EVENT_TYPES, plus the API's
 *  `chargeback`. */
const CORRECTIVE_TYPES = ['refund', 'chargeback', 'dispute_created', 'invoice_payment_failed'];
/** Types POST /attribution/refunds records against a named conversion. */
const API_REFUND_TYPES = ['refund', 'chargeback'];
/** Stripe-native revenue events: revenue whatever the program says. */
export const DEFAULT_REVENUE_EVENT_TYPES = ['invoice_paid', 'subscription_created'];
/** A conversion first attributed this long before the previous report,
 *  with no ledger rows, is still picked up: its transaction may have
 *  committed after that report read. */
export const LATE_COMMIT_GRACE_MS = 24 * 60 * 60 * 1000;

export type LedgerReason = 'opening' | 'billed' | 'refunded' | 'reversed' | 'removed';

/** The terms a conversion is billed under, frozen on its ledger rows. */
export type FeeTerms =
  | { v: 1; rev: boolean }
  | {
      v: 2;
      rev: boolean;
      /** Revenue rate, commission rate, the meter's per-unit price. */
      rr: number;
      cr: number;
      mr: number;
    };

/** What a tenant's new conversions are billed under (fee-terms.ts). */
export interface FeeContext {
  revenueRate: number;
  commissionRate: number;
  /** USD the metered price charges per unit of basis (0.03 = 3¢). */
  meterRate: number;
  /** Conversions first attributed at or after this are on rule 2. Null:
   *  rule 1 for everything. */
  effectiveAt: Date | null;
}

/** Rule 1 for everything: the old reporter's basis. */
export const OLD_RULE: FeeContext = { revenueRate: 0, commissionRate: 0, meterRate: 1, effectiveAt: null };

export interface LedgerEntry {
  eventId: string;
  currency: string;
  /** Signed, in the conversion's currency. */
  amount: number;
  /** Null: no published rate, held out of the meter. */
  usdPerUnit: number | null;
  amountUsd: number;
  reason: LedgerReason;
  terms: FeeTerms | null;
}

/** A conversion whose basis differs from what has been billed for it. */
export interface LedgerDelta {
  eventId: string;
  currency: string;
  target: number;
  billed: number;
  billedUsd: number;
  /** No longer a billable conversion at all (attribution gone). */
  gone: boolean;
  reversed: boolean;
  refunded: boolean;
  /** The terms `target` was computed under; null when gone. */
  terms: FeeTerms | null;
}

export interface PricedRun {
  entries: LedgerEntry[];
  /** New billable basis, per currency (positive). */
  gmvByCurrency: AmountsByCurrency;
  /** Refunded or reversed basis credited back, per currency (negative). */
  creditsByCurrency: AmountsByCurrency;
  /** Rates the new basis was converted at, when any of it wasn't USD. */
  fx?: FxSnapshot;
  /** New basis in currencies with no published rate: not metered. */
  heldOut: AmountsByCurrency;
  /** Sum of the entries' amountUsd, before carry and rounding. */
  usd: number;
  /** The credit part of `usd` (≤ 0). */
  creditUsd: number;
  /** The part of `usd` from conversions on rule 2. */
  newRuleUsd: number;
}

interface ConversionOptions {
  /** Null: rely on the caller's tenant scope (RLS GUC). */
  tenantId: string | null;
  until: Date;
  /** Event time window (`since < ts`). */
  since?: Date | null;
  /** First-attribution window (`attributedAfter < first ≤ attributedBy`). */
  attributedAfter?: Date | null;
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
 * A commission paid at a percentage. Accruals stamp metadata.rateType
 * (commission-slabs.ts commissionMetadata); for rows from before that, and
 * replacements a partial refund accrued, the program's rule decides: a
 * percent sub-rule that matches the event's type.
 */
const PERCENT_COMMISSION = `coalesce(
    c.metadata->>'rateType' = 'percent',
    exists (
      select 1
      from jsonb_array_elements(
        case jsonb_typeof(p."commissionRule")
          when 'array' then p."commissionRule"
          when 'object' then jsonb_build_array(p."commissionRule")
          else '[]'::jsonb
        end
      ) sr
      where sr->>'type' = 'percent' and (sr->>'eventType' is null or sr->>'eventType' = e.type)
    )
  )`;

/**
 * One row per attributed conversion:
 *
 *   eventId, currency, type, firstAttributedAt
 *   declared    revenue by type: the defaults or its program's declaration
 *   percent     paid a percent commission
 *   reversed    earned commission and all of it is reversed
 *   refunded    has a refund recorded against it
 *   revenue     value kept after refunds (the commission guard applied),
 *               whether or not it counts as revenue
 *   commissions what the partner holds on it
 *
 * Amounts are numeric in the conversion's currency, unrounded.
 */
export function conversionSql(o: ConversionOptions): { sql: string; bindings: Knex.RawBinding[] } {
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
    select x."eventId", x.currency, x.type, x."firstAttributedAt", x.declared, x.percent, x.reversed,
      (x."apiRefunded" > 0 or x."apiNullRefund" or x."stripeShare" > 0) as refunded,
      case
        when x.reversed or x.gross is null or x.gross <= 0 or x."apiNullRefund" then 0
        -- The partner holds more commission than the refund left them (half
        -- a cent a row of slack: a prorated replacement is rounded to the
        -- cent): only the share they gave back comes off.
        when x.credited > 0 and x.kept > x.credited * x."refundKept" / x.gross + 0.005 * x.n
          then least(x.gross, x.gross * x.kept / x.credited)
        else x."refundKept"
      end as revenue,
      case when x.reversed then 0 else greatest(0, x.kept) end as commissions
    from (
      select y.*,
        case
          when y.gross is null or y.gross <= 0 then 0
          else greatest(0, least(y.gross - y."apiRefunded", y.gross * (1 - y."stripeShare")))
        end as "refundKept"
      from (
        select
          e.id as "eventId",
          upper(coalesce(e.currency, 'USD')) as currency,
          e.type,
          e.value as gross,
          fa.first as "firstAttributedAt",
          (e.type = any(${p(DEFAULT_REVENUE_EVENT_TYPES)}::text[]) or exists (
            select 1 from "Attribution" da join "Program" dp on dp.id = da."programId"
            where da."eventId" = e.id and e.type = any(dp."revenueEventTypes")
          )) as declared,
          coalesce(api.refunded, 0) as "apiRefunded",
          coalesce(api."nullRefund", false) as "apiNullRefund",
          case when e.type = 'invoice_paid' then greatest(coalesce(inv.share, 0), coalesce(pi.share, 0)) else 0 end
            as "stripeShare",
          coalesce(cm.n, 0) > 0 and coalesce(cm.live, 0) = 0 as reversed,
          coalesce(cm.n, 0) as n,
          coalesce(cm.credited, 0) as credited,
          coalesce(cm.kept, 0) as kept,
          coalesce(cm.percent, false) as percent
        from "Event" e
        join (
          select a."eventId", min(a."computedAt") as first
          from "Attribution" a
          where true${tenant('a')}
          group by a."eventId"
        ) fa on fa."eventId" = e.id
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
        left join lateral (
          select
            count(c.id) as n,
            count(c.id) filter (where c.status <> 'reversed') as live,
            coalesce(sum(c.amount) filter (where c.metadata->'refund'->>'rootCommissionId' is null), 0) as credited,
            coalesce(sum(c.amount) filter (where c.status <> 'reversed'), 0)
              + coalesce(sum(adj.clawback) filter (where c.status <> 'reversed'), 0) as kept,
            bool_or(${PERCENT_COMMISSION}) as percent
          from "Attribution" a
          join "Commission" c on c."attributionId" = a.id
          join "Program" p on p.id = a."programId"
          left join (
            select ca."commissionId", sum(ca.amount) as clawback
            from "CommissionAdjustment" ca
            where ca.reason = 'refund_clawback'
            group by ca."commissionId"
          ) adj on adj."commissionId" = c.id
          where a."eventId" = e.id
        ) cm on true
        where not (e.type = any(${p(CORRECTIVE_TYPES)}::text[]))
          and e.ts <= ${p(o.until)}${o.since ? ` and e.ts > ${p(o.since)}` : ''}${tenant('e')}${
            o.attributedAfter ? ` and fa.first > ${p(o.attributedAfter)}` : ''
          }${o.attributedBy ? ` and fa.first <= ${p(o.attributedBy)}` : ''}
      ) y
    ) x`;
  return { sql, bindings };
}

/** Rule 1's basis of a conversionSql row `v`, 2 dp. */
const RULE1_BASIS = (v: string) => `round(case when ${v}.declared then ${v}.revenue else 0 end, 2)`;

/**
 * Rule-1 basis per currency for conversions with `since < ts <= until`.
 * Filtered on `tenantId` explicitly as well as by the caller's GUC, so a pool
 * that bypasses RLS can't sum another tenant's GMV.
 */
export async function sumBillableBasis(
  db: Knex,
  tenantId: string,
  since: Date | null,
  until: Date,
): Promise<AmountsByCurrency> {
  const { sql, bindings } = conversionSql({ tenantId, until, since });
  const res = (await db.raw(
    `select v.currency, sum(${RULE1_BASIS('v')}) as total from (${sql}) v group by v.currency`,
    bindings,
  )) as { rows: Array<{ currency: string; total: string | null }> };
  const out: AmountsByCurrency = {};
  for (const r of res.rows) {
    const total = Number(r.total ?? 0);
    if (total !== 0) out[r.currency] = total;
  }
  return out;
}

/**
 * Every conversion whose basis differs from what its ledger rows add up to.
 * `newSince`: the previous report's time; a conversion with no ledger rows
 * is only considered when first attributed after it (less the grace).
 */
export async function ledgerDeltas(
  db: Knex,
  tenantId: string,
  until: Date,
  fee: FeeContext,
  newSince: Date | null,
): Promise<LedgerDelta[]> {
  const { sql, bindings } = conversionSql({ tenantId, until });
  const after = newSince ? new Date(newSince.getTime() - LATE_COMMIT_GRACE_MS) : null;
  const res = (await db.raw(
    `with l as (
      select "eventId", currency, sum(amount) as amount, sum("amountUsd") as usd,
        (array_agg(terms order by "createdAt", id) filter (where terms is not null))[1] as terms,
        true as present
      from "UsageLedger"
      where "tenantId" = ?
      group by "eventId", currency
    ),
    v as (${sql}),
    t as (
      select v.*,
        case
          when l.present then coalesce((l.terms->>'v')::int, 1)
          when ?::timestamptz is not null and v."firstAttributedAt" >= ?::timestamptz then 2
          else 1
        end as tv,
        l.terms as lterms
      from v
      left join l on l."eventId" = v."eventId" and l.currency = v.currency
      where l.present or ?::timestamptz is null or v."firstAttributedAt" > ?::timestamptz
    ),
    b as (
      select t.*,
        case
          when t.lterms->>'rev' is not null then (t.lterms->>'rev')::boolean
          when t.tv = 2 then t.declared or t.percent
          else t.declared
        end as trev,
        coalesce((t.lterms->>'rr')::numeric, ?::numeric) as trr,
        coalesce((t.lterms->>'cr')::numeric, ?::numeric) as tcr,
        coalesce((t.lterms->>'mr')::numeric, ?::numeric) as tmr
      from t
    ),
    s as (
      select b.*,
        case
          when b.tv = 2 then coalesce(round(
            greatest(b.trr * (case when b.trev then b.revenue else 0 end), b.tcr * b.commissions) / nullif(b.tmr, 0),
            2), 0)
          else round(case when b.trev then b.revenue else 0 end, 2)
        end as basis
      from b
    )
    select
      coalesce(s."eventId", l."eventId") as "eventId",
      coalesce(s.currency, l.currency) as currency,
      coalesce(s.basis, 0) as target,
      coalesce(l.amount, 0) as billed,
      coalesce(l.usd, 0) as "billedUsd",
      s."eventId" is null as gone,
      coalesce(s.reversed, false) as reversed,
      coalesce(s.refunded, false) as refunded,
      s.tv, s.trev, s.trr, s.tcr, s.tmr
    from s
    full outer join l on l."eventId" = s."eventId" and l.currency = s.currency
    where coalesce(s.basis, 0) <> coalesce(l.amount, 0)
    order by 1, 2`,
    [
      tenantId,
      ...bindings,
      fee.effectiveAt,
      fee.effectiveAt,
      after,
      after,
      fee.revenueRate,
      fee.commissionRate,
      fee.meterRate,
    ],
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
      tv: number | null;
      trev: boolean | null;
      trr: string | null;
      tcr: string | null;
      tmr: string | null;
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
    terms:
      r.tv === null
        ? null
        : r.tv === 2
          ? { v: 2, rev: !!r.trev, rr: Number(r.trr), cr: Number(r.tcr), mr: Number(r.tmr) }
          : { v: 1, rev: !!r.trev },
  }));
}

/**
 * Turn deltas into ledger entries. New basis is converted at today's ECB
 * rate (convertToUsd, which throws FxUnavailableError when it needs the
 * feed and can't read it). A credit is converted at the rate its conversion
 * was billed at, so it never needs the feed, and a full refund nets the
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
  let newRuleUsd = 0;
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
    if (d.terms?.v === 2) newRuleUsd += amountUsd;
    entries.push({
      eventId: d.eventId,
      currency: d.currency,
      amount,
      usdPerUnit: usdPerUnit === null ? null : round12(usdPerUnit),
      amountUsd,
      // A refund usually reverses the commissions too; it's the cause, so
      // it names the row.
      reason: amount > 0 ? 'billed' : d.gone ? 'removed' : d.refunded ? 'refunded' : d.reversed ? 'reversed' : 'removed',
      terms: d.terms,
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
    newRuleUsd: round6(newRuleUsd),
  };
}

/** Signed amount a delta bills (positive) or credits (negative). */
function deltaAmount(d: LedgerDelta): number {
  return (toCents(d.target) - toCents(d.billed)) / 100;
}

/** New basis and credits, per currency. */
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
  // 11 columns a row: well under Postgres's 65535-parameter cap.
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
        terms: e.terms === null ? null : JSON.stringify(e.terms),
        createdAt,
      })),
    );
  }
}

/** Per-currency sums comparing the two rules over the same conversions. */
export interface RuleComparison {
  currency: string;
  conversions: number;
  /** Rule 1's basis (= revenue billed at the meter's rate). */
  oldBasis: number;
  /** Rule 2's fee, before dividing by a meter rate. */
  newFee: number;
  floorConversions: number;
  renamedSaleConversions: number;
  /** Rule 2's revenue and commissions, for statements. */
  revenue: number;
  commissions: number;
}

/**
 * Compare the two rules for conversions first attributed in
 * (attributedAfter, attributedBy], at the given rule-2 rates. Read-only:
 * this is what the shadow comparison, the ops console's estimates and the
 * contract statements are built from. Tenant scope: `tenantId`, or the
 * caller's GUC when null.
 */
export async function compareRules(
  db: Knex,
  o: { tenantId: string | null; attributedAfter: Date | null; attributedBy: Date; revenueRate: number; commissionRate: number },
): Promise<RuleComparison[]> {
  const { sql, bindings } = conversionSql({
    tenantId: o.tenantId,
    until: o.attributedBy,
    attributedAfter: o.attributedAfter,
    attributedBy: o.attributedBy,
  });
  const res = (await db.raw(
    `select v.currency,
        count(*) filter (where w.fee > 0 or w.old > 0) as conversions,
        coalesce(sum(w.old), 0) as "oldBasis",
        coalesce(sum(w.fee), 0) as "newFee",
        count(*) filter (where w."floorWins") as "floorConversions",
        count(*) filter (where v.percent and not v.declared and v.revenue > 0) as "renamedSaleConversions",
        coalesce(sum(w.rev), 0) as revenue,
        coalesce(sum(v.commissions), 0) as commissions
      from (${sql}) v
      cross join lateral (
        select
          ${RULE1_BASIS('v')} as old,
          case when v.declared or v.percent then v.revenue else 0 end as rev,
          greatest(?::numeric * (case when v.declared or v.percent then v.revenue else 0 end), ?::numeric * v.commissions) as fee,
          ?::numeric * v.commissions > ?::numeric * (case when v.declared or v.percent then v.revenue else 0 end) as "floorWins"
      ) w
      group by v.currency
      order by v.currency`,
    [...bindings, o.revenueRate, o.commissionRate, o.commissionRate, o.revenueRate],
  )) as {
    rows: Array<Record<string, string>>;
  };
  return res.rows.map((r) => ({
    currency: r.currency!,
    conversions: Number(r.conversions),
    oldBasis: Number(r.oldBasis),
    newFee: Number(r.newFee),
    floorConversions: Number(r.floorConversions),
    renamedSaleConversions: Number(r.renamedSaleConversions),
    revenue: Number(r.revenue),
    commissions: Number(r.commissions),
  }));
}

/**
 * Open the ledger for a tenant that was reporting usage before it existed.
 *
 * The old reporter billed every attributed revenue event up to its last
 * report (`cutoff`) at full value. Those events get an `opening` row for
 * their rule-1 basis TODAY, so the ledger starts from what is billable now:
 * refunds and reversals recorded before the cutover are not credited
 * automatically (they're reconciled by hand, once), while anything that
 * changes from now on is. Events first attributed after the last report
 * never were billed, so they get no opening row and the first report bills
 * them.
 *
 * Opening rows take today's rate: the old reporter's rate for a non-USD
 * event isn't recorded anywhere. Production had no non-USD billable events
 * at cutover.
 *
 * Idempotent: marked done in Config, and skipped for a tenant that already
 * has ledger rows.
 */
export async function openLedger(db: Knex, tenantId: string, cutoff: Date | null): Promise<number> {
  if (await getConfig<string>(db, tenantId, CONFIG_KEYS.UsageLedgerOpenedAt)) return 0;
  const existing = await db(TABLES.UsageLedger).where({ tenantId }).first('id');
  let entries: LedgerEntry[] = [];
  if (cutoff && !existing) {
    const { sql, bindings } = conversionSql({ tenantId, until: cutoff, attributedBy: cutoff });
    const res = (await db.raw(
      `select b."eventId", b.currency, b.basis
        from (select v."eventId", v.currency, ${RULE1_BASIS('v')} as basis from (${sql}) v) b
        where b.basis > 0 order by 1`,
      bindings,
    )) as {
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
        terms: { v: 1 as const, rev: true },
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
