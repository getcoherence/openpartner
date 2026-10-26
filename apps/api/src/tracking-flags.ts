/**
 * Tracking health flags: changes a single window can't show, because each
 * is only odd next to what's normal for the same browser or the same
 * partner. GET /admin/tracking-health/flags serves them, and the daily
 * alert job (tracking-alerts.ts) emails new ones.
 *
 * Derived from the raw tables on every read, like the rest of Tracking
 * health (tracking-health.ts). Account-wide: each compares a browser or a
 * partner with its own past, whatever the program.
 *
 *   linkage_drop  a browser (family + device, the funnel's rows) whose
 *                 partner-link clicks stopped landing on a page running the
 *                 script, or stopped being linked to a customer, as often
 *                 as they used to: what a new consent banner, a redirect
 *                 that drops ?cref=, or a browser update looks like.
 *                   recent    clicks 1 to 8 days old
 *                   baseline  clicks 8 to 36 days old
 *                 Both windows end a day back, and both rates count only
 *                 what happened within a day of the click. A click from
 *                 this morning hasn't had its day yet, and a month-old one
 *                 has had a month, so comparing all-time rates would make
 *                 the recent week look worse than it is. Flagged when the
 *                 recent rate is at most 60% of the baseline's and the gap
 *                 is unlikely to be chance (one-sided two-proportion z of
 *                 3 or more), with enough clicks on both sides.
 *   fast_sales    a partner whose sales now follow their click within
 *                 seconds. A browser extension or a coupon site that clicks
 *                 the link at checkout takes the credit without bringing
 *                 the customer, and its clicks land just before the sale.
 *                 A sale here is the first one credited through a click of
 *                 the partner's link. Renewals inherit the first sale's
 *                 click and would read as months, and a coupon redemption's
 *                 synthetic click is stamped at checkout, so it reads as
 *                 zero by construction: both are left out. Sales only (an
 *                 event with a value), since a signup a minute after the
 *                 click is ordinary.
 *                   recent    sales in the last 14 days
 *                   baseline  sales in the 90 days before
 *                 Flagged with at least 5 recent sales, when either
 *                   - most of them (60%) came within a minute of the click
 *                     ("mostly_instant"), or
 *                   - with at least 10 baseline sales, the median fell to
 *                     a tenth of the baseline's and under 5 minutes
 *                     ("collapsed": 30 minutes to 10 seconds, not 2 days
 *                     to 3 hours).
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';
import { CORRECTIVE_EVENT_TYPES } from './attribution.js';
import { parseUserAgent } from './ua-parse.js';

/** Every threshold the flags use, in one place (docs/tracking-health.md). */
export const FLAG_THRESHOLDS = {
  linkage: {
    /** Clicks this old are measured, and "landed"/"linked" mean within this long of the click. */
    maturityHours: 24,
    recentDays: 7,
    baselineDays: 28,
    minRecentClicks: 100,
    minBaselineClicks: 200,
    /** Baseline landings (or links), so the baseline rate means something. */
    minBaselineHits: 20,
    /** The recent rate is at most (1 − this) × the baseline rate. */
    minRelativeDrop: 0.4,
    /** One-sided two-proportion z-score. */
    minZ: 3,
  },
  sales: {
    recentDays: 14,
    baselineDays: 90,
    fastSeconds: 60,
    minRecentSales: 5,
    minBaselineSales: 10,
    /** mostly_instant: this share of recent sales within fastSeconds. */
    instantShare: 0.6,
    /** collapsed: the recent median at most this × the baseline median… */
    maxMedianRatio: 0.1,
    /** …and at most this many seconds. */
    maxCollapsedMedianSeconds: 300,
  },
} as const;

/** Flags returned (and emailed) at most. */
const MAX_FLAGS = 50;

export interface LinkageRate {
  clicks: number;
  /** Clicks that landed (or were linked) within a day. */
  hits: number;
  rate: number;
}

export interface LinkageDropFlag {
  kind: 'linkage_drop';
  /** `<browser>|<device>|<metric>`: what the alert job dedupes on. */
  subject: string;
  browser: string;
  device: string;
  /** landed: reached a page running the script. linked: linked to a
   *  customer (identify, a Stripe checkout, a conversion call). */
  metric: 'landed' | 'linked';
  recent: LinkageRate;
  baseline: LinkageRate;
}

