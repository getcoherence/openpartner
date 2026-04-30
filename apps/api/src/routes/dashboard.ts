import { Router } from 'express';
import { TABLES, type LinkRow } from '@openpartner/db';
import { grantScope, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { tenantOf } from '../tenancy.js';

export const dashboardRouter = Router();

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
