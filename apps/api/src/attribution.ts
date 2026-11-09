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
 * Renewals (Program.renewalsStayWithPartner, on by default): the window
 * decides ACQUISITION only. An event of a type the customer has already
 * converted on reuses the touches (click, partner, weight, model) of the
 * customer's first attributed event of that type, however old the click.
 * Nothing is stored to make that happen: the earlier conversion is read
 * back from the Attribution × Event rows, so a re-run derives the same
 * answer. Full rules and edge cases: docs/renewal-attribution.md.
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
import { onCommit } from './on-commit.js';
import type { WebhookPayload } from './openapi/webhook-events.js';
import { accrueSlabRule, commissionMetadata, type SubRuleAccrual } from './commission-slabs.js';
import { rowCurrency } from './currency.js';
import { accrueRecruiterCommission } from './recruiter-commissions.js';

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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Event types that correct an earlier conversion rather than being one.
 * They're recorded for the audit trail with a NEGATIVE value (the Stripe
 * webhook and POST /attribution/refunds handle any clawback themselves,
 * through refunds.ts) and are never attributed: a percent rule would accrue
 * a negative commission — a second clawback — and a fixed rule would pay a
 * bounty on a refund. Every path into attributeEvent, including the backlog
 * replay, goes through this one definition.
 *
 * They also never inherit a renewal attribution and never anchor one
 * (priorConversions).
 */
export const CORRECTIVE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'refund',
  'chargeback',
  'dispute_created',
  'invoice_payment_failed',
]);

export interface AttributeResult {
  status: 'attributed' | 'no_identity' | 'no_click' | 'outside_window' | 'already_attributed' | 'corrective';
  touches?: Array<{ clickId: string; partnerId: string; weight: number; attributionId: string; commissionId?: string }>;
  model?: AttributionModel;
  /**
   * What the attributed touches earned. Set only when status is 'attributed'.
   *   accrued          at least one commission was written
   *   no_matching_rule no commission rule on any touch's terms takes this
   *                    event type: a typo'd stage name (`funded` for
   *                    `loan_funded`), or a stage nobody pays on yet
   *   none             a rule takes the type but nothing accrued: the
   *                    program has ended, a `first` rule already paid, a cap
   *                    was reached, or the amount came to zero
   */
  commission?: 'accrued' | 'no_matching_rule' | 'none';
}

/** Whether `subRule` can fire for an event of `eventType` at all. A rule
 *  without an eventType takes every type. */
export function ruleTakesEventType(subRule: Pick<CommissionSubRule, 'eventType'>, eventType: string): boolean {
  return !subRule.eventType || subRule.eventType === eventType;
}

export interface ClickWithCampaign extends ClickRow {
  campaign: ProgramRow;
}

export interface Touch {
  click: ClickWithCampaign;
  weight: number;
  /** The click is older than its program's window: the touch reached this
   *  event through an earlier conversion, not through the window. Only
   *  `recurring` sub-rules pay on it. */
  pastWindow: boolean;
}

/** A coupon redemption's synthetic click (routes/coupons.ts): no Link,
 *  and a coupon:// landing URL naming the code. */
export function isCouponClick(click: Pick<ClickRow, 'linkId' | 'landingUrl'>): boolean {
  return click.linkId == null && click.landingUrl.startsWith('coupon://');
}

/** Who gets credit for one event, and under which model. */
export interface AttributionDecision {
  model: AttributionModel;
  touches: Touch[];
  /**
   *   window             the model ran over the clicks in the window
   *   renewal            a repeat conversion kept the touches of the
   *                      customer's first conversion of its type
   *   latest_conversion  no click was left in the window, so the
   *                      customer's latest conversion carried it
   */
  source: 'window' | 'renewal' | 'latest_conversion';
  /** The earlier conversion a renewal or latest_conversion came from. */
  fromEventId: string | null;
}

/**
 * What became of one of the customer's clicks when an event was decided.
 * attributeEvent doesn't need it; the journey view (journey.ts) uses it to
 * say why a click did or didn't count.
 *
 *   flagged          fraud-flagged; never counts
 *   partner_revoked  its partner has been revoked
 *   no_program       its program no longer exists
 *   after_event      it came after the event (beyond the clock grace)
 *   outside_window   older than its program's attribution window
 *   yielded_to_link  a code redemption that gives way to a link click in
 *                    the window (Program.couponsYieldToLinks)
 *   in_window        a candidate the model ran over
 */