export interface SalesTiming {
  sales: number;
  medianSeconds: number;
  /** Share of sales within FLAG_THRESHOLDS.sales.fastSeconds of the click. */
  fastShare: number;
}

export interface FastSalesFlag {
  kind: 'fast_sales';
  /** The partner id. */
  subject: string;
  partnerId: string;
  partnerName: string;
  reason: 'collapsed' | 'mostly_instant';
  recent: SalesTiming;
  /** Null under the minimum baseline sample. */
  baseline: SalesTiming | null;
}

export type TrackingFlag = LinkageDropFlag | FastSalesFlag;

export interface TrackingFlags {
  computedAt: string;
  windows: {
    linkage: { baselineSince: string; recentSince: string; until: string };
    sales: { baselineSince: string; recentSince: string; until: string };
  };
  flags: TrackingFlag[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export async function computeTrackingFlags(db: Knex, tenantId: string, opts: { now?: Date } = {}): Promise<TrackingFlags> {
  const now = opts.now ?? new Date();
  const L = FLAG_THRESHOLDS.linkage;
  const linkageUntil = new Date(now.getTime() - L.maturityHours * HOUR);
  const linkageRecent = new Date(linkageUntil.getTime() - L.recentDays * DAY);
  const linkageBaseline = new Date(linkageRecent.getTime() - L.baselineDays * DAY);
  const S = FLAG_THRESHOLDS.sales;
  const salesRecent = new Date(now.getTime() - S.recentDays * DAY);
  const salesBaseline = new Date(salesRecent.getTime() - S.baselineDays * DAY);

  // One after another: `db` is usually a single-connection transaction.
  const linkage = await linkageDrops(db, tenantId, linkageBaseline, linkageRecent, linkageUntil);
  const sales = await fastSales(db, tenantId, salesBaseline, salesRecent, now);

  return {
    computedAt: now.toISOString(),
    windows: {
      linkage: { baselineSince: linkageBaseline.toISOString(), recentSince: linkageRecent.toISOString(), until: linkageUntil.toISOString() },
      sales: { baselineSince: salesBaseline.toISOString(), recentSince: salesRecent.toISOString(), until: now.toISOString() },
    },
    flags: [...linkage, ...sales].slice(0, MAX_FLAGS),
  };
}

interface LinkageAggregate {
  userAgent: string | null;
  recentClicks: number;
  recentLanded: number;
  recentLinked: number;
  baselineClicks: number;
  baselineLanded: number;
  baselineLinked: number;
}

/** One-sided z for "the recent rate is below the baseline's". */
function dropZ(baseline: { n: number; x: number }, recent: { n: number; x: number }): number {
  const pooled = (baseline.x + recent.x) / (baseline.n + recent.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / baseline.n + 1 / recent.n));
  if (!(se > 0)) return 0;
  return (baseline.x / baseline.n - recent.x / recent.n) / se;
}

async function linkageDrops(
  db: Knex,
  tenantId: string,
  baselineSince: Date,
  recentSince: Date,
  until: Date,
): Promise<LinkageDropFlag[]> {
  const L = FLAG_THRESHOLDS.linkage;
  const within = `interval '${L.maturityHours} hours'`;
  // Partner-link clicks only (coupon redemptions' synthetic clicks have no
  // Link), not flagged. Bots are dropped after parsing the user agent.
  const { rows } = await db.raw<{ rows: LinkageAggregate[] }>(
    `with clicks as (
       select c."userAgent",
              c.ts >= ? as recent,
              coalesce(l."landedAt" <= c.ts + ${within}, false) as landed,
              exists (
                select 1 from ?? i
                 where i."clickId" = c.id and i."tenantId" = c."tenantId"
                   and i."stitchedAt" <= c.ts + ${within}
              ) as linked
         from ?? c
         left join ?? l on l."clickId" = c.id and l."tenantId" = c."tenantId"
        where c."tenantId" = ? and c.ts >= ? and c.ts < ?
          and c."linkId" is not null and c."fraudFlag" is null
     )
     select "userAgent",
            count(*) filter (where recent)::int as "recentClicks",
            count(*) filter (where recent and landed)::int as "recentLanded",
            count(*) filter (where recent and linked)::int as "recentLinked",
            count(*) filter (where not recent)::int as "baselineClicks",
            count(*) filter (where not recent and landed)::int as "baselineLanded",
            count(*) filter (where not recent and linked)::int as "baselineLinked"
       from clicks
      group by "userAgent"`,
    [recentSince, TABLES.Identity, TABLES.Click, TABLES.ClickLanding, tenantId, baselineSince, until],
  );

  const browsers = new Map<string, Omit<LinkageAggregate, 'userAgent'> & { browser: string; device: string }>();
  for (const row of rows) {
    const ua = parseUserAgent(row.userAgent);
    if (ua.device === 'bot') continue;
    const key = `${ua.browser}|${ua.device}`;
    const b = browsers.get(key) ?? {
      browser: ua.browser,
      device: ua.device,
      recentClicks: 0,
      recentLanded: 0,
      recentLinked: 0,
      baselineClicks: 0,
      baselineLanded: 0,
      baselineLinked: 0,
    };
    b.recentClicks += row.recentClicks;
    b.recentLanded += row.recentLanded;
    b.recentLinked += row.recentLinked;
    b.baselineClicks += row.baselineClicks;
    b.baselineLanded += row.baselineLanded;
    b.baselineLinked += row.baselineLinked;
    browsers.set(key, b);
  }

  const flags: LinkageDropFlag[] = [];
  for (const b of browsers.values()) {
    if (b.recentClicks < L.minRecentClicks || b.baselineClicks < L.minBaselineClicks) continue;
    for (const metric of ['landed', 'linked'] as const) {
      const recent = { n: b.recentClicks, x: metric === 'landed' ? b.recentLanded : b.recentLinked };
      const baseline = { n: b.baselineClicks, x: metric === 'landed' ? b.baselineLanded : b.baselineLinked };
      if (baseline.x < L.minBaselineHits) continue;
      const recentRate = recent.x / recent.n;
      const baselineRate = baseline.x / baseline.n;
      if (recentRate > baselineRate * (1 - L.minRelativeDrop)) continue;
      if (dropZ(baseline, recent) < L.minZ) continue;
      flags.push({
        kind: 'linkage_drop',
        subject: `${b.browser}|${b.device}|${metric}`,
        browser: b.browser,
        device: b.device,
        metric,
        recent: { clicks: recent.n, hits: recent.x, rate: round4(recentRate) },
        baseline: { clicks: baseline.n, hits: baseline.x, rate: round4(baselineRate) },
      });
    }
  }
  // The steepest fall first.
  return flags.sort((a, b) => a.recent.rate / a.baseline.rate - b.recent.rate / b.baseline.rate);
}

interface SaleRow {
  partnerId: string;
  partnerName: string;
  recent: boolean;
  seconds: number;
}

function timing(seconds: number[]): SalesTiming {
  const sorted = [...seconds].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const fast = sorted.filter((s) => s <= FLAG_THRESHOLDS.sales.fastSeconds).length;
  return { sales: sorted.length, medianSeconds: Math.round(median), fastShare: round4(fast / sorted.length) };
}

async function fastSales(db: Knex, tenantId: string, baselineSince: Date, recentSince: Date, until: Date): Promise<FastSalesFlag[]> {
  const S = FLAG_THRESHOLDS.sales;
  const corrective = [...CORRECTIVE_EVENT_TYPES];
  const notCorrective = `not in (${corrective.map(() => '?').join(', ')})`;
  // horizon: the window's sales credited through a link click, under each
  //   conversion's first-computed model (the live one, as in codeShare).
  // first:   each click's first sale. A renewal is credited through the
  //   click its first sale was (priorConversions in attribution.ts), so it
  //   is never a click's first, here or (prior) before the window.
  // A sale credited through several of one partner's clicks (linear) is
  // timed from the latest of them that it was the first sale for.
  const { rows } = await db.raw<{ rows: SaleRow[] }>(
    `with horizon as (
       select a."partnerId", a."clickId", e.id as "eventId", e.ts as "eventTs", c.ts as "clickTs"
         from ?? a
         join ?? e on e.id = a."eventId" and e."tenantId" = a."tenantId"
         join ?? c on c.id = a."clickId" and c."tenantId" = a."tenantId"
        where a."tenantId" = ? and e.ts >= ? and e.ts < ?
          and e.value > 0 and e.type ${notCorrective}
          and c."linkId" is not null
          and a.model = (
            select a0.model from ?? a0
             where a0."eventId" = a."eventId" and a0."tenantId" = a."tenantId"
             order by a0."computedAt", a0.id
             limit 1
          )
     ),
     prior as (
       select distinct a2."clickId"
         from ?? a2
         join ?? e2 on e2.id = a2."eventId" and e2."tenantId" = a2."tenantId"
        where a2."tenantId" = ? and e2.ts < ?
          and e2.value > 0 and e2.type ${notCorrective}
          and a2."clickId" in (select "clickId" from horizon)
     ),
     ranked as (
       select h.*, row_number() over (partition by h."clickId" order by h."eventTs", h."eventId") as rn
         from horizon h
        where h."clickId" not in (select "clickId" from prior)
     ),
     sales as (
       select "partnerId", "eventId", "eventTs", max("clickTs") as "clickTs"
         from ranked
        where rn = 1
        group by "partnerId", "eventId", "eventTs"
     )
     select s."partnerId", p.name as "partnerName",
            s."eventTs" >= ? as recent,
            greatest(0, extract(epoch from s."eventTs" - s."clickTs"))::float8 as seconds
       from sales s
       join ?? p on p.id = s."partnerId" and p."tenantId" = ?`,
    [
      TABLES.Attribution,
      TABLES.Event,
      TABLES.Click,
      tenantId,
      baselineSince,
      until,
      ...corrective,
      TABLES.Attribution,
      TABLES.Attribution,
      TABLES.Event,
      tenantId,
      baselineSince,
      ...corrective,
      recentSince,
      TABLES.Partner,
      tenantId,
    ],
  );

  const byPartner = new Map<string, { name: string; recent: number[]; baseline: number[] }>();
  for (const row of rows) {
    const p = byPartner.get(row.partnerId) ?? { name: row.partnerName, recent: [], baseline: [] };
    (row.recent ? p.recent : p.baseline).push(Number(row.seconds));
    byPartner.set(row.partnerId, p);
  }

  const flags: FastSalesFlag[] = [];
  for (const [partnerId, p] of byPartner) {
    if (p.recent.length < S.minRecentSales) continue;
    const recent = timing(p.recent);
    const baseline = p.baseline.length >= S.minBaselineSales ? timing(p.baseline) : null;
    const collapsed =
      baseline !== null &&
      recent.medianSeconds <= baseline.medianSeconds * S.maxMedianRatio &&
      recent.medianSeconds <= S.maxCollapsedMedianSeconds;
    const instant = recent.fastShare >= S.instantShare;
    if (!collapsed && !instant) continue;
    flags.push({
      kind: 'fast_sales',
      subject: partnerId,
      partnerId,
      partnerName: p.name,
      reason: collapsed ? 'collapsed' : 'mostly_instant',
      recent,
      baseline,
    });
  }
  return flags.sort((a, b) => b.recent.fastShare - a.recent.fastShare || a.recent.medianSeconds - b.recent.medianSeconds);
}

/** "12 seconds", "4 minutes", "2.5 hours", "3 days". */
export function formatDuration(seconds: number): string {
  const unit = (n: number, word: string) => {
    const v = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
    return `${v} ${word}${v === 1 ? '' : 's'}`;
  };
  if (seconds < 90) return unit(Math.max(0, Math.round(seconds)), 'second');
  if (seconds < 90 * 60) return unit(seconds / 60, 'minute');
  if (seconds < 36 * 3600) return unit(seconds / 3600, 'hour');
  return unit(seconds / 86_400, 'day');
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** One plain-language line per flag, for the alert email. The portal says
 *  the same in its own words (pages/admin/TrackingHealth.tsx). */
export function describeFlag(flag: TrackingFlag): string {
  if (flag.kind === 'linkage_drop') {
    const what =
      flag.metric === 'landed'
        ? 'of partner clicks reached a page running the script within a day'
        : 'of partner clicks were linked to a customer within a day';
    return `${flag.browser} (${flag.device}): ${pct(flag.recent.rate)} ${what} last week, down from ${pct(flag.baseline.rate)} over the four weeks before (${flag.recent.clicks.toLocaleString('en-US')} clicks).`;
  }
  const r = flag.recent;
  if (flag.reason === 'collapsed' && flag.baseline) {
    return `${flag.partnerName}: half of their ${r.sales} sales in the last two weeks came within ${formatDuration(r.medianSeconds)} of their click, against ${formatDuration(flag.baseline.medianSeconds)} over the three months before.`;
  }
  const fast = Math.round(r.fastShare * r.sales);
  return `${flag.partnerName}: ${fast} of their ${r.sales} sales in the last two weeks came within a minute of their click.`;
}
