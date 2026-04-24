import { Router } from 'express';
import { TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { grantScope, requireAuth, requirePartnerOrAdmin } from '../auth.js';

export const dashboardRouter = Router();

// Partner dashboard — top-line counts, attributed revenue, commission by status.
// Read-optimized via denormalized partnerId on Click/Attribution/Commission.
dashboardRouter.get('/partners/:id/dashboard', requireAuth, grantScope('partners:read'), requirePartnerOrAdmin('id'), async (req, res) => {
  const partnerId = req.params.id;
  const since = req.query.since
    ? new Date(String(req.query.since))
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

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

  res.json({
    partnerId,
    since: since.toISOString(),
    clicks: Number(clicksRow?.count ?? 0),
    attributedEvents: Number(attributedRow?.events ?? 0),
    attributedRevenue: Number(attributedRow?.revenue ?? 0),
    commissionByStatus: Object.fromEntries(
      commissionByStatus.map((r) => [r.status, Number(r.amount ?? 0)]),
    ),
  });
});
