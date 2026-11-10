/**
 * Performance rows for the MCP `get_performance` tool: clicks, signups,
 * conversions, attributed revenue (gross, refunded, net) and commission,
 * grouped by tracking link, utm_campaign, partner or program.
 *
 * What counts in a window is what GET /admin/overview and
 * GET /programs/stats count (reporting.ts): clicks by Click.ts, conversions
 * by Attribution.computedAt, commissions by Commission.accruedAt, every
 * click (fraud-flagged ones too), revenue as Σ Event.value × Attribution.weight.
 * So a program row here matches that program on the Programs page, and the
 * partner rows add up to the dashboard's totals.
 *
 * Added here:
 *   signups          distinct signup / trial_started events
 *   paidConversions  distinct events with a value above 0
 *   refunded / net   refunds recorded so far against those conversions,
 *                    read as performance-metric.ts reads them (refunds
 *                    naming the conversion add up, a Stripe refund reports
 *                    its share, the larger wins)
 *
 * Grouping:
 *   link          by the click's Link (null for coupon and API clicks, one
 *                 row per partner and program). A link's commission is all
 *                 commission on its conversions, a recruiter's share
 *                 included; bonuses have no link and aren't in any.
 *   utm_campaign  by the click's utm_campaign, null when it had none.
 *                 Commission as for links.
 *   partner       by the partner. Commission is the partner's own, bonuses
 *                 included.
 *   program       every program, active or not. Commission as
 *                 reporting.ts assigns it (a bonus by Bonus.programId).
 *
 * Amounts stay per currency and are never converted.
 */

import type { Knex } from 'knex';
import {
  COMMISSION_CURRENCY,
  COMMISSION_PROGRAM,
  EVENT_CURRENCY,
  attributedIn,
  clicksIn,
  commissionsIn,
  type ReportWindow,
} from '../reporting.js';
import { CONVERSION_REFUND_SQL, joinConversionRefunds } from '../performance-metric.js';
import { TABLES } from '@openpartner/db';

export const REPORT_GROUPS = ['link', 'utm_campaign', 'partner', 'program'] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

export const REPORT_SORTS = ['revenue', 'clicks', 'conversions', 'commission'] as const;
export type ReportSort = (typeof REPORT_SORTS)[number];

const LEAD_TYPES = ['signup', 'trial_started'];

export interface ReportQuery extends ReportWindow {
  until: Date;
  groupBy: ReportGroup;
  partnerId?: string;
  linkId?: string;
}

export interface RevenueAmounts {
  currency: string;
  gross: number;
  refunded: number;
  net: number;
}

export interface CommissionAmounts {
  currency: string;
  accrued: number;
  approved: number;
  paid: number;
  reversed: number;
}

export interface ReportRow {
  /** The group's key columns: linkId + partnerId + programId, utmCampaign,
   *  partnerId or programId. */
  key: Record<string, string | null>;
  clicks: number;
  attributedEvents: number;
  signups: number;
  paidConversions: number;
  revenue: RevenueAmounts[];
  commission: CommissionAmounts[];
}

/** The key columns per group, for each source the report reads. "k" is the
 *  click an attribution came through; "ck" the click under a commission's
 *  attribution. */
const KEYS: Record<ReportGroup, { names: string[]; clicks: string[]; attributions: string[]; commissions: string[] }> = {
  link: {
    names: ['linkId', 'partnerId', 'programId'],
    clicks: ['"linkId"', '"partnerId"', '"programId"'],
    attributions: ['"k"."linkId"', '"a"."partnerId"', '"a"."programId"'],
    commissions: ['"ck"."linkId"', '"ck"."partnerId"', '"ck"."programId"'],
  },
  utm_campaign: {
    names: ['utmCampaign'],
    clicks: ['"utmCampaign"'],
    attributions: ['"k"."utmCampaign"'],
    commissions: ['"ck"."utmCampaign"'],
  },
  partner: {
    names: ['partnerId'],
    clicks: ['"partnerId"'],
    attributions: ['"a"."partnerId"'],
    commissions: ['"c"."partnerId"'],
  },
  program: {
    names: ['programId'],
    clicks: ['"programId"'],
    attributions: ['"a"."programId"'],
    commissions: [COMMISSION_PROGRAM],
  },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function selectKeys(db: Knex, exprs: string[]): Knex.Raw[] {
  return exprs.map((e, i) => db.raw(`${e} as "g${i}"`));
}

function keyOf(row: Record<string, unknown>, n: number): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => row[`g${i}`] ?? null));
}