export type ClickVerdict =
  | 'flagged'
  | 'partner_revoked'
  | 'no_program'
  | 'after_event'
  | 'outside_window'
  | 'yielded_to_link'
  | 'in_window';

export interface AttributionTrace {
  /** Every click linked to the customer, keyed by click id. */
  verdicts: Map<string, ClickVerdict>;
  /** The in-window candidates, oldest first. The model's input when the
   *  decision's source is `window`. */
  candidates: ClickWithCampaign[];
}

export type AttributionOutcome =
  | { status: 'corrective' | 'no_identity' | 'no_click' | 'outside_window'; decision: null; trace: AttributionTrace }
  | { status: 'decided'; decision: AttributionDecision; trace: AttributionTrace };

/** Signed age of the click at the event: negative when the click came after. */
function clickAgeMs(click: ClickRow, event: EventRow): number {
  return new Date(event.ts).getTime() - new Date(click.ts).getTime();
}

// Every weight applyModel produces for up to 32 touches. Stored to 4
// decimals they stay unambiguous (each is within rounding of only itself)
// up to 40.
const MODEL_WEIGHTS: number[] = (() => {
  const out: number[] = [];
  for (const model of ['linear', 'position'] as const) {
    for (let n = 1; n <= 32; n += 1) {
      for (const w of applyModel(model, n)) if (!out.some((x) => Math.abs(x - w) < 1e-12)) out.push(w);
    }
  }
  return out;
})();

/**
 * A weight read back from Attribution, where it is stored to 4 decimals.
 * A renewal pays on its first conversion's weights, and 0.3333 for a
 * three-way linear split would pay a cent-level drift on every renewal
 * (20% of a 10,000 invoice: 666.60 instead of 666.67). Snap it back to
 * the model weight it was rounded from; anything that isn't one is used
 * as stored.
 */
function storedWeight(raw: string): number {
  const stored = Number(raw);
  const near = MODEL_WEIGHTS.filter((w) => Math.abs(w - stored) <= 0.00005);
  return near.length === 1 ? near[0]! : stored;
}

/**
 * Serialise attribution work on one customer (the tenant plus the brand's
 * userId) until the transaction ends. Two requests for the same customer,
 * say two invoice.paid webhooks a second apart, each read what the other
 * writes: whether the partner has had its `first` commission
 * (evaluateSubRule), the customer's earlier conversions (priorConversions)
 * and the start of a recurringMonths cap. Each request is one transaction
 * (tenancy.ts), so without the lock each misses the other's uncommitted
 * rows and both pay a first-time commission. With it the second request
 * waits for the first to commit, and its next read (READ COMMITTED) sees
 * those rows.
 *
 * Every path that attributes takes it BEFORE its first write for the
 * customer: /attribution/events, conversions, coupon redemptions,
 * identify, PayPal and the Stripe webhook. Taken later, a request holding
 * an uncommitted Identity or Event row could wait for the lock while the
 * request holding the lock waits for that row. Two exceptions: corrective
 * events, which attribute nothing (a refund locks its conversions' Event
 * rows without this lock), and the webhook's coupon redemption for a cus_
 * user, which only adds a new synthetic Click and its Identity, rows
 * nobody else can be holding.
 *
 * A request that takes two of these locks can deadlock with one taking the
 * same two in the other order. Fraud-review unflag takes several, so it
 * takes them in userId order; Postgres aborts one side of any other cycle,
 * and the request fails rather than paying twice.
 *
 * Re-entrant within a transaction, so taking it again (attributeEvent,
 * attributeBacklogForUser) costs nothing. The Stripe webhook's
 * lockMerchantUser is this lock. Outside a transaction it's released at the
 * end of the statement, so it does nothing.
 */
export async function lockCustomer(db: Knex, tenantId: string, userId: string): Promise<void> {
  await db.raw(`select pg_advisory_xact_lock(hashtext(?::text || ':' || ?::text))`, [tenantId, userId]);
}

