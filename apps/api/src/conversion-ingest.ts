/**
 * Conversion ingest shared by the server-to-server routes.
 *
 * Every route that records an Event on a caller's behalf is idempotent on
 * the caller's externalEventId, with one per-tenant key namespace shared by
 * /attribution/events, /attribution/conversions, /postback, /coupons/redeem
 * and Stripe webhook event ids. The (tenantId, externalEventId) unique
 * constraint is the arbiter, so concurrent duplicates insert once.
 *
 * recordClickConversion is the one-call path for callers that hold a click
 * id but never saw an identify() (a lender reporting a funded loan, a CRM,
 * an affiliate network's postback): it stitches the click and records the
 * event in the request's transaction.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type AttributionRow,
  type ClickRow,
  type CommissionRow,
  type EventRow,
  type IdentityRow,
  type ProgramRow,
} from '@openpartner/db';
import { attributeEvent, resolveCommissionRule, ruleTakesEventType, type AttributeResult } from './attribution.js';
import { ingestCurrency, rowCurrency } from './currency.js';

/**
 * A replay must describe the same conversion. Reusing a key for a different
 * one is a caller bug, and replaying would silently drop the new event, so it
 * 409s instead. metadata and ts aren't compared: a retry that omits ts gets a
 * fresh server timestamp. Currencies compare upper-cased, and a stored null
 * (coupon redemptions before currencies were stored) ≡ USD, as the
 * attribution engine treats it.
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
    rowCurrency(existing.currency) === rowCurrency(incoming.currency)
  );
}

export type ReplayedAttribution = Omit<AttributeResult, 'status'> & { status: 'attributed' | 'not_attributed' };

/**
 * Rebuild a replayed event's attribution result from the rows the first
 * request wrote, rather than re-running attributeEvent — a replay mutates
 * nothing. A miss leaves no row, so which one it was (no_identity / no_click /
 * outside_window) isn't recoverable: that reports 'not_attributed'. Weights
 * come back at their stored 4-dp precision. `commission` is 'accrued' when
 * the first request wrote a commission; otherwise it's checked against the
 * rules as they are now, so a retried typo still hears `no_matching_rule`.
 */
export async function storedAttribution(db: Knex, eventId: string): Promise<ReplayedAttribution> {
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
    commission: commissions.length > 0 ? 'accrued' : await unpaidReason(db, eventId, touches),
  };
}

async function unpaidReason(
  db: Knex,
  eventId: string,
  touches: AttributionRow[],
): Promise<'none' | 'no_matching_rule'> {
  const event = await db<EventRow>(TABLES.Event).where({ id: eventId }).first('type');
  const programs = await db<ProgramRow>(TABLES.Program)
    .whereIn('id', [...new Set(touches.map((t) => t.programId))])
    .select('id', 'commissionRule');
  for (const touch of touches) {
    const program = programs.find((p) => p.id === touch.programId);
    if (!program || !event) continue;
    const rules = await resolveCommissionRule(db, touch.partnerId, touch.programId, program.commissionRule);
    if (rules.some((r) => ruleTakesEventType(r, event.type))) return 'none';
  }
  return 'no_matching_rule';
}

/**
 * The user a click's conversions are recorded under when the caller has no
 * user id of its own. Deterministic, so every conversion reported for the
 * click lands on one user: a "first" commission rule fires once, and a
 * retry stitches nothing new.
 */
export function clickUserId(clickId: string): string {
  return `click:${clickId}`;
}

export interface ClickConversionInput {
  clickId: string;
  /** The caller's own user id. Omitted → clickUserId(clickId). */
  userId?: string;
  type: string;
  value?: number;
  currency?: string;
  externalEventId: string;
  metadata?: Record<string, unknown>;
  ts?: Date;
}

