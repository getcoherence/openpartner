/**
 * Commission-lifecycle interlocks — spec §8 (finding 5).
 *
 * A commission sitting in a live funding allocation cannot be silently
 * status-flipped: the money for it is reserved, mid-charge, or mid-transfer.
 * Every reversal path (admin reverse, consumer-refund clawback) calls this
 * first and only flips what it clears:
 *
 *   allocation `reserved`         → allocation canceled, flip allowed.
 *       batch still `reserved`    → batch principal shrinks too (no PI yet).
 *       batch mid-flight/funded   → amounts stay frozen; the canceled
 *                                   allocation surfaces as a residual at
 *                                   settlement (settled_with_residual).
 *   allocation `transfer_pending` → HELD. The executor may be posting this
 *                                   very transfer; the flip is refused and
 *                                   the caller surfaces it for an operator.
 *   no live allocation            → flip allowed, nothing to do.
 *
 * `transferred` allocations never reach here in a flippable state —
 * their commissions are 'paid', which the reversal paths already treat
 * as immutable history (adjustments only).
 */

import type { Knex } from 'knex';
import {
  TABLES,
  type HostedFundingAllocationRow,
  type HostedFundingBatchRow,
} from '@openpartner/db';
import { casBatch } from './state.js';

export interface InterlockResult {
  /** Commission ids safe to status-flip (no live allocation, or the
   *  allocation was just canceled). */
  flippable: string[];
  /** Commission ids whose allocation is transfer_pending — do NOT flip. */
  held: string[];
}

export async function interlockCommissionReversal(
  db: Knex,
  commissionIds: string[],
): Promise<InterlockResult> {
  if (commissionIds.length === 0) return { flippable: [], held: [] };

  const live = (await db(TABLES.HostedFundingAllocation)
    .whereIn('commissionId', commissionIds)
    .whereIn('state', ['reserved', 'transfer_pending'])) as HostedFundingAllocationRow[];
  const byCommission = new Map(live.map((a) => [a.commissionId, a]));

  const flippable: string[] = [];
  const held: string[] = [];
  const canceledByBatch = new Map<string, { minor: number; allocationIds: string[] }>();

  for (const id of commissionIds) {
    const allocation = byCommission.get(id);
    if (!allocation) {
      flippable.push(id);
      continue;
    }
    if (allocation.state === 'transfer_pending') {
      held.push(id);
      continue;
    }
    // CAS the allocation out from under any concurrent executor claim —
    // the executor claims `WHERE state = 'reserved'` too, so exactly one
    // of us wins this row.
    const canceled = await db(TABLES.HostedFundingAllocation)
      .where({ id: allocation.id, state: 'reserved' })
      .update({ state: 'canceled', updatedAt: new Date() });
    if (canceled === 0) {
      // Executor won the race → it's transfer_pending now. Hold.
      held.push(id);
      continue;
    }
    flippable.push(id);
    const entry = canceledByBatch.get(allocation.batchId) ?? { minor: 0, allocationIds: [] };
    entry.minor += Number(allocation.amountMinor);
    entry.allocationIds.push(allocation.id);
    canceledByBatch.set(allocation.batchId, entry);
  }

  // Shrink still-`reserved` batches (no PI exists yet, amounts are ours to
  // edit). Ledger semantics of the allocation state depend on which side
  // of the charge freeze we're on:
  //   pre-PI  (shrink succeeded)  → allocation `released`: principal shrank
  //                                 with it, no residual ever exists.
  //   in-flight (shrink refused)  → allocation stays `canceled`: the charge
  //                                 amount is frozen, the money surfaces as
  //                                 a residual at settlement.
  // Invariant everywhere else: principal == Σ allocations != released.
  for (const [batchId, entry] of canceledByBatch) {
    const shrunk = (await db(TABLES.HostedFundingBatch)
      .where({ id: batchId, status: 'reserved' })
      .update({
        principalMinor: db.raw('"principalMinor" - ?', [entry.minor]),
        grossChargeMinor: db.raw('"grossChargeMinor" - ?', [entry.minor]),
        updatedAt: new Date(),
      })
      .returning('*')) as HostedFundingBatchRow[];
    if (shrunk.length === 0) {
      console.warn(
        `[funding] allocation(s) canceled on in-flight batch ${batchId} (${entry.minor} minor) — will settle as residual`,
      );
      continue;
    }
    await db(TABLES.HostedFundingAllocation)
      .whereIn('id', entry.allocationIds)
      .update({ state: 'released', updatedAt: new Date() });
    const remaining = await db(TABLES.HostedFundingAllocation)
      .where({ batchId })
      .whereIn('state', ['reserved', 'transfer_pending'])
      .count<{ count: string }[]>('* as count')
      .first();
    if (Number((remaining as { count?: string } | undefined)?.count ?? 1) === 0) {
      await casBatch(db, batchId, 'reserved', 'released', {
        failureReason: 'all_allocations_canceled',
        releasedAt: new Date(),
      });
    }
  }

  return { flippable, held };
}
