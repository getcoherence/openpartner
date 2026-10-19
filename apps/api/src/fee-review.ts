/**
 * Ops-console views of the hosted platform fee (docs/platform-fee.md): who
 * is on which rule, the shadow comparison, on-demand estimates, contract
 * statements, and review signals for fee gaming.
 *
 * Platform-scoped: the privileged pool, explicit tenant ids. Everything here
 * reads; the only writes are contract terms, which an operator sets.
 */

import type { Knex } from 'knex';
import { DEFAULT_TENANT_ID, TABLES, type HostedFeeTermsRow, type TenantRow } from '@openpartner/db';
import { planToMode } from './billing-plan.js';
import { convertToUsd } from './fx.js';
import { isMeteredMode, METER_RATES, ratesFor } from './fee-terms.js';
import type { FeeRuleSettings } from './platform-settings.js';
import { shadowComparison, type AmountsByCurrency, type ShadowComparison } from './usage-billing.js';
import { compareRules, DEFAULT_REVENUE_EVENT_TYPES } from './usage-ledger.js';

const DAY_MS = 86_400_000;

type TenantPick = Pick<TenantRow, 'id' | 'slug' | 'displayName' | 'billingPlan' | 'stripeSubscriptionId'>;

async function hostedTenants(db: Knex): Promise<TenantPick[]> {
  return (await db<TenantRow>(TABLES.Tenant)
    .where({ status: 'active' })
    .whereNot({ id: DEFAULT_TENANT_ID })
    .whereNull('pendingDeletionAt')
    .orderBy('createdAt', 'asc')
    .select('id', 'slug', 'displayName', 'billingPlan', 'stripeSubscriptionId')) as TenantPick[];
}

async function termsByTenant(db: Knex, ids: string[]): Promise<Map<string, HostedFeeTermsRow>> {
  if (ids.length === 0) return new Map();
  const rows = (await db<HostedFeeTermsRow>(TABLES.HostedFeeTerms).whereIn('tenantId', ids)) as HostedFeeTermsRow[];
  return new Map(rows.map((r) => [r.tenantId, r]));
}

export interface FeeTenantStatus {
  tenantId: string;
  slug: string;
  displayName: string;
  plan: string | null;
  mode: string;
  subscribed: boolean;
  /** new: on the new rule now; scheduled: noticed, moving at effectiveAt;
   *  old: on the old rule with no date. */
  rule: 'new' | 'scheduled' | 'old';
  effectiveAt: string | null;
  effectiveSource: HostedFeeTermsRow['effectiveSource'];
  planStartedAt: string | null;
  noticeSentAt: string | null;
  noticeRecipients: string[] | null;
  revenueRate: number;
  commissionRate: number;
  contract: boolean;
  monthlyMinimumUsd: number | null;
  contractNote: string | null;
  /** Stored shadow rows over the last `shadowDays`. */
  shadow: {
    reports: number;
    conversions: number;
    oldFeeUsd: number;
    newFeeUsd: number;
    floorConversions: number;
    renamedSaleConversions: number;
  } | null;
}

export async function listFeeTenants(
  db: Knex,
  settings: FeeRuleSettings,
  opts: { now?: Date; shadowDays?: number } = {},
): Promise<FeeTenantStatus[]> {
  const now = opts.now ?? new Date();
  const tenants = await hostedTenants(db);
  const ids = tenants.map((t) => t.id);
  const terms = await termsByTenant(db, ids);
  const since = new Date(now.getTime() - (opts.shadowDays ?? 30) * DAY_MS);
  const shadows = ids.length
    ? ((await db(TABLES.UsageFeeShadow)
        .whereIn('tenantId', ids)
        .where('rangeEnd', '>', since)
        .groupBy('tenantId')
        .select('tenantId')
        .count({ reports: '*' })
        .sum({
          conversions: 'conversions',
          oldFeeUsd: 'oldFeeUsd',
          newFeeUsd: 'newFeeUsd',
          floorConversions: 'floorConversions',
          renamedSaleConversions: 'renamedSaleConversions',
        })) as Array<Record<string, string | number>>)
    : [];
  const shadowBy = new Map(shadows.map((s) => [String(s.tenantId), s]));

  return tenants.map((t) => {
    const mode = planToMode(t.billingPlan);
    const row = terms.get(t.id) ?? null;
    const rates = isMeteredMode(mode) ? ratesFor(mode, settings, row) : { revenueRate: 0, commissionRate: 0, contract: false };
    const effectiveAt = row?.effectiveAt ? new Date(row.effectiveAt) : null;
    const s = shadowBy.get(t.id);
    return {
      tenantId: t.id,
      slug: t.slug,
      displayName: t.displayName,
      plan: t.billingPlan,
      mode,
      subscribed: !!t.stripeSubscriptionId,
      rule: effectiveAt ? (effectiveAt <= now ? 'new' : 'scheduled') : 'old',
      effectiveAt: effectiveAt ? effectiveAt.toISOString() : null,
      effectiveSource: row?.effectiveSource ?? null,
      planStartedAt: row?.planStartedAt ? new Date(row.planStartedAt).toISOString() : null,
      noticeSentAt: row?.noticeSentAt ? new Date(row.noticeSentAt).toISOString() : null,
      noticeRecipients: row?.noticeRecipients ?? null,
      revenueRate: rates.revenueRate,
      commissionRate: rates.commissionRate,
      contract: rates.contract,
      monthlyMinimumUsd: row?.monthlyMinimumUsd == null ? null : Number(row.monthlyMinimumUsd),
      contractNote: row?.contractNote ?? null,
      shadow: s
        ? {
            reports: Number(s.reports),
            conversions: Number(s.conversions ?? 0),
            oldFeeUsd: Number(s.oldFeeUsd ?? 0),
            newFeeUsd: Number(s.newFeeUsd ?? 0),
            floorConversions: Number(s.floorConversions ?? 0),
            renamedSaleConversions: Number(s.renamedSaleConversions ?? 0),
          }
        : null,
    };
  });
}