export async function attributeEvent(
  db: Knex,
  event: EventRow,
  modelOverride?: AttributionModel,
): Promise<AttributeResult> {
  // A corrective event never attributes, and it can arrive holding Event
  // row locks (refunds.ts), so it doesn't take the customer lock: the order
  // is always the customer lock first, then Event rows.
  if (!CORRECTIVE_EVENT_TYPES.has(event.type)) await lockCustomer(db, event.tenantId, event.userId);
  const outcome = await decideAttribution(db, event, modelOverride);
  if (outcome.status !== 'decided') return { status: outcome.status };
  const { model, touches } = outcome.decision;

  const results: NonNullable<AttributeResult['touches']> = [];
  let allDup = true;
  // For AttributeResult.commission: did anything accrue, and was there a
  // rule that could have (a lapsed program counts as one).
  let accrued = false;
  let typeTaken = false;

  for (const { click, weight, pastWindow } of touches) {
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
      typeTaken = true;
      continue;
    }

    // Prefer the partner's snapshotted rule (set at PartnershipRequest
    // approval time via federation) over the live Campaign rule. This
    // is what makes "brand edits campaign rule post-approval" safe —
    // existing partners keep what they were approved under. Absent
    // snapshot = pre-snapshot partner OR non-Network partner; falls
    // back to the Campaign rule (status quo). A snapshot scoped to this
    // click's program beats the partner-wide one.
    const rules = await resolveCommissionRule(db, click.partnerId, click.programId, click.campaign.commissionRule);
    if (rules.some((r) => ruleTakesEventType(r, event.type))) typeTaken = true;

    // Walk every sub-rule. A single event may produce multiple Commission
    // rows (e.g., a `subscription_created` matches both a one-time bonus
    // and a recurring rule). Each sub-rule's eligibility is evaluated
    // independently against the same Event + Attribution.
    let firstCommissionId: string | undefined;
    let firstCommissionCurrency: string | undefined;
    for (const [ruleIndex, subRule] of rules.entries()) {
      // Past the window the touch earns only on rules the brand marked as
      // recurring; a one-off or non-recurring rule stays window-bound, as
      // it was before renewals outlived the window.
      if (pastWindow && !subRule.recurring) continue;
      const accrual = await evaluateSubRule(db, subRule, event, click.partnerId, click.programId);
      if (accrual === null) continue; // not eligible (filter / first / cap miss)
      const amount = accrual.amount * weight;
      if (amount === 0) continue;

      const currency = commissionCurrency(subRule, event);
      const commissionId = ulid();
      await db(TABLES.Commission).insert({
        id: commissionId,
        tenantId: event.tenantId,
        attributionId,
        partnerId: click.partnerId,
        amount: amount.toFixed(2),
        currency,
        status: 'accrued',
        // `trigger` is the record isFirstConversion reads: which commission
        // was the partner's first-time one for this customer.
        metadata: { ...commissionMetadata(accrual, ruleIndex, subRule.type), trigger: subRule.trigger },
      });
      if (!firstCommissionId) {
        firstCommissionId = commissionId;
        firstCommissionCurrency = currency;
      }
      accrued = true;

      // After COMMIT: a receiver may fetch the commission straight away,
      // and a rolled-back request must announce nothing (on-commit.ts).
      const accruedPayload = {
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
        currency,
        eventType: event.type,
        eventValue: event.value,
        // The publisher's sub-ID → {sub_id}, for trackers that match on it.
        subId: click.subId,
      } satisfies WebhookPayload<'commission.accrued'>;
      onCommit(db, 'commission.accrued webhook', () => dispatchEvent(event.tenantId, 'commission.accrued', accruedPayload));

      // Two-tier: the partner who recruited this one earns the program's
      // share of this commission, on the same attribution
      // (recruiter-commissions.ts). Only a partner's own commission pays a
      // recruiter, so it stops at two levels.
      const recruiterCommission = await accrueRecruiterCommission(
        db,
        { id: commissionId, tenantId: event.tenantId, attributionId, partnerId: click.partnerId, amount: amount.toFixed(2), currency },
        click.campaign,
        new Date(event.ts),
      );
      if (recruiterCommission) {
        const recruiterPayload = {
          ...accruedPayload,
          commissionId: recruiterCommission.id,
          partnerId: recruiterCommission.partnerId,
          amount: recruiterCommission.amount,
          sourceCommissionId: commissionId,
          recruitedPartnerId: click.partnerId,
        } satisfies WebhookPayload<'commission.accrued'>;
        onCommit(db, 'commission.accrued webhook', () => dispatchEvent(event.tenantId, 'commission.accrued', recruiterPayload));
      }
    }

    // attribution.created fires once per Attribution regardless of how many
    // Commission rows it produced. commissionId/Amount in the payload
    // reflect the FIRST commission for backwards compat with subscribers
    // that key off a single commission per attribution; multi-rule consumers
    // should listen to commission.accrued.
    results.push({ clickId: click.id, partnerId: click.partnerId, weight, attributionId, commissionId: firstCommissionId });
    const attributionPayload = {
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
      commissionCurrency: firstCommissionCurrency ?? rowCurrency(event.currency),
    } satisfies WebhookPayload<'attribution.created'>;
    onCommit(db, 'attribution.created webhook', () => dispatchEvent(event.tenantId, 'attribution.created', attributionPayload));
  }

  if (allDup) return { status: 'already_attributed', model };
  const commission = accrued ? 'accrued' : typeTaken ? 'none' : 'no_matching_rule';
  return { status: 'attributed', touches: results, model, commission };
}

