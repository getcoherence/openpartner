/**
 * A partner's attributed performance in one program over a window: the one
 * query commission tiers (commission-slabs.ts) and performance bounties
 * (performance-bounties.ts) share, so "a conversion" means the same thing to
 * both.
 *
 * What counts: the partner's Attribution rows in the program whose click
 * wasn't flagged (a partner can't climb on traffic the program rejected),
 * on the `events` asked for, with ts in [start, end). Corrective events
 * (refunds, chargebacks, disputes) never count as conversions. Tiers measure "strictly before
 * the event being accrued", so they pass that event's ts as `end` and its id
 * as `tieBreakId`: same-instant events with a lower id count too, so two
 * events stamped the same millisecond still order deterministically.
 *
 * Each touch counts as its SHARE of its event: its weight over the sum of
 * that event's weights under the same model. Attribution.weight is stored
 * to 4 decimals, so a conversion a partner owns outright through three
 * linear touches is stored as 3 × 0.3333 = 0.9999 (ten never reach "at
 * least 10"), and six touches as 1.0002. The ratio restores the share the
 * commission itself was paid on.
 *
 * Measures:
 *   count        Σ share
 *   value        Σ Event.value × share, events in `currency` only (no FX)
 *   commissions  Σ the partner's live (not reversed) commissions on those
 *                attributions, in `currency`, net of refund_clawback
 *                adjustments. Through Attribution, so a bonus's commission
 *                never counts: a bounty can't feed itself.
 *
 * `netOfRefunds` (bounties; tiers have never netted) takes refund and
 * chargeback Events into account, linked to their conversion through
 * metadata.conversionEventId: a conversion refunded in full stops counting,
 * and value counts net of what was refunded. Commissions already net
 * themselves: a refund reverses or replaces them, or claws back a paid one.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';

/** Event types that correct a conversion rather than being one
 *  (usage-ledger.ts CORRECTIVE_TYPES). */
export const CORRECTIVE_EVENT_TYPES = ['refund', 'chargeback', 'dispute_created', 'invoice_payment_failed'] as const;
/** The refunds POST /attribution/refunds records against a conversion. */
const REFUND_EVENT_TYPES = ['refund', 'chargeback'];

export interface MetricWindow {
  /** Inclusive. Null: all history. */
  start: Date | null;
  /** Exclusive. Null: no end. */
  end: Date | null;
  /** Also count events at exactly `end` whose id sorts below this one. */
  tieBreakId?: string;
}

export type PerformanceMeasure = 'count' | 'value' | 'commissions';

export interface PerformanceQuery {
  /** Filter on it explicitly as well as by the caller's RLS scope. Null:
   *  the caller's scope alone (the attribution engine's own handle). */
  tenantId: string | null;
  programId: string;
  /** These partners only; null = everyone with activity in the window. */
  partnerIds: readonly string[] | null;
  /** Events that count: these types; 'sales', any non-corrective event
   *  with a value above 0; or 'all', any non-corrective event. */
  events: readonly string[] | 'sales' | 'all';
  measure: PerformanceMeasure;
  /** value and commissions: only amounts in this currency. */
  currency?: string;
  window: MetricWindow;
  netOfRefunds?: boolean;
}

