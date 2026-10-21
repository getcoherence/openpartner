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
 * Manual-rail payouts are announced (payout.created + commission.paid) by
 * the CALLER, after its transaction commits: this function returns them
 * as `pendingNotifications` and the caller passes them to
 * `dispatchPayoutNotifications`. Dispatching from in here sent the brand
 * webhook and the partner postback for a payout that a later throw in the
 * same run (e.g. a lost commission claim) then rolled back.
 *
 * Why the split (audit #10): this function runs inside the caller's tenant
 * transaction (scheduler tick / admin route). Calling Stripe from
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
 *   - revshare          → also transfers the full commission amount; nothing
 *                         is withheld. Our 3% is billed to the merchant on
 *                         attributed GMV through the Stripe usage meter
 *                         (usage-billing.ts). Payout.metadata.platformFee
 *                         records 3% of the payout as a ledger note only.
 *
 * Refund clawbacks (clawback-netting.ts): a manual or direct-Connect
 * payout is the partner's commissions less their outstanding
 * `refund_clawback` adjustments, which are stamped with the payout in the
 * same transaction. A partner who owes at least what they're due is held
 * (`heldForClawback`) instead of paid. Funding-rail groups never net.
 *
 * Compliance holds (sanctions-screening.ts): a partner whose latest
 * declared country is blocked, or whose sanctions screening has an open or
 * confirmed match (or hasn't answered yet), is not paid on the Connect or
 * funded rails. Their commissions stay approved and unclaimed, nothing is
 * written, and the group is reported in `heldForCompliance`; the run after
 * the hold lifts pays it. On the manual rail the brand sends the money
 * itself, so the payout goes ahead and carries a `complianceWarning`.
 *
 * Multi-tenant: takes (db, tenantId), where `db` is a transaction with
 * app.tenant_id pinned. Open it with `withTenantTransaction` (the
 * scheduler's forEachActiveTenant does) and dispatch the result's
 * `pendingNotifications` once that call has returned. Don't pass req.db
 * from a route: the request transaction commits only after the response
 * is sent, so the handler has no point at which the run is known to be
 * committed — POST /payouts/run plans in its own withTenantTransaction.
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
import { db as platformDb } from './db.js';
import { connectNeedsFunding, resolvePayoutMethod } from './payout-method.js';
import { partnerPayoutHolds, type PayoutHoldReason } from './sanctions-screening.js';
import { centsToStripeMinor, fromStripeMinor, majorToCents } from './stripe-amounts.js';
import type { PayoutTransferMeta } from './payout-transfers.js';
import { getTenantBillingState } from './billing-plan.js';
import { dispatchEvent } from './webhook-dispatcher.js';
import type { WebhookPayload } from './openapi/webhook-events.js';
import { dispatchCommissionEvents } from './commission-events.js';
import { fundingEnabled, tryTenantPayoutLock } from './funding/state.js';
import {
  NO_NETTING,
  nettingPayloadFields,
  outstandingClawbacks,
  stampClawbacks,
  type PayoutNettingMeta,
} from './clawback-netting.js';
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
  /** Groups not paid because the partner's outstanding refund clawbacks
   *  are at least what they're owed (`amount`, before clawbacks). Nothing
   *  is written: the commissions stay 'approved' and the clawbacks
   *  outstanding, and a later run nets them once enough has accrued. */
  heldForClawback: Array<{ partnerId: string; currency: string; amount: number; clawbackAmount: number }>;
  /** Connect and funded-rail groups not paid because the partner is on a
   *  compliance hold (blocked country, or a sanctions screening match
   *  that's open, confirmed or not yet answered). Nothing is written: the
   *  commissions stay approved and unclaimed until the hold lifts.
   *  `amount` is the gross owed. */
  heldForCompliance: Array<{ partnerId: string; currency: string; amount: number; reason: PayoutHoldReason }>;
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
    /** Refund clawbacks netted off this payout; `amount` is already net
     *  of them. Absent when nothing was netted. */
    clawbackAmount?: number;
    /** Manual rail only: the partner is on a compliance hold. The payout
     *  is still written, because the brand sends the money itself; check
     *  before sending it. */
    complianceWarning?: PayoutHoldReason;
    error?: string;
  }>;
  /** Manual-rail announcements this run owes. NOT dispatched yet — the
   *  run's writes are uncommitted when it returns. The caller fires them
   *  with `dispatchPayoutNotifications` once its transaction commits and
   *  drops them if it rolls back. Keep them out of responses and job logs
   *  (one entry per commission). */
  pendingNotifications: PendingPayoutNotification[];
}

/** A manual-rail payout's webhooks: payout.created, plus commission.paid
 *  for each commission it paid (bonus.paid for a bonus's). */
export interface PendingPayoutNotification {
  /** The payout.created payload, exactly as dispatched. */
  payout: WebhookPayload<'payout.created'>;
  commissions: Array<Pick<CommissionRow, 'id' | 'partnerId' | 'attributionId' | 'bonusId' | 'amount' | 'currency'>>;
}

/**
 * Fire the webhooks (and partner postbacks) for manual-rail payouts a
 * `runPayouts` call created. Call ONLY after the transaction that ran it
 * has committed (webhook-dispatcher.ts contract): a subscriber may
 * re-fetch the payout, and a rolled-back run must announce nothing.
 * commission.paid goes through `dispatchCommissionEvents`, so it carries
 * the commission's click/event origin like every other lifecycle path.
 */
export function dispatchPayoutNotifications(
  tenantId: string,
  pending: readonly PendingPayoutNotification[],
): void {
  for (const { payout, commissions } of pending) {
    dispatchEvent(tenantId, 'payout.created', payout);
    void dispatchCommissionEvents(tenantId, 'commission.paid', commissions, { payoutId: payout.payoutId });
  }
}

export async function runPayouts(db: Knex, tenantId: string): Promise<PayoutRunResult> {
  // Serialize every payout actor for this tenant — the weekly scheduler
  // tick, the admin run-payouts endpoint, and funding reservation — on one
  // advisory xact lock (audit: concurrent runs could double-transfer).
  // Callers always run inside a transaction (scheduler + the admin route's
  // withTenantTransaction), so the xact-scoped lock self-releases.
  if (db.isTransaction && !(await tryTenantPayoutLock(db as Knex.Transaction, tenantId))) {
    return {
      runId: 'locked',
      mode: 'flat',
      payouts: [],
      skippedBelowThreshold: [],
      skippedUnfunded: [],
      heldForClawback: [],
      heldForCompliance: [],
      pendingNotifications: [],
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
  // behavior intact for tenants who haven't touched the setting. The
  // minimum is in the tenant's default currency; without FX it says
  // nothing about a balance in any other, so those pay at any amount.
  const thresholdCents = Math.max(0, tenant?.payoutThresholdCents ?? 0);
  const thresholdCurrency = (tenant?.defaultCurrency ?? 'USD').toUpperCase();

  // `payoutId is null` is the un-claimed filter: a commission already
  // frozen onto an open transfer intent must NOT be regrouped, or the
  // retry would pay it twice under a different idempotency key (audit
  // #10). Claims are stamped by this function and released by the
  // executor when an intent is abandoned.
  //
  // tenantId is named explicitly. RLS scopes `db` to this tenant, but a
  // multi-tenant pool that bypasses RLS (no app role) would otherwise plan
  // payouts for every tenant's partners in this run. The reads below are
  // keyed on a partnerId from these groups, so they stay in the tenant.
  //
  // Grouped on the upper-cased code: commissions booked before ingest
  // normalised currencies can say "inr", and they are the same rupees as
  // "INR" — one balance, one payout.
  const groups = (await db(TABLES.Commission)
    .where({ tenantId, status: 'approved' })
    .whereNull('payoutId')
    .groupByRaw('"partnerId", upper("currency")')
    .select('partnerId', db.raw('upper("currency") as currency'))) as Array<{ partnerId: string; currency: string }>;

  const results: PayoutRunResult['payouts'] = [];
  const skipped: PayoutRunResult['skippedBelowThreshold'] = [];
  const skippedUnfunded: PayoutRunResult['skippedUnfunded'] = [];
  const heldForClawback: PayoutRunResult['heldForClawback'] = [];
  const heldForCompliance: PayoutRunResult['heldForCompliance'] = [];
  const pendingNotifications: PendingPayoutNotification[] = [];
  const fundingCandidates: Array<{ currency: string; candidate: ReservationCandidate }> = [];

  // Compliance holds for every partner in this run, read once. On the
  // privileged pool: the hold records are platform tables the tenant
  // transaction's app role can't read.
  const groupPartnerIds = [...new Set(groups.map((g) => g.partnerId))];
  const holds = await partnerPayoutHolds(
    platformDb,
    tenantId,
    groupPartnerIds.length > 0
      ? ((await db<PartnerRow>(TABLES.Partner)
          .where({ tenantId })
          .whereIn('id', groupPartnerIds)
          .select('id', 'name')) as Array<Pick<PartnerRow, 'id' | 'name'>>)
      : [],
  );

  for (const group of groups) {
    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: group.partnerId }).first();
    if (!partner) continue;

    // Read the exact rows first and derive the total from them. The group
    // total and a later SELECT can disagree under READ COMMITTED (each
    // statement takes a fresh snapshot), and the transfer amount must
    // equal the sum of the commissions we actually claim — never a stale
    // aggregate.
    const commissions = await db<CommissionRow>(TABLES.Commission)
      .where({ partnerId: group.partnerId, status: 'approved' })
      .whereRaw('upper("currency") = ?', [group.currency])
      .whereNull('payoutId');
    if (commissions.length === 0) continue;
    // Summed in hundredths, the storage precision, so the total is exact.
    const grossCents = commissions.reduce((s, c) => s + majorToCents(c.amount), 0);

    // Rail preference resolves to a concrete method per partner
    // (payout-method.ts).
    const method: PayoutMethod = resolvePayoutMethod(railPreference, partner);

    // Compliance hold: the platform moves no money to this partner. That
    // covers both Connect rails (direct intent and funded batch), and a
    // connect-blocked failure row too, which would only nag the partner to
    // finish onboarding. Checked before anything is claimed, netted or
    // reserved, so the group is untouched and the next run after the hold
    // lifts pays it. The manual rail goes ahead with a warning below.
    const hold = holds.get(partner.id);
    if (hold && method === 'stripe_connect') {
      console.warn(
        `[payouts] HELD for compliance: tenant=${tenantId} partner=${partner.id} ${group.currency} (${hold.reason}); commissions remain approved`,
      );
      heldForCompliance.push({ partnerId: partner.id, currency: group.currency, amount: grossCents / 100, reason: hold.reason });
      continue;
    }

    // Hosted Connect goes through the funding pipeline (below) or nowhere.
    const fundedRail = method === 'stripe_connect' && connectNeedsFunding(mode);

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

    // Refund clawbacks the partner owes come off this payout — on the rails
    // that pay it now: manual, and a direct-Connect intent. Never on the
    // hosted funding rail, whose batch has no row for a deduction
    // (docs/refund-clawback-netting.md §4), and not on a connect-blocked
    // failure row, which pays nothing.
    const netting =
      !fundedRail && (method === 'manual' || canTransfer)
        ? await outstandingClawbacks(db, tenantId, partner.id, group.currency)
        : NO_NETTING;
    // What would actually be paid, after clawbacks, in hundredths.
    // `amountMinor` is that total in Stripe's integer form for this
    // currency (¥1,000 is 1000, KWD 1.23 is 1230; stripe-amounts.ts) and
    // is what a transfer sends. `amount` is the same figure in major
    // units, so the Payout row records what is paid: it differs from the
    // net sum only where Stripe has no fractions (¥100.50 → ¥101).
    const amountCents = grossCents - netting.clawbackCents;
    const amountMinor = centsToStripeMinor(amountCents, group.currency);
    const amount = fromStripeMinor(amountMinor, group.currency);
    // Owing at least what's due carries over: no payout at all, so no
    // transfer is ever zero or negative (measured in the currency's own
    // smallest unit, so ¥0.40 net is ¥0 and is held too). The commissions
    // stay 'approved' and the clawbacks outstanding, and the next run nets
    // them once enough has accrued.
    if (netting.clawbackCents > 0 && amountMinor <= 0) {
      heldForClawback.push({
        partnerId: partner.id,
        currency: group.currency,
        amount: grossCents / 100,
        clawbackAmount: netting.clawbackCents / 100,
      });
      continue;
    }

    // Threshold gate: balances below the tenant minimum stay 'approved'
    // and roll over to the next run. The minimum is in the tenant's default
    // currency, and hundredths are the storage unit on the tenant column, so
    // the comparison happens in them (amountCents, not the exponent-aware
    // amountMinor) — on what would actually be paid, after clawbacks.
    if (thresholdCents > 0 && group.currency === thresholdCurrency && amountCents < thresholdCents) {
      skipped.push({ partnerId: partner.id, currency: group.currency, amount });
      continue;
    }

    const platformFee = mode === 'revshare' ? Math.round(amount * REVSHARE_FEE_BPS) / 10000 : 0;

    const payoutId = ulid();

    // HOSTED CONNECT = FUNDED FLOW OR NOTHING. On hosted tenants a Connect
    // transfer spends the PLATFORM's Stripe balance, so it only happens
    // through the funding pipeline (reserve → charge the brand → transfer
    // after settlement; docs/payout-funding.md). Eligible groups are
    // handed to reservation below; tenants without funding enabled +
    // authorized stay on the fail-closed guard (commissions 'approved',
    // no Payout row). Self-host is unaffected: the platform account IS
    // the brand's own Stripe. Escape hatch = deliberate operator override.
    if (fundedRail) {
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
        // Audit copy of what was netted. The source of truth is
        // CommissionAdjustment.appliedPayoutId, stamped below.
        ...(netting.clawbackCents > 0
          ? {
              netting: {
                grossCents,
                clawbackCents: netting.clawbackCents,
                adjustmentIds: netting.adjustmentIds,
              } satisfies PayoutNettingMeta,
            }
          : {}),
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
      // Compare-and-set, like the Connect claim below: the rows were read
      // without a lock, and a refund or an admin reversal can flip one to
      // 'reversed' in between. An unguarded UPDATE turned it back into
      // 'paid', paying refunded revenue (and, after a partial refund, its
      // replacement commission too). A short count aborts the whole run;
      // nothing has been announced yet, so the next run starts clean.
      const marked = await db(TABLES.Commission)
        .whereIn('id', commissions.map((c) => c.id))
        .where({ status: 'approved' })
        .whereNull('payoutId')
        .update({ status: 'paid', paidAt: new Date(), payoutId });
      if (marked !== commissions.length) {
        throw new Error(
          `manual payout ${payoutId}: marked ${marked}/${commissions.length} commissions paid for partner ${partner.id} — a commission was reversed or claimed concurrently; aborting`,
        );
      }
      // Planning is terminal on this rail, so the deduction is final too.
      await stampClawbacks(db, payoutId, netting.adjustmentIds);
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
      // Frozen with the commissions: the executor's preflight checks
      // amountMinor against both, and releases both if it abandons the
      // intent (payout-transfers.ts releaseClaims).
      await stampClawbacks(db, payoutId, netting.adjustmentIds);
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
        clawbackAmount: netting.clawbackCents > 0 ? netting.clawbackCents / 100 : undefined,
      });
    } else {
      // Manual path: commissions are already marked paid in the tx above
      // (the operator owns the out-of-band transfer). Queue the webhooks
      // for the caller to fire after commit — a later group can still
      // throw and roll this payout back.
      pendingNotifications.push({
        payout: {
          payoutId,
          partnerId: partner.id,
          amount: amount.toFixed(2),
          currency: group.currency,
          method,
          commissionIds: commissions.map((c) => c.id),
          platformFee: platformFee || undefined,
          ...nettingPayloadFields(
            netting.clawbackCents > 0
              ? { grossCents, clawbackCents: netting.clawbackCents, adjustmentIds: netting.adjustmentIds }
              : undefined,
          ),
        },
        commissions: commissions.map((c) => ({
          id: c.id,
          partnerId: c.partnerId,
          attributionId: c.attributionId,
          bonusId: c.bonusId,
          amount: c.amount,
          currency: c.currency,
        })),
      });
      results.push({
        payoutId,
        partnerId: partner.id,
        amount,
        currency: group.currency,
        method,
        status: 'pending',
        platformFee: platformFee || undefined,
        clawbackAmount: netting.clawbackCents > 0 ? netting.clawbackCents / 100 : undefined,
        complianceWarning: hold?.reason,
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
          skippedUnfunded.push({ partnerId: c.partnerId, currency, amount: fromStripeMinor(c.amountMinor, currency) });
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
          skippedUnfunded.push({ partnerId: c.partnerId, currency, amount: fromStripeMinor(c.amountMinor, currency) });
        }
      }
      // open_batch_exists: eligible commissions roll forward silently —
      // they'll reserve on the tick after the current batch terminalizes.
    }
  }

  return {
    runId,
    mode,
    payouts: results,
    skippedBelowThreshold: skipped,
    skippedUnfunded,
    heldForClawback,
    heldForCompliance,
    pendingNotifications,
  };
}