/**
 * Who gets credit for `event`, and under which model, without writing
 * anything. attributeEvent writes the result; the journey view
 * (journey.ts) uses the same decision, plus the per-click trace, to show
 * an admin why the credit went where it did. One function, so the
 * explanation can't drift from the engine.
 */
export async function decideAttribution(
  db: Knex,
  event: EventRow,
  modelOverride?: AttributionModel,
): Promise<AttributionOutcome> {
  const trace: AttributionTrace = { verdicts: new Map(), candidates: [] };
  if (CORRECTIVE_EVENT_TYPES.has(event.type)) return { status: 'corrective', decision: null, trace };

  // userId is the BRAND's user ID, unique only within a tenant. RLS
  // scopes `db`, but a multi-tenant pool that bypasses RLS (no app role)
  // would otherwise match another brand's identity for the same userId
  // and credit that brand's partner. So the identities, and the clicks
  // they point at, are read for the event's tenant explicitly: an Identity
  // stitched on such a pool can name another tenant's click. The partner
  // and program reads below are keyed on these clicks.
  const tenantId = event.tenantId;
  const identities = await db<IdentityRow>(TABLES.Identity).where({ tenantId, userId: event.userId });
  if (identities.length === 0) return { status: 'no_identity', decision: null, trace };

  const clickIds = identities.map((i) => i.clickId);
  const clicks = await db<ClickRow>(TABLES.Click).where({ tenantId }).whereIn('id', clickIds);
  for (const c of clicks) if (c.fraudFlag) trace.verdicts.set(c.id, 'flagged');
  const cleanClicks = clicks.filter((c) => !c.fraudFlag);
  if (cleanClicks.length === 0) return { status: 'no_click', decision: null, trace };

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
  const revokedPartners = await db(TABLES.Partner).where({ tenantId }).whereIn('id', partnerIds).whereNotNull('revokedAt').pluck('id');
  const revokedSet = new Set(revokedPartners as string[]);
  for (const c of cleanClicks) if (revokedSet.has(c.partnerId)) trace.verdicts.set(c.id, 'partner_revoked');
  const eligibleByPartner = cleanClicks.filter((c) => !revokedSet.has(c.partnerId));
  if (eligibleByPartner.length === 0) return { status: 'no_click', decision: null, trace };

  const programIds = Array.from(new Set(eligibleByPartner.map((c) => c.programId)));
  // The program, like the partner above, is read for the event's tenant:
  // an imported click naming another tenant's program must not earn under
  // that tenant's terms (the note on userId above).
  const campaigns = await db<ProgramRow>(TABLES.Program).where({ tenantId }).whereIn('id', programIds);
  const campaignsById = new Map(campaigns.map((c) => [c.id, c]));

  // Every click that may still earn, with its campaign attached. A renewal
  // can only reuse a touch whose click is in here, so a click flagged as
  // fraud or a partner revoked since the first conversion drops out of the
  // renewals too.
  const usable = new Map<string, ClickWithCampaign>();
  for (const click of eligibleByPartner) {
    const campaign = campaignsById.get(click.programId);
    if (campaign) usable.set(click.id, { ...click, campaign });
    else trace.verdicts.set(click.id, 'no_program');
  }

  // Clicks in-window relative to this event.
  const eligible: ClickWithCampaign[] = [];
  for (const click of usable.values()) {
    const windowMs = click.campaign.attributionWindowDays * DAY_MS;
    const ageMs = clickAgeMs(click, event);
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
    if (ageMs < -CLICK_AFTER_EVENT_GRACE_MS) {
      trace.verdicts.set(click.id, 'after_event');
      continue;
    }
    if (ageMs > windowMs) {
      trace.verdicts.set(click.id, 'outside_window');
      continue;
    }
    eligible.push(click);
  }

  // A coupon redemption's synthetic click is stamped at checkout, so under
  // last click a code always beats the link click that brought the
  // customer. A program can turn that round (Program.couponsYieldToLinks,
  // off by default): its coupon clicks drop out whenever a link click is in
  // the window, so the code credits only when no link did. Each coupon click
  // follows its own program's setting. A renewal inherits its first
  // conversion's touches (priorConversions) before this matters, so the
  // setting decides who wins a customer, not who keeps them.
  if (eligible.some((c) => !isCouponClick(c))) {
    for (let i = eligible.length - 1; i >= 0; i--) {
      const click = eligible[i]!;
      if (isCouponClick(click) && click.campaign.couponsYieldToLinks) {
        trace.verdicts.set(click.id, 'yielded_to_link');
        eligible.splice(i, 1);
      }
    }
  }
  for (const c of eligible) trace.verdicts.set(c.id, 'in_window');
  trace.candidates = [...eligible].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  // A repeat of a conversion the customer already made keeps that
  // conversion's attribution; a first-of-its-type event is decided by the
  // window, falling back to the customer's latest conversion only when no
  // click is in the window any more.
  const prior = CORRECTIVE_EVENT_TYPES.has(event.type) ? null : await priorConversions(db, event, usable, modelOverride);
  let decision: AttributionDecision | null = prior?.sameType ?? null;

  if (!decision && eligible.length > 0) {
    eligible.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    // Pick the model. Override wins; else use the most-recent click's campaign's model.
    const lastClick = eligible[eligible.length - 1]!;
    const model: AttributionModel = modelOverride ?? lastClick.campaign.attributionModel;

    const weights = applyModel(model, eligible.length);
    decision = {
      model,
      touches: eligible.map((click, i) => ({ click, weight: weights[i]!, pastWindow: false })),
      source: 'window',
      fromEventId: null,
    };
  }

  decision ??= prior?.latest ?? null;
  if (!decision) return { status: 'outside_window', decision: null, trace };
  return { status: 'decided', decision, trace };
}

