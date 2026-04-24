/**
 * Fraud review surface.
 *
 * Flagged clicks (router velocity limiter or manual admin designation)
 * are kept in the Click table with `fraudFlag` set — the attribution
 * engine silently skips them. Without a review UI, false positives
 * orphan their partner's commissions permanently.
 *
 * Admin workflow:
 *   GET  /admin/clicks/flagged      — paginated list of flagged clicks
 *                                     with partner, link, IP hash, UA.
 *   POST /clicks/:id/unflag         — clears fraudFlag. Re-runs
 *                                     attribution for every userId that
 *                                     stitched to this click, so any
 *                                     events that arrived while the click
 *                                     was flagged finally earn commission.
 *   POST /clicks/:id/flag           — set fraudFlag='manual'. Any
 *                                     existing Attribution rows stay put
 *                                     (we don't retroactively unwind);
 *                                     future events on this click just
 *                                     won't attribute.
 */

import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type ClickRow, type IdentityRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { attributeBacklogForUser } from '../attribution.js';

export const fraudReviewRouter = Router();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  reason: z.enum(['velocity', 'manual']).optional(),
});

fraudReviewRouter.get('/admin/clicks/flagged', requireAuth, requireAdmin, async (req, res) => {
  const q = listQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });
  const limit = q.data.limit ?? 100;

  const query = db(TABLES.Click)
    .leftJoin(TABLES.Link, `${TABLES.Link}.id`, `${TABLES.Click}.linkId`)
    .leftJoin(TABLES.Partner, `${TABLES.Partner}.id`, `${TABLES.Click}.partnerId`)
    .whereNotNull(`${TABLES.Click}.fraudFlag`)
    .orderBy(`${TABLES.Click}.ts`, 'desc')
    .limit(limit)
    .select(
      `${TABLES.Click}.id as id`,
      `${TABLES.Click}.fraudFlag as fraudFlag`,
      `${TABLES.Click}.ts as ts`,
      `${TABLES.Click}.ipHash as ipHash`,
      `${TABLES.Click}.userAgent as userAgent`,
      `${TABLES.Click}.referer as referer`,
      `${TABLES.Click}.landingUrl as landingUrl`,
      `${TABLES.Click}.partnerId as partnerId`,
      `${TABLES.Partner}.name as partnerName`,
      `${TABLES.Link}.id as linkId`,
      `${TABLES.Link}.linkKey as linkKey`,
    );

  if (q.data.reason) query.andWhere(`${TABLES.Click}.fraudFlag`, q.data.reason);

  const clicks = await query;
  res.json({ clicks });
});

fraudReviewRouter.post('/clicks/:id/unflag', requireAuth, requireAdmin, async (req, res) => {
  const clickId = req.params.id!;
  const click = await db<ClickRow>(TABLES.Click).where({ id: clickId }).first();
  if (!click) return res.status(404).json({ error: 'click_not_found' });
  if (!click.fraudFlag) return res.status(409).json({ error: 'not_flagged' });

  await db<ClickRow>(TABLES.Click).where({ id: clickId }).update({ fraudFlag: null });

  // Re-run attribution for any user that stitched to this click — their
  // events didn't earn while the click was flagged, but they should now.
  // We use the existing backlog helper so all the usual window + model
  // logic applies.
  const identities = await db<IdentityRow>(TABLES.Identity).where({ clickId });
  let reattributed = 0;
  for (const identity of identities) {
    const n = await attributeBacklogForUser(db, identity.userId);
    reattributed += n;
  }

  res.json({ ok: true, clickId, reattributedEvents: reattributed });
});

fraudReviewRouter.post('/clicks/:id/flag', requireAuth, requireAdmin, async (req, res) => {
  const clickId = req.params.id!;
  const click = await db<ClickRow>(TABLES.Click).where({ id: clickId }).first();
  if (!click) return res.status(404).json({ error: 'click_not_found' });
  if (click.fraudFlag) return res.status(409).json({ error: 'already_flagged', flag: click.fraudFlag });

  await db<ClickRow>(TABLES.Click).where({ id: clickId }).update({ fraudFlag: 'manual' });
  res.json({ ok: true, clickId });
});