export type ClickConversionResult =
  | { ok: true; replayed: false; eventId: string; userId: string; attribution: AttributeResult }
  | { ok: true; replayed: true; eventId: string; userId: string; attribution: ReplayedAttribution }
  | { ok: false; status: 404; error: 'click_not_found' }
  | { ok: false; status: 422; error: 'click_flagged'; fraudFlag: string }
  | { ok: false; status: 409; error: 'external_event_id_conflict'; eventId: string };

/**
 * Record a conversion against a click in one step: stitch the click to the
 * user (the caller's, or the click's own synthetic user) and record the
 * Event, then attribute it. Runs on the caller's transaction, so the stitch
 * and the event commit together or not at all.
 *
 * With the caller's userId, attribution follows the program's model across
 * every click that user is stitched to, as it does for /attribution/events.
 * Without one, the click's synthetic user has this click alone.
 *
 * Only the new event is attributed. Events recorded for the user before this
 * stitch stay as they are; /attribution/identify is the call that backfills.
 *
 * A retry with the same externalEventId replays the original result, even if
 * the click has been flagged since. Reusing the key for a different click or
 * conversion is a 409.
 */
export async function recordClickConversion(
  db: Knex,
  tenantId: string,
  input: ClickConversionInput,
): Promise<ClickConversionResult> {
  // Explicit tenant filter rather than RLS alone: the app pool falls back to
  // the privileged role when DATABASE_URL_APP is unset (see auth.ts).
  const click = await db<ClickRow>(TABLES.Click).where({ id: input.clickId, tenantId }).first();
  if (!click) return { ok: false, status: 404, error: 'click_not_found' };

  const userId = input.userId ?? clickUserId(click.id);
  const row = {
    id: ulid(),
    tenantId,
    userId,
    type: input.type,
    value: input.value != null ? input.value.toFixed(2) : null,
    currency: await ingestCurrency(db, tenantId, input.currency),
    externalEventId: input.externalEventId,
    metadata: input.metadata ?? {},
    ts: input.ts ?? new Date(),
  };

  const existing = await db<EventRow>(TABLES.Event).where({ tenantId, externalEventId: row.externalEventId }).first();
  if (existing) return replay(db, existing, row, click.id);

  // Flagged clicks (velocity, revoked partner) record nothing. Checked after
  // the replay lookup so a retry still gets its original answer.
  if (click.fraudFlag) return { ok: false, status: 422, error: 'click_flagged', fraudFlag: click.fraudFlag };

  // As in /attribution/events: a concurrent duplicate's INSERT blocks on this
  // request's uncommitted row, then no-ops and replays once it commits.
  const [event] = (await db<EventRow>(TABLES.Event)
    .insert(row)
    .onConflict(['tenantId', 'externalEventId'])
    .ignore()
    .returning('*')) as EventRow[];
  if (!event) {
    const winner = await db<EventRow>(TABLES.Event).where({ tenantId, externalEventId: row.externalEventId }).first();
    if (!winner) throw new Error(`externalEventId conflict with no visible Event row (${row.externalEventId})`);
    return replay(db, winner, row, click.id);
  }

  await db<IdentityRow>(TABLES.Identity)
    .insert({ id: ulid(), tenantId, clickId: click.id, userId })
    .onConflict(['clickId', 'userId'])
    .ignore();

  const attribution = await attributeEvent(db, event);
  return { ok: true, replayed: false, eventId: event.id, userId, attribution };
}

async function replay(
  db: Knex,
  existing: EventRow,
  incoming: { userId: string; type: string; value: string | null; currency: string | null },
  clickId: string,
): Promise<ClickConversionResult> {
  // The key must have been used for this click, not just this user: a
  // caller-supplied userId can be stitched to several clicks.
  const stitched = await db<IdentityRow>(TABLES.Identity).where({ clickId, userId: existing.userId }).first('id');
  if (!sameConversion(existing, incoming) || !stitched) {
    return { ok: false, status: 409, error: 'external_event_id_conflict', eventId: existing.id };
  }
  return {
    ok: true,
    replayed: true,
    eventId: existing.id,
    userId: existing.userId,
    attribution: await storedAttribution(db, existing.id),
  };
}
