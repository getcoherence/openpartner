/**
 * Usage-based billing reporter.
 *
 * The Hosted Flex plan bills $49/mo + 1.5% of attributed GMV. The 1.5% portion
 * is a Stripe metered price tied to a Stripe Meter ("openpartner_attributed_gmv");
 * we report usage via meterEvents.create on whatever cadence makes sense for
 * the merchant — daily cron, manual admin trigger, end-of-billing-period job.
 *
 * Hosted Revshare uses the same meter (3% of GMV instead of 1.5%) — it just
 * has a different metered price. The reporter is mode-aware and picks the
 * correct meter event_name for each tier.
 *
 * Idempotency: Stripe's Meter Event API accepts an optional `identifier` so
 * the same period reported twice is a no-op. We use the high-water mark
 * timestamp to define a closed period and stamp identifier accordingly. If
 * the report fails we DO NOT advance the high-water mark, so the next run
 * picks up from the same point.
 *
 * Multi-tenant: each tenant has its own Stripe customer + high-water mark
 * (Config rows are tenant-scoped). The scheduler iterates tenants and calls
 * this once per tenant; the billing route passes the request's tenant.
 */

import type { Knex } from 'knex';
import { TABLES, type EventRow } from '@openpartner/db';
import { CONFIG_KEYS, deleteConfig, getConfig, setConfig } from './config.js';
import { requireStripe } from './stripe.js';
import { getTenantBillingState } from './billing-plan.js';

// The explicit billable-GMV semantic: event types whose Event.value counts
// toward attributed GMV (summed over events that have an Attribution — i.e.
// credit actually went to a partner). Defaults to Stripe-native revenue
// events; extend via OPENPARTNER_BILLABLE_EVENT_TYPES_EXTRA (comma-separated)
// when a merchant reports revenue under CUSTOM type names (e.g. order_paid) —
// otherwise those conversions accrue partner commissions but escape the
// platform %. Set to the exact custom types you consider revenue; do NOT add
// non-revenue events, whose value would be billed as GMV.
const DEFAULT_REVENUE_EVENT_TYPES = ['invoice_paid', 'subscription_created'];
const REVENUE_EVENT_TYPES: string[] = (() => {
  const extra = (process.env.OPENPARTNER_BILLABLE_EVENT_TYPES_EXTRA ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_REVENUE_EVENT_TYPES, ...extra])];
})();

// Mode → meter event_name. Network access uses a separate meter for
// Network-originated payouts; that's reported by the payout runner, not here.
const MODE_TO_METER: Record<string, string> = {
  flat: 'openpartner_attributed_gmv',
  revshare: 'openpartner_attributed_gmv',
};

export interface UsageReportResult {
  mode: string;
  meterEventName: string;
  customerId: string;
  amount: number; // dollars
  rangeStart: Date | null;
  rangeEnd: Date;
  reported: boolean;
  reason?: string;
}

/**
 * Sum payout amounts (in dollars) for payouts whose Partner came from
 * the OpenPartner Network — i.e., Partner.metadata.network.creatorId
 * is set, which is stamped by network-client.ts when a partner is
 * upserted to the Network.
 *
 * This is what the Network bills the vendor on (3% metered). Only
 * 'paid' payouts count — pending / failed don't generate Network fee
 * because no money actually moved to the partner.
 *
 * Tenant scope: caller provides db + GUC.
 */
