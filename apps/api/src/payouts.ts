/**
 * Payout PLANNER.
 *
 * Finds approved commissions, groups by (partner, currency), and writes a
 * Payout row per group. Manual-rail payouts are complete when this returns
 * (the operator owns the transfer). Connect-rail payouts are written as
 * durable *intents* — `metadata.transferState = 'intent'` — and the money
 * is moved later by `executePayoutTransfers` (payout-transfers.ts), which
 * runs OUTSIDE any transaction.
 *
 * Why the split (audit #10): this function runs inside the caller's tenant
 * transaction (scheduler tick / request middleware). Calling Stripe from
 * in here meant a transfer could succeed and the surrounding commit then
 * fail — the Payout row rolled back, the money gone, and the next run
 * minted a NEW payoutId, hence a NEW idempotency key, hence a DUPLICATE
 * transfer. Same for an ambiguous (timeout) Stripe error. The fix mirrors
 * `funding/executor.ts`: freeze the intent (its id, and with it its
 * idempotency key `payout_<payoutId>`) and its commission set in the DB,
 * COMMIT, and only then talk to Stripe.
 *
 * The commission set is frozen by claiming the rows — `Commission.payoutId`
 * is stamped while `status` stays 'approved'. Claimed rows are invisible to
 * the next planning run (every lookup here filters `payoutId is null`), so
 * a retry re-uses the same intent instead of regrouping a larger set under
 * a new key. Claims are released if the intent is abandoned.
 *
 * Mode semantics:
 *   - selfhost / flat   → no platform fee; transfer the full amount.
 *   - revshare          → we retain 3% as our platform fee. The transfer still
 *                         sends the full commission amount to the partner;
 *                         the 3% is reconciled against merchant billing (tracked
 *                         on Payout.metadata.platformFee for the ledger).
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
import { REVSHARE_FEE_BPS, type OpenPartnerMode } from './stripe.js';
import type { PayoutTransferMeta } from './payout-transfers.js';
import { getTenantBillingState } from './billing-plan.js';
import { dispatchEvent } from './webhook-dispatcher.js';
import { fundingEnabled, tryTenantPayoutLock } from './funding/state.js';
import {
  getFundingAuthorization,
  reserveFundingBatch,
  type ReservationCandidate,
} from './funding/reserve.js';

export interface PayoutRunResult {
  runId: string;
  mode: OpenPartnerMode;
  /** Group totals that didn't meet the tenant's payoutThresholdCents are
   *  reported here instead of in payouts. Commissions stay 'approved' so
   *  they accumulate to the next run. */
  skippedBelowThreshold: Array<{ partnerId: string; currency: string; amount: number }>;
  /** Hosted-tenant Connect payouts refused because there is no mechanism
   *  funding the commission principal — transfers would spend the
   *  PLATFORM's Stripe balance with no way to collect from the brand
   *  (audit 2026-07-10). Commissions stay 'approved'; no Payout row is
   *  written so retries don't accumulate failure rows. */
  skippedUnfunded: Array<{ partnerId: string; currency: string; amount: number }>;
  /** Connect-rail rows come back 'pending': the Payout intent is written
   *  and its commissions are frozen, but the transfer is posted later by
   *  `executePayoutTransfers`. Manual-rail rows are 'pending' too (the
   *  operator confirms out-of-band). */
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
  // Serialize every payout actor for this tenant — the weekly scheduler
  // tick, the admin run-payouts endpoint, and funding reservation — on one
  // advisory xact lock (audit: concurrent runs could double-transfer).
  // Callers always run inside a transaction (scheduler + tenantMiddleware),
  // so the xact-scoped lock self-releases.
  if (db.isTransaction && !(await tryTenantPayoutLock(db as Knex.Transaction, tenantId))) {
    return {
      runId: 'locked',
      mode: 'flat',
      payouts: [],
      skippedBelowThreshold: [],
      skippedUnfunded: [],
    };
  }

  // Per-TENANT billing mode, not the global env — on the hosted deployment
  // OPENPARTNER_MODE says 'flat' while individual tenants are on revshare,
  // which zeroed platformFee for every hosted revshare payout (audit
  // finding). Also drives the funding guard below.
  const billing = await getTenantBillingState(db, tenantId);
  const mode = billing.mode;
  const runId = ulid();

  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first();
  const railPreference: PayoutRailPreference = tenant?.payoutRailPreference ?? 'auto';
  // null / 0 / negative all collapse to "no threshold" — keeps the legacy
  // behavior intact for tenants who haven't touched the setting.
  const thresholdCents = Math.max(0, tenant?.payoutThresholdCents ?? 0);

  // `payoutId is null` is the un-claimed filter: a commission already
  // frozen onto an open transfer intent must NOT be regrouped, or the
  // retry would pay it twice under a different idempotency key (audit
  // #10). Claims are stamped by this function and released by the
  // executor when an intent is abandoned.
  const groups = (await db(TABLES.Commission)
    .where({ status: 'approved' })
    .whereNull('payoutId')
    .groupBy('partnerId', 'currency')
    .select('partnerId', 'currency')) as Array<{ partnerId: string; currency: string }>;

  const results: PayoutRunResult['payouts'] = [];
  const skipped: PayoutRunResult['skippedBelowThreshold'] = [];
  const skippedUnfunded: PayoutRunResult['skippedUnfunded'] = [];
  const fundingCandidates: Array<{ currency: string; candidate: ReservationCandidate }> = [];

  for (const group of groups) {
    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: group.partnerId }).first();
    if (!partner) continue;

    // Read the exact rows first and derive the total from them, in minor
    // units. The group total and a later SELECT can disagree under READ
    // COMMITTED (each statement takes a fresh snapshot), and the transfer
    // amount must equal the sum of the commissions we actually claim —
    // never a stale aggregate.
    const commissions = await db<CommissionRow>(TABLES.Commission)
      .where({ partnerId: group.partnerId, currency: group.currency, status: 'approved' })
      .whereNull('payoutId');
    if (commissions.length === 0) continue;
    const amountMinor = commissions.reduce((s, c) => s + Math.round(Number(c.amount) * 100), 0);
    const amount = amountMinor / 100;

    // Threshold gate: balances below the tenant minimum stay 'approved'
    // and roll over to the next run. Cents are the storage unit on the
    // tenant column, so the comparison happens in minor units.
    if (thresholdCents > 0 && amountMinor < thresholdCents) {
      skipped.push({ partnerId: partner.id, currency: group.currency, amount });
      continue;
    }

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

    // HOSTED CONNECT = FUNDED FLOW OR NOTHING. On hosted tenants a Connect
    // transfer spends the PLATFORM's Stripe balance, so it only happens
    // through the funding pipeline (reserve → charge the brand → transfer
    // after settlement; docs/payout-funding.md). Eligible groups are
    // handed to reservation below; tenants without funding enabled +
    // authorized stay on the fail-closed guard (commissions 'approved',
    // no Payout row). Self-host is unaffected: the platform account IS
    // the brand's own Stripe. Escape hatch = deliberate operator override.
    if (
      method === 'stripe_connect' &&
      mode !== 'selfhost' &&
      process.env.OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS !== '1'
    ) {
      // Connect-readiness preflight applies to funding too — a partner
      // who can't receive transfers shouldn't have money collected for
      // them (it would strand as a residual, spec §7).
      const meta = (partner.metadata as { stripe?: { payoutsEnabled?: boolean } }).stripe;
      const transferReady = !!partner.stripeConnectAccountId && meta?.payoutsEnabled === true;
      if (fundingEnabled() && transferReady) {
        fundingCandidates.push({
          currency: group.currency,
          candidate: {
            partnerId: partner.id,
            commissionIds: commissions.map((c) => c.id),
            amountMinor,
          },
        });
        continue;
      }
      console.error(
        `[payouts] REFUSED unfunded Connect payout: tenant=${tenantId} partner=${partner.id} ${group.currency} ${amount.toFixed(2)} — funding ${fundingEnabled() ? 'not available for this partner' : 'disabled'}; commissions remain approved`,
      );
      skippedUnfunded.push({ partnerId: partner.id, currency: group.currency, amount });
      continue;
    }

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
      canTransfer ? 'pending' /* flipped to 'paid' by the executor */ :
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
        // The transfer intent (audit #10). Everything the executor needs
        // to post the transfer is frozen here, so the amount and the
        // destination can't drift between planning and execution.
        ...(canTransfer
          ? ({
              transferState: 'intent',
              destinationAccountId: partner.stripeConnectAccountId!,
              amountMinor,
              mode,
              attempts: 0,
            } satisfies PayoutTransferMeta)
          : {}),
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
      // Freeze the commission set onto the intent. The rows stay
      // 'approved' (they are not paid yet) but become invisible to the
      // next planning run, so a retry re-uses THIS payoutId — and with
      // it this idempotency key — instead of minting a new one over a
      // possibly larger set. `whereNull('payoutId')` makes the claim a
      // compare-and-set; a short count means someone else claimed a row
      // and the whole run aborts (nothing has reached Stripe yet, so the
      // rollback is free).
      const claimed = await db(TABLES.Commission)
        .whereIn('id', commissions.map((c) => c.id))
        .where({ status: 'approved' })
        .whereNull('payoutId')
        .update({ payoutId });
      if (claimed !== commissions.length) {
        throw new Error(
          `payout intent ${payoutId}: claimed ${claimed}/${commissions.length} commissions for partner ${partner.id} — concurrent payout run; aborting`,
        );
      }
      // No webhook here — the money hasn't moved. payout.created and
      // commission.paid fire from the executor once the transfer lands.
      results.push({
        payoutId,
        partnerId: partner.id,
        amount,
        currency: group.currency,
        method,
        status: 'pending',
        platformFee: platformFee || undefined,
      });
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

  // Funding reservation (hosted Connect groups). Requires the tenant's
  // funding authorization; without one, groups fall back to the guard so
  // behavior is identical to funding-disabled. Reservation is DB-only —
  // the collector job charges the brand OUTSIDE any transaction, and
  // transfers happen only after the payment settles.
  if (fundingCandidates.length > 0 && db.isTransaction) {
    // Funding eligibility ≠ service eligibility (spec §4 finding 13): a
    // NEW batch needs healthy billing (mirror active/trialing, or no
    // mirror yet) and no funding already in trouble. Already-funded
    // batches always finish transferring regardless — that's the
    // executor's job, unaffected here.
    const billingHealthy =
      billing.subscriptionStatus == null ||
      ['active', 'trialing'].includes(billing.subscriptionStatus);
    const troubled = await db(TABLES.HostedFundingBatch)
      .where({ tenantId })
      .whereIn('status', ['funding_failed', 'funding_disputed', 'release_requested', 'recovery_required'])
      .first(['id', 'status']);
    const auth = billingHealthy && !troubled ? await getFundingAuthorization(db, tenantId) : null;
    if (!billingHealthy || troubled) {
      console.error(
        `[funding] tenant ${tenantId} ineligible for new batches: ${!billingHealthy ? `billing ${billing.subscriptionStatus}` : `batch ${(troubled as { id: string }).id} is ${(troubled as { status: string }).status}`}`,
      );
    }
    const byCurrency = new Map<string, ReservationCandidate[]>();
    for (const { currency, candidate } of fundingCandidates) {
      const list = byCurrency.get(currency) ?? [];
      list.push(candidate);
      byCurrency.set(currency, list);
    }
    for (const [currency, candidates] of byCurrency) {
      if (!auth) {
        for (const c of candidates) {
          skippedUnfunded.push({ partnerId: c.partnerId, currency, amount: c.amountMinor / 100 });
        }
        console.error(
          `[payouts] funding enabled but tenant ${tenantId} has no funding authorization — ${candidates.length} group(s) held`,
        );
        continue;
      }
      const reserved = await reserveFundingBatch(db as Knex.Transaction, tenantId, currency, candidates);
      if (reserved.batchId) {
        console.log(
          `[funding] reserved batch ${reserved.batchId}: tenant=${tenantId} ${currency} ${reserved.principalMinor} minor across ${reserved.reservedCommissions} commissions`,
        );
      } else if (reserved.skipped && reserved.skipped !== 'open_batch_exists') {
        for (const c of candidates) {
          skippedUnfunded.push({ partnerId: c.partnerId, currency, amount: c.amountMinor / 100 });
        }
      }
      // open_batch_exists: eligible commissions roll forward silently —
      // they'll reserve on the tick after the current batch terminalizes.
    }
  }

  return { runId, mode, payouts: results, skippedBelowThreshold: skipped, skippedUnfunded };
}
