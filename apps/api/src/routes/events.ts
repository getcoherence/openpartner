import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type EventRow } from '@openpartner/db';
import { attributeEvent } from '../attribution.js';
import { grantScope, requireAdmin, requireAuth } from '../auth.js';
import { sameConversion, storedAttribution } from '../conversion-ingest.js';
import { tenantOf } from '../tenancy.js';

const schema = z.object({
  userId: z.string().min(1),
  type: z.string().min(1),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  metadata: z.record(z.unknown()).optional(),
  ts: z.string().datetime().optional(),
  /** Idempotency key — the source system's stable id for this one event
   *  (order id, invoice id, CRM deal-stage change id). A retry with the
   *  same key replays the original result instead of inserting a second
   *  Event and commissioning it again. One per-tenant namespace shared
   *  with /coupons/redeem and Stripe webhook event ids.
   *
   *  The field was silently ignored before it existed, so inputs no-code
   *  tools commonly send must not start failing: an unmapped Zapier/Make
   *  field ("" or null) means no key, and a numeric order id is its string. */
  externalEventId: z.preprocess(
    (v) =>
      v === null || (typeof v === 'string' && v.trim() === '')
        ? undefined
        : typeof v === 'number' && Number.isFinite(v)
          ? String(v)
          : v,
    z.string().min(1).max(120).optional(),
  ),
});

export const eventsRouter = Router();

// Server-to-server conversion event ingest — requires admin credentials
// (this is the merchant's backend speaking, not a browser). A scoped key
// with `events:write` is also accepted so brands can wire CRMs / Zapier /
// HubSpot workflows into this route without sharing a full admin key.
eventsRouter.post('/attribution/events', requireAuth, grantScope('events:write'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = schema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const eventId = ulid();
  const { userId, type, value, currency, metadata, ts, externalEventId } = body.data;
  const row = {
    id: eventId,
    tenantId,
    userId,
    type,
    value: value != null ? value.toFixed(2) : null,
    currency: currency ?? 'USD',
    externalEventId: externalEventId ?? null,
    metadata: metadata ?? {},
    ts: ts ? new Date(ts) : new Date(),
  };

  // Idempotency rides the (tenantId, externalEventId) unique constraint, not
  // a read-then-write. The whole request is one transaction (tenantMiddleware),
  // so a concurrent duplicate's INSERT blocks on the first request's
  // uncommitted row and no-ops once it commits — by then the first request's
  // Attribution + Commission rows are committed too. Without a key the column
  // is NULL, which never conflicts: every POST inserts, as before.
  const [event] = (await db<EventRow>(TABLES.Event)
    .insert(row)
    .onConflict(['tenantId', 'externalEventId'])
    .ignore()
    .returning('*')) as EventRow[];

  if (!event) {
    const existing = await db<EventRow>(TABLES.Event).where({ tenantId, externalEventId: row.externalEventId }).first();
    if (!existing) throw new Error(`externalEventId conflict with no visible Event row (${row.externalEventId})`);
    if (!sameConversion(existing, row)) {
      return res.status(409).json({
        error: 'external_event_id_conflict',
        eventId: existing.id,
        detail: 'externalEventId was already used for an event with a different userId, type, value or currency',
      });
    }
    return res.json({ ok: true, replayed: true, eventId: existing.id, attribution: await storedAttribution(db, existing.id) });
  }

  const result = await attributeEvent(db, event);
  res.json({ ok: true, eventId, attribution: result });
});
