/**
 * Hosted funding — state-machine primitives (docs/payout-funding.md §3/§9).
 *
 * Every transition is compare-and-set: `UPDATE … WHERE status = expected`.
 * A transition that matches zero rows is a LOSS, and callers must treat it
 * as "someone else moved first" — re-read, never force. This is what makes
 * webhook replays, out-of-order events, and concurrent workers safe.
 */

import type { Knex } from 'knex';
import { TABLES, type FundingBatchStatus, type HostedFundingBatchRow } from '@openpartner/db';

export const FUNDING_TIMEOUT_DAYS = 10;
export const TRANSFER_DEADLINE_DAYS = 14;
/** Platform floor per batch (founder decision) — below this, commissions
 *  roll forward instead of generating a paperwork-sized bank debit. */
export const BATCH_FLOOR_MINOR = 2_500; // $25.00
/** Launch is USD + ACH only (spec §12). */
export const LAUNCH_CURRENCY = 'usd';

export function fundingEnabled(): boolean {
  return process.env.HOSTED_FUNDING_ENABLED === '1';
}

/** Major-unit decimal string/number → integer minor units (USD/GBP: ×100).
 *  Throws on NaN — money math never guesses. */
export function toMinor(amount: string | number): number {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) throw new Error(`non-numeric amount: ${amount}`);
  return Math.round(n * 100);
}

export function minorToMajorString(minor: number | string): string {
  const n = typeof minor === 'string' ? Number(minor) : minor;
  return (n / 100).toFixed(2);
}

/**
 * Compare-and-set a batch transition. Returns the updated row on a win,
 * null on a loss (someone else transitioned first — caller re-reads).
 */
export async function casBatch(
  db: Knex,
  batchId: string,
  from: FundingBatchStatus | FundingBatchStatus[],
  to: FundingBatchStatus,
  patch: Partial<Record<string, unknown>> = {},
): Promise<HostedFundingBatchRow | null> {
  const fromList = Array.isArray(from) ? from : [from];
  const [row] = (await db(TABLES.HostedFundingBatch)
    .where({ id: batchId })
    .whereIn('status', fromList)
    .update({ status: to, updatedAt: new Date(), ...patch })
    .returning('*')) as HostedFundingBatchRow[];
  return row ?? null;
}

/** Collector retry backoff by attempt count (owned dunning: ~day 1, 3, 7).
 *  Attempt 0 (first try) is always due. */
export function fundingRetryDueMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const days = attempts === 1 ? 1 : attempts === 2 ? 2 : 4; // cumulative ≈ 1, 3, 7
  return days * 24 * 60 * 60 * 1000;
}

/** Stable advisory-lock key for a tenant's payout/funding runs. Shared by
 *  the scheduler tick, the admin run-payouts endpoint, and the collector,
 *  so no two of them can operate on one tenant concurrently. */
export function payoutLockKey(tenantId: string): [number, number] {
  let h = 0;
  for (let i = 0; i < tenantId.length; i += 1) h = ((h << 5) - h + tenantId.charCodeAt(i)) | 0;
  return [0x50415946 /* 'PAYF' */, h];
}

export async function tryTenantPayoutLock(trx: Knex.Transaction, tenantId: string): Promise<boolean> {
  const [classId, objId] = payoutLockKey(tenantId);
  const r = (await trx.raw('select pg_try_advisory_xact_lock(?, ?) as locked', [classId, objId])) as {
    rows: Array<{ locked: boolean }>;
  };
  return !!r.rows[0]?.locked;
}
