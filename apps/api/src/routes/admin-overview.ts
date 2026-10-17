import { Router } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';
import { TABLES } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';

export const adminOverviewRouter = Router();

const SORTS = ['revenue', 'commission', 'clicks'] as const;
type OverviewSort = (typeof SORTS)[number];

const querySchema = z.object({
  sort: z.enum(SORTS).optional().default('revenue'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(24),
  cursor: z.string().optional(),
});

/** Rank expression per sort, over the per-partner aggregates joined in
 *  rankedPartnersPage. "commission" is what the partner earned in the
 *  window — reversed commission doesn't count. */
const SORT_EXPR: Record<OverviewSort, string> = {
  revenue: 'coalesce(r.revenue, 0)',
  commission: 'coalesce(m.accrued, 0) + coalesce(m.approved, 0) + coalesce(m.paid, 0)',
  clicks: 'coalesce(k.clicks, 0)',
};

const COMMISSION_STATUSES = ['accrued', 'approved', 'paid', 'reversed'] as const;

/**
 * One-shot admin dashboard payload. Composed in a single endpoint so the
 * portal's home view doesn't need N+1 per-partner fetches.
 *
 * Window defaults to 30 days; the Dub-style partner cards don't need more
 * granularity than that for the high-level view.
 *
 * `totals` aggregate over the whole tenant. `partners` is one page of
 * per-partner rows ranked by `?sort=` (revenue | commission | clicks; ties
 * break by id, newest first), and `nextCursor` fetches the next page.
 * Programs run to tens of thousands of partners, so neither is bounded by
 * a fixed partner list.
 *
 * Every query filters on tenantId explicitly rather than leaning on RLS
 * alone, which the privileged-pool fallback (DATABASE_URL_APP unset)
 * bypasses.
 */
adminOverviewRouter.get('/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  const q = querySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });
  const { sort, limit } = q.data;
  let cursor: OverviewCursor | null = null;
  if (q.data.cursor) {
    cursor = decodeOverviewCursor(q.data.cursor, sort);
    if (!cursor) return res.status(400).json({ error: 'invalid_cursor' });
  }

  const { db, tenantId } = tenantOf(req);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [partnerCount] = await db(TABLES.Partner).where({ tenantId }).count<{ count: string }[]>({ count: '*' });
  const [clickTotal] = await clicksSince(db, tenantId, since).count<{ count: string }[]>({ count: '*' });
  const [revenueTotal] = (await attributedSince(db, tenantId, since).select(
    db.raw('coalesce(sum(e.value * a.weight), 0) as revenue'),
    db.raw('count(*) as events'),
  )) as Array<{ revenue: string; events: string }>;
  const commissionTotals = await commissionsSince(db, tenantId, since)
    .groupBy('status')
    .select('status')
    .sum<{ status: string; amount: string }[]>({ amount: 'amount' });

  const commissionBy = (status: string) => Number(commissionTotals.find((r) => r.status === status)?.amount ?? 0);
  const totals = {
    partners: Number(partnerCount?.count ?? 0),
    clicks: Number(clickTotal?.count ?? 0),
    attributedRevenue: Number(revenueTotal?.revenue ?? 0),
    attributedEvents: Number(revenueTotal?.events ?? 0),
    commissionAccrued: commissionBy('accrued'),
    commissionApproved: commissionBy('approved'),
    commissionPaid: commissionBy('paid'),
  };

  const ranked = await rankedPartnersPage(db, tenantId, since, sort, limit, cursor);
  const hasMore = ranked.length > limit;
  const page = hasMore ? ranked.slice(0, limit) : ranked;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeOverviewCursor({ s: sort, v: last.sortValue, id: last.id }) : null;

  res.json({
    since: since.toISOString(),
    sort,
    totals,
    partners: page.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      stripeConnected: !!p.stripeConnectAccountId,
      clicks: Number(p.clicks),
      revenue: Number(p.revenue),
      events: Number(p.events),
      commission: Object.fromEntries(COMMISSION_STATUSES.map((s) => [s, Number(p[s])])),
    })),
    nextCursor,
  });
});

