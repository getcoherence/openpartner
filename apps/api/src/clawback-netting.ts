/**
 * Netting refund clawbacks off a partner's next payout
 * (docs/refund-clawback-netting.md).
 *
 * A refund of an already-paid commission can't reverse it — paid rows are
 * ledger history — so `applyRefund` records a negative CommissionAdjustment
 * (`refund_clawback`). The payout planner deducts those from the partner's
 * next manual or direct-Connect payout and stamps the payout on them
 * (`appliedPayoutId`); the direct-Connect executor un-stamps them wherever
 * it abandons that payout. Every payout that nets keeps
 *
 *   amount = Σ its commissions + Σ the adjustments stamped with its id
 *
 * The hosted-funding rail never nets: a funding batch charges the brand the
 * sum of per-commission allocations and has no row for a deduction (§4 of
 * the design note). Its partners' clawbacks stay outstanding until a manual
 * or direct-Connect payout picks them up.
 *
 * Only `refund_clawback` rows are ever netted. A `transfer_reversed`
 * adjustment means the money already came back; and a clawback on a
 * commission whose transfer was then reversed is capped out (see
 * `outstandingClawbacks`), so nothing is recovered twice.
 */

import type { Knex } from 'knex';
import { TABLES, type CommissionAdjustmentRow, type CommissionRow } from '@openpartner/db';
import { majorToCents } from './stripe-amounts.js';

// Amounts here are integer hundredths of the major unit ("cents"), the
// storage precision of Commission.amount and CommissionAdjustment.amount,
// whatever the currency. The planner converts the net figure to Stripe's
// integer form for the currency (stripe-amounts.ts) only when it freezes a
// transfer intent.

export interface ClawbackNetting {
  /** The clawbacks to deduct, oldest first. */
  adjustmentIds: string[];
  /** What they deduct, as a positive amount in hundredths. */
  clawbackCents: number;
}

export const NO_NETTING: ClawbackNetting = { adjustmentIds: [], clawbackCents: 0 };

/** `Payout.metadata.netting`: an audit copy of what the planner netted, in
 *  hundredths. The stamps on CommissionAdjustment are the source of truth. */
export interface PayoutNettingMeta {
  /** Σ the payout's commissions, before clawbacks. */
  grossCents: number;
  clawbackCents: number;
  adjustmentIds: string[];
}

/** The optional `payout.created` fields that let a subscriber reconcile
 *  `amount` with the commissions it lists. Empty when nothing was netted.
 *  `amount` is grossAmount − clawbackAmount, rounded to what Stripe can
 *  send in currencies without fractions (¥100.50 → ¥101). */
export function nettingPayloadFields(
  netting: unknown,
): { grossAmount?: string; clawbackAmount?: string; clawbackAdjustmentIds?: string[] } {
  const n = netting as Partial<PayoutNettingMeta> | null | undefined;
  if (!n || typeof n.clawbackCents !== 'number' || n.clawbackCents <= 0 || typeof n.grossCents !== 'number') return {};
  return {
    grossAmount: (n.grossCents / 100).toFixed(2),
    clawbackAmount: (n.clawbackCents / 100).toFixed(2),
    clawbackAdjustmentIds: Array.isArray(n.adjustmentIds) ? n.adjustmentIds : [],
  };
}

/**
 * The partner's outstanding refund clawbacks in `currency` that may be
 * netted now. Run inside the planner's transaction.
 *
 * Each clawback is capped by what the partner still holds from its
 * commission: the amount, less every other adjustment on it (a reversed
 * transfer, or clawbacks already netted). A full transfer reversal writes
 * `transfer_reversed` for the whole amount, which leaves nothing to take,
 * so a clawback recorded before that reversal is left alone rather than
 * recovered a second time. Clawbacks are taken whole, oldest first, while
 * they fit.
 *
 * Locks the clawbacks' commissions before reading their adjustments.
 * `applyRefund` and the funding reversal handler take the same lock before
 * they write one, so neither can land between the cap and the stamp.
 */
