/**
 * Refunds and chargebacks: the one implementation behind
 * POST /attribution/refunds and the self-host Stripe `charge.refunded`
 * webhook.
 *
 * The refund itself is a raw corrective Event (CORRECTIVE_EVENT_TYPES), so
 * it is never attributed. `applyRefund` then brings the refunded
 * conversion's commissions in line with it: each commission the conversion
 * accrued (its "root") ends up worth its original amount times the share of
 * the conversion's value the customer kept. A full refund keeps nothing.
 *
 *   accrued / approved → flipped to `reversed`, through the same funding and
 *                        payout-intent interlocks as the admin reverse. On a
 *                        partial refund a replacement commission for the kept
 *                        amount is accrued on the same attribution, with the
 *                        same status and accruedAt (so the holdback clock
 *                        doesn't restart) and `metadata.refund` naming the
 *                        root. No commission's amount is ever rewritten.
 *   paid               → stays paid: it is ledger history and the partner
 *                        has the money. A negative CommissionAdjustment
 *                        (`refund_clawback`) records what they now hold for
 *                        refunded revenue, and the caller is told
 *                        (`clawback_recorded`). The partner's next manual or
 *                        direct-Connect payout deducts it
 *                        (clawback-netting.ts); the hosted funding rail
 *                        doesn't, so it stays an action for the caller.
 *   in a payout        → left alone (`held_in_transfer`): an open payout
 *                        intent or a transfer_pending funding allocation is
 *                        moving that money right now.
 *
 * The target is computed from the CUMULATIVE refunded share, never from the
 * increment, so a run is convergent: repeating it after the same refunds
 * changes nothing, and a commission that was held in transfer is finished by
 * the next run (a retry of the same refund, or the next refund). Callers
 * lock the conversion Event rows first (`lockConversions`), which serialises
 * every refund of one conversion across both paths.
 *
 * Announcements (commission.reversed / .accrued / .approved, and the partner
 * postbacks they carry) are returned, not sent: callers fire them with
 * `announceRefund` once their transaction has committed.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type AttributionRow,
  type CommissionAdjustmentRow,
  type CommissionRow,
  type CommissionStatus,
  type EventRow,
} from '@openpartner/db';
import { CORRECTIVE_EVENT_TYPES } from './attribution.js';
import { dispatchCommissionEvents, type CommissionOrigin } from './commission-events.js';
import { interlockCommissionReversal, whereNotClaimedByOpenIntent } from './funding/interlocks.js';
import type { WebhookPayload } from './openapi/webhook-events.js';
import { dispatchEvent } from './webhook-dispatcher.js';

/** Event types POST /attribution/refunds records. Both are corrective. */
export const REFUND_KINDS = ['refund', 'chargeback'] as const;
export type RefundKind = (typeof REFUND_KINDS)[number];

/** How much of the conversion has been refunded so far, all refunds
 *  included. Minor units, so the kept share is exact. */
export type RefundedShare = { full: true } | { full: false; refundedMinor: number; ofMinor: number };

export type RefundCommissionStatus = 'reversed' | 'reduced' | 'clawback_recorded' | 'held_in_transfer' | 'unchanged';

/** Where one of the conversion's commissions stands after the refund. */
export interface RefundCommissionOutcome {
  /** The commission the conversion originally accrued. */
  commissionId: string;
  partnerId: string;
  currency: string;
  originalAmount: string;
  /** What the partner keeps for this conversion now: the live commission's
   *  amount, or for a paid one its amount net of adjustments. */
  keptAmount: string;
  status: RefundCommissionStatus;
  /** The live row: the original, its replacement, or null once reversed. */
  currentCommissionId: string | null;
  /** That row's status; null once reversed. */
  currentStatus: Exclude<CommissionStatus, 'reversed'> | null;
  /** Paid commissions only: the refund clawbacks recorded against it, as a
   *  negative decimal. Null when there are none. */
  clawbackAmount: string | null;
}

export interface RefundAnnouncements {
  reversed: Array<{ commission: CommissionRow; replacementCommissionId?: string }>;
  accrued: Array<WebhookPayload<'commission.accrued'>>;
  approved: CommissionRow[];
  /** Click/event origin per attributionId, so the announcement needn't read
   *  rows that may not be committed yet. */
  origins: Map<string, CommissionOrigin>;
}

export interface AppliedRefund {
  commissions: RefundCommissionOutcome[];
  announce: RefundAnnouncements;
}

