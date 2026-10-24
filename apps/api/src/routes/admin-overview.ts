import { Router } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';
import { TABLES } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { byCurrency, byCurrencyAndStatus, tenantDefaultCurrency } from '../currency.js';
import {
  COMMISSION_CURRENCY,
  COMMISSION_STATUSES,
  EVENT_CURRENCY,
  attributedIn,
  clicksIn,
  commissionsIn,
  enrollmentsIn,
  type ReportWindow,
} from '../reporting.js';

export const adminOverviewRouter = Router();

const SORTS = ['revenue', 'commission', 'clicks'] as const;
type OverviewSort = (typeof SORTS)[number];

const querySchema = z.object({
  sort: z.enum(SORTS).optional().default('revenue'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(24),
  cursor: z.string().optional(),
  /** Only this program's activity and partners (see reporting.ts). */
  programId: z.string().min(1).max(64).optional(),
});

/** Rank expression per sort, over the per-partner aggregates joined in
 *  rankedPartnersPage. "commission" is what the partner earned in the
 *  window — reversed commission doesn't count. */
const SORT_EXPR: Record<OverviewSort, string> = {
  revenue: 'coalesce(r.revenue, 0)',
  commission: 'coalesce(m.accrued, 0) + coalesce(m.approved, 0) + coalesce(m.paid, 0)',
  clicks: 'coalesce(k.clicks, 0)',
};

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
 * `?programId=` narrows both to one program: its clicks, conversions and
 * commissions (a bonus's by Bonus.programId), and its partners, enrolled
 * or active in it during the window. reporting.ts defines each, shared
 * with GET /programs/stats so the two agree.
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
  const { programId } = q.data;
  if (programId && !(await db(TABLES.Program).where({ id: programId, tenantId }).first('id'))) {
    return res.status(404).json({ error: 'program_not_found' });
  }
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const w: ReportWindow = { tenantId, since, programId };
  // Amounts are never added across currencies. The scalar totals, the
  // per-partner `revenue` / `commission`, and the ranking are in the
  // brand's default currency; the ByCurrency maps hold every currency.
  const currency = await tenantDefaultCurrency(db, tenantId);

  const ranked = await rankedPartnersPage(db, w, sort, limit, cursor, currency);
  // Every ranked row carries the size of the whole ranked set. A cursor
  // past the end (its rows moved since it was minted) leaves none to read.
  const partnerTotal =
    ranked[0]?.setSize ?? (cursor ? (await rankedPartnersPage(db, w, sort, 0, null, currency))[0]?.setSize : undefined);
  const [clickTotal] = await clicksIn(db, w).count<{ count: string }[]>({ count: '*' });
  const [eventTotal] = (await attributedIn(db, w).select(db.raw('count(*) as events'))) as Array<{
    events: string;
  }>;
  const revenueByCurrency = byCurrency(
    (await attributedIn(db, w)
      .groupByRaw(EVENT_CURRENCY)
      .select(db.raw(`${EVENT_CURRENCY} as currency`), db.raw('sum(e.value * a.weight) as amount'))) as Array<{
      currency: string;
      amount: string | null;
    }>,
  );
  const commissionByCurrency = byCurrencyAndStatus(
    (await commissionsIn(db, w)
      .groupByRaw(`"c"."status", ${COMMISSION_CURRENCY}`)
      .select('c.status as status', db.raw(`${COMMISSION_CURRENCY} as currency`), db.raw('sum("c"."amount") as amount'))) as Array<{
      status: string;
      currency: string;
      amount: string | null;
    }>,
  );

  const commissionBy = (status: string) => commissionByCurrency[currency]?.[status] ?? 0;
  const totals = {
    partners: Number(partnerTotal ?? 0),
    clicks: Number(clickTotal?.count ?? 0),
    currency,
    attributedRevenue: revenueByCurrency[currency] ?? 0,
    attributedRevenueByCurrency: revenueByCurrency,
    attributedEvents: Number(eventTotal?.events ?? 0),
    commissionAccrued: commissionBy('accrued'),
    commissionApproved: commissionBy('approved'),
    commissionPaid: commissionBy('paid'),
    commissionByCurrency,
  };

  const hasMore = ranked.length > limit;
  const page = hasMore ? ranked.slice(0, limit) : ranked;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeOverviewCursor({ s: sort, v: last.sortValue, id: last.id }) : null;
  const perCurrency = await partnerAmountsByCurrency(
    db,
    w,
    page.map((p) => p.id),
  );

  res.json({
    since: since.toISOString(),
    programId: programId ?? null,
    sort,
    totals,
    partners: page.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      stripeConnected: !!p.stripeConnectAccountId,
      clicks: Number(p.clicks),
      revenue: Number(p.revenue),
      revenueByCurrency: perCurrency.revenue.get(p.id) ?? {},
      events: Number(p.events),
      commission: Object.fromEntries(COMMISSION_STATUSES.map((s) => [s, Number(p[s])])),
      commissionByCurrency: perCurrency.commission.get(p.id) ?? {},
    })),
    nextCursor,
  });
});

