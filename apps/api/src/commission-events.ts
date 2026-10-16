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
 * eventType / programId, looked up via Attribution → Event — so partner
 * postback macros ({click_id}, {event_id}, {transaction_id},
 * {event_type}, {program_id}) resolve on every lifecycle event, not just
 * commission.accrued. Trackers key conversions on the click id; without
 * it an approval or reversal can't be matched to the conversion it
 * updates.
 *
 * Like dispatchEvent this is fire-and-forget: the returned promise never
 * rejects, and a failed origin lookup still dispatches the bare payload
 * (a missing macro beats a missing event). Callers invoke it AFTER the
 * write that moved the commission has committed. It reads with the
 * privileged `db`, filtered by tenantId, for the same reason the
 * dispatcher does — the caller's transaction may already be gone.
 */

import { TABLES, type CommissionRow } from '@openpartner/db';
import { db } from './db.js';
import { dispatchEvent } from './webhook-dispatcher.js';

export type CommissionLifecycleEvent = 'commission.approved' | 'commission.reversed' | 'commission.paid';

type CommissionLike = Pick<CommissionRow, 'id' | 'partnerId' | 'attributionId' | 'amount' | 'currency'>;

interface CommissionOrigin {
  clickId: string;
  eventId: string;
  eventType: string | null;
  programId: string;
}

/** Bind-parameter headroom: a holdback sweep can approve thousands of
 *  rows at once, and Postgres caps a statement at 65535 parameters. */
const LOOKUP_CHUNK = 1000;

export async function dispatchCommissionEvents(
  tenantId: string,
  event: CommissionLifecycleEvent,
  commissions: readonly CommissionLike[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (commissions.length === 0) return;

  let origins = new Map<string, CommissionOrigin>();
  try {
    origins = await loadOrigins(tenantId, commissions.map((c) => c.attributionId));
  } catch (err) {
    console.error(
      `[webhook] ${event}: origin lookup failed, dispatching without click/event fields: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const c of commissions) {
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
      .where('a.tenantId', tenantId)
      .whereIn('a.id', ids.slice(i, i + LOOKUP_CHUNK))
      .select('a.id', 'a.clickId', 'a.eventId', 'a.programId', 'e.type as eventType')) as Array<
      { id: string } & CommissionOrigin
    >;
    for (const r of rows) {
      out.set(r.id, { clickId: r.clickId, eventId: r.eventId, eventType: r.eventType, programId: r.programId });
    }
  }
  return out;
}
