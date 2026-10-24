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
import { z } from '../zod.js';
import { TABLES, type ClickRow, type IdentityRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { attributeBacklogForUser } from '../attribution.js';
import { tenantOf } from '../tenancy.js';

export const fraudReviewRouter = Router();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  reason: z.enum(['velocity', 'manual']).optional(),
});

fraudReviewRouter.get('/admin/clicks/flagged', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const q = listQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });
  const limit = q.data.limit ?? 100;

  const query = db(TABLES.Click)
    .leftJoin(TABLES.Link, `${TABLES.Link}.id`, `${TABLES.Click}.linkId`)
    .leftJoin(TABLES.Partner, `${TABLES.Partner}.id`, `${TABLES.Click}.partnerId`)
    .where(`${TABLES.Click}.tenantId`, tenantId)
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
  const { db, tenantId } = tenantOf(req);
  const clickId = req.params.id!;
  const click = await db<ClickRow>(TABLES.Click).where({ id: clickId, tenantId }).first();
  if (!click) return res.status(404).json({ error: 'click_not_found' });
  if (!click.fraudFlag) return res.status(409).json({ error: 'not_flagged' });

  const identities = await db<IdentityRow>(TABLES.Identity).where({ clickId, tenantId });
  let reattributed = 0;

  // The request is already in a transaction (per-request via tenantMiddleware).
  // No nested transaction needed — operate on req.db directly.
  await db<ClickRow>(TABLES.Click).where({ id: clickId, tenantId }).update({ fraudFlag: null });

  // Re-run attribution for any user that stitched to this click. If we
  // just called the backlog helper directly, events already attributed
  // under a different click-set (e.g. linear with two clicks, weight
  // 0.5 each) would gain a third row for the newly-unflagged click
  // without adjusting the existing weights — the partner would add up
  // to > 1x the event's revenue. Before re-running, drop any
  // non-finalized attribution rows for this user's events and their
  // accrued commissions, so the backlog recomputes clean. We leave
  // approved / paid commissions alone — you don't retroactively
  // rewrite the ledger.
  //
  // userId is unique per tenant only, so the event lookup names the
  // tenant: without it, a pool that bypasses RLS deleted another brand's
  // accrued commissions for a user with the same ID.
  //
  // An event is re-derived only while every commission on it is still
  // accrued. One with anything approved, paid or reversed on it keeps its
  // attributions and commissions as they are: those rows are ledger, and an
  // attribution can't be dropped from under them. That covers a recruiter's
  // share (recruiter-commissions.ts), which sits on its source's
  // attribution: accrued with an accrued source, it is dropped with it and
  // the replay accrues it again; reversed on its own, its event stays.
  for (const identity of identities) {
    const eventIds = (
      await db(TABLES.Event).where({ tenantId, userId: identity.userId }).select('id')
    ).map((r) => (r as { id: string }).id);
    if (eventIds.length === 0) continue;

    const onEvents = (await db(`${TABLES.Commission} as c`)
      .join(`${TABLES.Attribution} as a`, 'a.id', 'c.attributionId')
      .where('c.tenantId', tenantId)
      .whereIn('a.eventId', eventIds)
      .select('c.id', 'c.attributionId', 'c.status', 'a.eventId')) as Array<{
      id: string;
      attributionId: string;
      status: string;
      eventId: string;
    }>;
    const settledEvents = new Set(onEvents.filter((c) => c.status !== 'accrued').map((c) => c.eventId));
    const accruedCommissions = onEvents.filter((c) => !settledEvents.has(c.eventId));

    const attributionsToDelete = [...new Set(accruedCommissions.map((c) => c.attributionId))];

    if (accruedCommissions.length > 0) {
      await db(TABLES.Commission)
        .whereIn('id', accruedCommissions.map((c) => c.id))
        .del();
    }
    if (attributionsToDelete.length > 0) {
      await db(TABLES.Attribution).whereIn('id', attributionsToDelete).del();
    }

    const n = await attributeBacklogForUser(db, tenantId, identity.userId);
    reattributed += n;
  }

  res.json({ ok: true, clickId, reattributedEvents: reattributed });
});

fraudReviewRouter.post('/clicks/:id/flag', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const clickId = req.params.id!;
  const click = await db<ClickRow>(TABLES.Click).where({ id: clickId, tenantId }).first();
  if (!click) return res.status(404).json({ error: 'click_not_found' });
  if (click.fraudFlag) return res.status(409).json({ error: 'already_flagged', flag: click.fraudFlag });

  await db<ClickRow>(TABLES.Click).where({ id: clickId, tenantId }).update({ fraudFlag: 'manual' });
  res.json({ ok: true, clickId });
});