/** Every row with activity in the window (every program, for `program`),
 *  unsorted. */
export async function performanceReport(db: Knex, q: ReportQuery): Promise<ReportRow[]> {
  const keys = KEYS[q.groupBy];
  const n = keys.names.length;
  const throughClick = q.groupBy === 'link' || q.groupBy === 'utm_campaign';
  const w: ReportWindow = { tenantId: q.tenantId, since: q.since, until: q.until, programId: q.programId };

  const clicks = (await clicksIn(db, w)
    .modify((c) => {
      if (q.partnerId) c.where({ partnerId: q.partnerId });
      if (q.linkId) c.where({ linkId: q.linkId });
    })
    .groupByRaw(keys.clicks.join(', '))
    .select(...selectKeys(db, keys.clicks), db.raw('count(*)::int as clicks'))) as Array<Record<string, unknown> & { clicks: number }>;

  const attributed = () =>
    attributedIn(db, w)
      // attributedIn joins the Event by id alone. Name its tenant too, so a
      // cross-tenant reference can't count on the privileged pool.
      .where('e.tenantId', q.tenantId)
      .leftJoin(`${TABLES.Click} as k`, (j) => j.on('k.id', 'a.clickId').andOnVal('k.tenantId', q.tenantId))
      .modify((a) => {
        if (q.partnerId) a.where('a.partnerId', q.partnerId);
        if (q.linkId) a.where('k.linkId', q.linkId);
      });

  const counts = (await attributed()
    .groupByRaw(keys.attributions.join(', '))
    .select(
      ...selectKeys(db, keys.attributions),
      db.raw('count(*)::int as "attributedEvents"'),
      db.raw(`(count(distinct "e"."id") filter (where "e"."type" in (${LEAD_TYPES.map(() => '?').join(', ')})))::int as signups`, LEAD_TYPES),
      db.raw('(count(distinct "e"."id") filter (where "e"."value" > 0))::int as "paidConversions"'),
    )) as Array<Record<string, unknown> & { attributedEvents: number; signups: number; paidConversions: number }>;

  const revenueQuery = attributed();
  joinConversionRefunds(db, revenueQuery, q.tenantId);
  const revenue = (await revenueQuery
    .groupByRaw(`${keys.attributions.join(', ')}, ${EVENT_CURRENCY}`)
    .havingRaw('count("e"."value") > 0')
    .select(
      ...selectKeys(db, keys.attributions),
      db.raw(`${EVENT_CURRENCY} as currency`),
      db.raw('coalesce(sum("e"."value" * "a"."weight"), 0) as gross'),
      db.raw(`coalesce(sum(${CONVERSION_REFUND_SQL.kept} * "a"."weight"), 0) as net`),
    )) as Array<Record<string, unknown> & { currency: string; gross: string; net: string }>;

  const commissions = (await commissionsIn(db, w, { joinProgram: true })
    .modify((c) => {
      if (throughClick || q.linkId) {
        c.leftJoin(`${TABLES.Click} as ck`, (j) => j.on('ck.id', 'ca.clickId').andOnVal('ck.tenantId', q.tenantId));
      }
      // A bonus has no click: it can't belong to a link or a utm_campaign.
      if (throughClick) c.whereNotNull('ca.id');
      if (q.groupBy === 'program') c.whereRaw(`${COMMISSION_PROGRAM} is not null`);
      if (q.partnerId) c.where(throughClick ? 'ck.partnerId' : 'c.partnerId', q.partnerId);
      if (q.linkId) c.where('ck.linkId', q.linkId);
    })
    .groupByRaw(`${keys.commissions.join(', ')}, "c"."status", ${COMMISSION_CURRENCY}`)
    .select(
      ...selectKeys(db, keys.commissions),
      'c.status as status',
      db.raw(`${COMMISSION_CURRENCY} as currency`),
      db.raw('sum("c"."amount") as amount'),
    )) as Array<Record<string, unknown> & { status: string; currency: string; amount: string | null }>;

  const rows = new Map<string, ReportRow & { rev: Map<string, RevenueAmounts>; com: Map<string, CommissionAmounts> }>();
  const rowFor = (r: Record<string, unknown>) => {
    const id = keyOf(r, n);
    let row = rows.get(id);
    if (!row) {
      const key: Record<string, string | null> = {};
      keys.names.forEach((name, i) => (key[name] = (r[`g${i}`] as string | null) ?? null));
      row = { key, clicks: 0, attributedEvents: 0, signups: 0, paidConversions: 0, revenue: [], commission: [], rev: new Map(), com: new Map() };
      rows.set(id, row);
    }
    return row;
  };

  if (q.groupBy === 'program') {
    const programs = (await db(TABLES.Program)
      .where({ tenantId: q.tenantId })
      .modify((p) => {
        if (q.programId) p.where({ id: q.programId });
      })
      .select('id as g0')) as Array<{ g0: string }>;
    for (const p of programs) rowFor(p);
  }
  for (const r of clicks) rowFor(r).clicks += r.clicks;
  for (const r of counts) {
    const row = rowFor(r);
    row.attributedEvents += r.attributedEvents;
    row.signups += r.signups;
    row.paidConversions += r.paidConversions;
  }
  for (const r of revenue) {
    const row = rowFor(r);
    const gross = Number(r.gross);
    const net = Number(r.net);
    const amounts = row.rev.get(r.currency) ?? { currency: r.currency, gross: 0, refunded: 0, net: 0 };
    amounts.gross += gross;
    amounts.net += net;
    amounts.refunded += gross - net;
    row.rev.set(r.currency, amounts);
  }
  for (const r of commissions) {
    const amount = Number(r.amount ?? 0);
    if (amount === 0) continue;
    const row = rowFor(r);
    const amounts = row.com.get(r.currency) ?? { currency: r.currency, accrued: 0, approved: 0, paid: 0, reversed: 0 };
    if (r.status === 'accrued' || r.status === 'approved' || r.status === 'paid' || r.status === 'reversed') {
      amounts[r.status] += amount;
    }
    row.com.set(r.currency, amounts);
  }

  return [...rows.values()].map(({ rev, com, ...row }) => ({
    ...row,
    revenue: [...rev.values()]
      .map((a) => ({ currency: a.currency, gross: round2(a.gross), refunded: round2(a.refunded), net: round2(a.net) }))
      .sort((x, y) => x.currency.localeCompare(y.currency)),
    commission: [...com.values()]
      .map((a) => ({
        currency: a.currency,
        accrued: round2(a.accrued),
        approved: round2(a.approved),
        paid: round2(a.paid),
        reversed: round2(a.reversed),
      }))
      .sort((x, y) => x.currency.localeCompare(y.currency)),
  }));
}

/** Rank rows: amounts in the brand's default currency (never converted),
 *  ties by key. Commission is what was earned: accrued + approved + paid. */
export function sortReport(rows: ReportRow[], sort: ReportSort, currency: string): ReportRow[] {
  const value = (r: ReportRow): number => {
    switch (sort) {
      case 'clicks':
        return r.clicks;
      case 'conversions':
        return r.paidConversions;
      case 'revenue':
        return r.revenue.find((a) => a.currency === currency)?.net ?? 0;
      case 'commission': {
        const c = r.commission.find((a) => a.currency === currency);
        return c ? c.accrued + c.approved + c.paid : 0;
      }
    }
  };
  const id = (r: ReportRow) => JSON.stringify(r.key);
  return [...rows].sort((a, b) => value(b) - value(a) || id(a).localeCompare(id(b)));
}
