/**
 * Partner conversion funnel.
 *
 * click  → stitched identity  → signup  → first paid conversion
 *
 * All counts are filtered by partnerId (derived off Click.partnerId for
 * the top of funnel, and Attribution.partnerId downstream), and by a
 * time window defaulting to the last 30 days. Stages:
 *
 *   clicks      — Click rows, EXCLUDING fraud-flagged. We want the
 *                 funnel to match what the attribution engine treats
 *                 as real traffic.
 *   identities  — distinct userIds reached through this partner's
 *                 clicks — i.e. the users we successfully stitched.
 *   signups     — distinct userIds with an attributed signup event.
 *   paid        — distinct userIds with at least one attributed
 *                 invoice_paid event, plus total attributed revenue.
 *
 * Rates are downstream / upstream, not cumulative from clicks, so you
 * can read the step-over-step drop directly: stitchRate = identities/clicks,
 * signupRate = signups/identities, paidRate = paid/signups.
 */

import { Router } from 'express';
import { TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { requireAuth, requirePartnerOrAdmin } from '../auth.js';

export const funnelRouter = Router();

funnelRouter.get('/partners/:id/funnel', requireAuth, requirePartnerOrAdmin('id'), async (req, res) => {
  const partnerId = req.params.id!;
  const since = req.query.since
    ? new Date(String(req.query.since))
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // 1. Clicks (fraud-clean)
  const clicksRow = await db(TABLES.Click)
    .where({ partnerId })
    .whereNull('fraudFlag')
    .andWhere('ts', '>=', since)
    .count<{ count: string }[]>({ count: '*' })
    .first();
  const clicks = Number(clicksRow?.count ?? 0);

  // 2. Identities stitched through this partner's clicks in-window.
  //    We use Click.ts as the time filter: people who clicked in-window
  //    AND subsequently stitched.
  const identitiesRow = await db(TABLES.Identity)
    .join(TABLES.Click, `${TABLES.Click}.id`, `${TABLES.Identity}.clickId`)
    .where(`${TABLES.Click}.partnerId`, partnerId)
    .andWhere(`${TABLES.Click}.ts`, '>=', since)
    .countDistinct<{ count: string }[]>({ count: `${TABLES.Identity}.userId` })
    .first();
  const identities = Number(identitiesRow?.count ?? 0);

  // 3. Signups — distinct users with an attributed signup event.
  const signupsRow = await db(TABLES.Attribution)
    .join(TABLES.Event, `${TABLES.Event}.id`, `${TABLES.Attribution}.eventId`)
    .where(`${TABLES.Attribution}.partnerId`, partnerId)
    .andWhere(`${TABLES.Attribution}.computedAt`, '>=', since)
    .andWhere(`${TABLES.Event}.type`, 'signup')
    .countDistinct<{ count: string }[]>({ count: `${TABLES.Event}.userId` })
    .first();
  const signups = Number(signupsRow?.count ?? 0);

  // 4. Paid conversions + revenue.
  const paidRow = await db(TABLES.Attribution)
    .join(TABLES.Event, `${TABLES.Event}.id`, `${TABLES.Attribution}.eventId`)
    .where(`${TABLES.Attribution}.partnerId`, partnerId)
    .andWhere(`${TABLES.Attribution}.computedAt`, '>=', since)
    .andWhere(`${TABLES.Event}.type`, 'invoice_paid')
    .select(
      db.raw(`COUNT(DISTINCT "Event"."userId") as users`),
      db.raw(`COALESCE(SUM("Event".value * "Attribution".weight), 0) as revenue`),
    )
    .first<{ users: string; revenue: string }>();
  const paid = Number(paidRow?.users ?? 0);
  const revenue = Number(paidRow?.revenue ?? 0);

  const rate = (num: number, den: number) => (den > 0 ? num / den : 0);

  res.json({
    partnerId,
    since: since.toISOString(),
    stages: {
      clicks,
      identities,
      signups,
      paid,
    },
    rates: {
      stitchRate: rate(identities, clicks),
      signupRate: rate(signups, identities),
      paidRate: rate(paid, signups),
      // Full-funnel — visitors who became paying customers.
      overall: rate(paid, clicks),
    },
    revenue,
  });
});