/**
 * The customer's earlier conversions that can carry `event`, derived from
 * the raw Attribution × Event rows — nothing is cached, so a replay or a
 * re-import reaches the same answer.
 *
 *   sameType — the customer's FIRST attributed event of this event's type.
 *              Set means `event` is a renewal: it keeps that conversion's
 *              touches instead of being re-decided against the window, so
 *              a later click from another partner doesn't take it.
 *   latest   — the customer's most recent attributed event of any type.
 *              Used only for a first-of-its-type event that has no click
 *              left in the window: the customer was already won.
 *
 * Each candidate keeps its own clicks, weights and model; weights are NOT
 * re-normalised. A touch survives only while its click is still usable
 * (not fraud-flagged, partner not revoked); a conversion with no surviving
 * touch is skipped, so once every partner on it is revoked the next
 * repeat is decided by the window again, and whoever wins it carries the
 * renewals after it. When the conversion has rows under several models
 * (a modelOverride re-run), the first-computed model is the live one;
 * with an override only rows of that model count.
 *
 * Either is null when the program in control of the conversion — the one
 * behind its most recent surviving click, the same rule that picks the
 * model — has renewalsStayWithPartner off.
 */
async function priorConversions(
  db: Knex,
  event: EventRow,
  usable: ReadonlyMap<string, ClickWithCampaign>,
  modelOverride: AttributionModel | undefined,
): Promise<{ sameType: AttributionDecision | null; latest: AttributionDecision | null }> {
  const A = TABLES.Attribution;
  const E = TABLES.Event;
  const rows = (await db(A)
    .join(E, `${E}.id`, `${A}.eventId`)
    .where(`${E}.tenantId`, event.tenantId)
    .andWhere(`${A}.tenantId`, event.tenantId)
    .andWhere(`${E}.userId`, event.userId)
    .andWhere(`${E}.ts`, '<', event.ts)
    .andWhereNot(`${E}.id`, event.id)
    .whereNotIn(`${E}.type`, [...CORRECTIVE_EVENT_TYPES])
    .modify((q) => {
      if (modelOverride) q.andWhere(`${A}.model`, modelOverride);
    })
    .orderBy([
      { column: `${E}.ts`, order: 'asc' },
      { column: `${E}.id`, order: 'asc' },
      { column: `${A}.computedAt`, order: 'asc' },
      { column: `${A}.id`, order: 'asc' },
    ])
    .select(
      `${A}.eventId as eventId`,
      `${E}.type as eventType`,
      `${A}.clickId as clickId`,
      `${A}.model as model`,
      `${A}.weight as weight`,
    )) as Array<{ eventId: string; eventType: string; clickId: string; model: AttributionModel; weight: string }>;

  const byEvent = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byEvent.get(row.eventId);
    if (group) group.push(row);
    else byEvent.set(row.eventId, [row]);
  }

  let sameType: AttributionDecision | null | undefined;
  let latest: AttributionDecision | null = null;
  for (const group of byEvent.values()) {
    const model = group[0]!.model;
    const touches: Touch[] = [];
    for (const row of group) {
      if (row.model !== model) continue;
      const click = usable.get(row.clickId);
      if (!click) continue;
      const ageMs = clickAgeMs(click, event);
      // Never let a renewal credit a click that came after it (see the
      // grace note in attributeEvent).
      if (ageMs < -CLICK_AFTER_EVENT_GRACE_MS) continue;
      touches.push({ click, weight: storedWeight(row.weight), pastWindow: ageMs > click.campaign.attributionWindowDays * DAY_MS });
    }
    if (touches.length === 0) continue;

    const control = touches.reduce((a, b) => (new Date(b.click.ts).getTime() > new Date(a.click.ts).getTime() ? b : a));
    const carries = control.click.campaign.renewalsStayWithPartner;
    const fromEventId = group[0]!.eventId;
    if (sameType === undefined && group[0]!.eventType === event.type) {
      sameType = carries ? { model, touches, source: 'renewal', fromEventId } : null;
    }
    latest = carries ? { model, touches, source: 'latest_conversion', fromEventId } : null;
  }
  // A repeat whose first conversion's program has the setting off is
  // decided by the window alone, like every event before the setting
  // existed; it doesn't fall back to some other conversion.
  if (sameType !== undefined) return { sameType, latest: null };
  return { sameType: null, latest };
}