export interface FeeEstimate extends ShadowComparison {
  tenantId: string;
  slug: string;
  mode: string;
  revenueRate: number;
  commissionRate: number;
}

/**
 * What each metered tenant's conversions first attributed in the last
 * `days` cost on the old rule and would cost on the new one, at its rates.
 * Computed live from the raw tables (the stored shadow rows only start once
 * shadow mode is on). Tenants whose comparison needed an FX rate the feed
 * couldn't supply are left out.
 */
export async function estimateFeeImpact(
  db: Knex,
  settings: FeeRuleSettings,
  opts: { days: number; now?: Date },
): Promise<FeeEstimate[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.days * DAY_MS);
  const tenants = await hostedTenants(db);
  const terms = await termsByTenant(db, tenants.map((t) => t.id));
  const out: FeeEstimate[] = [];
  for (const t of tenants) {
    const mode = planToMode(t.billingPlan);
    if (!isMeteredMode(mode)) continue;
    const rates = ratesFor(mode, settings, terms.get(t.id) ?? null);
    const cmp = await shadowComparison(db, t.id, { ...rates, meterRate: METER_RATES[mode] }, since, now);
    // A tenant whose only activity is bonuses has no conversions, but the
    // new rule still bills them.
    if (!cmp || (cmp.conversions === 0 && cmp.oldFeeUsd === 0 && cmp.newFeeUsd === 0)) continue;
    out.push({ tenantId: t.id, slug: t.slug, mode, revenueRate: rates.revenueRate, commissionRate: rates.commissionRate, ...cmp });
  }
  return out;
}

export interface ContractTermsInput {
  revenueRate: number | null;
  commissionRate: number | null;
  monthlyMinimumUsd: number | null;
  /** ISO. Conversions first attributed from then on use these terms. */
  effectiveAt: string | null;
  note: string | null;
}

export class ContractTermsError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * Set (or clear, with nulls) a tenant's contract terms. A monthly minimum
 * only makes sense where the invoice is ours to write: Enterprise, billed
 * outside Stripe from the statement below. A Stripe-metered plan can carry
 * rate overrides (the meter basis is scaled to them) but not a minimum.
 */
export async function setContractTerms(db: Knex, tenantId: string, input: ContractTermsInput, operatorEmail: string): Promise<HostedFeeTermsRow> {
  const tenant = (await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['id', 'billingPlan'])) as
    | Pick<TenantRow, 'id' | 'billingPlan'>
    | undefined;
  if (!tenant) throw new ContractTermsError('not_found', 'no such tenant');
  if (input.monthlyMinimumUsd !== null && tenant.billingPlan !== 'enterprise') {
    throw new ContractTermsError(
      'minimum_requires_enterprise',
      'a monthly minimum is invoiced from the contract statement, so the tenant must be on the Enterprise plan',
    );
  }
  const now = new Date();
  const patch: Record<string, unknown> = {
    revenueRate: input.revenueRate,
    commissionRate: input.commissionRate,
    monthlyMinimumUsd: input.monthlyMinimumUsd,
    contractNote: input.note,
    updatedByEmail: operatorEmail,
    updatedAt: now,
  };
  if (input.effectiveAt) {
    patch.effectiveAt = new Date(input.effectiveAt);
    patch.effectiveSource = 'contract';
  }
  await db(TABLES.HostedFeeTerms)
    .insert({ tenantId, ...patch })
    .onConflict('tenantId')
    .merge(Object.keys(patch));
  return (await db<HostedFeeTermsRow>(TABLES.HostedFeeTerms).where({ tenantId }).first()) as HostedFeeTermsRow;
}

