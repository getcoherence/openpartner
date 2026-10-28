/**
 * In-process scheduler for periodic platform jobs.
 *
 * DO App Platform doesn't have native cron, so for hosted deployments we run
 * jobs in the api process via croner. Self-host customers get the same code
 * — set OPENPARTNER_ENABLE_SCHEDULER=1 to opt in. Off by default so dev,
 * test, and CI runs don't fire scheduled jobs unexpectedly.
 *
 * Jobs:
 *   - usage-report: every day at 03:15 UTC. Per active tenant, aggregates
 *                   attributed GMV since last report and reports to Stripe
 *                   Billing meters.
 *   - payouts:      every Monday at 09:00 UTC. Per active tenant, runs
 *                   runPayouts() to PLAN payouts (manual-rail rows +
 *                   committed Connect transfer intents), announcing each
 *                   tenant's manual-rail payouts as soon as its own
 *                   planning transaction commits, then posts the intents'
 *                   transfers once every tenant has been planned.
 *   - payout-transfers: every 15 minutes. Retries/reconciles Connect
 *                   transfer intents left open by a crash, an ambiguous
 *                   Stripe response, or a partner who wasn't ready.
 *   - paypal-payouts: every 5 minutes. Posts Pay with PayPal batches
 *                   waiting to go out (or re-sends one whose answer never
 *                   came), and reads PayPal's status for batches it is
 *                   processing (paypal-payouts.ts).
 *   - sanctions-screening: hourly. Screens partners with approved
 *                   commissions against the Consolidated Screening List
 *                   the first time they're payable, and again at most
 *                   daily (the payouts tick also runs this part first),
 *                   then any brand never screened under its current name.
 *   - tracking-alerts: daily at 06:40 UTC. Per active tenant, emails the
 *                   admins each setup check that turns failing and each
 *                   Tracking health flag the first time it appears
 *                   (tracking-alerts.ts), unless the brand turned the
 *                   email off.
 *
 * Both jobs are no-ops in selfhost mode for usage-report. Payouts run in
 * every mode (a self-host operator with no approved commissions just gets
 * an empty result).
 *
 * Multi-tenant: each tick iterates active tenants. For each tenant we open
 * an `appDb.transaction` with `app.tenant_id` pinned, so the per-tenant
 * job runs scoped to that tenant's data.
 *
 * Concurrency: croner's `protect: true` ensures a job that's still running
 * when its next tick arrives skips that tick rather than overlapping. This
 * matters most for usage-report on first run after a long downtime.
 */

import { Cron } from 'croner';
import type { Knex } from 'knex';
import { DEFAULT_TENANT_ID, TABLES, type PayoutCadence, type TenantRow } from '@openpartner/db';
import { db } from './db.js';
import { getTenancyMode, withTenantTransaction } from './tenancy.js';
import { reportUsageToStripe } from './usage-billing.js';
import { dispatchPayoutNotifications, runPayouts } from './payouts.js';
import { drainOutbox, reportNetworkPayoutsToNetwork, sendHeartbeat } from './network-client.js';
import { getMode } from './stripe.js';
import { sweepCampaignEndNotifications } from './campaign-end-notifications.js';
import { autoApproveMatureCommissions } from './commission-auto-approve.js';
import { dispatchCommissionEvents } from './commission-events.js';
import { sendBountyEmails, sweepTenantBounties } from './performance-bounties.js';
import { reverifyPortalDomains, sweepWhiteLabelEntitlement } from './portal-domains.js';
import { runScreeningSweep, screenPayablePartners } from './sanctions-screening.js';
import { sealPlaintextPayoutProfiles } from './payout-profile.js';
import { runSealWebhookSecretsJob } from './webhook-secret.js';
import { runSealPostbackUrlsJob } from './postback-url.js';
import { purgeTestClicks, TEST_CLICK } from './test-clicks.js';

interface ScheduledJob {
  name: string;
  cronExpr: string;
  description: string;
  handler: () => Promise<unknown>;
}

/**
 * Run `fn` once per active tenant inside a tenant-scoped transaction
 * (`withTenantTransaction` — appDb + `app.tenant_id`, so RLS applies).
 * Failures in one tenant don't stop the iteration — each tenant gets its own
 * try/catch and the aggregate result lists per-tenant outcomes.
 *
 * `afterCommit`, if given, runs with a tenant's result as soon as THAT
 * tenant's transaction has committed, before the next tenant starts. It
 * never runs for a tenant whose transaction threw. Use it for post-commit
 * side effects (webhooks) rather than waiting for the loop to finish: a
 * process that dies mid-loop must not lose the announcements of tenants
 * that already committed. A throw from it is logged, and the tenant still
 * reports ok (its writes are committed).
 */