/**
 * Replay attribution over a user's events after something new made them
 * attributable — a fresh Identity stitch (identify) or an unflagged click
 * (fraud review).
 *
 * Only events with NO Attribution row (under any model) are replayed. An
 * attributed event is decided: the unique key is (eventId, model, clickId),
 * so re-running attributeEvent with a different click-set — e.g. a
 * cross-device click stitched after the conversion but timestamped before
 * it — inserted a second last_click row at weight 1 beside the first, and a
 * second full commission. Re-deciding an event means removing its old rows
 * first, which only the caller can judge (fraud-review drops accrued rows;
 * approved/paid ledger rows are never rewritten).
 *
 * Corrective events (CORRECTIVE_EVENT_TYPES) never have an Attribution row
 * by design, so the filter above would select every one of them; they're
 * excluded here rather than locked and handed to attributeEvent. An event
 * that was refunded before it attributed has those refunds applied to its
 * new commissions straight away (reapplyRecordedRefunds).
 *
 * The Event row lock serialises concurrent replays for the same user (two
 * devices logging in at once): each would otherwise see the event
 * unattributed and insert its own winner. The re-check after the lock reads
 * a fresh snapshot, so the second replay sees the first one's rows. The
 * customer lock comes first, so the order is the same as attributeEvent's
 * (customer, then Event rows) and the two can't deadlock.
 *
 * Events replay oldest first, and the Event id (a ULID) orders events
 * stamped the same instant, so the same rows always replay in the same
 * order: the one that takes a `first` commission doesn't depend on the
 * order Postgres happens to return them in.
 */