/** Every currency's revenue and commission for one page of partners. */
async function partnerAmountsByCurrency(
  db: Knex,
  w: ReportWindow,
  partnerIds: string[],
): Promise<{ revenue: Map<string, Record<string, number>>; commission: Map<string, Record<string, Record<string, number>>> }> {
  const revenue = new Map<string, Record<string, number>>();
  const commission = new Map<string, Record<string, Record<string, number>>>();
  if (partnerIds.length === 0) return { revenue, commission };

  const revenueRows = (await attributedIn(db, w)
    .whereIn('a.partnerId', partnerIds)
    .groupByRaw(`"a"."partnerId", ${EVENT_CURRENCY}`)
    .select('a.partnerId as partnerId', db.raw(`${EVENT_CURRENCY} as currency`), db.raw('sum(e.value * a.weight) as amount'))) as Array<{
    partnerId: string;
    currency: string;
    amount: string | null;
  }>;
  const commissionRows = (await commissionsIn(db, w)
    .whereIn('c.partnerId', partnerIds)
    .groupByRaw(`"c"."partnerId", "c"."status", ${COMMISSION_CURRENCY}`)
    .select(
      'c.partnerId as partnerId',
      'c.status as status',
      db.raw(`${COMMISSION_CURRENCY} as currency`),
      db.raw('sum("c"."amount") as amount'),
    )) as Array<{
    partnerId: string;
    status: string;
    currency: string;
    amount: string | null;
  }>;
  for (const id of partnerIds) {
    revenue.set(id, byCurrency(revenueRows.filter((r) => r.partnerId === id)));
    commission.set(id, byCurrencyAndStatus(commissionRows.filter((r) => r.partnerId === id)));
  }
  return { revenue, commission };
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
  /** How many partners the whole ranking holds, on every row. */
  setSize: string;
} & Record<(typeof COMMISSION_STATUSES)[number], string>;

/** Every partner in the tenant joined to its windowed aggregates, ranked
 *  by `sort` DESC then id DESC; returns up to `limit + 1` rows past the
 *  cursor so the caller can tell whether another page exists. Revenue and
 *  commission are in `currency` only: ranking by a sum of rupees and
 *  dollars would rank by nothing.
 *
 *  With `w.programId` the aggregates are that program's, and the partners
 *  are the ones enrolled in it or with an aggregate row: active in it
 *  during the window (reporting.ts). Reading "active" off the joins the
 *  ranking needs anyway costs nothing extra; a separate partner-set query
 *  re-read the program's clicks and doubled the request at 30k partners. */
function rankedPartnersPage(
  db: Knex,
  w: ReportWindow,
  sort: OverviewSort,
  limit: number,
  cursor: OverviewCursor | null,
  currency: string,
): Promise<RankedPartnerRow[]> {
  const clicks = clicksIn(db, w).groupBy('partnerId').select('partnerId').count({ clicks: '*' });
  const revenue = attributedIn(db, w)
    .groupBy('a.partnerId')
    .select('a.partnerId as partnerId')
    .select(
      db.raw(`sum(e.value * a.weight) filter (where ${EVENT_CURRENCY} = ?) as revenue`, [currency]),
      db.raw('count(*) as events'),
    );
  const commission = commissionsIn(db, w)
    .groupBy('c.partnerId')
    .select('c.partnerId as partnerId')
    .select(
      ...COMMISSION_STATUSES.map((s) =>
        db.raw(`sum("c"."amount") filter (where "c"."status" = ? and ${COMMISSION_CURRENCY} = ?) as ??`, [s, currency, s]),
      ),
    );

  const ranked = db(`${TABLES.Partner} as p`)
    .leftJoin(clicks.as('k'), 'k.partnerId', 'p.id')
    .leftJoin(revenue.as('r'), 'r.partnerId', 'p.id')
    .leftJoin(commission.as('m'), 'm.partnerId', 'p.id')
    .where('p.tenantId', w.tenantId)
    .select('p.id', 'p.name', 'p.email', 'p.stripeConnectAccountId')
    .select(
      db.raw('coalesce(k.clicks, 0) as clicks'),
      db.raw('coalesce(r.revenue, 0) as revenue'),
      db.raw('coalesce(r.events, 0) as events'),
      ...COMMISSION_STATUSES.map((s) => db.raw('coalesce(??, 0) as ??', [`m.${s}`, s])),
      db.raw(`(${SORT_EXPR[sort]})::numeric as "sortValue"`),
      db.raw('count(*) over () as "setSize"'),
    );
  if (w.programId) {
    ranked
      .leftJoin(enrollmentsIn(db, w).select('partnerId').as('g'), 'g.partnerId', 'p.id')
      .where((q) =>
        q.whereNotNull('g.partnerId').orWhereNotNull('k.partnerId').orWhereNotNull('r.partnerId').orWhereNotNull('m.partnerId'),
      );
  }

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