async function forEachActiveTenant<T>(
  fn: (db: Knex, tenantId: string) => Promise<T>,
  afterCommit?: (tenantId: string, result: T) => void | Promise<void>,
): Promise<Array<{ tenantId: string; ok: boolean; result?: T; error?: string }>> {
  const tenants = await db<TenantRow>(TABLES.Tenant).where({ status: 'active' }).select('id');
  const out: Array<{ tenantId: string; ok: boolean; result?: T; error?: string }> = [];
  for (const t of tenants) {
    let result: T;
    try {
      result = await withTenantTransaction(t.id, (trx) => fn(trx, t.id));
    } catch (err) {
      out.push({ tenantId: t.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    out.push({ tenantId: t.id, ok: true, result });
    if (afterCommit) {
      try {
        await afterCommit(t.id, result);
      } catch (err) {
        console.error(
          `[scheduler] after-commit step failed for tenant ${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return out;
}

/**
 * The weekly payouts tick: plan each active tenant (cadence-gated) and
 * announce its manual-rail payouts as soon as its own planning
 * transaction commits, then post the committed Connect intents'
 * transfers.
 */
export async function runPayoutsJob() {
  // Screen anyone payable who hasn't been yet, so a partner who became
  // payable since the last hourly sweep isn't held as screening_pending
  // (or paid unscreened). Outside every transaction: it calls the list.
  const screening = await screenPayablePartners(db).catch((err: unknown) => ({
    error: err instanceof Error ? err.message : String(err),
  }));
  const planned = await forEachActiveTenant(
    async (trx, tenantId) => {
      // Cron ticks every Monday; per-tenant cadence decides whether the
      // tenant actually runs on this tick. Default (null) treated as
      // 'weekly' for backwards compat — every tick runs every tenant.
      const tenant = await trx<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first();
      const cadence: PayoutCadence = tenant?.payoutCadence ?? 'weekly';
      if (!shouldRunPayoutsThisTick(cadence, new Date())) {
        return { skipped: 'cadence', cadence };
      }
      return runPayouts(trx, tenantId);
    },
    // This tenant's run has committed: announce its manual-rail payouts
    // before the next tenant starts. Holding them until the loop ends
    // lost them for every committed tenant if the process died mid-tick
    // (their commissions are already paid, so nothing re-announces them).
    // A tenant whose run threw never gets here and announces nothing.
    (tenantId, result) => {
      if ('pendingNotifications' in result) dispatchPayoutNotifications(tenantId, result.pendingNotifications);
    },
  );
  // The notifications (one per commission) are stripped from the
  // returned summary, which the scheduler logs.
  const summary = planned.map((t) => {
    if (!t.result || !('pendingNotifications' in t.result)) return t;
    const { pendingNotifications: _announced, ...result } = t.result;
    return { ...t, result };
  });
  // The intents are durable too, so their transfers can be posted (audit
  // #10). Doing it here rather than waiting for the 15-minute executor
  // tick keeps the weekly run a single visible operation.
  const { executePayoutTransfers } = await import('./payout-transfers.js');
  const transfers = await executePayoutTransfers(db);
  return { screening, planned: summary, transfers };
}

const JOBS: ScheduledJob[] = [
  {
    name: 'usage-report',
    cronExpr: '15 3 * * *',
    description: 'Per tenant: aggregate attributed GMV and report to Stripe meters (daily 03:15 UTC)',
    handler: async () => {
      if (getMode() === 'selfhost') return { skipped: 'selfhost' };
      return forEachActiveTenant((trx, tenantId) => reportUsageToStripe(trx, tenantId));
    },
  },
  {
    name: 'payouts',
    cronExpr: '0 9 * * 1',
    description: 'Per tenant: plan payouts — write Connect transfer intents + manual-rail rows for approved commissions (Monday 09:00 UTC; cadence-gated per tenant)',
    handler: runPayoutsJob,
  },
  {
    name: 'payout-transfers',
    cronExpr: '*/15 * * * *',
    description:
      'Apply pending operator-recovery requests for the direct-Connect rail, then post Stripe transfers for committed payout intents: frozen idempotency key per intent, reconcile-by-transfer_group past the 24h key window, release claims on definite failure (every 15 minutes)',
    handler: async () => {
      // Recovery FIRST (decision B): an intent an operator just released
      // is executed by the same tick that released it, instead of waiting
      // for the next one.
      const { applyRecoveryRequests } = await import('./operator-recovery.js');
      const recovery = await applyRecoveryRequests(db, { rail: 'direct_connect' });
      const { executePayoutTransfers } = await import('./payout-transfers.js');
      const transfers = await executePayoutTransfers(db);
      return { recovery, transfers };
    },
  },
  {
    name: 'paypal-payouts',
    cronExpr: '*/5 * * * *',
    description:
      'Pay with PayPal: post committed batches with their frozen sender_batch_id (re-sending only within 29 days of the first POST), read back batches PayPal is processing, confirm paid items and release failed or returned ones (every 5 minutes)',
    handler: async () => {
      const { runPaypalPayoutsJob } = await import('./paypal-payouts.js');
      return runPaypalPayoutsJob(db);
    },
  },
  {
    name: 'sanctions-screening',
    cronExpr: '35 * * * *',
    description:
      'Screen partners with approved commissions against the US Consolidated Screening List the first time they are payable, then at most daily; then screen brands never screened under their current name (hourly at :35; skipped without CSL_API_KEY)',
    handler: async () => runScreeningSweep(db),
  },
  {
    name: 'network-outbox-drain',
    cronExpr: '*/5 * * * *',
    description: 'Per tenant: retry failed Network pushes from NetworkOutbox (every 5 minutes)',
    handler: async () => forEachActiveTenant((trx, tenantId) => drainOutbox(trx, tenantId)),
  },
  {
    name: 'network-payouts-report',
    cronExpr: '30 3 * * *',
    description: 'Per tenant: aggregate Network-originated payout volume + report to the Network for Stripe metering (daily 03:30 UTC)',
    handler: async () =>
      forEachActiveTenant((trx, tenantId) => reportNetworkPayoutsToNetwork(trx, tenantId)),
  },
  {
    name: 'network-heartbeat',
    cronExpr: '7 * * * *',
    // Hourly (offset 7 min so it doesn't pile on top of other top-of-the-hour
    // jobs). The Network uses partnerCount + lastHeartbeatAt to populate the
    // vendor's "active partners" stat and to detect abandoned instances —
    // shorter interval keeps that view fresh for brand admins.
    description: 'Per tenant: ping the Network with current partner count (hourly @ :07)',
    handler: async () => forEachActiveTenant((trx, tenantId) => sendHeartbeat(trx, tenantId)),
  },
  {
    name: 'network-review-reconcile',
    cronExpr: '*/15 * * * *',
    // Backstop for the best-effort approve/reject pushes, and the backfill
    // that hides already-pending brands after the Network review-gate
    // migration (which defaults existing vendors to 'approved').
    description:
      'Hosted multi-tenant: mirror each brand approvalStatus onto its Network vendor reviewStatus so unapproved brands never list on the marketplace (every 15 minutes)',
    handler: async () => {
      const { reconcileNetworkReview } = await import('./network-review-reconcile.js');
      return reconcileNetworkReview();
    },
  },
  {
    name: 'network-creator-review-alert',
    cronExpr: '5,20,35,50 * * * *',
    description:
      'Hosted multi-tenant: email the ops inbox when Network creators finish their profile and wait for review (every 15 minutes)',
    handler: async () => {
      const { alertOpsToCreatorsAwaitingReview } = await import('./network-creator-review-alert.js');
      return alertOpsToCreatorsAwaitingReview();
    },
  },
  {
    name: 'network-country-access-sync',
    cronExpr: '45 3 * * *',
    description:
      'Hosted multi-tenant: re-push the ops console country list to the Network, which checks creators against its own copy (daily 03:45 UTC)',
    handler: runCountryAccessSyncJob,
  },
  {
    name: 'tenant-hard-delete',
    cronExpr: '0 4 * * *',
    description:
      'Hard-delete tenants whose 30-day deletion grace window has lapsed, then platform passwords no admin or operator holds any more (daily 04:00 UTC)',
    handler: async () => hardDeleteExpiredTenants(),
  },
  {
    name: 'campaign-end-notifications',
    cronExpr: '0 9 * * *',
    description: 'Email brand admins + participating partners ~7 days before a campaign ends (daily 09:00 UTC)',
    handler: async () => sweepCampaignEndNotifications(),
  },
  {
    name: 'brand-setup-reminders',
    cronExpr: '0 15 * * *',
    description:
      'Hosted multi-tenant, when switched on in the ops console: email brand admins whose setup is incomplete (max 3, spaced 2/4/7 days; daily 15:00 UTC)',
    handler: async () => {
      if (getTenancyMode() !== 'multi') return { skipped: 'single_tenant' };
      const { getNotificationSettings } = await import('./platform-settings.js');
      if (!(await getNotificationSettings(db)).brandSetupReminders) return { skipped: 'disabled' };
      const { runBrandSetupReminders } = await import('./brand-setup-reminders.js');
      const r = await runBrandSetupReminders(db);
      return { sent: r.sent, failed: r.failed, eligible: r.eligible.length };
    },
  },
  {
    name: 'creator-profile-reminders',
    cronExpr: '30 15 * * *',
    description:
      'Hosted multi-tenant, when switched on in the ops console: trigger the Network to email creators with incomplete profiles (daily 15:30 UTC)',
    handler: async () => {
      if (getTenancyMode() !== 'multi') return { skipped: 'single_tenant' };
      const { getNotificationSettings } = await import('./platform-settings.js');
      if (!(await getNotificationSettings(db)).creatorProfileReminders) return { skipped: 'disabled' };
      const { adminRunCreatorReminders, platformNetworkUrl } = await import('./network-client.js');
      const networkUrl = platformNetworkUrl();
      if (!networkUrl || !process.env.NETWORK_ADMIN_API_KEY) return { skipped: 'network_admin_not_configured' };
      const r = await adminRunCreatorReminders(networkUrl, { dryRun: false });
      return { sent: r.sent, failed: r.failed, eligible: r.eligible.length };
    },
  },
  {
    name: 'funding-collector',
    cronExpr: '*/5 * * * *',
    description:
      'Apply pending operator-recovery requests for the hosted funding rail, then advance hosted funding batches: create/retry funding PaymentIntents, poll as webhook-loss backstop, release timed-out batches (every 5 minutes; the collector is a no-op unless HOSTED_FUNDING_ENABLED=1)',
    handler: async () => {
      // Recovery first (decision B), and NOT behind the funding flag: a
      // force-release of a stuck batch is exactly what an operator does
      // after HOSTED_FUNDING_ENABLED was pulled mid-incident, and
      // forceReleaseBatch carries its own verification either way.
      const { applyRecoveryRequests } = await import('./operator-recovery.js');
      const recovery = await applyRecoveryRequests(db, { rail: 'hosted_funding' });
      const { runFundingCollector } = await import('./funding/collect.js');
      const collected = await runFundingCollector(db);
      return { recovery, collected };
    },
  },
  {
    name: 'funding-executor',
    cronExpr: '*/5 * * * *',
    description:
      'Execute partner transfers for funded batches: intent rows with frozen idempotency keys, source_transaction-linked transfers, Payout + commission.paid on confirm, reconcile-by-listing for ambiguous posts (every 5 minutes)',
    handler: async () => {
      const { runTransferExecutor } = await import('./funding/executor.js');
      return runTransferExecutor(db);
    },
  },
  {
    name: 'funding-reconcile',
    cronExpr: '30 5 * * *',
    description:
      'Daily funding ledger audit: allocation/principal invariants, stuck batches past the transfer deadline, reconcile_required and duplicate_review transfer intents, residuals awaiting disposition, Stripe fee telemetry backfill (daily 05:30 UTC; verifies + alerts, never moves money)',
    handler: async () => {
      const { runFundingReconciliation } = await import('./funding/reconcile.js');
      return runFundingReconciliation(db);
    },
  },
  {
    name: 'billing-subscription-reconcile',
    cronExpr: '25 4 * * *',
    description:
      'Poll Stripe for every tenant plan subscription and heal state a missed webhook left behind: clear ended subscriptions (revoking white-label + custom-domain routing), refresh the status mirror, and alert ops on newly scheduled cancellations (daily 04:25 UTC)',
    handler: async () => {
      if (getMode() === 'selfhost') return { skipped: 'selfhost' };
      const { reconcileTenantSubscriptions } = await import('./billing-lifecycle.js');
      return reconcileTenantSubscriptions(db);
    },
  },
  {
    name: 'portal-domain-reverify',
    cronExpr: '45 4 * * *',
    description:
      'Re-check the _openpartner ownership TXT for every verified white-label domain; demote + revoke on missing proof (daily 04:45 UTC)',
    handler: async () => {
      // Selfhost has no hosted white-label edge to police — the operator
      // owns their own domain and branding.
      if (getMode() === 'selfhost') return { skipped: 'selfhost' };
      return reverifyPortalDomains(db);
    },
  },
  {
    name: 'white-label-entitlement-sweep',
    cronExpr: '55 4 * * *',
    description:
      'Revoke custom-domain routing for tenants whose effective white-label entitlement lapsed — incl. trials that expired without subscribing (daily 04:55 UTC)',
    handler: async () => {
      if (getMode() === 'selfhost') return { skipped: 'selfhost' };
      return sweepWhiteLabelEntitlement(db);
    },
  },
  {
    name: 'commission-auto-approve',
    cronExpr: '15 5 * * *',
    description:
      "Per tenant: auto-approve accrued commissions whose holdback has elapsed (re-checking a performance bounty's goal first), then fire commission.approved / bonus.approved (daily 05:15 UTC)",
    handler: runCommissionAutoApproveJob,
  },
  {
    name: 'performance-bounties',
    cronExpr: '20 * * * *',
    description:
      'Per tenant: measure partners against active performance bounties, pay the bonus to each who reached one, end bounties past their 7-day grace, and email partners (hourly at :20)',
    handler: runPerformanceBountiesJob,
  },
  {
    name: 'stripe-app-reward-backfill',
    cronExpr: '50 * * * *',
    description:
      'Hosted: give partner codes with a customer discount their promotion code in the brand’s connected Stripe where it is still missing — a connect-time pass that failed, a mint whose Stripe call failed, a program that gained a reward later (customer-rewards.ts; hourly at :50)',
    handler: async () => {
      if (getMode() === 'selfhost') return { skipped: 'selfhost' };
      const { runRewardBackfillSweep } = await import('./customer-rewards.js');
      return runRewardBackfillSweep();
    },
  },
  {
    name: 'stripe-event-catchup',
    cronExpr: '25 */6 * * *',
    description:
      'Hosted: list each connected brand’s Stripe events from the last 72 hours and record the ones no webhook delivered (stripe-event-catchup.ts; every 6 hours at :25)',
    handler: async () => {
      if (getMode() === 'selfhost') return { skipped: 'selfhost' };
      const { runStripeEventCatchup } = await import('./stripe-event-catchup.js');
      return runStripeEventCatchup();
    },
  },
  {
    name: 'tracking-alerts',
    cronExpr: '40 6 * * *',
    description:
      'Per tenant: run the setup checks (setup-checks.ts), compare each browser and partner with its own recent past (tracking-flags.ts), and email the admins each check that turns failing and each flag the first time it appears, unless the brand turned it off (daily 06:40 UTC)',
    handler: runTrackingAlertsJob,
  },
  {
    name: 'test-click-purge',
    cronExpr: '50 6 * * *',
    description: `Delete admins' test clicks (test-clicks.ts) ${TEST_CLICK.retentionDays} days after they were made (daily 06:50 UTC)`,
    handler: async () => ({ deleted: await purgeTestClicks(db) }),
  },
  {
    name: 'seal-payout-details',
    cronExpr: '35 * * * *',
    description:
      'Seal any partner payout details a SQL-dump restore left in the clear (payout-profile.ts; also runs at startup) (hourly at :35)',
    handler: async () => ({ sealed: await sealPlaintextPayoutProfiles(db) }),
  },
  {
    name: 'seal-webhook-secrets',
    cronExpr: '40 * * * *',
    description:
      'Seal any webhook signing secret a SQL-dump restore left in the clear (webhook-secret.ts; also runs 10 minutes after startup, and skips until then) (hourly at :40)',
    handler: () => runSealWebhookSecretsJob(db),
  },
  {
    name: 'seal-postback-urls',
    cronExpr: '45 * * * *',
    description:
      'Seal any partner postback URL a SQL-dump restore (or a write during deploy grace) left in the clear (postback-url.ts; also runs 10 minutes after startup, and skips until then) (hourly at :45)',
    handler: () => runSealPostbackUrlsJob(db),
  },
];

/**
 * Re-send the ops console's country list to the Network (country-access-
 * sync.ts). Every console save pushes it already; this heals a push that
 * failed, and covers a Network that was updated or restored since.
 */
export async function runCountryAccessSyncJob() {
  if (getTenancyMode() !== 'multi') return { skipped: 'single_tenant' };
  const { pushCountryAccessToNetwork } = await import('./country-access-sync.js');
  return pushCountryAccessToNetwork(db);
}

/**
 * The holdback sweep, then commission.approved (webhook + partner
 * postback) for every row it approved. Each tenant's rows are announced
 * as soon as that tenant's transaction commits, so a subscriber that
 * re-fetches sees the commission approved, a rolled-back tenant announces
 * nothing, and a process that dies mid-loop has already announced every
 * tenant it committed. Returns counts only; the approved rows would flood
 * the job log.
 */
export async function runCommissionAutoApproveJob() {
  const swept = await forEachActiveTenant(
    (trx, tenantId) => autoApproveMatureCommissions(trx, tenantId),
    (tenantId, result) => {
      void dispatchCommissionEvents(tenantId, 'commission.approved', result.approved);
      void dispatchCommissionEvents(tenantId, 'commission.reversed', result.requalified, { reason: 'bounty_requalification' });
    },
  );
  return swept.map(({ result, ...t }) =>
    result ? { ...t, approvedCount: result.approvedCount, requalifiedCount: result.requalified.length } : t,
  );
}

/**
 * The performance-bounty sweep (performance-bounties.ts). Each tenant's
 * bonus.* webhooks go out on its commit (awardBonus), and its partner
 * emails right after, so a rolled-back tenant announces nothing. Returns
 * counts only.
 */
export async function runPerformanceBountiesJob() {
  const swept = await forEachActiveTenant(
    (trx, tenantId) => sweepTenantBounties(trx, tenantId),
    async (tenantId, result) => {
      await sendBountyEmails(tenantId, result.emails);
    },
  );
  return swept.map(({ result, ...t }) =>
    result ? { ...t, evaluated: result.evaluated, awarded: result.awarded, ended: result.ended } : t,
  );
}

/**
 * The daily Tracking health alert sweep (tracking-alerts.ts), one tenant
 * transaction each. Returns counts only.
 */
export async function runTrackingAlertsJob() {
  const { sweepTenantTrackingAlerts } = await import('./tracking-alerts.js');
  return forEachActiveTenant((trx, tenantId) => sweepTenantTrackingAlerts(trx, tenantId));
}

/**
 * Tables with a tenantId column that the tenant purge deliberately keeps:
 * compliance records retained for 10 years (OFAC, 31 CFR 501.601; see
 * docs/country-access.md "Records"). They're append-only with no foreign
 * keys, so they never block the purge either. Plain strings because
 * SanctionsScreening's TABLES entry arrives with its own migration.
 */
export const TENANT_PURGE_KEEP: readonly string[] = ['LocationDeclaration', 'SanctionsScreening'];

/**
 * Every table with a tenantId column, except TENANT_PURGE_KEEP, in the
 * order the tenant purge deletes from them. Each table comes before every
 * table it references without ON DELETE CASCADE. The Tenant row is
 * dropped last.
 *
 * Tables whose Tenant FK cascades are listed too. The cascade fires only
 * when the Tenant row goes, which is too late for a row that also points
 * at a non-cascading parent deleted earlier (the funding and clawback
 * tables below). Coupon has no Tenant FK at all.
 *
 * A new tenant-scoped table must be added here or to TENANT_PURGE_KEEP:
 * the tenant-purge test reads the catalog and fails until it is.
 */
export const TENANT_PURGE_ORDER = [
  TABLES.NetworkOutbox,
  TABLES.WebhookDelivery,
  // After WebhookDelivery (WebhookDelivery.endpointId).
  TABLES.WebhookEndpoint,
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.PartnerSigninLinkLog,
  // The brand's partner passwords and any signup password still waiting on
  // an activation link. Platform passwords belong to an email, not a brand:
  // they sit under DEFAULT_TENANT_ID, like platform magic-link tokens, and
  // deleteOrphanedPlatformPasswords removes them once nobody holds them.
  TABLES.PasswordCredential,
  TABLES.ApiKey,
  TABLES.ConversionPostbackToken,
  TABLES.Config,
  TABLES.BrandNotification,
  TABLES.TrackingIssue,
  TABLES.TrackingAlert,
  // Before Program (TestClick.programId).
  TABLES.TestClick,
  TABLES.OperatorRecoveryRequest,
  TABLES.UsageLedger,
  TABLES.UsageFeeShadow,
  TABLES.HostedFeeTerms,
  TABLES.HostedBillingProfile,
  TABLES.HostedBillingState,
  TABLES.StripeEventLog,
  TABLES.TenantStripeConnection,
  // Before PaypalConnection (PaypalPayoutBatch.connectionId).
  TABLES.PaypalPayoutBatch,
  TABLES.PaypalConnection,
  TABLES.PortalCustomDomain,
  // Before Payout (PayoutReversal.payoutId).
  TABLES.PayoutReversal,
  // Before Commission (CommissionAdjustment.commissionId).
  TABLES.CommissionAdjustment,
  // Before Commission and Partner (commissionId, partnerId), and before
  // its batch.
  TABLES.HostedFundingAllocation,
  // Before Partner (partnerId), and before its batch.
  TABLES.HostedFundingTransfer,
  TABLES.HostedFundingBatch,
  // Before Admin (HostedFundingAuthorization.adminId).
  TABLES.HostedFundingAuthorization,
  TABLES.Payout,
  TABLES.Commission,
  // After its Commission (Commission.bonusId), before Partner and
  // Program, which it references without a cascade.
  TABLES.Bonus,
  // After Bonus (Bonus.bountyId), before Program.
  TABLES.Bounty,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  // Cascades with its Click; named so the purge never depends on that.
  TABLES.ClickLanding,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.PartnerPostback,
  TABLES.PartnerNetworkConsent,
  // Where each partner wants manual payouts sent: bank and PayPal details,
  // sealed (payout-profile.ts). Cascades with Partner too; named so the
  // purge never depends on that.
  TABLES.PartnerPayoutProfile,
  TABLES.Program,
  TABLES.Partner,
  TABLES.Admin,
  TABLES.BrandAsset,
] as const;

/**
 * Delete platform passwords nobody holds any more. A 'platform'
 * PasswordCredential belongs to an email (principalId, lower-cased), not a
 * brand, so the per-tenant purge never reaches it. It goes once the email
 * has no live Admin row in any tenant and isn't an operator.
 *
 * Live: an Admin or PlatformAdmin row that isn't revoked or was revoked
 * after `cutoff` (30 days ago), activated or not, or an address in
 * PLATFORM_ADMIN_EMAILS. Removing an admin only revokes the row, so it
 * counts as gone 30 days after the revocation. Until then the brand can
 * reinstate them with the password intact; afterwards a reinstated admin signs
 * in by link or resets it. A revoked admin can't sign in to that brand with
 * the password anyway (tenantSigninCandidates skips them).
 *
 * So a password goes 30 days after the email's last membership ends: its
 * last brand is hard-deleted (the tenant purge runs 30 days after the brand
 * asked) or its last revocation turns 30 days old. The only other deletes
 * of Admin rows are never-activated admins replaced by signup's
 * abandoned-slug recovery or dropped by a failed /install. Those never
 * held an account, so a password one of them set goes on the next run.
 */
async function deleteOrphanedPlatformPasswords(cutoff: Date): Promise<number> {
  const { envAdminEmails } = await import('./routes/platform-admin.js');
  const pc = TABLES.PasswordCredential;
  const holds = (table: string) => (q: Knex.QueryBuilder) =>
    q
      .select(db.raw('1'))
      .from(table)
      .whereRaw('lower(??) = ??', [`${table}.email`, `${pc}.principalId`])
      .where((w) => w.whereNull(`${table}.revokedAt`).orWhere(`${table}.revokedAt`, '>', cutoff));
  return db(pc)
    .where({ tenantId: DEFAULT_TENANT_ID, principalKind: 'platform' })
    .whereNotExists(holds(TABLES.Admin))
    .whereNotExists(holds(TABLES.PlatformAdmin))
    .whereNotIn('principalId', [...envAdminEmails()])
    .del();
}

/** Cascade-delete tenants whose pendingDeletionAt is older than the
 *  grace window, then any platform password that leaves without an owner
 *  (deleteOrphanedPlatformPasswords). Runs in the privileged db (we need
 *  to bypass RLS to drop child rows in any tenant's slice).
 *
 *  A tenant whose purge fails rolls back and is retried on the next run.
 *  Each run that has failures sends ops one email listing them, so a
 *  stuck erasure keeps showing up in the inbox until someone fixes it.
 *  A failed password sweep is logged and retried on the next run; it
 *  never holds up the tenant purge. */
export async function hardDeleteExpiredTenants(): Promise<{
  purged: number;
  tenantIds: string[];
  failed: Array<{ tenantId: string; error: string }>;
  /** Orphaned platform passwords deleted; null if the sweep failed. */
  orphanedPasswordsDeleted: number | null;
}> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const expired = await db<TenantRow>(TABLES.Tenant)
    .where('pendingDeletionAt', '<', cutoff)
    .select('id', 'slug', 'displayName', 'pendingDeletionAt');
  const tenantIds: string[] = [];
  const failures: Array<{ tenantId: string; slug: string; displayName: string; pendingDeletionAt: Date; error: string }> = [];
  for (const t of expired) {
    try {
      await db.transaction(async (trx) => {
        for (const tbl of TENANT_PURGE_ORDER) {
          await trx(tbl).where({ tenantId: t.id }).del();
        }
        await trx<TenantRow>(TABLES.Tenant).where({ id: t.id }).del();
      });
      tenantIds.push(t.id);
    } catch (err) {
      console.error('[scheduler] hard-delete failed', { tenantId: t.id, err });
      failures.push({
        tenantId: t.id,
        slug: t.slug,
        displayName: t.displayName,
        pendingDeletionAt: t.pendingDeletionAt!,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let orphanedPasswordsDeleted: number | null = null;
  try {
    orphanedPasswordsDeleted = await deleteOrphanedPlatformPasswords(cutoff);
  } catch (err) {
    console.error('[scheduler] orphaned platform password sweep failed', { err });
  }
  if (failures.length > 0) {
    const { sendOpsEmail } = await import('./platform-ops-mail.js');
    const { opsTenantPurgeFailedEmail } = await import('./email-templates.js');
    await sendOpsEmail(db, opsTenantPurgeFailedEmail(failures), 'ops_tenant_purge_failed');
  }
  return {
    purged: tenantIds.length,
    tenantIds,
    failed: failures.map(({ tenantId, error }) => ({ tenantId, error })),
    orphanedPasswordsDeleted,
  };
}

let started = false;
const handles: Cron[] = [];

export function startScheduler(): void {
  if (started) return;
  if (process.env.OPENPARTNER_ENABLE_SCHEDULER !== '1') {
    console.log('[scheduler] disabled (set OPENPARTNER_ENABLE_SCHEDULER=1 to enable)');
    return;
  }

  for (const job of JOBS) {
    const handle = new Cron(
      job.cronExpr,
      { name: job.name, timezone: 'UTC', protect: true },
      async () => {
        const start = Date.now();
        // pg advisory lock keyed off the job name — guarantees only one
        // process across the whole cluster runs the body, even if the
        // app scales to multiple instances. Two-int form to match the
        // 64-bit signature; use a stable hash of the name so the same
        // job always lands on the same key.
        const [classId, objId] = lockKeyForJob(job.name);
        const trx = await db.transaction();
        let acquired = false;
        try {
          const r = (await trx.raw('select pg_try_advisory_xact_lock(?, ?) as locked', [classId, objId])) as {
            rows: Array<{ locked: boolean }>;
          };
          acquired = !!r.rows[0]?.locked;
          if (!acquired) {
            console.log(`[scheduler] ${job.name} skipped — another instance holds the lock`);
            await trx.rollback();
            return;
          }
          console.log(`[scheduler] ${job.name} starting`);
          const result = await job.handler();
          await trx.commit();
          console.log(`[scheduler] ${job.name} finished in ${Date.now() - start}ms`, result);
        } catch (err) {
          await trx.rollback().catch(() => {});
          console.error(`[scheduler] ${job.name} failed`, err);
        }
      },
    );
    handles.push(handle);
    console.log(`[scheduler] registered ${job.name} (${job.cronExpr}) — ${job.description}`);
  }
  started = true;
}

/**
 * Cadence gate for the payouts cron. The cron fires every Monday 09:00 UTC;
 * this decides whether a given tenant runs on this tick.
 *
 *   weekly    every tick (current behavior)
 *   biweekly  every other tick — even ISO weeks only. Deterministic without
 *             needing a "last run" column; aligned with the calendar so two
 *             biweekly tenants always pay on the same Mondays.
 *   monthly   first Monday of the month — i.e., this Monday's date is in
 *             [1, 7]
 *   manual    never automatic; brand triggers payouts from the admin UI
 */
export function shouldRunPayoutsThisTick(cadence: PayoutCadence, at: Date): boolean {
  switch (cadence) {
    case 'weekly':
      return true;
    case 'biweekly':
      return isoWeekNumber(at) % 2 === 0;
    case 'monthly':
      return at.getUTCDate() <= 7;
    case 'manual':
      return false;
  }
}

/** ISO 8601 week number — Thursday-of-the-week / Monday-start. */
function isoWeekNumber(d: Date): number {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Shift so Sunday=7, Monday=1 (ISO).
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
}

/** Stable two-int advisory-lock key for a job name. The xact-scoped
 *  variant releases on commit/rollback, so we don't need explicit
 *  unlock. Class id is fixed so all our scheduler locks share a
 *  namespace. */
function lockKeyForJob(name: string): [number, number] {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  // 0x534F503F = 'SCHED' magic-ish — any constant works as long as it
  // doesn't collide with another locker on the same DB.
  return [0x534f503f, h];
}

export function stopScheduler(): void {
  for (const h of handles) h.stop();
  handles.length = 0;
  started = false;
}