export interface ContractStatement {
  tenantId: string;
  /** YYYY-MM (UTC). */
  month: string;
  periodStart: string;
  periodEnd: string;
  revenueRate: number;
  commissionRate: number;
  monthlyMinimumUsd: number | null;
  conversions: number;
  revenueByCurrency: AmountsByCurrency;
  commissionsByCurrency: AmountsByCurrency;
  feeUsd: number;
  /** The minimum less the fee, when the fee falls short of it. */
  minimumTopUpUsd: number;
  amountOwedUsd: number;
  heldOut: AmountsByCurrency | null;
}

/**
 * The month's fee under a tenant's contract terms, for manual invoicing:
 * max(revenueRate × revenue, commissionRate × commissions) per conversion
 * first attributed in the month (from the contract's effective date), in
 * USD at today's ECB rates, then the monthly minimum. Derived from the raw
 * tables as of now, so a refund recorded later changes a past month's
 * statement: invoice once the month and its refund window have closed.
 */
export async function contractStatement(
  db: Knex,
  settings: FeeRuleSettings,
  tenantId: string,
  month: string,
): Promise<ContractStatement> {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new ContractTermsError('invalid_month', 'month must be YYYY-MM');
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  const tenant = (await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['id', 'billingPlan'])) as
    | Pick<TenantRow, 'id' | 'billingPlan'>
    | undefined;
  if (!tenant) throw new ContractTermsError('not_found', 'no such tenant');
  const row = (await termsByTenant(db, [tenantId])).get(tenantId) ?? null;
  const mode = planToMode(tenant.billingPlan);
  const rates = ratesFor(isMeteredMode(mode) ? mode : 'flat', settings, row);
  const effectiveAt = row?.effectiveAt ? new Date(row.effectiveAt) : null;
  const from = effectiveAt && effectiveAt > start ? new Date(effectiveAt.getTime() - 1) : start;
  const minimum = row?.monthlyMinimumUsd == null ? null : Number(row.monthlyMinimumUsd);

  const rows =
    effectiveAt && effectiveAt < end
      ? await compareRules(db, {
          tenantId,
          attributedAfter: from,
          // compareRules' window is (after, by]: stop just short of the
          // next month.
          attributedBy: new Date(end.getTime() - 1),
          revenueRate: rates.revenueRate,
          commissionRate: rates.commissionRate,
        })
      : [];
  const revenueByCurrency: AmountsByCurrency = {};
  const commissionsByCurrency: AmountsByCurrency = {};
  const feeByCurrency: AmountsByCurrency = {};
  let conversions = 0;
  for (const r of rows) {
    if (r.revenue) revenueByCurrency[r.currency] = round2(r.revenue);
    if (r.commissions) commissionsByCurrency[r.currency] = round2(r.commissions);
    if (r.newFee) feeByCurrency[r.currency] = r.newFee;
    conversions += r.conversions;
  }
  const fee = await convertToUsd(feeByCurrency);
  const topUp = minimum !== null && effectiveAt && effectiveAt < end ? Math.max(0, round2(minimum - fee.amountUsd)) : 0;
  return {
    tenantId,
    month,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    revenueRate: rates.revenueRate,
    commissionRate: rates.commissionRate,
    monthlyMinimumUsd: minimum,
    conversions,
    revenueByCurrency,
    commissionsByCurrency,
    feeUsd: fee.amountUsd,
    minimumTopUpUsd: topUp,
    amountOwedUsd: round2(fee.amountUsd + topUp),
    heldOut: Object.keys(fee.heldOut).length > 0 ? fee.heldOut : null,
  };
}

/** Thresholds for the review signals. Signals, not verdicts: each one is a
 *  reason for an operator to look, never an automatic action. */
export const REVIEW_THRESHOLDS = {
  /** Clicks in the window that make "no commission at all" worth a look. */
  quietClicks: 100,
  /** Clicks a tenant needs to count as a conversion-rate peer. */
  peerClicks: 200,
  /** Peers needed before a median means anything. */
  minPeers: 3,
  /** Flag a conversion rate below the peer median divided by this. */
  lowRateFactor: 5,
};

export interface ReviewSignals {
  windowDays: number;
  /** Identified signups or real click traffic, but no commission-bearing
   *  conversion at all. */
  noCommissionActivity: Array<{ tenantId: string; slug: string; clicks: number; identities: number }>;
  /** Revenue conversions whose live commissions exceed their value: an
   *  understated or missing value next to a fixed bounty. */
  commissionAboveValue: Array<{ tenantId: string; slug: string; events: number; sampleEventIds: string[] }>;
  /** Commission-bearing conversions per click far below the peer median. */
  lowConversion: {
    peerMedian: number | null;
    peers: number;
    tenants: Array<{ tenantId: string; slug: string; clicks: number; conversions: number; rate: number }>;
  };
}

