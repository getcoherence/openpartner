import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type ClickRow, type LinkRow } from '@openpartner/db';
import { grantScope, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { parseUserAgent } from '../ua-parse.js';

export const dashboardRouter = Router();

/**
 * Event-type buckets for the partner-facing analytics charts.
 *
 * Maps OpenPartner's open-ended event-type taxonomy onto the standard
 * 3-pane funnel creators expect (Clicks / Leads / Sales). Anything not
 * captured here (custom event types) falls into "other" and only shows
 * up on the raw events list, not the chart aggregates — keeps the chart
 * legend stable across brands using different conversion taxonomies.
 */
const LEAD_EVENT_TYPES = ['signup', 'trial_started'] as const;

// Partner dashboard — top-line counts, attributed revenue, commission by status.
// Read-optimized via denormalized partnerId on Click/Attribution/Commission.
//
// Optional `?includeLinks=true` adds a per-Link breakdown so the partner /
// creator portal can show channel-level performance ("newsletter converted
// at 8%, TikTok bio at 0.3% — focus on the newsletter").
dashboardRouter.get('/partners/:id/dashboard', requireAuth, grantScope('partners:read'), requirePartnerOrAdmin('id'), async (req, res) => {
  const { db } = tenantOf(req);
  const partnerId = req.params.id;
  const since = req.query.since
    ? new Date(String(req.query.since))
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const includeLinks = req.query.includeLinks === 'true' || req.query.includeLinks === '1';

  const [clicksRow] = await db(TABLES.Click)
    .where({ partnerId })
    .andWhere('ts', '>=', since)
    .count<{ count: string }[]>({ count: '*' });

  // Multi-touch: an event may produce N attribution rows with fractional
  // weights. The partner's share of revenue is Σ(value × weight), and
  // the event count is distinct eventIds (one partner can't "earn" an
  // event twice within the same model).
  const attributedRow = await db(TABLES.Attribution)
    .join(TABLES.Event, `${TABLES.Event}.id`, `${TABLES.Attribution}.eventId`)
    .where(`${TABLES.Attribution}.partnerId`, partnerId)
    .andWhere(`${TABLES.Attribution}.computedAt`, '>=', since)
    .select(
      db.raw(`COUNT(DISTINCT "Attribution"."eventId") as events`),
      db.raw(`COALESCE(SUM("Event".value * "Attribution".weight), 0) as revenue`),
    )
    .first<{ events: string; revenue: string }>();

  const commissionByStatus = (await db(TABLES.Commission)
    .where({ partnerId })
    .andWhere('accruedAt', '>=', since)
    .groupBy('status')
    .select('status')
    .sum({ amount: 'amount' })) as Array<{ status: string; amount: string | null }>;

  let links: Array<{
    linkKey: string;
    clicks: number;
    attributedEvents: number;
    attributedRevenue: number;
  }> | undefined;

  if (includeLinks) {
    // Per-Link breakdown: clicks via Click.linkId, conversions via the
    // attribution → event join with the same linkId. We aggregate by
    // Link (not by linkKey directly) so a deleted-and-recreated link
    // with the same key shows as one row tied to the current Link.
    // Then surface linkKey for display.
    const partnerLinks = (await db<LinkRow>(TABLES.Link)
      .where({ partnerId })
      .select('id', 'linkKey')) as Array<Pick<LinkRow, 'id' | 'linkKey'>>;
    const linkIds = partnerLinks.map((l) => l.id);

    if (linkIds.length > 0) {
      const clicksByLink = (await db(TABLES.Click)
        .whereIn('linkId', linkIds)
        .andWhere('ts', '>=', since)
        .groupBy('linkId')
        .select('linkId')
        .count<{ linkId: string; count: string }[]>({ count: '*' })) as Array<{ linkId: string; count: string }>;

      // Attribution rows don't carry linkId directly — they reference clickId.
      // Join through Click + Event to get per-link conversion + revenue.
      const eventsByLink = (await db(TABLES.Attribution)
        .join(TABLES.Click, `${TABLES.Click}.id`, `${TABLES.Attribution}.clickId`)
        .join(TABLES.Event, `${TABLES.Event}.id`, `${TABLES.Attribution}.eventId`)
        .where(`${TABLES.Attribution}.partnerId`, partnerId)
        .andWhere(`${TABLES.Attribution}.computedAt`, '>=', since)
        .whereIn(`${TABLES.Click}.linkId`, linkIds)
        .groupBy(`${TABLES.Click}.linkId`)
        .select(`${TABLES.Click}.linkId as linkId`)
        .select(
          db.raw(`COUNT(DISTINCT "Attribution"."eventId") as events`),
          db.raw(`COALESCE(SUM("Event".value * "Attribution".weight), 0) as revenue`),
        )) as Array<{ linkId: string; events: string; revenue: string }>;

      const clicksMap = new Map(clicksByLink.map((c) => [c.linkId, Number(c.count)]));
      const eventsMap = new Map(eventsByLink.map((e) => [e.linkId, { events: Number(e.events), revenue: Number(e.revenue) }]));

      links = partnerLinks
        .map((l) => ({
          linkKey: l.linkKey,
          clicks: clicksMap.get(l.id) ?? 0,
          attributedEvents: eventsMap.get(l.id)?.events ?? 0,
          attributedRevenue: eventsMap.get(l.id)?.revenue ?? 0,
        }))
        // Sort by attributed revenue desc, then clicks desc — most useful
        // surface for "what's working" comparisons.
        .sort((a, b) => b.attributedRevenue - a.attributedRevenue || b.clicks - a.clicks);
    } else {
      links = [];
    }
  }

  res.json({
    partnerId,
    since: since.toISOString(),
    clicks: Number(clicksRow?.count ?? 0),
    attributedEvents: Number(attributedRow?.events ?? 0),
    attributedRevenue: Number(attributedRow?.revenue ?? 0),
    commissionByStatus: Object.fromEntries(
      commissionByStatus.map((r) => [r.status, Number(r.amount ?? 0)]),
    ),
    ...(links !== undefined ? { links } : {}),
  });
});

// ---------- Time-series for charting ----------
//
// Daily (or weekly, when the range exceeds ~90 days) buckets of:
//   clicks   — Click rows for this partner
//   leads    — Events of type signup / trial_started
//   sales    — Events with non-null value > 0 (subscription_created,
//              invoice_paid, custom paid events)
//   revenue  — Σ(Event.value × Attribution.weight) for sales events
//   earnings — Σ(Commission.amount) accrued in the bucket
//
// All filterable by programId so the per-partnership detail page on the
// creator portal scopes the chart correctly. The Network forwards the
// programId from Partnership.offering.vendorProgramId.

const timeseriesQuerySchema = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  programId: z.string().min(1).optional(),
  bucket: z.enum(['day', 'week']).optional(),
});