const LIVE_STATUSES: ReadonlySet<CommissionStatus> = new Set(['accrued', 'approved', 'paid']);

/** What a replacement commission records under `metadata.refund`. */
interface RefundLink {
  rootCommissionId: string;
  replacesCommissionId: string;
  refundEventId: string;
}

export function toMinor(decimal: string | number | null | undefined): number {
  return Math.round(Number(decimal ?? 0) * 100);
}

function fromMinor(minor: number): string {
  return (minor / 100).toFixed(2);
}

function refundLink(c: CommissionRow): RefundLink | null {
  const link = (c.metadata as { refund?: Partial<RefundLink> } | null)?.refund;
  return link?.rootCommissionId ? (link as RefundLink) : null;
}

/** What a root commission is worth once `refunded` is taken out. */
export function keptMinor(rootMinor: number, refunded: RefundedShare): number {
  if (refunded.full || refunded.refundedMinor >= refunded.ofMinor) return 0;
  return Math.round((rootMinor * (refunded.ofMinor - refunded.refundedMinor)) / refunded.ofMinor);
}

/** Lock the conversion Event rows. Every refund of a conversion takes this
 *  lock before it reads prior refunds or the commissions, from either path. */
export async function lockConversions(trx: Knex, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  await trx(TABLES.Event).whereIn('id', [...eventIds].sort()).orderBy('id').forUpdate().select('id');
}

/**
 * Bring the commissions of `conversions` in line with `refunded`. Run inside
 * the transaction that records the refund Event, after `lockConversions`.
 */
