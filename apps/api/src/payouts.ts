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
 *
 * Multi-tenant: takes (db, tenantId). Pass req.db from a route handler, or
 * the privileged db with app.tenant_id pinned in the calling transaction
 * from the scheduler.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type CommissionRow,
  type PartnerRow,
  type PayoutMethod,
  type PayoutRailPreference,
  type TenantRow,
} from '@openpartner/db';
import { REVSHARE_FEE_BPS, getMode, requireStripe, type OpenPartnerMode } from './stripe.js';
import { dispatchEvent } from './webhook-dispatcher.js';

export interface PayoutRunResult {
  runId: string;
  mode: OpenPartnerMode;
  /** Group totals that didn't meet the tenant's payoutThresholdCents are
   *  reported here instead of in payouts. Commissions stay 'approved' so
   *  they accumulate to the next run. */
  skippedBelowThreshold: Array<{ partnerId: string; currency: string; amount: number }>;
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

export async function runPayouts(db: Knex, tenantId: string): Promise<PayoutRunResult> {
  const mode = getMode();
  const runId = ulid();

  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first();
  const railPreference: PayoutRailPreference = tenant?.payoutRailPreference ?? 'auto';
  // null / 0 / negative all collapse to "no threshold" — keeps the legacy
  // behavior intact for tenants who haven't touched the setting.
  const thresholdCents = Math.max(0, tenant?.payoutThresholdCents ?? 0);

  const groups = (await db(TABLES.Commission)
    .where({ status: 'approved' })
    .groupBy('partnerId', 'currency')
    .select('partnerId', 'currency')
    .sum({ total: 'amount' })) as Array<{ partnerId: string; currency: string; total: string }>;

  const results: PayoutRunResult['payouts'] = [];
  const skipped: PayoutRunResult['skippedBelowThreshold'] = [];

  for (const group of groups) {
    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: group.partnerId }).first();
    if (!partner) continue;

    const amount = Number(group.total ?? 0);
    // Threshold gate: balances below the tenant minimum stay 'approved'
    // and roll over to the next run. We treat amounts in dollars; cents
    // are the storage unit on the tenant column so converting once here
    // keeps the comparison numerically stable across currencies.
    if (thresholdCents > 0 && Math.round(amount * 100) < thresholdCents) {
      skipped.push({ partnerId: partner.id, currency: group.currency, amount });
      continue;
    }

    const commissions = await db<CommissionRow>(TABLES.Commission)
      .where({ partnerId: group.partnerId, currency: group.currency, status: 'approved' });

    const platformFee = mode === 'revshare' ? Math.round(amount * REVSHARE_FEE_BPS) / 10000 : 0;

    const payoutId = ulid();
    // Rail preference resolves to a concrete method per partner:
    //   auto            (legacy) stripe_connect if Connect account exists, else manual
    //   stripe_connect  always stripe_connect — partners without a Connect
    //                   account get a 'failed' payout with a clear error
    //                   instead of silently being paid manually
    //   manual          force manual — operator handles all transfers off-platform
    const method: PayoutMethod = (() => {
      if (railPreference === 'manual') return 'manual';
      if (railPreference === 'stripe_connect') return 'stripe_connect';
      return partner.stripeConnectAccountId ? 'stripe_connect' : 'manual';
    })();

    // Preflight: a linked Connect account that hasn't finished onboarding
    // will 400 on transfers.create. Decide up front and take a path that
    // doesn't optimistically mark commissions paid — the previous design
    // rolled commissions back on failure but the Payout row was already
    // committed, and webhooks fired before the outcome was known.
    const stripeMeta = (partner.metadata as { stripe?: { payoutsEnabled?: boolean } }).stripe;
    const payoutsReady = stripeMeta?.payoutsEnabled === true;
    const canTransfer = method === 'stripe_connect' && partner.stripeConnectAccountId && payoutsReady;
    const onboardingIncomplete =
      method === 'stripe_connect' && partner.stripeConnectAccountId && !payoutsReady;
    // Tenant forced stripe_connect but the partner never connected an
    // account. Distinct from onboarding-incomplete (which means an account
    // exists but isn't payouts-enabled yet); the partner-facing message
    // is "start connect onboarding" rather than "finish it".
    const noConnectAccount = method === 'stripe_connect' && !partner.stripeConnectAccountId;
    const connectBlocked = onboardingIncomplete || noConnectAccount;
    const blockReason = noConnectAccount
      ? 'stripe_connect_account_missing'
      : onboardingIncomplete
        ? 'stripe_onboarding_incomplete'
        : null;

