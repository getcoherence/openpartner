/**
 * Partner conversion funnel: what became of the clicks a partner sent.
 *
 * click  → identified user  → signup  → paid
 *
 * Every stage counts ONE cohort: this partner's clicks made in the window
 * (default: the last 30 days) and the users those clicks produced. The
 * later stages follow those users through Attribution.clickId, the click
 * the attribution engine credited, so nothing is counted by when an event
 * arrived or when attribution ran. A customer won by an older click
 * stays out even when their renewal lands in the window: a renewal keeps
 * the attribution (and the click) of the customer's first conversion of
 * that type (docs/renewal-attribution.md), and that click predates the
 * window. Stages:
 *
 *   clicks      — Click rows in the window, EXCLUDING fraud-flagged. We
 *                 want the funnel to match what the attribution engine
 *                 treats as real traffic.
 *   identities  — distinct userIds stitched (Identity) to those clicks.
 *   signups     — of those users, the ones with a signup-or-later event
 *                 (SIGNED_UP_TYPES) attributed to this partner through
 *                 one of those clicks. A paying customer has signed up
 *                 even when the brand never sends a `signup` event.
 *   paid        — of those, the ones with an attributed `invoice_paid`.
 *
 * Each stage is a subset of the one before, so no step rate tops 100%
 * (clicks → identities aside: two accounts signing in on one browser can
 * stitch to the same click). Rates are downstream / upstream, not
 * cumulative from clicks, so you can read the step-over-step drop
 * directly: stitchRate = identities/clicks, signupRate = signups/identities,
 * paidRate = paid/signups, overall = paid/clicks.
 *
 * revenue — Σ(Event.value × Attribution.weight) over those attributed
 * `invoice_paid` events: what the cohort has paid so far, its own renewals
 * included. In the brand's default currency; `revenueByCurrency` has every
 * currency, never added together.
 */

import { Router } from 'express';
import { TABLES } from '@openpartner/db';
import { requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { byCurrency, currencySql, tenantDefaultCurrency } from '../currency.js';

export const funnelRouter = Router();

/** Event types a customer only sends once they have an account. */
const SIGNED_UP_TYPES = ['signup', 'trial_started', 'subscription_created', 'invoice_paid'];

funnelRouter.get('/partners/:id/funnel', requireAuth, requirePartnerOrAdmin('id'), async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const partnerId = req.params.id!;
  const since = req.query.since
    ? new Date(String(req.query.since))
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // The cohort: this partner's fraud-clean clicks in the window.
  const cohortClicks = () =>
    db(TABLES.Click)
      .select('id')
      .where({ tenantId, partnerId })
      .whereNull('fraudFlag')
      .andWhere('ts', '>=', since);
  const cohortUsers = () => db(TABLES.Identity).select('userId').whereIn('clickId', cohortClicks());

  // 1. Clicks
  const clicksRow = await cohortClicks().clearSelect().count<{ count: string }[]>({ count: '*' }).first();
  const clicks = Number(clicksRow?.count ?? 0);

  // 2. Users stitched to those clicks.
  const identitiesRow = await db(TABLES.Identity)
    .whereIn('clickId', cohortClicks())
    .countDistinct<{ count: string }[]>({ count: 'userId' })
    .first();
  const identities = Number(identitiesRow?.count ?? 0);

  // 3 + 4. Those users' conversions credited to this partner through a
  // cohort click.
  const conversions = () =>
    db(TABLES.Attribution)
      .join(TABLES.Event, `${TABLES.Event}.id`, `${TABLES.Attribution}.eventId`)
      .where(`${TABLES.Attribution}.partnerId`, partnerId)
      .whereIn(`${TABLES.Attribution}.clickId`, cohortClicks())
      .whereIn(`${TABLES.Event}.userId`, cohortUsers());
  const usersRow = await conversions()
    .whereIn(`${TABLES.Event}.type`, SIGNED_UP_TYPES)
    .select(
      db.raw(`COUNT(DISTINCT "Event"."userId") as signups`),
      db.raw(`COUNT(DISTINCT "Event"."userId") FILTER (WHERE "Event".type = 'invoice_paid') as paid`),
    )
    .first<{ signups: string; paid: string }>();
  const signups = Number(usersRow?.signups ?? 0);
  const paid = Number(usersRow?.paid ?? 0);

  const currency = await tenantDefaultCurrency(db, tenantId);
  const eventCurrency = currencySql('"Event"."currency"');
  const revenueByCurrency = byCurrency(
    (await conversions()
      .where(`${TABLES.Event}.type`, 'invoice_paid')
      .groupByRaw(eventCurrency)
      .select(db.raw(`${eventCurrency} as currency`), db.raw(`SUM("Event".value * "Attribution".weight) as amount`))) as Array<{
      currency: string;
      amount: string | null;
    }>,
  );

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
    currency,
    revenue: revenueByCurrency[currency] ?? 0,
    revenueByCurrency,
  });
});