export async function applyRefund(
  trx: Knex,
  input: { conversions: EventRow[]; refunded: RefundedShare; refundEventId: string },
): Promise<AppliedRefund> {
  const out: AppliedRefund = {
    commissions: [],
    announce: { reversed: [], accrued: [], approved: [], origins: new Map() },
  };
  const conversionsById = new Map(input.conversions.map((e) => [e.id, e]));
  if (conversionsById.size === 0) return out;
  await lockConversions(trx, [...conversionsById.keys()]);

  const attributions = (await trx<AttributionRow>(TABLES.Attribution).whereIn('eventId', [
    ...conversionsById.keys(),
  ])) as AttributionRow[];
  if (attributions.length === 0) return out;
  const attributionsById = new Map(attributions.map((a) => [a.id, a]));
  // The publisher's sub-ID rides on every announcement ({sub_id}).
  const clicks = (await trx(TABLES.Click)
    .whereIn('id', [...new Set(attributions.map((a) => a.clickId))])
    .select('id', 'subId')) as Array<{ id: string; subId: string | null }>;
  const subIds = new Map(clicks.map((c) => [c.id, c.subId]));
  for (const a of attributions) {
    const conversion = conversionsById.get(a.eventId);
    out.announce.origins.set(a.id, {
      clickId: a.clickId,
      eventId: a.eventId,
      eventType: conversion?.type ?? null,
      programId: a.programId,
      eventValue: conversion?.value ?? null,
      subId: subIds.get(a.clickId) ?? null,
    });
  }

  // Locked so nothing moves a commission between our reads and our writes:
  // the payout planner and the funding reversal handler both write these
  // rows, and the clawback below is check-then-insert.
  const commissions = (await trx<CommissionRow>(TABLES.Commission)
    .whereIn('attributionId', [...attributionsById.keys()])
    .orderBy('id')
    .forUpdate()) as CommissionRow[];
  if (commissions.length === 0) return out;

  // Every adjustment counts toward what a paid partner still holds (a
  // reversed transfer already took the money back); only refund_clawback
  // rows are reported as the refund's clawback.
  const adjustments = (await trx<CommissionAdjustmentRow>(TABLES.CommissionAdjustment).whereIn(
    'commissionId',
    commissions.map((c) => c.id),
  )) as CommissionAdjustmentRow[];
  const adjustedMinor = new Map<string, number>();
  const clawedMinor = new Map<string, number>();
  for (const a of adjustments) {
    adjustedMinor.set(a.commissionId, (adjustedMinor.get(a.commissionId) ?? 0) + toMinor(a.amount));
    if (a.reason === 'refund_clawback') {
      clawedMinor.set(a.commissionId, (clawedMinor.get(a.commissionId) ?? 0) + toMinor(a.amount));
    }
  }

  // Chains: a root and the replacements earlier partial refunds accrued.
  const chains = new Map<string, CommissionRow[]>();
  for (const c of commissions) {
    const rootId = refundLink(c)?.rootCommissionId ?? c.id;
    const chain = chains.get(rootId) ?? [];
    chain.push(c);
    chains.set(rootId, chain);
  }

  type Work = { root: CommissionRow; current: CommissionRow; targetMinor: number };
  const flips: Work[] = [];
  const paid: Work[] = [];
  const outcome = (
    root: CommissionRow,
    status: RefundCommissionStatus,
    current: CommissionRow | null,
    keptAmountMinor: number,
    clawbackMinor = 0,
  ) => {
    out.commissions.push({
      commissionId: root.id,
      partnerId: root.partnerId,
      currency: root.currency,
      originalAmount: fromMinor(toMinor(root.amount)),
      keptAmount: fromMinor(keptAmountMinor),
      status,
      currentCommissionId: current?.id ?? null,
      currentStatus: current && current.status !== 'reversed' ? current.status : null,
      clawbackAmount: clawbackMinor < 0 ? fromMinor(clawbackMinor) : null,
    });
  };

  for (const [rootId, chain] of chains) {
    const root = chain.find((c) => c.id === rootId);
    if (!root) {
      console.error(`[refunds] replacement commission(s) ${chain.map((c) => c.id).join(', ')} name a root ${rootId} that is not on this conversion — skipped`);
      continue;
    }
    const live = chain.filter((c) => LIVE_STATUSES.has(c.status));
    if (live.length > 1) {
      console.error(`[refunds] ALERT: commission ${root.id} has ${live.length} live rows (${live.map((c) => c.id).join(', ')}) — using the newest`);
    }
    const current = live[live.length - 1] ?? null;
    if (!current) {
      outcome(root, 'reversed', null, 0);
      continue;
    }
    const rootMinor = toMinor(root.amount);
    // Nothing to take back from a zero or negative commission.
    const targetMinor = rootMinor > 0 ? keptMinor(rootMinor, input.refunded) : rootMinor;
    if (current.status === 'paid') {
      paid.push({ root, current, targetMinor });
    } else if (toMinor(current.amount) > targetMinor) {
      flips.push({ root, current, targetMinor });
    } else {
      outcome(root, current.id === root.id ? 'unchanged' : 'reduced', current, toMinor(current.amount));
    }
  }

  if (flips.length > 0) {
    const interlock = await interlockCommissionReversal(trx, flips.map((w) => w.current.id));
    const held = new Set(interlock.held);
    // Re-asserted inside the UPDATE, as on every reversal path: a payout
    // intent or a funding allocation can claim a row after the interlock read.
    const flipped = interlock.flippable.length
      ? ((await whereNotClaimedByOpenIntent(
          trx,
          trx<CommissionRow>(TABLES.Commission)
            .whereIn(`${TABLES.Commission}.id`, interlock.flippable)
            .whereIn('status', ['accrued', 'approved']),
        )
          .update({ status: 'reversed' })
          .returning('*')) as CommissionRow[])
      : [];
    const flippedById = new Map(flipped.map((c) => [c.id, c]));

    for (const w of flips) {
      const reversed = flippedById.get(w.current.id);
      if (!reversed) {
        if (!held.has(w.current.id)) {
          console.error(
            `[refunds] ALERT: commission ${w.current.id} was claimed by a payout while the refund was applied — left payable; retry the refund once the payout settles`,
          );
        }
        outcome(w.root, 'held_in_transfer', w.current, toMinor(w.current.amount));
        continue;
      }
      let replacement: CommissionRow | null = null;
      if (w.targetMinor > 0) {
        replacement = await accrueReplacement(trx, w, input.refundEventId);
        // Loaded by attributionId above, so never a bonus commission.
        const attributionId = replacement.attributionId!;
        const attribution = attributionsById.get(attributionId)!;
        const conversion = conversionsById.get(attribution.eventId)!;
        out.announce.accrued.push({
          commissionId: replacement.id,
          partnerId: replacement.partnerId,
          attributionId,
          clickId: attribution.clickId,
          eventId: conversion.id,
          programId: attribution.programId,
          amount: replacement.amount,
          currency: replacement.currency,
          eventType: conversion.type,
          eventValue: conversion.value,
          subId: out.announce.origins.get(attributionId)?.subId ?? null,
          replacesCommissionId: w.current.id,
        });
        if (replacement.status === 'approved') out.announce.approved.push(replacement);
      }
      out.announce.reversed.push({
        commission: reversed,
        ...(replacement ? { replacementCommissionId: replacement.id } : {}),
      });
      outcome(w.root, replacement ? 'reduced' : 'reversed', replacement, replacement ? w.targetMinor : 0);
    }
  }

  for (const w of paid) {
    const heldMinor = toMinor(w.current.amount) + (adjustedMinor.get(w.current.id) ?? 0);
    const deltaMinor = w.targetMinor - heldMinor;
    let clawbackMinor = clawedMinor.get(w.current.id) ?? 0;
    if (deltaMinor < 0) {
      await trx(TABLES.CommissionAdjustment).insert({
        id: ulid(),
        tenantId: w.current.tenantId,
        commissionId: w.current.id,
        amount: fromMinor(deltaMinor),
        currency: w.current.currency,
        reason: 'refund_clawback',
        metadata: {
          refundEventId: input.refundEventId,
          conversionEventId: attributionsById.get(w.current.attributionId!)?.eventId ?? null,
          ...(w.current.id !== w.root.id ? { rootCommissionId: w.root.id } : {}),
        },
        createdAt: new Date(),
      });
      clawbackMinor += deltaMinor;
      console.warn(
        `[refunds] commission ${w.current.id} was already paid (payout ${w.current.payoutId ?? 'unknown'}): recorded a ${fromMinor(deltaMinor)} ${w.current.currency} refund clawback — the partner holds refunded revenue`,
      );
    }
    const keptAmountMinor = heldMinor + Math.min(deltaMinor, 0);
    const status: RefundCommissionStatus =
      clawbackMinor < 0 ? 'clawback_recorded' : w.current.id === w.root.id ? 'unchanged' : 'reduced';
    outcome(w.root, status, w.current, keptAmountMinor, clawbackMinor);
  }

  return out;
}

