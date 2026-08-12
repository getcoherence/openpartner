/**
 * Attribution engine.
 *
 * Walks: Event.userId → Identity[] → Click[] → Campaign (rules).
 *
 * The Identity table is multi-touch: every cref the SDK stitches against a
 * userId is recorded. For each event, we pull every click within the model's
 * window, then apply the model to distribute weight:
 *
 *   last_click  — 100% to the most-recent click
 *   first_click — 100% to the earliest click
 *   linear      — 1/N to each click
 *   position    — 40% first, 40% last, 20% split across the middle (U-shape)
 *
 * The attribution model comes from the Campaign of the most recent click
 * (rationale: the partner in "control" of the conversion is whichever one
 * the user most recently engaged with). Commission is accrued separately
 * per touch, proportional to the weight, using each click's own campaign's
 * commissionRule — partners don't subsidize each other.
 *
 * Idempotent: unique (eventId, model, clickId) blocks dup rows on retry.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type AttributionModel,
  type AttributionRow,
  type ProgramRow,
  type ClickRow,
  type CommissionRule,
  type CommissionSubRule,
  type EventRow,
  type IdentityRow,
} from '@openpartner/db';
import { dispatchEvent } from './webhook-dispatcher.js';

// Average month length used by the recurringMonths cap. We use 30.4375 days
// (365.25 / 12) so a "12 months" cap doesn't drift by an extra day every
// February. The cap fires when (event.ts - firstAttributedEventTs) exceeds
// this; we DON'T anchor on calendar months because that would require
// timezone reasoning the rest of the engine doesn't do.
const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;

// How far an event may predate its click and still attribute. Absorbs Stripe's
// whole-second `created` truncation and clock drift between whoever stamped the
// click and whoever stamped the event. See the age check in attributeEvent().
const CLICK_AFTER_EVENT_GRACE_MS = 5 * 60 * 1000;

export interface AttributeResult {
  status: 'attributed' | 'no_identity' | 'no_click' | 'outside_window' | 'already_attributed';
  touches?: Array<{ clickId: string; partnerId: string; weight: number; attributionId: string; commissionId?: string }>;
  model?: AttributionModel;
}

interface ClickWithCampaign extends ClickRow {
  campaign: ProgramRow;
}

export async function attributeEvent(
  db: Knex,
  event: EventRow,
  modelOverride?: AttributionModel,
): Promise<AttributeResult> {
  const identities = await db<IdentityRow>(TABLES.Identity).where({ userId: event.userId });
  if (identities.length === 0) return { status: 'no_identity' };

  const clickIds = identities.map((i) => i.clickId);
  const clicks = await db<ClickRow>(TABLES.Click).whereIn('id', clickIds);
  const cleanClicks = clicks.filter((c) => !c.fraudFlag);
  if (cleanClicks.length === 0) return { status: 'no_click' };

  // Revoked partners are excluded from attribution — any call landing
  // here (whether a live event webhook or a replay via
  // attributeBacklogForUser) skips them regardless of whether the event
  // timestamp predates the revoke. This matches the admin-intent of
  // "stop all earning for this partner going forward" and keeps backlog
  // re-runs from retroactively shifting weight around a revoked
  // partner. Historical attribution rows already in the table for the
  // partner aren't deleted on revoke — admin reverses those manually
  // via the commissions review queue if needed.
  const partnerIds = Array.from(new Set(cleanClicks.map((c) => c.partnerId)));
  const revokedPartners = await db('Partner').whereIn('id', partnerIds).whereNotNull('revokedAt').pluck('id');
  const revokedSet = new Set(revokedPartners as string[]);
  const eligibleByPartner = cleanClicks.filter((c) => !revokedSet.has(c.partnerId));
  if (eligibleByPartner.length === 0) return { status: 'no_click' };

  const programIds = Array.from(new Set(eligibleByPartner.map((c) => c.programId)));
  const campaigns = await db<ProgramRow>(TABLES.Program).whereIn('id', programIds);
  const campaignsById = new Map(campaigns.map((c) => [c.id, c]));

  // Clicks in-window relative to this event, with their campaign attached.
  const eligible: ClickWithCampaign[] = [];
  for (const click of eligibleByPartner) {
    const campaign = campaignsById.get(click.programId);
    if (!campaign) continue;
    const windowMs = campaign.attributionWindowDays * 24 * 60 * 60 * 1000;
    const ageMs = new Date(event.ts).getTime() - new Date(click.ts).getTime();
    // Outside the window OR a click that happened meaningfully AFTER the
    // event: a later click must never attribute an earlier conversion
    // (backlog / backdated events made negative ages pass the old one-sided
    // check).
    //
    // The grace is load-bearing, not slop. A genuine conversion can measure
    // slightly OLDER than the click that caused it for two ordinary reasons:
    // Stripe stamps `created` in whole SECONDS, so a conversion in the same
    // second as the click truncates to up to 999ms before it; and the clock
    // stamping Click.ts is not the clock stamping the event. A strict `< 0`
    // silently dropped both. What this rejects — a backdated backlog event
    // replayed against a newer click — is hours or months off, never minutes.
    if (ageMs < -CLICK_AFTER_EVENT_GRACE_MS || ageMs > windowMs) continue;
    eligible.push({ ...click, campaign });
  }
  if (eligible.length === 0) return { status: 'outside_window' };

  eligible.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  // Pick the model. Override wins; else use the most-recent click's campaign's model.
  const lastClick = eligible[eligible.length - 1]!;
  const model: AttributionModel = modelOverride ?? lastClick.campaign.attributionModel;

  const weights = applyModel(model, eligible.length);
  const touches = eligible.map((click, i) => ({ click, weight: weights[i]! }));

  const results: NonNullable<AttributeResult['touches']> = [];
  let allDup = true;

  for (const { click, weight } of touches) {
    if (weight === 0) continue;
    const attributionId = ulid();
    const insertRes = await db<AttributionRow>(TABLES.Attribution)
      .insert({
        id: attributionId,
        tenantId: event.tenantId,
        eventId: event.id,
        partnerId: click.partnerId,
        programId: click.programId,
        clickId: click.id,
        model,
        weight: weight.toFixed(4),
      })
      .onConflict(['eventId', 'model', 'clickId'])
      .ignore()
      .returning('id');

    if (insertRes.length === 0) continue; // dup — already attributed
    allDup = false;

    // Commission lifecycle gate: events dated after the campaign's
    // endsAt don't accrue. Attribution row stays for analytics — we
    // still want to know the click → conversion path was real — just
    // no payout. Pre-startsAt is similarly skipped (defensive; clicks
    // shouldn't exist for a not-yet-started campaign).
    const { commissionEarnable } = await import('./campaign-lifecycle.js');
    if (!commissionEarnable(click.campaign, new Date(event.ts))) {
      continue;
    }

    // Prefer the partner's snapshotted rule (set at PartnershipRequest
    // approval time via federation) over the live Campaign rule. This
    // is what makes "brand edits campaign rule post-approval" safe —
    // existing partners keep what they were approved under. Absent
    // snapshot = pre-snapshot partner OR non-Network partner; falls
    // back to the Campaign rule (status quo).
    const rules = await resolveCommissionRule(db, click.partnerId, click.campaign.commissionRule);

    // Walk every sub-rule. A single event may produce multiple Commission
    // rows (e.g., a `subscription_created` matches both a one-time bonus
    // and a recurring rule). Each sub-rule's eligibility is evaluated
    // independently against the same Event + Attribution.
    let firstCommissionId: string | undefined;
    for (const subRule of rules) {
      const baseAmount = await evaluateSubRule(db, subRule, event, click.partnerId);
      if (baseAmount === null) continue; // not eligible (filter / first / cap miss)
      const amount = baseAmount * weight;
      if (amount === 0) continue;

      const commissionId = ulid();
      await db(TABLES.Commission).insert({
        id: commissionId,
        tenantId: event.tenantId,
        attributionId,
        partnerId: click.partnerId,
        amount: amount.toFixed(2),
        currency: event.currency ?? 'USD',
        status: 'accrued',
      });
      if (!firstCommissionId) firstCommissionId = commissionId;

      dispatchEvent(event.tenantId, 'commission.accrued', {
        commissionId,
        partnerId: click.partnerId,
        attributionId,
        // clickId + eventId carry through to partner postback macros
        // ({click_id}, {event_id}, {transaction_id}). Tenant webhook
        // subscribers ignore them if they don't care.
        clickId: click.id,
        eventId: event.id,
        programId: click.programId,
        amount: amount.toFixed(2),
        currency: event.currency ?? 'USD',
        eventType: event.type,
        eventValue: event.value,
      });
    }

    // attribution.created fires once per Attribution regardless of how many
    // Commission rows it produced. commissionId/Amount in the payload
    // reflect the FIRST commission for backwards compat with subscribers
    // that key off a single commission per attribution; multi-rule consumers
    // should listen to commission.accrued.
    results.push({ clickId: click.id, partnerId: click.partnerId, weight, attributionId, commissionId: firstCommissionId });
    dispatchEvent(event.tenantId, 'attribution.created', {
      attributionId,
      eventId: event.id,
      partnerId: click.partnerId,
      programId: click.programId,
      clickId: click.id,
      model,
      weight,
      eventType: event.type,
      eventValue: event.value,
      commissionId: firstCommissionId,
      commissionCurrency: event.currency ?? 'USD',
    });
  }

  if (allDup) return { status: 'already_attributed', model };
  return { status: 'attributed', touches: results, model };
}

export async function attributeBacklogForUser(db: Knex, userId: string): Promise<number> {
  const events = await db<EventRow>(TABLES.Event).where({ userId }).orderBy('ts', 'asc');
  let attributed = 0;
  for (const event of events) {
    const result = await attributeEvent(db, event);
    if (result.status === 'attributed') attributed += 1;
  }
  return attributed;
}

export function applyModel(model: AttributionModel, n: number): number[] {
  if (n === 0) return [];
  const w = new Array<number>(n).fill(0);

  if (model === 'last_click') {
    w[n - 1] = 1;
    return w;
  }
  if (model === 'first_click') {
    w[0] = 1;
    return w;
  }
  if (model === 'linear') {
    return w.map(() => 1 / n);
  }
  if (model === 'position') {
    if (n === 1) return [1];
    if (n === 2) return [0.5, 0.5];
    w[0] = 0.4;
    w[n - 1] = 0.4;
    const middle = 0.2 / (n - 2);
    for (let i = 1; i < n - 1; i += 1) w[i] = middle;
    return w;
  }
  // Unknown model — fall back to last click.
  w[n - 1] = 1;
  return w;
}

/**
 * Tolerate both the array shape (post-compound-rules migration) and the
 * legacy single-object shape ({type, value, recurring?}). The single-object
 * fallback is what makes a half-applied migration non-catastrophic — the
 * 20260614000000 migration backfills Campaign rows but a pre-deploy app
 * version reading a post-migration row, or vice versa, still produces a
 * valid array.
 */
