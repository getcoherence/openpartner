/**
 * Stripe event catch-up: record the brand Stripe events a webhook missed.
 *
 * Stripe retries a failed delivery for three days and then gives up. An
 * outage longer than that, or an endpoint misconfigured for a weekend,
 * loses those checkouts, invoices and refunds for good, and every report
 * still looks plausible: the sales that arrived are all there. This job
 * lists each connected brand's recent events through the OpenPartner
 * Stripe App and runs the ones StripeEventLog has no row for through the
 * same pipeline a webhook would (processBrandStripeEvent).
 *
 *   - Hosted connections only: the Stripe App is what grants the read. A
 *     single-tenant self-host's /webhooks/stripe shares its account with
 *     OpenPartner billing and funding events and isn't covered yet.
 *   - The window is the last LOOKBACK_HOURS, never before the connection's
 *     eventLogSince (the log's start for it), and never the last
 *     SETTLE_MINUTES: a webhook may still be on its way.
 *   - Page by page as Stripe lists them (newest first; oldest first within
 *     a page), at most MAX_SCANNED_PER_RUN listed and MAX_RECOVERED_PER_RUN
 *     replayed per connection per run. Out of order is fine: the pipeline
 *     already takes Stripe's own out-of-order deliveries. A failure stops
 *     that connection's run (the next run retries what's left); other
 *     connections carry on.
 *   - Recorded Events carry metadata.recoveredBy = 'stripe_catchup', which
 *     Admin → Tracking health counts: any number above zero means webhook
 *     deliveries are failing.
 *
 * The pipeline is idempotent per event, as it is for Stripe's own
 * redeliveries, so racing a late webhook is safe.
 */

import type Stripe from 'stripe';
import { TABLES, type TenantStripeConnectionRow } from '@openpartner/db';
import { db } from './db.js';
import { announceRefund } from './refunds.js';
import { processBrandStripeEvent, type BrandStripeSource } from './routes/stripe-webhook.js';
import {
  STRIPE_APP_ATTRIBUTION_EVENT_TYPES,
  StripeConnectionUnavailableError,
  brandStripe,
  isHostedMode,
  tenantAcceptsStripeEvents,
} from './stripe-app.js';
import { withTenantTransaction } from './tenancy.js';

/** Inside Stripe's three days of webhook retries, with room to spare. */
export const LOOKBACK_HOURS = 72;
/** Younger events are left to the webhook still delivering them. */
export const SETTLE_MINUTES = 60;
export const MAX_SCANNED_PER_RUN = 10_000;
export const MAX_RECOVERED_PER_RUN = 1000;
/** Stripe lists events for 30 days; a log row older than that can't matter. */
export const LOG_RETENTION_DAYS = 35;

const PAGE_SIZE = 100;

export interface ConnectionCatchup {
  tenantId: string;
  connectionId: string;
  /** Events of this connection's mode listed in the window. */
  listed: number;
  recovered: number;
  /** A cap stopped the run before the window's oldest event. */
  truncated: boolean;
  error?: string;
}

export interface CatchupResult {
  connections: ConnectionCatchup[];
  pruned: number;
  skipped?: string;
}

export interface CatchupOptions {
  now?: Date;
  /** Tests: the client for a connection. Default: the Stripe App's (brandStripe). */
  clientFor?: (conn: TenantStripeConnectionRow) => Promise<Stripe>;
}