dashboardRouter.get(
  '/partners/:id/timeseries',
  requireAuth,
  grantScope('partners:read'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db } = tenantOf(req);
    const partnerId = req.params.id;
    const q = timeseriesQuerySchema.safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

    const since = q.data.since ? new Date(q.data.since) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = q.data.until ? new Date(q.data.until) : new Date();
    // Auto-bucket: short ranges default to day, long ranges to week. Saves
    // the caller from picking when they don't care, while letting them
    // override (e.g. weekly view of the last 14 days for a smoother chart).
    const rangeDays = (until.getTime() - since.getTime()) / (24 * 60 * 60 * 1000);
    const bucket = q.data.bucket ?? (rangeDays > 90 ? 'week' : 'day');
    const truncUnit = bucket === 'week' ? 'week' : 'day';

    // Three queries in parallel — clicks, events, commissions. Each
    // bucketed by date_trunc on its primary timestamp column. Joining
    // them in SQL would be cheaper but uglier; given partner-scoped
    // tables the row counts here are tiny.
    const [clicksRows, eventsRows, commissionsRows] = await Promise.all([
      db(TABLES.Click)
        .where({ partnerId })
        .modify((qb) => {
          if (q.data.programId) qb.andWhere({ programId: q.data.programId });
        })
        .andWhere('ts', '>=', since)
        .andWhere('ts', '<=', until)
        .groupByRaw(`date_trunc('${truncUnit}', "ts")`)
        .select(db.raw(`date_trunc('${truncUnit}', "ts") as bucket`))
        .count<{ bucket: Date; count: string }[]>({ count: '*' }) as unknown as Promise<
          Array<{ bucket: Date; count: string }>
        >,

      db(TABLES.Attribution)
        .join(TABLES.Event, `${TABLES.Event}.id`, `${TABLES.Attribution}.eventId`)
        .where(`${TABLES.Attribution}.partnerId`, partnerId)
        .modify((qb) => {
          if (q.data.programId) qb.andWhere(`${TABLES.Attribution}.programId`, q.data.programId);
        })
        .andWhere(`${TABLES.Event}.ts`, '>=', since)
        .andWhere(`${TABLES.Event}.ts`, '<=', until)
        .groupByRaw(`date_trunc('${truncUnit}', "Event"."ts")`)
        .select(db.raw(`date_trunc('${truncUnit}', "Event"."ts") as bucket`))
        .select(
          db.raw(
            `SUM(CASE WHEN "Event".type IN (${LEAD_EVENT_TYPES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) as leads`,
            LEAD_EVENT_TYPES as unknown as string[],
          ),
          db.raw(`SUM(CASE WHEN "Event".value > 0 THEN 1 ELSE 0 END) as sales`),
          db.raw(`COALESCE(SUM("Event".value * "Attribution".weight), 0) as revenue`),
        ) as unknown as Promise<
          Array<{ bucket: Date; leads: string; sales: string; revenue: string }>
        >,

      db(TABLES.Commission)
        .where({ partnerId })
        .modify((qb) => {
          if (q.data.programId) {
            qb.join(TABLES.Attribution, `${TABLES.Attribution}.id`, `${TABLES.Commission}.attributionId`)
              .andWhere(`${TABLES.Attribution}.programId`, q.data.programId);
          }
        })
        .andWhere(`${TABLES.Commission}.accruedAt`, '>=', since)
        .andWhere(`${TABLES.Commission}.accruedAt`, '<=', until)
        .groupByRaw(`date_trunc('${truncUnit}', "Commission"."accruedAt")`)
        .select(db.raw(`date_trunc('${truncUnit}', "Commission"."accruedAt") as bucket`))
        .sum({ earnings: `${TABLES.Commission}.amount` }) as unknown as Promise<
          Array<{ bucket: Date; earnings: string | null }>
        >,
    ]);

    // Outer-join the three streams in JS into a dense array — every
    // bucket in [since, until] gets a row, missing values fill as 0 so
    // the chart renders a continuous line instead of gaps.
    const buckets = denseTimeseries(since, until, bucket);
    const clicksByBucket = new Map(clicksRows.map((r) => [bucketKey(r.bucket), Number(r.count)]));
    const eventsByBucket = new Map(
      eventsRows.map((r) => [bucketKey(r.bucket), {
        leads: Number(r.leads ?? 0),
        sales: Number(r.sales ?? 0),
        revenue: Number(r.revenue ?? 0),
      }]),
    );
    const commissionsByBucket = new Map(
      commissionsRows.map((r) => [bucketKey(r.bucket), Number(r.earnings ?? 0)]),
    );

    res.json({
      partnerId,
      since: since.toISOString(),
      until: until.toISOString(),
      bucket,
      buckets: buckets.map((b) => {
        const k = bucketKey(b);
        const ev = eventsByBucket.get(k);
        return {
          bucket: b.toISOString(),
          clicks: clicksByBucket.get(k) ?? 0,
          leads: ev?.leads ?? 0,
          sales: ev?.sales ?? 0,
          revenue: ev?.revenue ?? 0,
          earnings: commissionsByBucket.get(k) ?? 0,
        };
      }),
    });
  },
);

