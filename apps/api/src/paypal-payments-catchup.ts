/**
 * PayPal payment catch-up: record the payments a webhook missed, for every
 * app tracking payments (docs/paypal-payments.md). The PayPal counterpart
 * of the Stripe catch-up (stripe-event-catchup.ts), on the same principle:
 * a delivery PayPal gave up on (it retries for three days) would otherwise
 * lose that conversion for good, and every report would still look right.
 *
 * Two sources per app, both read with the brand's own credentials:
 *
 *   1. The webhook events PayPal generated for the app
 *      (GET /v1/notifications/webhooks-events), when OpenPartner has a
 *      webhook on it: the last EVENTS_LOOKBACK_HOURS, minus the last
 *      EVENTS_SETTLE_MINUTES a delivery may still be on its way for.
 *   2. Transaction Search (GET /v1/reporting/transactions), which PayPal
 *      enables per app: the last SEARCH_LOOKBACK_HOURS, in windows of at
 *      most 31 days. It runs three hours behind but needs no webhook, so
 *      it is the only source for a deployment PayPal can't post to, and
 *      it names the subscription of every renewal. An app it refuses
 *      (403) is marked `unavailable` and asked again a day later. Not
 *      searched until tracking is SEARCH_LAG_HOURS old: PayPal refuses a
 *      window that starts after its newest data.
 *
 * Both turn into the same facts the webhook settles (paypal-payments.ts),
 * so a payment found twice, or found while its webhook arrives, is settled
 * once: the PaymentEventLog row is the arbiter. Never before the app's
 * paymentsSince, so turning tracking on doesn't backfill. Oldest first, so
 * a subscription is stored before its renewals. Bounded per app per run;
 * what a run leaves is still in the window next hour.
 *
 * Recorded Events carry metadata.recoveredBy = 'paypal_catchup', which
 * Tracking health counts.
 *
 * Each run also checks the app's webhook against the events OpenPartner
 * reads and fixes it in place (syncPaypalWebhook), so an app set up before
 * an event was added gets it without the brand doing anything.
 */

import { TABLES, type PaypalConnectionRow } from '@openpartner/db';
import { db } from './db.js';
import {
  PAYPAL_PAYMENT_EVENTS,
  PaypalApiError,
  listWebhookEvents,
  searchTransactions,
} from './paypal-api.js';
import { openWebhookId, paypalAccessToken, syncPaypalWebhook, type PaypalWebhookSync } from './paypal-connection.js';
import { factFromTransaction, factFromWebhookEvent, factKey, processPaypalFact, type PaypalFact } from './paypal-payments.js';
import { announceRefund } from './refunds.js';
import { tenantAcceptsStripeEvents } from './stripe-app.js';
import { withTenantTransaction } from './tenancy.js';

/** Inside PayPal's three days of webhook retries. */
export const EVENTS_LOOKBACK_HOURS = 72;
/** Younger events are left to the webhook still delivering them. */
export const EVENTS_SETTLE_MINUTES = 30;
/** Transaction Search lags up to three hours; four days covers a long
 *  outage with room to spare. */
export const SEARCH_LOOKBACK_HOURS = 96;
/** How far behind Transaction Search runs: it refuses a window that starts
 *  later than its newest data. */
export const SEARCH_LAG_HOURS = 3;
/** An app without Transaction Search is asked again after this long. */
export const SEARCH_RECHECK_HOURS = 24;
export const MAX_FACTS_PER_RUN = 1000;
export const MAX_PAGES_PER_RUN = 40;
/** One day past Tracking health's longest window. */
export const LOG_RETENTION_DAYS = 95;

const SEARCH_WINDOW_MS = 31 * 86_400_000;
const PAYMENT_EVENTS: ReadonlySet<string> = new Set(PAYPAL_PAYMENT_EVENTS);
/** Same-moment facts in dependency order: a subscription before its
 *  payments, a payment before its refund or dispute, those before the
 *  dispute's resolution. */
const KIND_ORDER: Record<PaypalFact['kind'], number> = { subscription: 0, capture: 1, sale: 1, refund: 2, dispute: 2, dispute_resolved: 3 };