export function parseCommissionRule(raw: unknown): CommissionRule {
  if (Array.isArray(raw)) return raw as CommissionRule;
  if (raw && typeof raw === 'object' && 'type' in raw) {
    const r = raw as { type: 'percent' | 'fixed'; value: number; currency?: string; recurring?: boolean };
    return [{
      trigger: 'every',
      type: r.type,
      value: r.value,
      currency: r.currency,
      recurring: r.recurring,
    }];
  }
  throw new Error('Invalid commissionRule on Campaign');
}

/**
 * Look up the partner's snapshotted commission rule (set at
 * PartnershipRequest approval via federation, or backfilled by an
 * admin migration). Falls back to the live Campaign rule when no
 * snapshot exists — preserves status quo for non-Network partners
 * and partners onboarded before snapshots shipped.
 *
 * Snapshot lookup precedence:
 *   1. PartnerCommission.commissionRules (the array form, post-compound)
 *   2. PartnerCommission legacy columns (commissionType/commissionValue/
 *      recurring) — wrapped into a 1-element array for the engine
 *   3. Campaign.commissionRule (no snapshot exists)
 */
async function resolveCommissionRule(
  db: Knex,
  partnerId: string,
  campaignRule: unknown,
): Promise<CommissionRule> {
  const snapshot = await db<{
    commissionType: 'percent' | 'fixed';
    commissionValue: string;
    recurring: boolean;
    commissionRules: CommissionRule | null;
  }>(TABLES.PartnerCommission)
    .where({ partnerId })
    .first('commissionType', 'commissionValue', 'recurring', 'commissionRules');

  if (snapshot?.commissionRules) return snapshot.commissionRules;

  if (snapshot) {
    return [{
      trigger: 'every',
      type: snapshot.commissionType,
      value: Number(snapshot.commissionValue),
      recurring: snapshot.recurring,
    }];
  }

  return parseCommissionRule(campaignRule);
}