export async function outstandingClawbacks(
  trx: Knex,
  tenantId: string,
  partnerId: string,
  currency: string,
): Promise<ClawbackNetting> {
  const candidates = (await trx(`${TABLES.CommissionAdjustment} as a`)
    .join(`${TABLES.Commission} as c`, 'c.id', 'a.commissionId')
    .where('a.tenantId', tenantId)
    .where('c.tenantId', tenantId)
    .where('c.partnerId', partnerId)
    .where('a.reason', 'refund_clawback')
    .whereNull('a.appliedPayoutId')
    .whereRaw('upper(a."currency") = upper(?)', [currency])
    .select('a.commissionId')) as Array<{ commissionId: string }>;
  if (candidates.length === 0) return NO_NETTING;

  const commissionIds = [...new Set(candidates.map((r) => r.commissionId))].sort();
  const commissions = (await trx<CommissionRow>(TABLES.Commission)
    .whereIn('id', commissionIds)
    .orderBy('id')
    .forUpdate()
    .select('id', 'amount', 'status')) as Array<Pick<CommissionRow, 'id' | 'amount' | 'status'>>;

  // Re-read under the lock: everything written before it is visible now.
  const adjustments = (await trx<CommissionAdjustmentRow>(TABLES.CommissionAdjustment)
    .whereIn('commissionId', commissionIds)
    .orderBy('createdAt')
    .orderBy('id')) as CommissionAdjustmentRow[];

  const out: ClawbackNetting = { adjustmentIds: [], clawbackCents: 0 };
  for (const commission of commissions) {
    const mine = adjustments.filter((a) => a.commissionId === commission.id);
    const isOpen = (a: CommissionAdjustmentRow) =>
      a.reason === 'refund_clawback' &&
      a.appliedPayoutId == null &&
      a.currency.toUpperCase() === currency.toUpperCase() &&
      majorToCents(a.amount) < 0;
    const open = mine.filter(isOpen);
    if (open.length === 0) continue;
    if (commission.status !== 'paid') {
      // Clawbacks are only ever written against paid commissions.
      console.error(
        `[payouts] ALERT: commission ${commission.id} carries refund clawbacks but is ${commission.status} — not netted`,
      );
      continue;
    }
    let holdsCents = majorToCents(commission.amount) + mine.filter((a) => !isOpen(a)).reduce((s, a) => s + majorToCents(a.amount), 0);
    for (const a of open) {
      const takeCents = -majorToCents(a.amount);
      if (takeCents > holdsCents) {
        console.warn(
          `[payouts] refund clawback ${a.id} (${a.amount} ${a.currency}) on commission ${commission.id} is not netted: the partner holds only ${(Math.max(holdsCents, 0) / 100).toFixed(2)} from it after other adjustments`,
        );
        continue;
      }
      holdsCents -= takeCents;
      out.adjustmentIds.push(a.id);
      out.clawbackCents += takeCents;
    }
  }
  return out;
}

/**
 * Stamp the netted clawbacks with their payout, in the planner's
 * transaction. Compare-and-set on `appliedPayoutId is null`: a short count
 * means another run netted one of them first, and the caller's run aborts —
 * nothing has been announced or sent to Stripe yet.
 */
export async function stampClawbacks(trx: Knex, payoutId: string, adjustmentIds: readonly string[]): Promise<void> {
  if (adjustmentIds.length === 0) return;
  const stamped = await trx(TABLES.CommissionAdjustment)
    .whereIn('id', adjustmentIds)
    .where({ reason: 'refund_clawback' })
    .whereNull('appliedPayoutId')
    .update({ appliedPayoutId: payoutId });
  if (stamped !== adjustmentIds.length) {
    throw new Error(
      `payout ${payoutId}: netted ${stamped}/${adjustmentIds.length} refund clawbacks — another payout run took one concurrently; aborting`,
    );
  }
}

/** What the clawbacks stamped with `payoutId` deduct, as a positive amount
 *  in hundredths. */
export async function nettedClawbackCents(db: Knex, payoutId: string): Promise<number> {
  const rows = (await db(TABLES.CommissionAdjustment)
    .where({ appliedPayoutId: payoutId })
    .select('amount')) as Array<{ amount: string }>;
  return -rows.reduce((s, r) => s + majorToCents(r.amount), 0);
}

/** Return the clawbacks a dead payout netted to the outstanding pool. Run
 *  in the transaction that terminalizes the payout. */
export async function releaseNettedClawbacks(trx: Knex, payoutId: string): Promise<void> {
  await trx(TABLES.CommissionAdjustment).where({ appliedPayoutId: payoutId }).update({ appliedPayoutId: null });
}