export async function reviewSignals(db: Knex, opts: { days?: number; now?: Date } = {}): Promise<ReviewSignals> {
  const days = opts.days ?? 60;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * DAY_MS);
  const tenants = await hostedTenants(db);
  const slugBy = new Map(tenants.map((t) => [t.id, t.slug]));
  const ids = tenants.map((t) => t.id);
  const empty: ReviewSignals = { windowDays: days, noCommissionActivity: [], commissionAboveValue: [], lowConversion: { peerMedian: null, peers: 0, tenants: [] } };
  if (ids.length === 0) return empty;

  const activity = (await db.raw(
    `select t.id as "tenantId",
        coalesce(cl.n, 0)::int as clicks,
        coalesce(idn.n, 0)::int as identities,
        coalesce(cv.n, 0)::int as conversions
      from "Tenant" t
      left join (
        select "tenantId", count(*) as n from "Click"
        where ts > ? and ts <= ? and "fraudFlag" is null and "tenantId" = any(?::text[])
        group by 1
      ) cl on cl."tenantId" = t.id
      left join (
        select "tenantId", count(*) as n from "Identity"
        where "stitchedAt" > ? and "stitchedAt" <= ? and "tenantId" = any(?::text[])
        group by 1
      ) idn on idn."tenantId" = t.id
      left join (
        select a."tenantId", count(distinct a."eventId") as n
        from "Attribution" a
        join "Commission" c on c."attributionId" = a.id
        where c.status <> 'reversed' and c."accruedAt" > ? and c."accruedAt" <= ? and a."tenantId" = any(?::text[])
        group by 1
      ) cv on cv."tenantId" = t.id
      where t.id = any(?::text[])`,
    [since, now, ids, since, now, ids, since, now, ids, ids],
  )) as { rows: Array<{ tenantId: string; clicks: number; identities: number; conversions: number }> };

  const noCommissionActivity = activity.rows
    .filter((r) => r.conversions === 0 && (r.identities > 0 || r.clicks >= REVIEW_THRESHOLDS.quietClicks))
    .map((r) => ({ tenantId: r.tenantId, slug: slugBy.get(r.tenantId)!, clicks: r.clicks, identities: r.identities }));

  const peers = activity.rows.filter((r) => r.clicks >= REVIEW_THRESHOLDS.peerClicks);
  const rates = peers.map((r) => r.conversions / r.clicks).sort((a, b) => a - b);
  const median =
    rates.length >= REVIEW_THRESHOLDS.minPeers
      ? rates.length % 2
        ? rates[(rates.length - 1) / 2]!
        : (rates[rates.length / 2 - 1]! + rates[rates.length / 2]!) / 2
      : null;
  const lowConversion = {
    peerMedian: median,
    peers: peers.length,
    tenants:
      median === null || median === 0
        ? []
        : peers
            .filter((r) => r.conversions / r.clicks < median / REVIEW_THRESHOLDS.lowRateFactor)
            .map((r) => ({
              tenantId: r.tenantId,
              slug: slugBy.get(r.tenantId)!,
              clicks: r.clicks,
              conversions: r.conversions,
              rate: r.conversions / r.clicks,
            })),
  };

  const above = (await db.raw(
    `select e."tenantId", count(*)::int as events, (array_agg(e.id order by e.ts desc))[1:5] as "sampleEventIds"
      from "Event" e
      join lateral (
        select
          sum(c.amount) filter (where c.status <> 'reversed') as kept,
          bool_or(c.metadata->>'rateType' = 'percent') as percent,
          bool_or(e.type = any(p."revenueEventTypes")) as declared
        from "Attribution" a
        join "Commission" c on c."attributionId" = a.id
        join "Program" p on p.id = a."programId"
        where a."eventId" = e.id
      ) cm on true
      where e."tenantId" = any(?::text[]) and e.ts > ? and e.ts <= ?
        and not (e.type = any(?::text[]))
        and (e.type = any(?::text[]) or cm.declared or cm.percent)
        and cm.kept > coalesce(e.value, 0)
      group by 1
      order by 2 desc`,
    [ids, since, now, ['refund', 'chargeback', 'dispute_created', 'invoice_payment_failed'], DEFAULT_REVENUE_EVENT_TYPES],
  )) as { rows: Array<{ tenantId: string; events: number; sampleEventIds: string[] }> };

  return {
    windowDays: days,
    noCommissionActivity,
    commissionAboveValue: above.rows.map((r) => ({ ...r, slug: slugBy.get(r.tenantId)! })),
    lowConversion,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