export async function aggregateNetworkOriginatedPayouts(
  db: Knex,
  since: Date | null,
  until: Date,
): Promise<number> {
  const q = db(TABLES.Payout)
    .join(TABLES.Partner, `${TABLES.Partner}.id`, `${TABLES.Payout}.partnerId`)
    .where(`${TABLES.Payout}.status`, 'paid')
    .andWhere(`${TABLES.Payout}.completedAt`, '<=', until)
    .andWhereRaw(`"${TABLES.Partner}"."metadata"->'network'->>'creatorId' is not null`);
  if (since) q.andWhere(`${TABLES.Payout}.completedAt`, '>', since);
  const rows = (await q.sum({ total: `${TABLES.Payout}.amount` })) as Array<{ total: string | null }>;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Sum attributed GMV (in dollars) for events with `ts > since` and `ts <= until`.
 * Only counts events that have at least one Attribution row (i.e. a partner
 * was credited). Refund/dispute events are excluded by event-type filter.
 *
 * Tenant scope is provided by the caller (req.db with app.tenant_id set, or
 * a transaction the scheduler opened with the GUC pinned).
 */
export async function aggregateAttributedGmv(
  db: Knex,
  since: Date | null,
  until: Date,
  eventTypes: string[] = REVENUE_EVENT_TYPES,
): Promise<number> {
  const q = db<EventRow>(TABLES.Event)
    .whereIn('type', eventTypes)
    .where('ts', '<=', until)
    .whereExists((qb) => {
      qb.select(db.raw('1')).from(TABLES.Attribution).whereRaw('"Attribution"."eventId" = "Event"."id"');
    });
  if (since) q.where('ts', '>', since);
  const rows = (await q.sum({ total: 'value' })) as Array<{ total: string | null }>;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Report aggregated GMV to Stripe via the Meter Events API. The meter
 * (openpartner_attributed_gmv) must exist in the platform's Stripe account
 * and the merchant's subscription must include the metered price tied to
 * the same meter. Both are provisioned by `scripts/setup-stripe.mjs`.
 */
export async function reportUsageToStripe(db: Knex, tenantId: string): Promise<UsageReportResult> {
  const state = await getTenantBillingState(db, tenantId);
  const mode = state.mode;
  const meterEventName = MODE_TO_METER[mode];
  if (!meterEventName) {
    return {
      mode,
      meterEventName: '',
      customerId: '',
      amount: 0,
      rangeStart: null,
      rangeEnd: new Date(),
      reported: false,
      reason: `usage reporting is not configured for mode=${mode}`,
    };
  }

  // Read Stripe customer from Tenant column (canonical) — fall back to
  // the legacy Config key for tenants that subscribed before the
  // billingPlan migration backfilled it. Both should be equivalent
  // post-migration.
  const customerId =
    state.stripeCustomerId ??
    (await getConfig<string>(db, tenantId, CONFIG_KEYS.StripeMerchantCustomerId));
  if (!customerId) {
    return {
      mode,
      meterEventName,
      customerId: '',
      amount: 0,
      rangeStart: null,
      rangeEnd: new Date(),
      reported: false,
      reason: 'no Stripe merchant customer configured (subscribe via /billing/checkout first)',
    };
  }

  const stripe = requireStripe();

  // Recovery path: a report was frozen but the run crashed before advancing
  // the high-water mark. Re-send it VERBATIM (same identifier ⇒ Stripe's
  // Meter Events API dedupes, so no double-count) rather than aggregating a
  // fresh — and overlapping — window.
  const pending = await getConfig<PendingUsageReport>(db, tenantId, CONFIG_KEYS.PendingUsageReport);
  if (pending) {
    // Staleness guard: Stripe rejects meter events with a timestamp beyond
    // its ~35-day window, so a pending row left by a multi-week outage can
    // never be resent — it would block this tenant's reporting forever. And
    // past Stripe's ≥24h dedup guarantee a resend risks double-billing. Once
    // it's this old, abandon it: advance past the window and ALERT for manual
    // reconciliation rather than double-bill or wedge the tenant. (Trades a
    // rare, loud under-report for a silent double-charge — the safe direction
    // for billing.)
    const STALE_PENDING_MS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - new Date(pending.rangeEndIso).getTime() > STALE_PENDING_MS) {
      console.error(
        `[usage] ALERT: abandoning stale pending usage report tenant=${tenantId} ` +
          `rangeEnd=${pending.rangeEndIso} amount=${pending.amount} — reconcile in Stripe manually`,
      );
      await setConfig(db, tenantId, CONFIG_KEYS.LastUsageReportedAt, pending.rangeEndIso);
      await deleteConfig(db, tenantId, CONFIG_KEYS.PendingUsageReport);
      return {
        mode,
        meterEventName: pending.meterEventName,
        customerId: pending.customerId,
        amount: pending.amount,
        rangeStart: pending.rangeStartIso ? new Date(pending.rangeStartIso) : null,
        rangeEnd: new Date(pending.rangeEndIso),
        reported: false,
        reason: 'stale_pending_abandoned',
      };
    }
    await stripe.billing.meterEvents.create({
      event_name: pending.meterEventName,
      payload: { stripe_customer_id: pending.customerId, value: pending.amount.toFixed(2) },
      identifier: pending.identifier,
      timestamp: Math.floor(new Date(pending.rangeEndIso).getTime() / 1000),
    });
    await setConfig(db, tenantId, CONFIG_KEYS.LastUsageReportedAt, pending.rangeEndIso);
    await deleteConfig(db, tenantId, CONFIG_KEYS.PendingUsageReport);
    return {
      mode,
      meterEventName: pending.meterEventName,
      customerId: pending.customerId,
      amount: pending.amount,
      rangeStart: pending.rangeStartIso ? new Date(pending.rangeStartIso) : null,
      rangeEnd: new Date(pending.rangeEndIso),
      reported: true,
      reason: 'resent frozen report (crash recovery)',
    };
  }

  const lastReportedAtIso = await getConfig<string>(db, tenantId, CONFIG_KEYS.LastUsageReportedAt);
  const rangeStart = lastReportedAtIso ? new Date(lastReportedAtIso) : null;
  const rangeEnd = new Date();
  const amount = await aggregateAttributedGmv(db, rangeStart, rangeEnd);

  if (amount <= 0) {
    // Still advance the high-water mark — we've "reported" zero usage for
    // the period and don't want to re-scan the same window forever. No
    // Stripe call, so no exactly-once concern here.
    await setConfig(db, tenantId, CONFIG_KEYS.LastUsageReportedAt, rangeEnd.toISOString());
    return {
      mode,
      meterEventName,
      customerId,
      amount,
      rangeStart,
      rangeEnd,
      reported: false,
      reason: 'no attributed GMV in range',
    };
  }

  // Freeze the report BEFORE calling Stripe. The identifier is Stripe's dedup
  // key, keyed on the period START (the high-water mark), NOT rangeEnd:
  // rangeStart is identical for two runs racing the same period (scheduler +
  // manual trigger, or two replicas), so they produce the SAME identifier and
  // Stripe dedupes the double-submit; distinct periods have distinct starts.
  // Persisting the frozen bounds+amount+identifier also lets a crash after
  // Stripe accepts (but before the mark advances) re-send this exact row above.
  const identifier = `op-usage-${mode}-${tenantId}-${rangeStart ? rangeStart.toISOString() : 'genesis'}`;
  const frozen: PendingUsageReport = {
    rangeStartIso: rangeStart ? rangeStart.toISOString() : null,
    rangeEndIso: rangeEnd.toISOString(),
    amount,
    identifier,
    meterEventName,
    customerId,
  };
  await setConfig(db, tenantId, CONFIG_KEYS.PendingUsageReport, frozen);

  await stripe.billing.meterEvents.create({
    event_name: meterEventName,
    payload: { stripe_customer_id: customerId, value: amount.toFixed(2) },
    identifier,
    timestamp: Math.floor(rangeEnd.getTime() / 1000),
  });

  await setConfig(db, tenantId, CONFIG_KEYS.LastUsageReportedAt, rangeEnd.toISOString());
  await deleteConfig(db, tenantId, CONFIG_KEYS.PendingUsageReport);
  return {
    mode,
    meterEventName,
    customerId,
    amount,
    rangeStart,
    rangeEnd,
    reported: true,
  };
}

interface PendingUsageReport {
  rangeStartIso: string | null;
  rangeEndIso: string;
  amount: number;
  identifier: string;
  meterEventName: string;
  customerId: string;
}
