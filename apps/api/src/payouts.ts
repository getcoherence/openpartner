/**
 * Payout runner.
 *
 * Finds approved commissions, groups by (partner, currency), creates a Stripe
 * transfer from the platform balance to each partner's Connect Standard
 * account, writes a Payout row, and marks the commissions paid.
 *
 * Mode semantics:
 *   - selfhost / flat   → no platform fee; transfer the full amount.
 *   - revshare          → we retain 3% as our platform fee. The transfer still
 *                         sends the full commission amount to the partner;
 *                         the 3% is reconciled against merchant billing (tracked
 *                         on Payout.metadata.platformFee for the ledger).
 *
 * Idempotency: we stamp the transfer's idempotency key with the Payout id
 * (generated up front) so a retry after a crash does not double-transfer.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type CommissionRow,
  type PartnerRow,
  type PayoutMethod,
} from '@openpartner/db';
import { db } from './db.js';
import { REVSHARE_FEE_BPS, getMode, requireStripe, type OpenPartnerMode } from './stripe.js';

export interface PayoutRunResult {
  runId: string;
  mode: OpenPartnerMode;
  payouts: Array<{
    payoutId: string;
    partnerId: string;
    amount: number;
    currency: string;
    method: PayoutMethod;
    status: 'pending' | 'paid' | 'failed';
    platformFee?: number;
    error?: string;
  }>;
}

export async function runPayouts(): Promise<PayoutRunResult> {
  const mode = getMode();
  const runId = ulid();

  const groups = (await db(TABLES.Commission)
    .where({ status: 'approved' })
    .groupBy('partnerId', 'currency')
    .select('partnerId', 'currency')
    .sum({ total: 'amount' })) as Array<{ partnerId: string; currency: string; total: string }>;

  const results: PayoutRunResult['payouts'] = [];

  for (const group of groups) {
    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: group.partnerId }).first();
    if (!partner) continue;

    const commissions = await db<CommissionRow>(TABLES.Commission)
      .where({ partnerId: group.partnerId, currency: group.currency, status: 'approved' });

    const amount = Number(group.total ?? 0);
    const platformFee = mode === 'revshare' ? Math.round(amount * REVSHARE_FEE_BPS) / 10000 : 0;

    const payoutId = ulid();
    const method: PayoutMethod = partner.stripeConnectAccountId ? 'stripe_connect' : 'manual';

    await db.transaction(async (trx) => {
      await trx(TABLES.Payout).insert({
        id: payoutId,
        partnerId: partner.id,
        amount: amount.toFixed(2),
        currency: group.currency,
        method,
        status: 'pending',
        metadata: { runId, platformFee, commissionCount: commissions.length },
      });

      await trx(TABLES.Commission)
        .whereIn(
          'id',
          commissions.map((c) => c.id),
        )
        .update({ status: 'paid', paidAt: new Date(), payoutId });
    });

    if (method === 'stripe_connect' && partner.stripeConnectAccountId) {
      try {
        const stripe = requireStripe();
        const transfer = await stripe.transfers.create(
          {
            amount: Math.round(amount * 100),
            currency: group.currency.toLowerCase(),
            destination: partner.stripeConnectAccountId,
            metadata: { openpartner_payout_id: payoutId, mode },
          },
          { idempotencyKey: `payout_${payoutId}` },
        );

        await db(TABLES.Payout).where({ id: payoutId }).update({
          stripeTransferId: transfer.id,
          status: 'paid',
          completedAt: new Date(),
        });

        results.push({
          payoutId,
          partnerId: partner.id,
          amount,
          currency: group.currency,
          method,
          status: 'paid',
          platformFee: platformFee || undefined,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await markPayoutFailed(db, payoutId, commissions.map((c) => c.id));
        results.push({
          payoutId,
          partnerId: partner.id,
          amount,
          currency: group.currency,
          method,
          status: 'failed',
          error: message,
        });
      }
    } else {
      // Manual / external: the Payout row exists in 'pending' state; operator
      // marks it paid once the transfer clears out-of-band.
      results.push({
        payoutId,
        partnerId: partner.id,
        amount,
        currency: group.currency,
        method,
        status: 'pending',
        platformFee: platformFee || undefined,
      });
    }
  }

  return { runId, mode, payouts: results };
}

async function markPayoutFailed(
  knex: Knex,
  payoutId: string,
  commissionIds: string[],
): Promise<void> {
  await knex.transaction(async (trx) => {
    await trx(TABLES.Payout).where({ id: payoutId }).update({ status: 'failed' });
    // Roll commissions back to approved so the next run can retry.
    await trx(TABLES.Commission)
      .whereIn('id', commissionIds)
      .update({ status: 'approved', paidAt: null, payoutId: null });
  });
}
