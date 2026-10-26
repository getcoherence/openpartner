/**
 * A customer's journey: every partner touch linked to them, their events,
 * and for one conversion who got credit and why (GET /events/:id/journey,
 * GET /customers/:userId/journey, routes/journey.ts).
 *
 * A dashboard says who "won" a conversion. An affiliate manager looking
 * into a dispute or a suspicious partner needs the evidence: Affiliate A's
 * click, Affiliate B's click twelve days later, the code used at checkout,
 * then the sale, and which rule picked the winner. This is that view.
 *
 * Derived on read, nothing stored. The touches come from the raw Click and
 * Identity rows; the explanation comes from decideAttribution(), the same
 * function attributeEvent() runs, so it can't drift from the engine; the
 * credit comes from the recorded Attribution and Commission rows, which
 * stay the ledger's truth. When today's data would decide differently
 * (a click linked or flagged since), the decision says so instead of
 * quietly showing a different winner.
 *
 * What it can't show: anything that isn't a partner touch. Paid search,
 * organic and direct visits never reach OpenPartner, so they're gaps in
 * the path, not steps.
 */

import type { Knex } from 'knex';
import {
  TABLES,
  type AttributionModel,
  type AttributionRow,
  type ClickLandingRow,
  type ClickRow,
  type CommissionRow,
  type EventRow,
  type IdentityRow,
} from '@openpartner/db';
import { CORRECTIVE_EVENT_TYPES, applyModel, decideAttribution, isCouponClick, type ClickVerdict } from './attribution.js';
import { parseUserAgent } from './ua-parse.js';

/** The newest touches and events a journey lists. A customer past either
 *  is unusual; the response says when it was cut. */
export const JOURNEY_MAX_TOUCHES = 200;
export const JOURNEY_MAX_EVENTS = 200;

/** Every model, in the order the alternatives list them. */
export const JOURNEY_MODELS: readonly AttributionModel[] = ['last_click', 'first_click', 'linear', 'position'];

export interface JourneyTouch {
  clickId: string;
  /** link: a click on a partner link. code: a partner's code redeemed at
   *  checkout (a synthetic click, stamped when the code was used). */
  kind: 'link' | 'code';
  ts: string;
  partner: { id: string; name: string | null };
  program: { id: string; name: string | null };
  /** kind code: the code. */
  code: string | null;
  /** kind link: where the link sent the visitor. */
  landingUrl: string | null;
  /** kind link: when the script on that page reported the landing. */
  landedAt: string | null;
  referer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  subId: string | null;
  browser: string | null;
  device: string | null;
  country: string | null;
  /** When the click was linked to this customer (identify, a checkout
   *  carrying it, the code redemption). */
  linkedAt: string | null;
  /** Fraud-flagged: never counts, for any conversion. */
  flagged: boolean;
}

export interface JourneyEvent {
  id: string;
  type: string;
  ts: string;
  value: number | null;
  currency: string | null;
  /** A refund, chargeback or failed payment: recorded, never attributed. */
  corrective: boolean;
  /** Who the recorded attribution credits, under the model it was decided by. */
  credited: Array<{ partnerId: string; partnerName: string | null; weight: number }>;
}

/** Why one touch did or didn't count for the selected conversion. */
export type JourneyVerdict = ClickVerdict | 'credited';