/** Build the dense bucket axis: every day (or week) between since and
 *  until inclusive. Caller fills missing series values with 0. Bucket
 *  start is normalized to UTC date_trunc semantics so the keys line up
 *  with what Postgres produced. */
function denseTimeseries(since: Date, until: Date, unit: 'day' | 'week'): Date[] {
  const out: Date[] = [];
  const stepMs = unit === 'week' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  // Postgres date_trunc('day', x) → start of day in the connection TZ;
  // mirror in JS with UTC truncation since the server is UTC.
  const start = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  if (unit === 'week') {
    // Postgres date_trunc('week', x) is ISO week — Monday. Align to
    // Monday so map keys match.
    const day = start.getUTCDay(); // 0=Sun, 1=Mon, ...
    const offset = (day + 6) % 7;
    start.setUTCDate(start.getUTCDate() - offset);
  }
  for (let t = start.getTime(); t <= until.getTime(); t += stepMs) {
    out.push(new Date(t));
  }
  return out;
}

function bucketKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------- Raw event stream (paginated) ----------
//
// Powers the creator portal's Events tab: every attributed Event for
// this partner, newest first. Includes Click context (linkKey, referer)
// and Attribution weight so the partner can see why they were credited.

const eventsQuerySchema = z.object({
  programId: z.string().min(1).optional(),
  type: z.string().min(1).max(80).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

dashboardRouter.get(
  '/partners/:id/events',
  requireAuth,
  grantScope('partners:read'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db } = tenantOf(req);
    const partnerId = req.params.id;
    const q = eventsQuerySchema.safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

    const limit = q.data.limit ?? 50;
    const offset = q.data.offset ?? 0;

    const rows = (await db(`${TABLES.Attribution} as a`)
      .join(`${TABLES.Event} as e`, 'e.id', 'a.eventId')
      .leftJoin(`${TABLES.Click} as cl`, 'cl.id', 'a.clickId')
      .leftJoin(`${TABLES.Link} as l`, 'l.id', 'cl.linkId')
      .where('a.partnerId', partnerId)
      .modify((qb) => {
        if (q.data.programId) qb.andWhere('a.programId', q.data.programId);
        if (q.data.type) qb.andWhere('e.type', q.data.type);
        if (q.data.since) qb.andWhere('e.ts', '>=', new Date(q.data.since));
        if (q.data.until) qb.andWhere('e.ts', '<=', new Date(q.data.until));
      })
      .orderBy('e.ts', 'desc')
      .limit(limit)
      .offset(offset)
      .select(
        'a.id as attributionId',
        'a.weight as attributionWeight',
        'a.model as attributionModel',
        'e.id as eventId',
        'e.type as eventType',
        'e.value as eventValue',
        'e.currency as eventCurrency',
        'e.ts as eventTs',
        'e.userId as userId',
        'cl.id as clickId',
        'cl.referer as clickReferer',
        'cl.landingUrl as clickLandingUrl',
        'cl.ts as clickTs',
        'l.linkKey as linkKey',
      )) as Array<{
        attributionId: string;
        attributionWeight: string;
        attributionModel: string;
        eventId: string;
        eventType: string;
        eventValue: string | null;
        eventCurrency: string | null;
        eventTs: Date;
        userId: string;
        clickId: string | null;
        clickReferer: string | null;
        clickLandingUrl: string | null;
        clickTs: Date | null;
        linkKey: string | null;
      }>;

    res.json({
      partnerId,
      events: rows.map((r) => ({
        attributionId: r.attributionId,
        weight: Number(r.attributionWeight),
        model: r.attributionModel,
        eventId: r.eventId,
        type: r.eventType,
        value: r.eventValue != null ? Number(r.eventValue) : null,
        currency: r.eventCurrency,
        ts: r.eventTs.toISOString(),
        userId: r.userId,
        click: r.clickId
          ? {
              id: r.clickId,
              linkKey: r.linkKey,
              referer: r.clickReferer,
              landingUrl: r.clickLandingUrl,
              ts: r.clickTs?.toISOString() ?? null,
            }
          : null,
      })),
      limit,
      offset,
    });
  },
);

// ---------- Customers (distinct attributed userIds) ----------
//
// Each row = one customer (userId) attributed to this partner, with
// first-touch click + lifetime attributed revenue. Useful for the
// Customers tab where a creator wants to see who they brought in.

const customersQuerySchema = z.object({
  programId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

dashboardRouter.get(
  '/partners/:id/customers',
  requireAuth,
  grantScope('partners:read'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db } = tenantOf(req);
    const partnerId = req.params.id;
    const q = customersQuerySchema.safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

    const limit = q.data.limit ?? 50;
    const offset = q.data.offset ?? 0;

    // Rolled-up per-customer view via knex query builder so the bindings
    // stay typed. Each row = one userId attributed to this partner with
    // first-event / last-event timestamps + lifetime attributed revenue
    // + event count, ordered by revenue desc.
    const rows = (await db(`${TABLES.Attribution} as a`)
      .join(`${TABLES.Event} as e`, 'e.id', 'a.eventId')
      .where('a.partnerId', partnerId)
      .modify((qb) => {
        if (q.data.programId) qb.andWhere('a.programId', q.data.programId);
      })
      .groupBy('e.userId')
      .select('e.userId as userId')
      .select(
        db.raw(`MIN("e"."ts") as "firstEventAt"`),
        db.raw(`MAX("e"."ts") as "lastEventAt"`),
        db.raw(`COUNT(DISTINCT "e"."id") as "eventCount"`),
        db.raw(`COALESCE(SUM("e".value * "a".weight), 0) as "revenue"`),
      )
      .orderByRaw(`COALESCE(SUM("e".value * "a".weight), 0) desc, MAX("e"."ts") desc`)
      .limit(limit)
      .offset(offset)) as Array<{
        userId: string;
        firstEventAt: Date;
        lastEventAt: Date;
        eventCount: string;
        revenue: string;
      }>;

    res.json({
      partnerId,
      customers: rows.map((r) => ({
        userId: r.userId,
        firstEventAt: r.firstEventAt.toISOString(),
        lastEventAt: r.lastEventAt.toISOString(),
        eventCount: Number(r.eventCount),
        revenue: Number(r.revenue),
      })),
      limit,
      offset,
    });
  },
);

// ---------- Click breakdowns (referrer / UTM / country / device) ----------
//
// Single endpoint, dimension picked via ?dimension=<name>. Returns the
// top-N values for that dimension within the partner's clicks in the
// requested window, with a click count per value.
//
// SQL dimensions (referer, utm*, country) aggregate in Postgres — fast
// even on large click volumes since the partnerId-scoped subset is
// tiny. UA dimensions (device, browser, os) parse-on-read in JS over a
// pulled raw-userAgent column; capped at the most recent N clicks
// (DEFAULT_UA_SAMPLE_LIMIT) so we don't pull a million UAs into memory
// for a top-10 chart.

const SQL_DIMENSIONS = ['referer', 'utm_source', 'utm_medium', 'utm_campaign', 'country'] as const;
const UA_DIMENSIONS = ['device', 'browser', 'os'] as const;
type SqlDimension = (typeof SQL_DIMENSIONS)[number];
type UaDimension = (typeof UA_DIMENSIONS)[number];
type AnyDimension = SqlDimension | UaDimension;

const DIMENSION_COLUMN: Record<SqlDimension, string> = {
  referer: 'referer',
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  country: 'country',
};

const DEFAULT_UA_SAMPLE_LIMIT = 5000;

const breakdownQuerySchema = z.object({
  dimension: z.enum([...SQL_DIMENSIONS, ...UA_DIMENSIONS] as [AnyDimension, ...AnyDimension[]]),
  programId: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

dashboardRouter.get(
  '/partners/:id/breakdowns',
  requireAuth,
  grantScope('partners:read'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db } = tenantOf(req);
    const partnerId = req.params.id;
    const q = breakdownQuerySchema.safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

    const since = q.data.since ? new Date(q.data.since) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = q.data.until ? new Date(q.data.until) : new Date();
    const limit = q.data.limit ?? 10;
    const dimension = q.data.dimension;

    const baseQuery = db<ClickRow>(TABLES.Click)
      .where({ partnerId })
      .modify((qb) => {
        if (q.data.programId) qb.andWhere({ programId: q.data.programId });
      })
      .andWhere('ts', '>=', since)
      .andWhere('ts', '<=', until);

    if ((SQL_DIMENSIONS as readonly string[]).includes(dimension)) {
      const col = DIMENSION_COLUMN[dimension as SqlDimension];
      const rows = (await baseQuery
        .clone()
        .whereNotNull(col)
        .groupBy(col)
        .select(`${col} as value`)
        .count<{ value: string; count: string }[]>({ count: '*' })
        .orderBy('count', 'desc')
        .limit(limit)) as Array<{ value: string; count: string }>;
      return res.json({
        dimension,
        rows: rows.map((r) => ({ value: r.value, count: Number(r.count) })),
      });
    }

    // UA dimensions: pull recent userAgents (capped) and bucket in JS.
    // We sort by ts desc so a creator's recent traffic shape dominates
    // the chart — same intent as the SQL dimensions which aren't
    // sample-capped (they're cheap GROUP BYs).
    const uaRows = (await baseQuery
      .clone()
      .whereNotNull('userAgent')
      .orderBy('ts', 'desc')
      .limit(DEFAULT_UA_SAMPLE_LIMIT)
      .select('userAgent as ua')) as Array<{ ua: string }>;

    const counts = new Map<string, number>();
    for (const { ua } of uaRows) {
      const parsed = parseUserAgent(ua);
      const key = parsed[dimension as UaDimension];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sorted = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([value, count]) => ({ value, count }));
    return res.json({
      dimension,
      rows: sorted,
      sampleSize: uaRows.length,
      sampleCapped: uaRows.length === DEFAULT_UA_SAMPLE_LIMIT,
    });
  },
);