export interface PaypalCatchupConnection {
  tenantId: string;
  connectionId: string;
  /** Facts the sources listed (each once). */
  listed: number;
  /** Facts this run settled that nothing had before. */
  recovered: number;
  truncated: boolean;
  transactionSearch: 'ok' | 'unavailable' | 'skipped';
  /** The app's webhook against the events it should receive. */
  webhook: PaypalWebhookSync | 'failed' | 'skipped';
  error?: string;
}

export interface PaypalCatchupResult {
  connections: PaypalCatchupConnection[];
  pruned: number;
}

export interface PaypalCatchupOptions {
  now?: Date;
  /** Tests: smaller caps. */
  maxFacts?: number;
  maxPages?: number;
}

export async function runPaypalPaymentsCatchup(opts: PaypalCatchupOptions = {}): Promise<PaypalCatchupResult> {
  const now = opts.now ?? new Date();
  // Privileged pool, across tenants, as the Stripe catch-up lists.
  const connections = (await db<PaypalConnectionRow>(TABLES.PaypalConnection)
    .whereNull('disconnectedAt')
    .whereNotNull('paymentsSince')
    .orderBy('tenantId')) as PaypalConnectionRow[];

  const results: PaypalCatchupConnection[] = [];
  for (const conn of connections) {
    if (!(await tenantAcceptsStripeEvents(conn.tenantId))) continue;
    results.push(await catchUpConnection(conn, now, { facts: opts.maxFacts ?? MAX_FACTS_PER_RUN, pages: opts.maxPages ?? MAX_PAGES_PER_RUN }));
  }

  const pruned = await db(TABLES.PaymentEventLog)
    .where({ provider: 'paypal' })
    .where('receivedAt', '<', new Date(now.getTime() - LOG_RETENTION_DAYS * 86_400_000))
    .del();

  const recovered = results.reduce((n, r) => n + r.recovered, 0);
  if (recovered > 0) {
    console.warn('[paypal-catchup] settled payments no webhook delivered', {
      recovered,
      tenants: results.filter((r) => r.recovered > 0).map((r) => ({ tenantId: r.tenantId, recovered: r.recovered })),
    });
  }
  return { connections: results, pruned };
}