/** The commission a partial refund leaves: the kept amount, accrued on the
 *  same attribution with the reversed row's status and accrual time. */
async function accrueReplacement(
  trx: Knex,
  w: { root: CommissionRow; current: CommissionRow; targetMinor: number },
  refundEventId: string,
): Promise<CommissionRow> {
  const { refund: _previous, ...metadata } = (w.current.metadata ?? {}) as Record<string, unknown>;
  const link: RefundLink = { rootCommissionId: w.root.id, replacesCommissionId: w.current.id, refundEventId };
  const [row] = (await trx(TABLES.Commission)
    .insert({
      id: ulid(),
      tenantId: w.current.tenantId,
      attributionId: w.current.attributionId,
      partnerId: w.current.partnerId,
      amount: fromMinor(w.targetMinor),
      currency: w.current.currency,
      status: w.current.status,
      accruedAt: w.current.accruedAt,
      metadata: { ...metadata, refund: link },
    })
    .returning('*')) as CommissionRow[];
  return row!;
}

/** Per-status counts, for the Stripe refund Event's metadata. */
export function refundCounts(outcomes: readonly RefundCommissionOutcome[]) {
  const count = (s: RefundCommissionStatus) => outcomes.filter((o) => o.status === s).length;
  return {
    reversed: count('reversed'),
    reduced: count('reduced'),
    clawbackRecorded: count('clawback_recorded'),
    heldInTransfer: count('held_in_transfer'),
    paid: outcomes.filter((o) => o.currentStatus === 'paid').length,
  };
}

/**
 * Announce what a committed `applyRefund` did. Reversals are dispatched
 * first, so a subscriber sees the old commission go before its replacement
 * arrives. Never rejects.
 */