export interface JourneyDecision {
  eventId: string;
  /**
   * What today's data decides for this conversion:
   *   credited        some touch gets credit
   *   corrective      a refund or similar: never attributed
   *   no_identity     the customer was never linked to a partner click
   *   no_click        every linked click is flagged or its partner revoked
   *   outside_window  no linked click could take it (each is outside its
   *                   window, came after the event, or lost its program),
   *                   and no earlier conversion carries the customer
   */
  status: 'credited' | 'corrective' | 'no_identity' | 'no_click' | 'outside_window';
  /** How the credit was decided (attribution.ts AttributionDecision.source). */
  source: 'window' | 'renewal' | 'latest_conversion' | null;
  model: AttributionModel | null;
  /** How many touches were in the window: the model's input when the
   *  window decided. Counts every linked click, also past the touch cap. */
  candidates: number;
  /** The earlier conversion a renewal or latest_conversion decision came from. */
  fromEvent: { id: string; type: string; ts: string } | null;
  touches: Array<{
    clickId: string;
    verdict: JourneyVerdict;
    /** Its share of the credit today; null when it isn't in the decision. */
    weight: number | null;
    /** Credited through an earlier conversion although older than the window. */
    pastWindow: boolean;
    /** Seconds from the touch to this conversion; negative when it came after. */
    secondsBeforeEvent: number;
    /** Linked to the customer after this conversion happened. */
    linkedAfterEvent: boolean;
  }>;
  /** The Attribution rows written for this conversion, with what they
   *  earned. What was actually credited and paid. */
  recorded: Array<{
    attributionId: string;
    clickId: string;
    partnerId: string;
    partnerName: string | null;
    model: AttributionModel;
    weight: number;
    computedAt: string;
    commissions: Array<{
      id: string;
      partnerId: string;
      partnerName: string | null;
      amount: string;
      currency: string;
      status: CommissionRow['status'];
      /** A recruiter's share of the partner's commission (two-tier). */
      recruiter: boolean;
    }>;
  }>;
  /** False when today's data credits differently from the record: a click
   *  linked, flagged or revoked since, or nothing recorded at all. */
  matchesRecord: boolean;
  /** Who each model credits over the same in-window touches. Only when the
   *  window decided (source `window`); a renewal keeps an earlier
   *  conversion's touches whatever the model. */
  alternatives: Array<{ model: AttributionModel; live: boolean; credits: Array<{ partnerId: string; partnerName: string | null; weight: number }> }> | null;
}

export interface Journey {
  userId: string;
  touches: JourneyTouch[];
  events: JourneyEvent[];
  selected: JourneyDecision | null;
  truncated: { touches: boolean; events: boolean };
}

const iso = (d: Date | string): string => new Date(d).toISOString();
const ms = (d: Date | string): number => new Date(d).getTime();

/** A weight as stored (4 decimals) or computed, as a plain number to 4 dp. */
const round4 = (w: number): number => Math.round(w * 10_000) / 10_000;

/**
 * The journey of `userId`, with the decision for `eventId` (or, without
 * one, for their latest conversion). Null when the tenant has neither a
 * linked click nor an event for the customer.
 */