/** The measure per partner, unrounded. Partners with nothing are absent. */
export async function performanceByPartner(db: Knex, q: PerformanceQuery): Promise<Map<string, number>> {
  if (q.partnerIds && q.partnerIds.length === 0) return new Map();
  if ((q.measure === 'value' || q.measure === 'commissions') && !q.currency) {
    throw new Error(`[performance-metric] measure ${q.measure} needs a currency`);
  }

  const query = db(`${TABLES.Attribution} as a`)
    .join(`${TABLES.Event} as e`, 'e.id', 'a.eventId')
    .join(`${TABLES.Click} as c`, 'c.id', 'a.clickId')
    .where('a.programId', q.programId)
    .whereNull('c.fraudFlag');
  if (q.tenantId) query.andWhere('a.tenantId', q.tenantId);
  if (q.partnerIds) query.whereIn('a.partnerId', q.partnerIds as string[]);
  if (typeof q.events !== 'string') {
    query.whereIn('e.type', q.events as string[]);
  } else {
    if (q.events === 'sales') query.where('e.value', '>', 0);
    query.whereNotIn('e.type', CORRECTIVE_EVENT_TYPES as unknown as string[]);
  }

  const { start, end, tieBreakId } = q.window;
  if (start) query.andWhere('e.ts', '>=', start);
  if (end) {
    if (tieBreakId) {
      query.andWhere((qb) =>
        qb.where('e.ts', '<', end).orWhere((same) => same.where('e.ts', end).andWhere('e.id', '<', tieBreakId)),
      );
    } else {
      query.andWhere('e.ts', '<', end);
    }
  }

  if (q.netOfRefunds && q.measure !== 'commissions') {
    // Refund Events grouped by the conversion they name. Tenant-filtered
    // inside the subquery, which can't see the outer rows.
    query.leftJoin(
      db(TABLES.Event)
        .whereIn('type', REFUND_EVENT_TYPES)
        .whereRaw(`metadata->>'conversionEventId' is not null`)
        .modify((r) => {
          if (q.tenantId) r.andWhere('tenantId', q.tenantId);
        })
        .groupByRaw(`metadata->>'conversionEventId'`)
        .select(
          db.raw(`metadata->>'conversionEventId' as "eventId"`),
          db.raw('sum(greatest(-coalesce(value, 0), 0)) as refunded'),
          db.raw('bool_or(value is null) as "nullRefund"'),
        )
        .as('rf'),
      'rf.eventId',
      'e.id',
    );
  }

  const share = `"a"."weight" / nullif((select sum("w"."weight") from "${TABLES.Attribution}" as "w" where "w"."eventId" = "a"."eventId" and "w"."model" = "a"."model"), 0)`;
  // Refunded in full: a value-less refund, a refund of a value-less
  // conversion, or refunds adding up to its whole value.
  const refundedOut = `(coalesce("rf"."nullRefund", false) or ("rf"."eventId" is not null and coalesce("e"."value", 0) <= "rf"."refunded"))`;

  let total: string;
  if (q.measure === 'count') {
    total = q.netOfRefunds
      ? `coalesce(sum(case when ${refundedOut} then 0 else ${share} end), 0)`
      : `coalesce(sum(${share}), 0)`;
  } else if (q.measure === 'value') {
    // Revenue in other currencies can't be added to this one without FX.
    query.andWhereRaw(`upper(coalesce("e"."currency", 'USD')) = ?`, [q.currency!]);
    const value = q.netOfRefunds
      ? `case when coalesce("rf"."nullRefund", false) then 0 else greatest(coalesce("e"."value", 0) - coalesce("rf"."refunded", 0), 0) end`
      : `coalesce("e"."value", 0)`;
    total = `coalesce(sum(${value} * ${share}), 0)`;
  } else {
    query
      .join(`${TABLES.Commission} as cm`, 'cm.attributionId', 'a.id')
      .whereNot('cm.status', 'reversed')
      .andWhereRaw(`upper("cm"."currency") = ?`, [q.currency!])
      .leftJoin(
        db(TABLES.CommissionAdjustment)
          .where('reason', 'refund_clawback')
          .groupBy('commissionId')
          .select('commissionId', db.raw('sum(amount) as clawback'))
          .as('adj'),
        'adj.commissionId',
        'cm.id',
      );
    total = `coalesce(sum("cm"."amount" + coalesce("adj"."clawback", 0)), 0)`;
  }

  const rows = (await query.groupBy('a.partnerId').select('a.partnerId', db.raw(`${total} as total`))) as Array<{
    partnerId: string;
    total: string | number;
  }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.partnerId, Number(r.total));
  return out;
}