function clicksSince(db: Knex, tenantId: string, since: Date) {
  return db(TABLES.Click).where({ tenantId }).where('ts', '>=', since);
}

function attributedSince(db: Knex, tenantId: string, since: Date) {
  return db(`${TABLES.Attribution} as a`)
    .join(`${TABLES.Event} as e`, 'e.id', 'a.eventId')
    .where('a.tenantId', tenantId)
    .where('a.computedAt', '>=', since);
}

function commissionsSince(db: Knex, tenantId: string, since: Date) {
  return db(TABLES.Commission).where({ tenantId }).where('accruedAt', '>=', since);
}

type RankedPartnerRow = {
  id: string;
  name: string;
  email: string;
  stripeConnectAccountId: string | null;
  clicks: string;
  revenue: string;
  events: string;
  /** numeric rendered as text — exact, so it round-trips through the cursor. */
  sortValue: string;
} & Record<(typeof COMMISSION_STATUSES)[number], string>;

/** Every partner in the tenant joined to its windowed aggregates, ranked
 *  by `sort` DESC then id DESC; returns up to `limit + 1` rows past the
 *  cursor so the caller can tell whether another page exists. */
function rankedPartnersPage(
  db: Knex,
  tenantId: string,
  since: Date,
  sort: OverviewSort,
  limit: number,
  cursor: OverviewCursor | null,
): Promise<RankedPartnerRow[]> {
  const clicks = clicksSince(db, tenantId, since).groupBy('partnerId').select('partnerId').count({ clicks: '*' });
  const revenue = attributedSince(db, tenantId, since)
    .groupBy('a.partnerId')
    .select('a.partnerId as partnerId')
    .select(db.raw('sum(e.value * a.weight) as revenue'), db.raw('count(*) as events'));
  const commission = commissionsSince(db, tenantId, since)
    .groupBy('partnerId')
    .select('partnerId')
    .select(...COMMISSION_STATUSES.map((s) => db.raw('sum(amount) filter (where status = ?) as ??', [s, s])));

  const ranked = db(`${TABLES.Partner} as p`)
    .leftJoin(clicks.as('k'), 'k.partnerId', 'p.id')
    .leftJoin(revenue.as('r'), 'r.partnerId', 'p.id')
    .leftJoin(commission.as('m'), 'm.partnerId', 'p.id')
    .where('p.tenantId', tenantId)
    .select('p.id', 'p.name', 'p.email', 'p.stripeConnectAccountId')
    .select(
      db.raw('coalesce(k.clicks, 0) as clicks'),
      db.raw('coalesce(r.revenue, 0) as revenue'),
      db.raw('coalesce(r.events, 0) as events'),
      ...COMMISSION_STATUSES.map((s) => db.raw('coalesce(??, 0) as ??', [`m.${s}`, s])),
      db.raw(`(${SORT_EXPR[sort]})::numeric as "sortValue"`),
    );

  const page = db
    .select('*')
    .from(ranked.as('t'))
    .orderBy([
      { column: 'sortValue', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])
    .limit(limit + 1);
  if (cursor) page.whereRaw('("sortValue", "id") < (?::numeric, ?)', [cursor.v, cursor.id]);
  return page as unknown as Promise<RankedPartnerRow[]>;
}

/** Opaque page cursor: the last row's rank value + id, bound to the sort
 *  it was minted under (a revenue cursor means nothing to a clicks page). */
interface OverviewCursor {
  s: OverviewSort;
  v: string;
  id: string;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

function encodeOverviewCursor(c: OverviewCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeOverviewCursor(raw: string, sort: OverviewSort): OverviewCursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<OverviewCursor>;
    if (c.s !== sort || typeof c.v !== 'string' || !NUMERIC.test(c.v) || typeof c.id !== 'string' || !c.id) {
      return null;
    }
    return { s: c.s, v: c.v, id: c.id };
  } catch {
    return null;
  }
}