async function catchUpConnection(
  conn: PaypalConnectionRow,
  now: Date,
  caps: { facts: number; pages: number },
): Promise<PaypalCatchupConnection> {
  const out: PaypalCatchupConnection = {
    tenantId: conn.tenantId,
    connectionId: conn.id,
    listed: 0,
    recovered: 0,
    truncated: false,
    transactionSearch: 'skipped',
    webhook: 'skipped',
  };
  let token: string;
  try {
    token = await paypalAccessToken(db, conn);
  } catch (err) {
    out.error = errorMessage(err);
    return out;
  }
  try {
    out.webhook = await syncPaypalWebhook(db, conn, token);
  } catch (err) {
    // Payments are still read below; the next run checks again.
    out.webhook = 'failed';
    console.warn('[paypal-catchup] webhook check failed', { tenantId: conn.tenantId, connectionId: conn.id, error: errorMessage(err) });
  }
  const since = new Date(conn.paymentsSince!).getTime();
  const found = new Map<string, { fact: PaypalFact; type: string }>();
  const pages = { used: 0, max: caps.pages };

  try {
    if (openWebhookId(conn)) {
      const start = new Date(Math.max(now.getTime() - EVENTS_LOOKBACK_HOURS * 3_600_000, since));
      const end = new Date(now.getTime() - EVENTS_SETTLE_MINUTES * 60_000);
      let page = end > start ? await listWebhookEvents(conn.environment, token, { start, end }) : null;
      while (page) {
        pages.used += 1;
        for (const event of page.events) {
          if (typeof event.event_type !== 'string' || !PAYMENT_EVENTS.has(event.event_type)) continue;
          const fact = factFromWebhookEvent(event);
          if (fact && fact.at.getTime() >= since) found.set(factKey(fact), { fact, type: event.event_type });
        }
        if (!page.next) break;
        if (pages.used >= pages.max) {
          out.truncated = true;
          break;
        }
        page = await listWebhookEvents(conn.environment, token, { next: page.next });
      }
    }

    const checkedAt = conn.transactionSearchCheckedAt ? new Date(conn.transactionSearchCheckedAt).getTime() : 0;
    // Tracking that began inside PayPal's lag has nothing to search yet, and
    // PayPal refuses the window ("Data for the given start date is not
    // available"); a later run searches from when it began.
    const searchable = since <= now.getTime() - SEARCH_LAG_HOURS * 3_600_000;
    if (searchable && (conn.transactionSearch !== 'unavailable' || now.getTime() - checkedAt >= SEARCH_RECHECK_HOURS * 3_600_000)) {
      const searched = await searchFacts(conn, token, now, since, found, pages);
      out.transactionSearch = searched.status;
      if (searched.truncated) out.truncated = true;
      await db(TABLES.PaypalConnection)
        .where({ id: conn.id, tenantId: conn.tenantId })
        .whereNull('disconnectedAt')
        .update({ transactionSearch: out.transactionSearch, transactionSearchCheckedAt: now });
    }
  } catch (err) {
    // What was listed before the failure is still settled below; the next
    // run lists the rest.
    out.error = errorMessage(err);
    out.truncated = true;
  }

  out.listed = found.size;
  const ordered = [...found.entries()].sort(
    ([, a], [, b]) => a.fact.at.getTime() - b.fact.at.getTime() || KIND_ORDER[a.fact.kind] - KIND_ORDER[b.fact.kind],
  );
  const logged = new Set<string>();
  for (let i = 0; i < ordered.length; i += 500) {
    const keys = ordered.slice(i, i + 500).map(([k]) => k);
    for (const k of (await db(TABLES.PaymentEventLog)
      .where({ tenantId: conn.tenantId, provider: 'paypal' })
      .whereIn('eventKey', keys)
      .pluck('eventKey')) as string[]) {
      logged.add(k);
    }
  }

  const source = { conn, via: 'catchup' as const, token: async () => token };
  try {
    for (const [key, { fact, type }] of ordered) {
      if (logged.has(key)) continue;
      if (out.recovered >= caps.facts) {
        out.truncated = true;
        break;
      }
      const result = await withTenantTransaction(conn.tenantId, (trx) => processPaypalFact(trx, { ...source, type }, fact));
      for (const r of result.refunds) void announceRefund(conn.tenantId, r.announce, { kind: 'refund', refundEventId: r.refundEventId });
      if (result.outcome !== 'duplicate' && result.outcome !== 'unresolved') out.recovered += 1;
    }
  } catch (err) {
    out.error = errorMessage(err);
    console.error('[paypal-catchup] connection failed', { tenantId: conn.tenantId, connectionId: conn.id, error: out.error });
  }
  return out;
}

/** Transaction Search's facts for the window, into `found` (a webhook
 *  event for the same fact wins: it carries the full custom_id). */
async function searchFacts(
  conn: PaypalConnectionRow,
  token: string,
  now: Date,
  since: number,
  found: Map<string, { fact: PaypalFact; type: string }>,
  pages: { used: number; max: number },
): Promise<{ status: 'ok' | 'unavailable'; truncated: boolean }> {
  const from = Math.max(now.getTime() - SEARCH_LOOKBACK_HOURS * 3_600_000, since);
  for (let start = from; start < now.getTime(); start += SEARCH_WINDOW_MS) {
    const window = { start: new Date(start), end: new Date(Math.min(start + SEARCH_WINDOW_MS, now.getTime())) };
    for (let page = 1; ; page += 1) {
      if (pages.used >= pages.max) return { status: 'ok', truncated: true };
      let result: Awaited<ReturnType<typeof searchTransactions>>;
      try {
        result = await searchTransactions(conn.environment, token, window, page);
      } catch (err) {
        if (err instanceof PaypalApiError && err.kind === 'http' && err.status === 403) return { status: 'unavailable', truncated: false };
        throw err;
      }
      pages.used += 1;
      for (const t of result.transactions) {
        const fact = factFromTransaction(t);
        if (!fact || fact.at.getTime() < since) continue;
        const key = factKey(fact);
        if (!found.has(key)) found.set(key, { fact, type: t.transaction_event_code ?? 'transaction' });
      }
      if (page >= result.totalPages) break;
    }
  }
  return { status: 'ok', truncated: false };
}

function errorMessage(err: unknown): string {
  return err instanceof PaypalApiError ? err.summary : err instanceof Error ? err.message : String(err);
}