export async function buildJourney(
  db: Knex,
  tenantId: string,
  userId: string,
  eventId?: string,
): Promise<Journey | null> {
  // Explicit tenant on every read: RLS scopes `db`, but a pool without the
  // app role would otherwise read another brand's customer of the same id.
  const identities = await db<IdentityRow>(TABLES.Identity).where({ tenantId, userId });
  const linkedAt = new Map<string, Date>();
  for (const i of identities) {
    const prev = linkedAt.get(i.clickId);
    if (!prev || ms(i.stitchedAt) < ms(prev)) linkedAt.set(i.clickId, i.stitchedAt);
  }

  const clickIds = [...linkedAt.keys()];
  const allClicks = clickIds.length
    ? await db<ClickRow>(TABLES.Click).where({ tenantId }).whereIn('id', clickIds).orderBy([{ column: 'ts', order: 'asc' }, { column: 'id', order: 'asc' }])
    : [];
  const clicks = allClicks.slice(-JOURNEY_MAX_TOUCHES);

  const eventRows = await db<EventRow>(TABLES.Event)
    .where({ tenantId, userId })
    .orderBy([{ column: 'ts', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(JOURNEY_MAX_EVENTS + 1);
  const eventsTruncated = eventRows.length > JOURNEY_MAX_EVENTS;
  const events = eventRows.slice(0, JOURNEY_MAX_EVENTS);

  // The event to explain: the one asked for, else the customer's latest
  // conversion, looked up on its own so a run of newer refunds past the
  // cap can't push it out. Listed even when older than the newest 200.
  let selectedEvent: EventRow | null;
  if (eventId) {
    selectedEvent = (await db<EventRow>(TABLES.Event).where({ tenantId, userId, id: eventId }).first()) ?? null;
    if (!selectedEvent) return null;
  } else {
    selectedEvent =
      (await db<EventRow>(TABLES.Event)
        .where({ tenantId, userId })
        .whereNotIn('type', [...CORRECTIVE_EVENT_TYPES])
        .orderBy([{ column: 'ts', order: 'desc' }, { column: 'id', order: 'desc' }])
        .first()) ??
      events[0] ??
      null;
  }
  if (selectedEvent && !events.some((e) => e.id === selectedEvent!.id)) events.push(selectedEvent);
  events.sort((a, b) => ms(a.ts) - ms(b.ts) || a.id.localeCompare(b.id));

  if (allClicks.length === 0 && events.length === 0) return null;

  // Names, landings and the recorded attribution, in batches.
  const attributions = events.length
    ? await db<AttributionRow>(TABLES.Attribution)
        .where({ tenantId })
        .whereIn('eventId', events.map((e) => e.id))
        .orderBy([{ column: 'computedAt', order: 'asc' }, { column: 'id', order: 'asc' }])
    : [];
  const partnerIds = new Set<string>([...allClicks.map((c) => c.partnerId), ...attributions.map((a) => a.partnerId)]);
  const commissions = selectedEvent
    ? await db<CommissionRow>(TABLES.Commission)
        .where({ tenantId })
        .whereIn('attributionId', attributions.filter((a) => a.eventId === selectedEvent!.id).map((a) => a.id))
        .orderBy('id', 'asc')
    : [];
  for (const c of commissions) partnerIds.add(c.partnerId);
  const partnerNames = await namesById(db, TABLES.Partner, tenantId, [...partnerIds]);
  const programNames = await namesById(db, TABLES.Program, tenantId, [...new Set(clicks.map((c) => c.programId))]);
  const landings = clicks.length
    ? await db<ClickLandingRow>(TABLES.ClickLanding).where({ tenantId }).whereIn('clickId', clicks.map((c) => c.id))
    : [];
  const landedAt = new Map(landings.map((l) => [l.clickId, l.landedAt]));

  const touches: JourneyTouch[] = clicks.map((c) => {
    const code = isCouponClick(c) ? c.landingUrl.slice('coupon://'.length) : null;
    const ua = c.userAgent ? parseUserAgent(c.userAgent) : null;
    return {
      clickId: c.id,
      kind: code === null ? 'link' : 'code',
      ts: iso(c.ts),
      partner: { id: c.partnerId, name: partnerNames.get(c.partnerId) ?? null },
      program: { id: c.programId, name: programNames.get(c.programId) ?? null },
      code,
      landingUrl: code === null ? c.landingUrl : null,
      landedAt: landedAt.has(c.id) ? iso(landedAt.get(c.id)!) : null,
      referer: c.referer,
      utmSource: c.utmSource,
      utmMedium: c.utmMedium,
      utmCampaign: c.utmCampaign,
      subId: c.subId,
      browser: ua?.browser ?? null,
      device: ua?.device ?? null,
      country: c.country,
      linkedAt: linkedAt.has(c.id) ? iso(linkedAt.get(c.id)!) : null,
      flagged: Boolean(c.fraudFlag),
    };
  });

  // The model an event was decided by is its first-computed one; rows of
  // another model come from a modelOverride re-run (attribution.ts).
  const liveRows = new Map<string, AttributionRow[]>();
  for (const a of attributions) {
    const rows = liveRows.get(a.eventId);
    if (!rows) liveRows.set(a.eventId, [a]);
    else if (rows[0]!.model === a.model) rows.push(a);
  }
  const creditsOf = (rows: AttributionRow[]) =>
    rows.map((a) => ({ partnerId: a.partnerId, partnerName: partnerNames.get(a.partnerId) ?? null, weight: round4(Number(a.weight)) }));

  const journeyEvents: JourneyEvent[] = events.map((e) => ({
    id: e.id,
    type: e.type,
    ts: iso(e.ts),
    value: e.value != null ? Number(e.value) : null,
    currency: e.currency,
    corrective: CORRECTIVE_EVENT_TYPES.has(e.type),
    credited: creditsOf(liveRows.get(e.id) ?? []),
  }));

  const selected = selectedEvent
    ? await explain(db, selectedEvent, { allClicks, linkedAt, attributions, commissions, partnerNames, events })
    : null;

  return {
    userId,
    touches,
    events: journeyEvents,
    selected,
    truncated: { touches: allClicks.length > clicks.length, events: eventsTruncated },
  };
}

async function explain(
  db: Knex,
  event: EventRow,
  ctx: {
    allClicks: ClickRow[];
    linkedAt: Map<string, Date>;
    attributions: AttributionRow[];
    commissions: CommissionRow[];
    partnerNames: Map<string, string>;
    events: EventRow[];
  },
): Promise<JourneyDecision> {
  const outcome = await decideAttribution(db, event);
  const decision = outcome.decision;
  const nameOf = (id: string) => ctx.partnerNames.get(id) ?? null;

  const weightOf = new Map<string, { weight: number; pastWindow: boolean }>();
  for (const t of decision?.touches ?? []) weightOf.set(t.click.id, { weight: t.weight, pastWindow: t.pastWindow });

  const eventMs = ms(event.ts);
  // A corrective event is never attributed, so no touch has a verdict for it.
  const listed = outcome.status === 'corrective' ? [] : ctx.allClicks.slice(-JOURNEY_MAX_TOUCHES);
  const touches: JourneyDecision['touches'] = listed.map((c) => {
    const inDecision = weightOf.get(c.id);
    // decideAttribution gives every linked click a verdict; the fallback
    // only covers a click it never read.
    const verdict: JourneyVerdict =
      inDecision && inDecision.weight > 0 ? 'credited' : (outcome.trace.verdicts.get(c.id) ?? (c.fraudFlag ? 'flagged' : 'outside_window'));
    const linked = ctx.linkedAt.get(c.id);
    return {
      clickId: c.id,
      verdict,
      weight: inDecision ? round4(inDecision.weight) : null,
      pastWindow: inDecision?.pastWindow ?? false,
      secondsBeforeEvent: Math.round((eventMs - ms(c.ts)) / 1000),
      linkedAfterEvent: linked ? ms(linked) > eventMs : false,
    };
  });

  const recordedRows = ctx.attributions.filter((a) => a.eventId === event.id);
  const recorded: JourneyDecision['recorded'] = recordedRows.map((a) => ({
    attributionId: a.id,
    clickId: a.clickId,
    partnerId: a.partnerId,
    partnerName: nameOf(a.partnerId),
    model: a.model,
    weight: round4(Number(a.weight)),
    computedAt: iso(a.computedAt),
    commissions: ctx.commissions
      .filter((c) => c.attributionId === a.id)
      .map((c) => ({
        id: c.id,
        partnerId: c.partnerId,
        partnerName: nameOf(c.partnerId),
        amount: c.amount,
        currency: c.currency,
        status: c.status,
        recruiter: c.sourceCommissionId != null,
      })),
  }));

  // Today's credit against the record's (its first-computed model's rows).
  // Who gets what share is compared, not the model's name: a program
  // moved from last click to linear credits a lone click the same way.
  const live = recordedRows.filter((a) => a.model === recordedRows[0]?.model);
  const recordedSet = live.map((a) => `${a.clickId}:${round4(Number(a.weight))}`).sort();
  const decidedSet = (decision?.touches ?? [])
    .filter((t) => t.weight > 0)
    .map((t) => `${t.click.id}:${round4(t.weight)}`)
    .sort();
  const matchesRecord = recordedSet.length === decidedSet.length && recordedSet.every((v, i) => v === decidedSet[i]);

  let fromEvent: JourneyDecision['fromEvent'] = null;
  if (decision?.fromEventId) {
    const from = ctx.events.find((e) => e.id === decision.fromEventId) ?? (await db<EventRow>(TABLES.Event).where({ tenantId: event.tenantId, id: decision.fromEventId }).first());
    if (from) fromEvent = { id: from.id, type: from.type, ts: iso(from.ts) };
  }

  let alternatives: JourneyDecision['alternatives'] = null;
  if (decision?.source === 'window') {
    const candidates = outcome.trace.candidates;
    alternatives = JOURNEY_MODELS.map((model) => {
      const weights = applyModel(model, candidates.length);
      const byPartner = new Map<string, number>();
      candidates.forEach((c, i) => byPartner.set(c.partnerId, (byPartner.get(c.partnerId) ?? 0) + weights[i]!));
      const credits = [...byPartner.entries()]
        .filter(([, w]) => w > 0)
        .map(([partnerId, w]) => ({ partnerId, partnerName: nameOf(partnerId), weight: round4(w) }))
        .sort((a, b) => b.weight - a.weight || a.partnerId.localeCompare(b.partnerId));
      return { model, live: model === decision.model, credits };
    });
  }

  return {
    eventId: event.id,
    status: outcome.status === 'decided' ? 'credited' : outcome.status,
    source: decision?.source ?? null,
    model: decision?.model ?? null,
    candidates: outcome.trace.candidates.length,
    fromEvent,
    touches,
    recorded,
    matchesRecord,
    alternatives,
  };
}

async function namesById(db: Knex, table: string, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = (await db(table).where({ tenantId }).whereIn('id', ids).select('id', 'name')) as Array<{ id: string; name: string }>;
  return new Map(rows.map((r) => [r.id, r.name]));
}
