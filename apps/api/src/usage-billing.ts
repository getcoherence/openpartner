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
 */

import { TABLES, type EventRow } from '@openpartner/db';
import { db } from './db.js';
import { CONFIG_KEYS, getConfig, setConfig } from './config.js';
import { getMode, requireStripe } from './stripe.js';

// Events we count toward attributed GMV. We sum Event.value for these,
// scoped to events that have a corresponding Attribution row (i.e. credit
// actually went to a partner). The signup event has no value and is
// excluded by the SUM (NULL handling).
const REVENUE_EVENT_TYPES = ['invoice_paid', 'subscription_created'];

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
 * Sum attributed GMV (in dollars) for events with `ts > since` and `ts <= until`.
 * Only counts events that have at least one Attribution row (i.e. a partner
 * was credited). Refund/dispute events are excluded by event-type filter.
 */
export async function aggregateAttributedGmv(since: Date | null, until: Date): Promise<number> {
  const q = db<EventRow>(TABLES.Event)
    .whereIn('type', REVENUE_EVENT_TYPES)
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
export async function reportUsageToStripe(): Promise<UsageReportResult> {
  const mode = getMode();
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

  const customerId = await getConfig<string>(CONFIG_KEYS.StripeMerchantCustomerId);
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

  const lastReportedAtIso = await getConfig<string>(CONFIG_KEYS.LastUsageReportedAt);
  const rangeStart = lastReportedAtIso ? new Date(lastReportedAtIso) : null;
  const rangeEnd = new Date();
  const amount = await aggregateAttributedGmv(rangeStart, rangeEnd);

  if (amount <= 0) {
    // Still advance the high-water mark — we've "reported" zero usage for
    // the period and don't want to re-scan the same window forever.
    await setConfig(CONFIG_KEYS.LastUsageReportedAt, rangeEnd.toISOString());
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

  const stripe = requireStripe();
  // identifier is Stripe's idempotency key for meter events. Tying it to the
  // window end means a re-run within the same second is deduped on Stripe's
  // side, which is what we want when an admin double-clicks the report
  // button or a cron job retries on transient failure.
  const identifier = `op-usage-${mode}-${rangeEnd.toISOString()}`;
  await stripe.billing.meterEvents.create({
    event_name: meterEventName,
    payload: {
      stripe_customer_id: customerId,
      value: amount.toFixed(2),
    },
    identifier,
    timestamp: Math.floor(rangeEnd.getTime() / 1000),
  });

  await setConfig(CONFIG_KEYS.LastUsageReportedAt, rangeEnd.toISOString());
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