export async function attributeBacklogForUser(db: Knex, tenantId: string, userId: string): Promise<number> {
  await lockCustomer(db, tenantId, userId);
  // userId is unique per tenant only; see attributeEvent.
  const events = await db<EventRow>(TABLES.Event)
    .where({ tenantId, userId })
    .whereNotIn('type', [...CORRECTIVE_EVENT_TYPES])
    .whereNotExists(
      db(TABLES.Attribution).select(db.raw('1')).whereRaw('?? = ??', [`${TABLES.Attribution}.eventId`, `${TABLES.Event}.id`]),
    )
    .orderBy([
      { column: 'ts', order: 'asc' },
      { column: 'id', order: 'asc' },
    ]);
  let attributed = 0;
  for (const event of events) {
    await db(TABLES.Event).where({ id: event.id }).forUpdate().first('id');
    const already = await db(TABLES.Attribution).where({ eventId: event.id }).first('id');
    if (already) continue;
    const result = await attributeEvent(db, event);
    if (result.status !== 'attributed') continue;
    attributed += 1;
    const { reapplyRecordedRefunds } = await import('./refunds.js');
    await reapplyRecordedRefunds(db, event);
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
 * Which snapshot: the row scoped to `programId` if there is one, else the
 * partner-wide row (programId null). Whole-row precedence — a program
 * row's rules replace the partner-wide rules, they don't merge.
 *
 * Within that row:
 *   1. PartnerCommission.commissionRules (the array form, post-compound)
 *   2. PartnerCommission legacy columns (commissionType/commissionValue/
 *      recurring) — wrapped into a 1-element array for the engine
 *   3. Campaign.commissionRule (no snapshot exists)
 */
export async function resolveCommissionRule(
  db: Knex,
  partnerId: string,
  programId: string,
  campaignRule: unknown,
): Promise<CommissionRule> {
  const snapshot = await db<CommissionSnapshotRules & { partnerId: string; programId: string | null }>(TABLES.PartnerCommission)
    .where({ partnerId })
    .andWhere((q) => q.where({ programId }).orWhereNull('programId'))
    .orderByRaw('"programId" is null') // false (program-scoped) sorts first
    .first('commissionType', 'commissionValue', 'recurring', 'commissionRules');
  return rulesFor(snapshot, campaignRule);
}

/** The PartnerCommission columns the engine pays on. */
export interface CommissionSnapshotRules {
  commissionType: 'percent' | 'fixed';
  commissionValue: string;
  recurring: boolean;
  commissionRules: CommissionRule | null;
}

/** resolveCommissionRule's precedence, for a snapshot already in hand (the
 *  program-scoped row if any, else the partner-wide one, else undefined). */
export function rulesFor(snapshot: CommissionSnapshotRules | undefined, campaignRule: unknown): CommissionRule {
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
 * pre-weight commission base amount (plus, for a slab rule, the band or
 * tier that set the rate — see commission-slabs.ts). Returns null when the
 * rule doesn't apply to this event (type mismatch, first-trigger already
 * fired, or recurringMonths cap reached).
 *
 * The trigger check is up to two small queries against (Attribution ×
 * Event), the second joining Commission (isFirstConversion); the indexes
 * on Attribution(partnerId) + Event(userId) keep them O(log n). The cap
 * check piggybacks on the same join.
 */
async function evaluateSubRule(
  db: Knex,
  subRule: CommissionSubRule,
  event: EventRow,
  partnerId: string,
  programId: string,
): Promise<SubRuleAccrual | null> {
  if (!ruleTakesEventType(subRule, event.type)) return null;

  if (subRule.trigger === 'first' || subRule.trigger === 'subsequent') {
    // first      → fire only on the partner's first conversion of this type
    //              for this customer (isFirstConversion)
    // subsequent → fire on every other one: the exact complement
    // Refunds don't re-arm the lookup; if a brand wants a refund to
    // re-trigger the bonus they'd reverse the prior commission and
    // re-attribute, consistent with how holdback works.
    const first = await isFirstConversion(db, event, partnerId);
    if (subRule.trigger === 'first' && !first) return null;
    if (subRule.trigger === 'subsequent' && first) return null;
  }

  // The cap counts from the earliest attributed event by time (this one
  // included), not from the one that took the `first` commission: an older
  // event that arrives late moves the start back, which only ever shortens
  // what's left. The customer lock keeps a racing request from missing it.
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

  if (subRule.bands || subRule.tiers) return accrueSlabRule(db, subRule, event, { partnerId, programId });
  return { amount: computeSubRuleAmount(subRule, event) };
}

/**
 * Whether `event` is `partnerId`'s first conversion of its type for its
 * customer, for `first` / `subsequent` sub-rules. It is unless one of the
 * customer's OTHER events of that type attributed to the partner either:
 *
 *   1. is earlier, by (ts, Event id). The Event id is a ULID, so two events
 *      stamped the same second still have an order, and it's the same order
 *      however often the rows are read: a replay reaches the same answer,
 *      whatever order the events arrived in. Or
 *   2. already holds the partner's first-time commission: an own Commission
 *      (not a recruiter's share) whose `metadata.trigger` is `first`.
 *
 * Test 2 is the once-only award record, and it's what keeps "at most once"
 * when events arrive out of order. The old `Event.ts < event.ts` test alone
 * paid an older event that arrived after a newer one had already been paid,
 * and paid both of two events stamped the same second. No ordering can stop
 * the first of those: the older event is the earliest by any order, and the
 * ledger can't take the newer one's payment back. The record is the
 * Commission row itself, which is immutable and already in every export, so
 * no new table needs exporting, importing, backfilling or keying by a rule's
 * scope. It also means an event that paid no first-time commission (the
 * program had ended, a $0 sale) holds nothing. An older event delivered
 * after it can still take the commission, and so can an earlier event that
 * a fraud review drops and replays. Commissions accrued before the trigger
 * was recorded have no `trigger`, and each of those counts as holding it,
 * so a ledger from before this can't be paid twice.
 *
 * This event's own rows don't count, so each touch of the same partner on
 * it pays its weighted share. attributeEvent holds the customer lock
 * (lockCustomer), so two requests for one customer take turns, and the
 * second sees the first's rows.
 */
async function isFirstConversion(db: Knex, event: EventRow, partnerId: string): Promise<boolean> {
  const A = TABLES.Attribution;
  const E = TABLES.Event;
  const C = TABLES.Commission;
  const others = () =>
    db(A)
      .join(E, `${E}.id`, `${A}.eventId`)
      .where(`${A}.partnerId`, partnerId)
      .andWhere(`${E}.userId`, event.userId)
      .andWhere(`${E}.type`, event.type)
      .andWhereNot(`${E}.id`, event.id);

  // Compared with the stored row, not event.ts: a JS Date drops the
  // microseconds Postgres keeps.
  const earlier = await others()
    .andWhereRaw(`(??, ??) < (select "ts", "id" from ?? where "id" = ?)`, [`${E}.ts`, `${E}.id`, E, event.id])
    .first(`${E}.id`);
  if (earlier) return false;

  const holder = await others()
    .join(C, `${C}.attributionId`, `${A}.id`)
    .andWhere(`${C}.partnerId`, partnerId)
    .whereNull(`${C}.sourceCommissionId`)
    .andWhere((q) =>
      q.whereRaw(`??->>'trigger' = 'first'`, [`${C}.metadata`]).orWhereRaw(`??->>'trigger' is null`, [`${C}.metadata`]),
    )
    .first(`${E}.id`);
  return !holder;
}

/**
 * The currency a sub-rule's commission is booked in. A fixed amount is in
 * the rule's own currency when it names one: "₹100 per lead" pays ₹100
 * whatever currency the event is in, including a lead sent with none. A
 * percent is a share of the event's value, so it is in the event's
 * currency. Nothing is converted; the engine has no FX. A partner earning
 * in two currencies gets one payout per currency.
 */
export function commissionCurrency(
  subRule: Pick<CommissionSubRule, 'type' | 'currency'>,
  event: Pick<EventRow, 'currency'>,
): string {
  if (subRule.type === 'fixed' && subRule.currency) return subRule.currency.toUpperCase();
  return rowCurrency(event.currency);
}

/** Pre-weight amount for one sub-rule against one event, in
 *  commissionCurrency(). No trigger evaluation — caller is responsible for
 *  that. Exported so tests can exercise the math without a database. */
export function computeSubRuleAmount(
  subRule: CommissionSubRule,
  event: Pick<EventRow, 'value'>,
): number {
  if (subRule.type === 'fixed') return subRule.value;
  const revenue = event.value ? Number(event.value) : 0;
  return Math.round(revenue * subRule.value) / 100;
}
