/**
 * Commission lifecycle webhooks — commission.approved / .reversed / .paid.
 *
 * Every path that moves a commission through its lifecycle (the admin
 * routes, the holdback auto-approve job, Stripe refund reversals, the
 * payout runner and both transfer executors) fires through here, so the
 * brand's webhook subscribers and the partner's postback get one payload
 * shape no matter which path did the move.
 *
 * The payload carries the commission's origin — clickId / eventId /
 * eventType / programId / eventValue / subId, looked up via Attribution →
 * Event and Click — so partner postback macros ({click_id}, {event_id},
 * {transaction_id}, {event_type}, {program_id}, {sale_amount}, {sub_id})
 * resolve on every lifecycle event, not just commission.accrued. Trackers
 * key conversions on the click id (or their own sub-ID); without it an
 * approval or reversal can't be matched to the conversion it updates.
 *
 * A bonus's commission (bonusId set, no attribution) fires the matching
 * bonus.* event instead (bonus.approved / .paid / .reversed, see
 * bonuses.ts), never commission.*: those payloads promise an attributionId,
 * a click and an event, and integrations rely on that.
 *
 * Like dispatchEvent this is fire-and-forget: the returned promise never
 * rejects, and a failed origin lookup still dispatches the bare payload
 * (a missing macro beats a missing event). Callers invoke it AFTER the
 * write that moved the commission has committed. It reads with the
 * privileged `db`, filtered by tenantId, for the same reason the
 * dispatcher does — the caller's transaction may already be gone.
 */

import { TABLES, type BonusRow, type CommissionRow, type WebhookEventType } from '@openpartner/db';
import { bonusPayload } from './bonuses.js';
import { db } from './db.js';
import { dispatchEvent } from './webhook-dispatcher.js';

export type CommissionLifecycleEvent = 'commission.approved' | 'commission.reversed' | 'commission.paid';

/** `bonusId` is required so no caller can forget it and announce a bonus
 *  as an attributed commission. */
type CommissionLike = Pick<CommissionRow, 'id' | 'partnerId' | 'attributionId' | 'bonusId' | 'amount' | 'currency'>;

const BONUS_EVENT: Record<CommissionLifecycleEvent, WebhookEventType> = {
  'commission.approved': 'bonus.approved',
  'commission.paid': 'bonus.paid',
  'commission.reversed': 'bonus.reversed',
};

export interface CommissionOrigin {
  clickId: string;
  eventId: string;
  eventType: string | null;
  programId: string;
  /** Event.value: the sale amount, or null for a valueless event. */
  eventValue: string | null;
  /** Click.subId: the publisher's `?sub_id=`, or null. */
  subId: string | null;
}

/** Bind-parameter headroom: a holdback sweep can approve thousands of
 *  rows at once, and Postgres caps a statement at 65535 parameters. */
const LOOKUP_CHUNK = 1000;

/**
 * `known` origins, keyed by attributionId, skip the lookup for those rows.
 * A caller that holds them already passes them when its rows may not be
 * committed yet (the lookup reads committed data only).
 */
export async function dispatchCommissionEvents(
  tenantId: string,
  event: CommissionLifecycleEvent,
  commissions: readonly CommissionLike[],
  extra: Record<string, unknown> = {},
  known?: ReadonlyMap<string, CommissionOrigin>,
): Promise<void> {
  const bonuses = commissions.filter((c) => c.bonusId);
  if (bonuses.length > 0) await dispatchBonusEvents(tenantId, BONUS_EVENT[event], bonuses, extra);
  const attributed = commissions.filter(
    (c): c is CommissionLike & { attributionId: string } => !c.bonusId && !!c.attributionId,
  );
  if (attributed.length === 0) return;

  const origins = new Map<string, CommissionOrigin>(known ?? []);
  try {
    const missing = attributed.map((c) => c.attributionId).filter((id) => !origins.has(id));
    if (missing.length > 0) for (const [id, o] of await loadOrigins(tenantId, missing)) origins.set(id, o);
  } catch (err) {
    console.error(
      `[webhook] ${event}: origin lookup failed, dispatching without click/event fields: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const c of attributed) {
    const origin = origins.get(c.attributionId);
    dispatchEvent(tenantId, event, {
      commissionId: c.id,
      partnerId: c.partnerId,
      attributionId: c.attributionId,
      amount: c.amount,
      currency: c.currency,
      ...(origin
        ? {
            clickId: origin.clickId,
            eventId: origin.eventId,
            ...(origin.eventType ? { eventType: origin.eventType } : {}),
            programId: origin.programId,
            eventValue: origin.eventValue,
            subId: origin.subId,
          }
        : {}),
      ...extra,
    });
  }
}

async function loadOrigins(tenantId: string, attributionIds: string[]): Promise<Map<string, CommissionOrigin>> {
  const ids = [...new Set(attributionIds)];
  const out = new Map<string, CommissionOrigin>();
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const rows = (await db(`${TABLES.Attribution} as a`)
      .leftJoin(`${TABLES.Event} as e`, 'e.id', 'a.eventId')
      .leftJoin(`${TABLES.Click} as c`, (j) => j.on('c.id', 'a.clickId').andOn('c.tenantId', 'a.tenantId'))
      .where('a.tenantId', tenantId)
      .whereIn('a.id', ids.slice(i, i + LOOKUP_CHUNK))
      .select(
        'a.id',
        'a.clickId',
        'a.eventId',
        'a.programId',
        'e.type as eventType',
        'e.value as eventValue',
        'c.subId as subId',
      )) as Array<{ id: string } & CommissionOrigin>;
    for (const r of rows) {
      out.set(r.id, {
        clickId: r.clickId,
        eventId: r.eventId,
        eventType: r.eventType,
        programId: r.programId,
        eventValue: r.eventValue,
        subId: r.subId,
      });
    }
  }
  return out;
}

/**
 * bonus.approved / .paid / .reversed for bonus commissions. The bonus row
 * supplies programId, bountyId, source and note; if that lookup fails the
 * bare payload still goes out, as for a commission's origin.
 */
async function dispatchBonusEvents(
  tenantId: string,
  event: WebhookEventType,
  commissions: readonly CommissionLike[],
  extra: Record<string, unknown>,
): Promise<void> {
  const bonuses = new Map<string, BonusRow>();
  try {
    const ids = [...new Set(commissions.map((c) => c.bonusId!))];
    for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
      const rows = (await db(TABLES.Bonus)
        .where({ tenantId })
        .whereIn('id', ids.slice(i, i + LOOKUP_CHUNK))) as BonusRow[];
      for (const b of rows) bonuses.set(b.id, b);
    }
  } catch (err) {
    console.error(
      `[webhook] ${event}: bonus lookup failed, dispatching without bonus fields: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const c of commissions) {
    const bonus = bonuses.get(c.bonusId!);
    dispatchEvent(tenantId, event, {
      ...(bonus
        ? bonusPayload(bonus, c.id)
        : { bonusId: c.bonusId, commissionId: c.id, partnerId: c.partnerId, amount: c.amount, currency: c.currency }),
      ...extra,
    });
  }
}