export async function runStripeEventCatchup(opts: CatchupOptions = {}): Promise<CatchupResult> {
  if (!isHostedMode()) return { connections: [], pruned: 0, skipped: 'selfhost' };
  const now = opts.now ?? new Date();
  const clientFor = opts.clientFor ?? ((conn) => brandStripe(conn));

  // Privileged pool, across tenants, like the reward sweep's list.
  const connections = (await db<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
    .whereNull('disconnectedAt')
    .whereNull('refreshFailedAt')
    .orderBy('tenantId')) as TenantStripeConnectionRow[];

  const results: ConnectionCatchup[] = [];
  for (const conn of connections) {
    if (!(await tenantAcceptsStripeEvents(conn.tenantId))) continue;
    results.push(await catchUpConnection(conn, now, clientFor));
  }

  const pruned = await db(TABLES.StripeEventLog)
    .where('receivedAt', '<', new Date(now.getTime() - LOG_RETENTION_DAYS * 86_400_000))
    .del();

  const recovered = results.reduce((n, r) => n + r.recovered, 0);
  if (recovered > 0) {
    console.warn('[stripe-catchup] recorded events the webhook missed', {
      recovered,
      tenants: results.filter((r) => r.recovered > 0).map((r) => ({ tenantId: r.tenantId, recovered: r.recovered })),
    });
  }
  return { connections: results, pruned };
}

async function catchUpConnection(
  conn: TenantStripeConnectionRow,
  now: Date,
  clientFor: (conn: TenantStripeConnectionRow) => Promise<Stripe>,
): Promise<ConnectionCatchup> {
  const out: ConnectionCatchup = { tenantId: conn.tenantId, connectionId: conn.id, listed: 0, recovered: 0, truncated: false };
  const from = Math.max(
    now.getTime() - LOOKBACK_HOURS * 3_600_000,
    new Date(conn.eventLogSince).getTime(),
    new Date(conn.connectedAt).getTime(),
  );
  const to = now.getTime() - SETTLE_MINUTES * 60_000;
  if (to <= from) return out;

  let stripe: Stripe;
  try {
    stripe = await clientFor(conn);
  } catch (err) {
    out.error = err instanceof StripeConnectionUnavailableError ? err.reason : errorMessage(err);
    return out;
  }

  const source: BrandStripeSource = {
    stripe,
    brandAccount: true,
    writeCustomerMetadata: false,
    keyRevenueByTransaction: true,
    eventMetadata: { via: 'stripe_app', stripeAccountId: conn.stripeAccountId, recoveredBy: 'stripe_catchup' },
    via: 'catchup',
  };

  try {
    let startingAfter: string | undefined;
    let scanned = 0;
    for (;;) {
      const page = await stripe.events.list({
        created: { gte: Math.floor(from / 1000), lte: Math.floor(to / 1000) },
        types: [...STRIPE_APP_ATTRIBUTION_EVENT_TYPES],
        limit: PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      scanned += page.data.length;
      // A live connection lists live events; a test-mode one, test events.
      const events = page.data.filter((e) => e.livemode === conn.livemode);
      out.listed += events.length;

      const seen = new Set(
        events.length === 0
          ? []
          : ((await db(TABLES.StripeEventLog)
              .where({ tenantId: conn.tenantId })
              .whereIn(
                'stripeEventId',
                events.map((e) => e.id),
              )
              .pluck('stripeEventId')) as string[]),
      );
      const missed = events.filter((e) => !seen.has(e.id)).sort((a, b) => a.created - b.created);
      for (const event of missed) {
        if (out.recovered >= MAX_RECOVERED_PER_RUN) {
          out.truncated = true;
          return out;
        }
        let refunds: Awaited<ReturnType<typeof processBrandStripeEvent>>['refunds'] = [];
        await withTenantTransaction(conn.tenantId, async (trx) => {
          const processed = await processBrandStripeEvent(trx, source, event, conn.tenantId);
          refunds = processed.refunds;
        });
        for (const r of refunds) {
          void announceRefund(conn.tenantId, r.announce, { kind: 'refund', refundEventId: r.refundEventId });
        }
        out.recovered += 1;
      }

      if (!page.has_more || page.data.length === 0) break;
      if (scanned >= MAX_SCANNED_PER_RUN) {
        out.truncated = true;
        break;
      }
      startingAfter = page.data[page.data.length - 1]!.id;
    }
  } catch (err) {
    // The next run retries whatever this one didn't log.
    out.error = errorMessage(err);
    console.error('[stripe-catchup] connection failed', { tenantId: conn.tenantId, connectionId: conn.id, error: out.error });
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
