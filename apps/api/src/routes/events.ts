import { Router } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type AttributionRow, type CommissionRow, type EventRow } from '@openpartner/db';
import { attributeEvent, type AttributeResult } from '../attribution.js';
import { grantScope, requireAdmin, requireAuth } from '../auth.js';
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

/**
 * A replay must describe the same conversion. Reusing a key for a different
 * one is a caller bug, and replaying would silently drop the new event, so it
 * 409s instead. metadata and ts aren't compared: a retry that omits ts gets a
 * fresh server timestamp. Currency null ≡ USD, as the attribution engine
 * treats it (coupon redemptions store null). Shared with /coupons/redeem —
 * the key namespace is per tenant across both routes.
 */
export function sameConversion(
  existing: EventRow,
  incoming: { userId: string; type: string; value: string | null; currency: string | null },
): boolean {
  const sameValue =
    existing.value === null || incoming.value === null
      ? existing.value === incoming.value
      : Number(existing.value) === Number(incoming.value);
  return (
    existing.userId === incoming.userId &&
    existing.type === incoming.type &&
    sameValue &&
    (existing.currency ?? 'USD') === (incoming.currency ?? 'USD')
  );
}

type ReplayedAttribution = Omit<AttributeResult, 'status'> & { status: 'attributed' | 'not_attributed' };

/**
 * Rebuild a replayed event's attribution result from the rows the first
 * request wrote, rather than re-running attributeEvent — a replay mutates
 * nothing. A miss leaves no row, so which one it was (no_identity / no_click /
 * outside_window) isn't recoverable: that reports 'not_attributed'. Weights
 * come back at their stored 4-dp precision.
 */
async function storedAttribution(db: Knex, eventId: string): Promise<ReplayedAttribution> {
  // Touch order matches attributeEvent's (click ts ascending). computedAt
  // first: if the event was ever re-derived under another model, the earliest
  // computation is the one the original request returned.
  const rows = (await db<AttributionRow>(TABLES.Attribution)
    .join(TABLES.Click, `${TABLES.Click}.id`, `${TABLES.Attribution}.clickId`)
    .where(`${TABLES.Attribution}.eventId`, eventId)
    .orderBy([
      { column: `${TABLES.Attribution}.computedAt`, order: 'asc' },
      { column: `${TABLES.Click}.ts`, order: 'asc' },
    ])
    .select(`${TABLES.Attribution}.*`)) as AttributionRow[];
  if (rows.length === 0) return { status: 'not_attributed' };

  const model = rows[0]!.model;
  const touches = rows.filter((r) => r.model === model);
  const commissions = await db<CommissionRow>(TABLES.Commission)
    .whereIn('attributionId', touches.map((t) => t.id))
    .orderBy('id', 'asc')
    .select('id', 'attributionId');
  // One commission per touch in the response, as attributeEvent reports it.
  const commissionByAttribution = new Map<string, string>();
  for (const c of commissions) {
    if (!commissionByAttribution.has(c.attributionId)) commissionByAttribution.set(c.attributionId, c.id);
  }

  return {
    status: 'attributed',
    model,
    touches: touches.map((t) => ({
      clickId: t.clickId,
      partnerId: t.partnerId,
      weight: Number(t.weight),
      attributionId: t.id,
      commissionId: commissionByAttribution.get(t.id),
    })),
  };
}
