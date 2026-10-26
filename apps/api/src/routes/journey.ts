/**
 * A customer's journey (journey.ts): their partner touches in order, their
 * events, and for one conversion who got credit and why. Admin only: it
 * names every partner who touched the customer and the brand's own userId.
 *
 *   GET /events/:id/journey               the journey of this event's
 *                                         customer, explaining this event
 *   GET /customers/:userId/journey        the same, explaining ?eventId=
 *                                         or the customer's latest
 *                                         conversion
 */

import { Router } from 'express';
import { z } from '../zod.js';
import { TABLES, type EventRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { buildJourney } from '../journey.js';
import { tenantOf } from '../tenancy.js';

export const journeyRouter = Router();

/** The brand's userId, as identify() and conversions send it. */
export const MAX_JOURNEY_USER_ID = 512;

export const customerJourneyQuerySchema = z.object({
  eventId: z.string().min(1).max(64).optional(),
});

journeyRouter.get('/events/:id/journey', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const event = await db<EventRow>(TABLES.Event).where({ tenantId, id: req.params.id }).first('id', 'userId');
  if (!event) return res.status(404).json({ error: 'event_not_found' });
  const journey = await buildJourney(db, tenantId, event.userId, event.id);
  if (!journey) return res.status(404).json({ error: 'event_not_found' });
  res.json(journey);
});

journeyRouter.get('/customers/:userId/journey', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const userId = req.params.userId ?? '';
  if (userId.length === 0 || userId.length > MAX_JOURNEY_USER_ID) {
    return res.status(400).json({ error: 'invalid_user_id' });
  }
  const q = customerJourneyQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });
  const journey = await buildJourney(db, tenantId, userId, q.data.eventId);
  if (!journey) return res.status(404).json({ error: q.data.eventId ? 'event_not_found' : 'customer_not_found' });
  res.json(journey);
});