export async function announceRefund(
  tenantId: string,
  announce: RefundAnnouncements,
  meta: { kind: RefundKind; refundEventId: string },
): Promise<void> {
  try {
    for (const r of announce.reversed) {
      await dispatchCommissionEvents(
        tenantId,
        'commission.reversed',
        [r.commission],
        {
          reason: meta.kind,
          refundEventId: meta.refundEventId,
          ...(r.replacementCommissionId ? { replacementCommissionId: r.replacementCommissionId } : {}),
        },
        announce.origins,
      );
    }
    for (const payload of announce.accrued) dispatchEvent(tenantId, 'commission.accrued', payload);
    await dispatchCommissionEvents(tenantId, 'commission.approved', announce.approved, {}, announce.origins);
  } catch (err) {
    console.error(`[refunds] announcing refund ${meta.refundEventId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Apply the refunds already recorded against `conversion` to commissions it
 * accrued after them. That happens when a backlog replay (identify, a
 * fraud-review unflag, a Stripe checkout stitch) attributes an event that
 * was recorded, and refunded, before its user was stitched to a click:
 * without this the fresh commission would pay for refunded revenue.
 *
 * The share is the larger of what POST /attribution/refunds recorded against
 * the conversion and what any Stripe refund of its invoice or PaymentIntent
 * reported. Null when nothing was refunded.
 *
 * Announces at once rather than after commit: its callers are replays whose
 * own commission.accrued (attributeEvent) already went out from inside the
 * same transaction, and the announcement carries its origins, so it reads
 * nothing that isn't committed yet.
 */
export async function reapplyRecordedRefunds(
  trx: Knex,
  conversion: EventRow,
): Promise<{ refundEventId: string; kind: RefundKind; applied: AppliedRefund } | null> {
  await lockConversions(trx, [conversion.id]);
  const api = await apiRefundsOf(trx, conversion);
  const stripe = await stripeRefundsOf(trx, conversion);
  const shares: RefundedShare[] = [];
  if (api.length > 0) {
    const valueMinor = toMinor(conversion.value);
    const refundedMinor = api.reduce((s, e) => s - toMinor(e.value), 0);
    shares.push(
      valueMinor <= 0 || refundedMinor >= valueMinor ? { full: true } : { full: false, refundedMinor, ofMinor: valueMinor },
    );
  }
  for (const e of stripe) {
    const md = (e.metadata ?? {}) as { fullRefund?: unknown; amountRefunded?: unknown; chargeCollected?: unknown };
    if (md.fullRefund === true) shares.push({ full: true });
    else if (Number(md.chargeCollected) > 0 && Number(md.amountRefunded) > 0) {
      shares.push({ full: false, refundedMinor: Number(md.amountRefunded), ofMinor: Number(md.chargeCollected) });
    }
  }
  if (shares.length === 0) return null;

  const refunded = shares.reduce(largerShare);
  const latest = [...api, ...stripe].reduce((a, b) => {
    const at = new Date(a.ts).getTime();
    const bt = new Date(b.ts).getTime();
    return bt > at || (bt === at && b.id > a.id) ? b : a;
  });
  const applied = await applyRefund(trx, { conversions: [conversion], refunded, refundEventId: latest.id });
  const kind: RefundKind = latest.type === 'chargeback' ? 'chargeback' : 'refund';
  void announceRefund(conversion.tenantId, applied.announce, { kind, refundEventId: latest.id });
  return { refundEventId: latest.id, kind, applied };
}

function largerShare(a: RefundedShare, b: RefundedShare): RefundedShare {
  if (a.full) return a;
  if (b.full) return b;
  return a.refundedMinor * b.ofMinor >= b.refundedMinor * a.ofMinor ? a : b;
}

/** Stripe `charge.refunded` events recorded against a conversion the Stripe
 *  webhook recorded, matched as conversionsForPayment matches them. */
async function stripeRefundsOf(trx: Knex, conversion: EventRow): Promise<EventRow[]> {
  const md = (conversion.metadata ?? {}) as { stripeInvoiceId?: unknown; stripePaymentIntentId?: unknown };
  const invoiceId = typeof md.stripeInvoiceId === 'string' ? md.stripeInvoiceId : null;
  const paymentIntentId = typeof md.stripePaymentIntentId === 'string' ? md.stripePaymentIntentId : null;
  if (!invoiceId && !paymentIntentId) return [];
  return (await trx<EventRow>(TABLES.Event)
    .where({ tenantId: conversion.tenantId, type: 'refund' })
    // An API refund names its conversion directly; it's counted above.
    .whereRaw(`"metadata"->>'conversionEventId' is null`)
    .where((q) => {
      if (invoiceId) q.orWhereRaw(`"metadata"->>'stripeInvoiceId' = ?`, [invoiceId]);
      if (paymentIntentId) q.orWhereRaw(`"metadata"->>'stripePaymentIntentId' = ?`, [paymentIntentId]);
    })) as EventRow[];
}

// ---------------------------------------------------------------------------
// POST /attribution/refunds
// ---------------------------------------------------------------------------

export interface RecordRefundInput {
  conversionEventId?: string;
  conversionExternalEventId?: string;
  /** Major units. Omitted: refund whatever is left. */
  amount?: number;
  currency?: string;
  kind: RefundKind;
  reason?: string;
  externalEventId: string;
  ts?: Date;
  metadata?: Record<string, unknown>;
}

export interface RefundResultBody {
  ok: true;
  replayed?: true;
  refundEventId: string;
  conversionEventId: string;
  kind: RefundKind;
  amount: string | null;
  refundedAmount: string | null;
  conversionValue: string | null;
  currency: string;
  fullRefund: boolean;
  actionRequired: boolean;
  commissions: RefundCommissionOutcome[];
}

export type RecordRefundResult =
  | { ok: true; body: RefundResultBody; announce: RefundAnnouncements }
  | { ok: false; status: 404 | 409 | 422; error: RefundError; detail: string; extra?: Record<string, unknown> };

export type RefundError =
  | 'conversion_not_found'
  | 'not_a_conversion'
  | 'external_event_id_conflict'
  | 'currency_mismatch'
  | 'partial_refund_needs_value'
  | 'refund_exceeds_remaining'
  | 'nothing_to_refund';

/** Refunds and chargebacks POST /attribution/refunds recorded against a
 *  conversion. Stripe refunds aren't among them: their value is the charge's
 *  cumulative refund, and the webhook measures the share from the charge. */
async function apiRefundsOf(trx: Knex, conversion: EventRow): Promise<EventRow[]> {
  return (await trx<EventRow>(TABLES.Event)
    .where({ tenantId: conversion.tenantId, userId: conversion.userId })
    .whereIn('type', [...REFUND_KINDS])
    .whereRaw(`"metadata"->>'conversionEventId' = ?`, [conversion.id])) as EventRow[];
}

/**
 * Record a refund or chargeback against a conversion and apply it, in the
 * caller's transaction; the caller announces the result once that has
 * committed. Validation failures return before anything is written.
 */
export async function recordRefund(
  trx: Knex,
  tenantId: string,
  input: RecordRefundInput,
): Promise<RecordRefundResult> {
  const lookup = trx<EventRow>(TABLES.Event).where({ tenantId });
  if (input.conversionEventId) lookup.where({ id: input.conversionEventId });
  else lookup.where({ externalEventId: input.conversionExternalEventId! });
  const found = (await lookup.first()) as EventRow | undefined;
  if (!found) {
    return { ok: false, status: 404, error: 'conversion_not_found', detail: 'No event with this id in this program.' };
  }
  if (CORRECTIVE_EVENT_TYPES.has(found.type)) {
    return {
      ok: false,
      status: 422,
      error: 'not_a_conversion',
      detail: `That event is a ${found.type}, not a conversion. Reference the conversion it corrects.`,
    };
  }

  // Serialises every refund of this conversion: a concurrent duplicate
  // waits here, then finds the first one's committed row below.
  await lockConversions(trx, [found.id]);
  const conversion = (await trx<EventRow>(TABLES.Event).where({ id: found.id }).first()) as EventRow;
  const currency = (conversion.currency ?? 'USD').toUpperCase();
  if (input.currency && input.currency.toUpperCase() !== currency) {
    return {
      ok: false,
      status: 422,
      error: 'currency_mismatch',
      detail: `The conversion was recorded in ${currency}; a refund of it is too.`,
    };
  }
  const requestedMinor = input.amount != null ? toMinor(input.amount) : null;

  const existing = (await trx<EventRow>(TABLES.Event)
    .where({ tenantId, externalEventId: input.externalEventId })
    .first()) as EventRow | undefined;
  if (existing) {
    if (!sameRefund(existing, conversion, input.kind, requestedMinor)) return keyConflict(existing.id);
    return applyAndRespond(trx, conversion, existing, input.kind, true);
  }

  const prior = await apiRefundsOf(trx, conversion);
  const priorMinor = prior.reduce((s, e) => s - toMinor(e.value), 0);
  const valueMinor = toMinor(conversion.value);
  let refundMinor: number | null;
  if (valueMinor <= 0) {
    if (requestedMinor != null) {
      return {
        ok: false,
        status: 422,
        error: 'partial_refund_needs_value',
        detail: 'The conversion has no value to refund part of. Omit amount to refund it in full.',
      };
    }
    if (prior.length > 0) return nothingToRefund(prior);
    refundMinor = null;
  } else {
    const remainingMinor = valueMinor - priorMinor;
    if (remainingMinor <= 0) return nothingToRefund(prior);
    refundMinor = requestedMinor ?? remainingMinor;
    if (refundMinor > remainingMinor) {
      return {
        ok: false,
        status: 422,
        error: 'refund_exceeds_remaining',
        detail: `Only ${fromMinor(remainingMinor)} ${currency} of this conversion is left to refund.`,
        extra: { remaining: fromMinor(remainingMinor) },
      };
    }
  }

  const [refund] = (await trx<EventRow>(TABLES.Event)
    .insert({
      id: ulid(),
      tenantId,
      userId: conversion.userId,
      type: input.kind,
      // Negative, like every corrective event: this refund's own amount.
      value: refundMinor != null ? fromMinor(-refundMinor) : null,
      currency,
      externalEventId: input.externalEventId,
      metadata: {
        ...(input.metadata ?? {}),
        // The link apiRefundsOf sums prior refunds by.
        conversionEventId: conversion.id,
        conversionExternalEventId: conversion.externalEventId,
        requestedAmount: requestedMinor != null ? fromMinor(requestedMinor) : null,
        reason: input.reason ?? null,
      },
      ts: input.ts ?? new Date(),
    })
    .onConflict(['tenantId', 'externalEventId'])
    .ignore()
    .returning('*')) as EventRow[];
  if (!refund) {
    // Another request took this key for a different conversion (one for
    // this conversion would have waited on the lock above).
    const taken = await trx<EventRow>(TABLES.Event).where({ tenantId, externalEventId: input.externalEventId }).first('id');
    return keyConflict(taken?.id ?? null);
  }
  return applyAndRespond(trx, conversion, refund, input.kind, false);
}

async function applyAndRespond(
  trx: Knex,
  conversion: EventRow,
  refund: EventRow,
  kind: RefundKind,
  replayed: boolean,
): Promise<RecordRefundResult> {
  // The share comes from every refund recorded so far, this one included,
  // so a replay re-applies the same target (finishing anything that was
  // held in transfer) and a later refund isn't undone by an earlier replay.
  const all = await apiRefundsOf(trx, conversion);
  const refundedMinor = all.reduce((s, e) => s - toMinor(e.value), 0);
  const valueMinor = toMinor(conversion.value);
  const refunded: RefundedShare =
    valueMinor <= 0 || refundedMinor >= valueMinor ? { full: true } : { full: false, refundedMinor, ofMinor: valueMinor };
  const applied = await applyRefund(trx, { conversions: [conversion], refunded, refundEventId: refund.id });
  return {
    ok: true,
    announce: applied.announce,
    body: {
      ok: true,
      ...(replayed ? { replayed: true as const } : {}),
      refundEventId: refund.id,
      conversionEventId: conversion.id,
      kind,
      amount: refund.value != null ? fromMinor(-toMinor(refund.value)) : null,
      refundedAmount: valueMinor > 0 ? fromMinor(Math.min(refundedMinor, valueMinor)) : null,
      conversionValue: conversion.value != null ? fromMinor(valueMinor) : null,
      currency: (conversion.currency ?? 'USD').toUpperCase(),
      fullRefund: refunded.full,
      actionRequired: applied.commissions.some((c) => c.status === 'held_in_transfer' || c.status === 'clawback_recorded'),
      commissions: applied.commissions,
    },
  };
}

/** A retry of the same refund: same conversion, kind and requested amount. */
function sameRefund(existing: EventRow, conversion: EventRow, kind: RefundKind, requestedMinor: number | null): boolean {
  const md = (existing.metadata ?? {}) as { conversionEventId?: unknown; requestedAmount?: unknown };
  if (existing.type !== kind || md.conversionEventId !== conversion.id) return false;
  const stored = md.requestedAmount == null ? null : toMinor(md.requestedAmount as string);
  return stored === requestedMinor;
}

function keyConflict(eventId: string | null): RecordRefundResult {
  return {
    ok: false,
    status: 409,
    error: 'external_event_id_conflict',
    detail: 'externalEventId was already used for a different event, conversion, kind or amount',
    extra: eventId ? { eventId } : undefined,
  };
}

function nothingToRefund(prior: EventRow[]): RecordRefundResult {
  return {
    ok: false,
    status: 422,
    error: 'nothing_to_refund',
    detail: 'This conversion has already been refunded in full. To finish one that reported held_in_transfer, retry that refund with its own externalEventId.',
    extra: { refundEventIds: prior.map((e) => e.id) },
  };
}