    // Commissions move to 'paid' ONLY when we have a terminal success
    // signal: either Stripe transfer succeeded, or method=manual (the
    // operator accepts responsibility out-of-band). Connect-blocked and
    // Stripe failures leave commissions 'approved' so the next run picks
    // them up.
    const finalStatus: 'paid' | 'pending' | 'failed' =
      canTransfer ? 'pending' /* flipped to 'paid' after transfer */ :
      connectBlocked ? 'failed' :
      /* manual */ 'pending';

    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId,
      partnerId: partner.id,
      amount: amount.toFixed(2),
      currency: group.currency,
      method,
      status: finalStatus,
      metadata: {
        runId,
        platformFee,
        commissionCount: commissions.length,
        ...(blockReason ? { error: blockReason } : {}),
      },
    });
    // Only mark commissions paid on the manual-commit path. Connect
    // path defers until after the transfer succeeds.
    if (method === 'manual') {
      await db(TABLES.Commission)
        .whereIn('id', commissions.map((c) => c.id))
        .update({ status: 'paid', paidAt: new Date(), payoutId });
    }

    if (connectBlocked) {
      results.push({
        payoutId,
        partnerId: partner.id,
        amount,
        currency: group.currency,
        method,
        status: 'pending',
        platformFee: platformFee || undefined,
        error: blockReason ?? undefined,
      });
      continue;
    }

    if (canTransfer) {
      try {
        const stripe = requireStripe();
        const transfer = await stripe.transfers.create(
          {
            amount: Math.round(amount * 100),
            currency: group.currency.toLowerCase(),
            destination: partner.stripeConnectAccountId!,
            metadata: { openpartner_payout_id: payoutId, openpartner_tenant_id: tenantId, mode },
          },
          { idempotencyKey: `payout_${payoutId}` },
        );

        await db(TABLES.Payout).where({ id: payoutId }).update({
          stripeTransferId: transfer.id,
          status: 'paid',
          completedAt: new Date(),
        });
        await db(TABLES.Commission)
          .whereIn('id', commissions.map((c) => c.id))
          .update({ status: 'paid', paidAt: new Date(), payoutId });

        // Webhooks fire only after the success is durable.
        dispatchEvent(tenantId, 'payout.created', {
          payoutId,
          partnerId: partner.id,
          amount: amount.toFixed(2),
          currency: group.currency,
          method,
          commissionIds: commissions.map((c) => c.id),
          platformFee: platformFee || undefined,
        });
        for (const c of commissions) {
          dispatchEvent(tenantId, 'commission.paid', {
            commissionId: c.id,
            partnerId: c.partnerId,
            amount: c.amount,
            currency: c.currency,
            payoutId,
          });
        }

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
        await db(TABLES.Payout).where({ id: payoutId }).update({ status: 'failed' });
        // Commissions were never flipped to paid in the Connect path, so
        // no rollback is needed — they're still 'approved' and will be
        // retried on the next runPayouts().
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
      // Manual path: commissions are already marked paid in the tx above.
      // Fire webhooks now — the operator owns the out-of-band transfer.
      dispatchEvent(tenantId, 'payout.created', {
        payoutId,
        partnerId: partner.id,
        amount: amount.toFixed(2),
        currency: group.currency,
        method,
        commissionIds: commissions.map((c) => c.id),
        platformFee: platformFee || undefined,
      });
      for (const c of commissions) {
        dispatchEvent(tenantId, 'commission.paid', {
          commissionId: c.id,
          partnerId: c.partnerId,
          amount: c.amount,
          currency: c.currency,
          payoutId,
        });
      }
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

  return { runId, mode, payouts: results, skippedBelowThreshold: skipped };
}
