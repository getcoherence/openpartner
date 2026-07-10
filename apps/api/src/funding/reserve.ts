/**
 * Reservation — spec §5. One short DB transaction, no Stripe calls.
 *
 * Freezes a set of approved, unallocated commissions into a
 * HostedFundingBatch + allocations. The partial unique index on live
 * allocations makes concurrent double-reservation a constraint violation;
 * row locks (FOR UPDATE SKIP LOCKED, plain rows, grouping in app code —
 * review finding 10) make it a non-event.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type CommissionRow,
  type HostedFundingAuthorizationRow,
} from '@openpartner/db';
import { BATCH_FLOOR_MINOR, LAUNCH_CURRENCY, toMinor } from './state.js';

export interface ReservationCandidate {
  partnerId: string;
  /** Commission ids + minor amounts frozen for this partner. */
  commissionIds: string[];
  amountMinor: number;
}

export interface ReserveResult {
  batchId: string | null;
  reservedCommissions: number;
  principalMinor: number;
  skipped: 'no_authorization' | 'open_batch_exists' | 'below_floor' | 'nothing_eligible' | null;
}

/** The tenant's funding authorization, if live. No authorization → the
 *  caller leaves commissions on the #44 guard path (unchanged behavior). */
export async function getFundingAuthorization(
  db: Knex,
  tenantId: string,
): Promise<HostedFundingAuthorizationRow | null> {
  const row = (await db(TABLES.HostedFundingAuthorization)
    .where({ tenantId })
    .whereNull('revokedAt')
    .first()) as HostedFundingAuthorizationRow | undefined;
  return row ?? null;
}

/**
 * Reserve a batch for one tenant + currency from pre-grouped candidates
 * (the payout runner already resolved rails, Connect preflight, and
 * per-partner thresholds — reservation only re-verifies commission state
 * under row locks and applies the platform floor).
 *
 * MUST be called inside a transaction that already holds the tenant
 * payout advisory lock. Currency is canonical lowercase.
 */
export async function reserveFundingBatch(
  trx: Knex.Transaction,
  tenantId: string,
  currency: string,
  candidates: ReservationCandidate[],
): Promise<ReserveResult> {
  const ccy = currency.toLowerCase();
  if (ccy !== LAUNCH_CURRENCY) {
    // Non-USD stays on the guard path until the Bacs/GBP fast-follow.
    return { batchId: null, reservedCommissions: 0, principalMinor: 0, skipped: 'nothing_eligible' };
  }

  // One non-terminal batch per tenant × currency: eligible commissions
  // roll forward while a batch is open (founder decision; also enforced
  // by the partial unique index — this check just gives a clean result).
  const open = await trx(TABLES.HostedFundingBatch)
    .where({ tenantId, currency: ccy })
    .whereNotIn('status', ['settled', 'settled_with_residual', 'released'])
    .first(['id']);
  if (open) {
    return { batchId: null, reservedCommissions: 0, principalMinor: 0, skipped: 'open_batch_exists' };
  }

  const wantedIds = candidates.flatMap((c) => c.commissionIds);
  if (wantedIds.length === 0) {
    return { batchId: null, reservedCommissions: 0, principalMinor: 0, skipped: 'nothing_eligible' };
  }

  // Row-lock the individual commissions and re-verify eligibility under
  // the lock: still approved, and not in any live allocation. Plain-row
  // FOR UPDATE (no grouping/aggregates — review finding 10); SKIP LOCKED
  // sidesteps rows a concurrent run already claimed.
  const lockable = (await trx(TABLES.Commission)
    .whereIn('id', wantedIds)
    .where({ status: 'approved' })
    .whereNotExists(
      trx(TABLES.HostedFundingAllocation)
        .whereRaw('"HostedFundingAllocation"."commissionId" = "Commission"."id"')
        .whereNotIn('state', ['released', 'canceled']),
    )
    .forUpdate()
    .skipLocked()
    .select('id', 'partnerId', 'amount', 'currency')) as Pick<
    CommissionRow,
    'id' | 'partnerId' | 'amount' | 'currency'
  >[];

  const lockedIds = new Set(lockable.map((c) => c.id));
  const groups = candidates
    .map((c) => {
      const ids = c.commissionIds.filter((id) => lockedIds.has(id));
      const amountMinor = lockable
        .filter((row) => ids.includes(row.id))
        .reduce((sum, row) => sum + toMinor(row.amount as unknown as string), 0);
      return { partnerId: c.partnerId, commissionIds: ids, amountMinor };
    })
    .filter((g) => g.commissionIds.length > 0 && g.amountMinor > 0);

  const principalMinor = groups.reduce((s, g) => s + g.amountMinor, 0);
  if (groups.length === 0) {
    return { batchId: null, reservedCommissions: 0, principalMinor: 0, skipped: 'nothing_eligible' };
  }
  if (principalMinor < BATCH_FLOOR_MINOR) {
    return { batchId: null, reservedCommissions: 0, principalMinor, skipped: 'below_floor' };
  }

  const batchId = ulid();
  const now = new Date();
  await trx(TABLES.HostedFundingBatch).insert({
    id: batchId,
    tenantId,
    currency: ccy,
    principalMinor,
    grossChargeMinor: principalMinor, // launch: bank-debit-only, no funding fee
    quotedFeeMinor: 0,
    pricingVersion: 'launch-ach-v1',
    status: 'reserved',
    createdAt: now,
    updatedAt: now,
  });
  await trx(TABLES.HostedFundingAllocation).insert(
    groups.flatMap((g) =>
      g.commissionIds.map((commissionId) => {
        const row = lockable.find((c) => c.id === commissionId)!;
        return {
          id: ulid(),
          tenantId,
          batchId,
          commissionId,
          partnerId: g.partnerId,
          amountMinor: toMinor(row.amount as unknown as string),
          state: 'reserved',
          createdAt: now,
          updatedAt: now,
        };
      }),
    ),
  );

  return {
    batchId,
    reservedCommissions: groups.reduce((s, g) => s + g.commissionIds.length, 0),
    principalMinor,
    skipped: null,
  };
}