/**
 * Decide whether `subRule` fires for `event` and, if so, return the
 * pre-weight commission base amount. Returns null when the rule doesn't
 * apply to this event (type mismatch, first-trigger already fired, or
 * recurringMonths cap reached).
 *
 * Trigger checks issue one query each against (Attribution × Event); the
 * indexes on Attribution(partnerId) + Event(userId) keep this O(log n).
 * The cap check piggybacks on the same join so it's a second small query.
 */
async function evaluateSubRule(
  db: Knex,
  subRule: CommissionSubRule,
  event: EventRow,
  partnerId: string,
): Promise<number | null> {
  if (subRule.eventType && subRule.eventType !== event.type) return null;

  if (subRule.trigger === 'first' || subRule.trigger === 'subsequent') {
    // "Has this (partner, user, eventType) been attributed before?"
    // first      → fire only when there's NO prior attribution
    // subsequent → fire only when there IS a prior attribution
    // Refunds don't re-arm the lookup; if a brand wants a refund to
    // re-trigger the bonus they'd reverse the prior commission and
    // re-attribute, consistent with how holdback works.
    const prior = await db(TABLES.Attribution)
      .join(TABLES.Event, `${TABLES.Event}.id`, `${TABLES.Attribution}.eventId`)
      .where(`${TABLES.Attribution}.partnerId`, partnerId)
      .andWhere(`${TABLES.Event}.userId`, event.userId)
      .andWhere(`${TABLES.Event}.type`, event.type)
      .andWhere(`${TABLES.Event}.ts`, '<', event.ts)
      .first(`${TABLES.Event}.id`);
    if (subRule.trigger === 'first' && prior) return null;
    if (subRule.trigger === 'subsequent' && !prior) return null;
  }

  if (subRule.recurring && subRule.recurringMonths != null) {
    const first = (await db(TABLES.Attribution)
      .join(TABLES.Event, `${TABLES.Event}.id`, `${TABLES.Attribution}.eventId`)
      .where(`${TABLES.Attribution}.partnerId`, partnerId)
      .andWhere(`${TABLES.Event}.userId`, event.userId)
      .andWhere(`${TABLES.Event}.type`, event.type)
      .orderBy(`${TABLES.Event}.ts`, 'asc')
      .first(`${TABLES.Event}.ts as ts`)) as { ts: Date | string } | undefined;
    if (first) {
      const firstMs = new Date(first.ts).getTime();
      const eventMs = new Date(event.ts).getTime();
      if (eventMs - firstMs > subRule.recurringMonths * MONTH_MS) return null;
    }
  }

  return computeSubRuleAmount(subRule, event);
}

/** Pure dollar amount for one sub-rule against one event. No trigger
 *  evaluation — caller is responsible for that. Exported so tests can
 *  exercise the math without a database. */
export function computeSubRuleAmount(
  subRule: CommissionSubRule,
  event: Pick<EventRow, 'value'>,
): number {
  if (subRule.type === 'fixed') return subRule.value;
  const revenue = event.value ? Number(event.value) : 0;
  return Math.round(revenue * subRule.value) / 100;
}
