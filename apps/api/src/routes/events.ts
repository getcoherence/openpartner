import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type EventRow } from '@openpartner/db';
import { attributeEvent } from '../attribution.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';

const schema = z.object({
  userId: z.string().min(1),
  type: z.string().min(1),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  metadata: z.record(z.unknown()).optional(),
  ts: z.string().datetime().optional(),
});

export const eventsRouter = Router();

// Server-to-server conversion event ingest — requires admin credentials
// (this is the merchant's backend speaking, not a browser).
eventsRouter.post('/attribution/events', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = schema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const eventId = ulid();
  const { userId, type, value, currency, metadata, ts } = body.data;

  const [event] = await db<EventRow>(TABLES.Event)
    .insert({
      id: eventId,
      tenantId,
      userId,
      type,
      value: value != null ? value.toFixed(2) : null,
      currency: currency ?? 'USD',
      metadata: metadata ?? {},
      ts: ts ? new Date(ts) : new Date(),
    })
    .returning('*');

  const result = await attributeEvent(db, event as EventRow);
  res.json({ ok: true, eventId, attribution: result });
});
