/**
 * Results for one Link: the clicks on it and the conversions credited to
 * them. Behind GET /partners/:id/links/:linkId/results, which the Network
 * reads for a booking's report: each tracked booking gets a link of its
 * own, so these are that booking's results and nothing else the partner
 * drove.
 *
 *   clicks    Click rows on the link in [clickSince, clickUntil], not
 *             fraud-flagged. A coupon's synthetic click has no link, so
 *             it never counts.
 *   credit    each event attributed through one of those clicks, under the
 *             event's live model (its first-computed one, as attribution.ts
 *             reads prior conversions), at the share those clicks hold: their
 *             weights over all of that model's weights on the event, as
 *             performance-metric.ts shares credit. Events after
 *             conversionUntil don't count: renewals stay with the partner
 *             however old the click, so a report has to stop somewhere.
 *   leads     distinct signup / trial_started events
 *   sales     distinct events with a value above 0
 *   revenue   Σ value × share, per currency, before refunds
 *   refunds   netted as performance-metric.ts nets them: refunds naming the
 *             conversion add up (a value-less one refunds it all), a Stripe
 *             refund of its invoice or PaymentIntent reports the charge's
 *             cumulative share, and whichever leaves less wins.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';
import { LEGACY_NULL_CURRENCY } from './currency.js';
import { CORRECTIVE_EVENT_TYPES } from './performance-metric.js';
import { STRIPE_SHARE } from './usage-ledger.js';

/** Bumped when the answer's shape or meaning changes; the Network checks it. */
export const LINK_RESULTS_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_TYPES = new Set(['signup', 'trial_started']);
const REFUND_TYPES = ['refund', 'chargeback'];
/** Ids per IN (...) list. */
const CHUNK = 1000;
/** A referer's hostname: after the scheme and any user info, up to the
 *  port, path, query or fragment. A value without one gives null. */
const REFERER_HOST = '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]+)';

export interface LinkResultsWindow {
  clickSince: Date;
  clickUntil: Date;
  conversionUntil: Date;
}

export interface LinkResults {
  clicks: number;
  /** Referring hostnames, www. dropped, malformed values left out. */
  bySource: Array<{ host: string; clicks: number }>;
  leads: number;
  sales: number;
  /** Sales a refund left nothing of. Still counted in `sales`. */
  refundedSales: number;
  revenueByCurrency: Record<string, number>;
  refundedByCurrency: Record<string, number>;
  /** Every UTC day from clickSince to conversionUntil, or today if sooner. */
  daily: Array<{ date: string; clicks: number; leads: number; sales: number }>;
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function add(map: Record<string, number>, key: string, n: number): void {
  if (n !== 0) map[key] = (map[key] ?? 0) + n;
}

export async function linkResults(
  db: Knex,
  q: { tenantId: string; partnerId: string; linkId: string; window: LinkResultsWindow },
): Promise<LinkResults> {
  const { tenantId, partnerId, linkId, window: w } = q;
  const onLink = (c: Knex.QueryBuilder, alias: string) =>
    c
      .where(`${alias}.tenantId`, tenantId)
      .andWhere(`${alias}.linkId`, linkId)
      .andWhere(`${alias}.partnerId`, partnerId)
      .andWhere(`${alias}.ts`, '>=', w.clickSince)
      .andWhere(`${alias}.ts`, '<=', w.clickUntil)
      .whereNull(`${alias}.fraudFlag`);

  const clickDays = (await onLink(db(`${TABLES.Click} as c`), 'c')
    .groupByRaw('1')
    .select(db.raw(`to_char(("c"."ts" at time zone 'UTC')::date, 'YYYY-MM-DD') as day`), db.raw('count(*)::int as n'))) as Array<{
    day: string;
    n: number;
  }>;

  const bySource = (await db
    .from(
      onLink(db(`${TABLES.Click} as c`), 'c')
        .whereNotNull('c.referer')
        // Bound, not inlined: knex would read the pattern's ? as placeholders.
        .select(db.raw(`lower(regexp_replace(substring("c"."referer" from ?), '^www\\.', '')) as host`, [REFERER_HOST]))
        .as('h'),
    )
    .whereRaw(`"h"."host" ~ '^[a-z0-9-]+(\\.[a-z0-9-]+)*$'`)
    .groupBy('h.host')
    .orderByRaw('count(*) desc, "h"."host" asc')
    .limit(5)
    .select('h.host', db.raw('count(*)::int as clicks'))) as Array<{ host: string; clicks: number }>;

  // The link's attribution rows on conversions inside the window (so a
  // closed report's cost stops growing with later renewals), then each
  // event's live model and that model's total weight, so the link's share
  // of the credit can be read.
  const linkRows = (await onLink(
    db(`${TABLES.Attribution} as a`)
      .join(`${TABLES.Click} as c`, 'c.id', 'a.clickId')
      .join(`${TABLES.Event} as e`, 'e.id', 'a.eventId')
      .where('a.tenantId', tenantId)
      .andWhere('e.tenantId', tenantId)
      .andWhere('e.ts', '<=', w.conversionUntil)
      .whereNotIn('e.type', CORRECTIVE_EVENT_TYPES as unknown as string[]),
    'c',
  ).select('a.eventId', 'a.model', 'a.weight')) as Array<{ eventId: string; model: string; weight: string }>;
  const eventIds = [...new Set(linkRows.map((r) => r.eventId))];

  const liveModel = new Map<string, string>();
  const modelWeight = new Map<string, number>();
  for (const ids of chunks(eventIds)) {
    const live = (await db(TABLES.Attribution)
      .where({ tenantId })
      .whereIn('eventId', ids)
      .distinctOn('eventId')
      .orderBy([{ column: 'eventId' }, { column: 'computedAt' }, { column: 'id' }])
      .select('eventId', 'model')) as Array<{ eventId: string; model: string }>;
    for (const r of live) liveModel.set(r.eventId, r.model);
    const totals = (await db(TABLES.Attribution)
      .where({ tenantId })
      .whereIn('eventId', ids)
      .groupBy('eventId', 'model')
      .select('eventId', 'model', db.raw('sum(weight) as total'))) as Array<{ eventId: string; model: string; total: string }>;
    for (const r of totals) modelWeight.set(`${r.eventId}:${r.model}`, Number(r.total));
  }

  const share = new Map<string, number>();
  for (const r of linkRows) {
    const model = liveModel.get(r.eventId);
    if (r.model !== model) continue;
    share.set(r.eventId, (share.get(r.eventId) ?? 0) + Number(r.weight));
  }
  for (const [eventId, weight] of share) {
    const total = modelWeight.get(`${eventId}:${liveModel.get(eventId)}`) ?? 0;
    const s = total > 0 ? Math.min(1, weight / total) : 0;
    if (s > 0) share.set(eventId, s);
    else share.delete(eventId);
  }

  type EventLite = {
    id: string;
    type: string;
    value: string | null;
    currency: string | null;
    ts: Date;
    invoiceId: string | null;
    paymentIntentId: string | null;
  };
  const events: EventLite[] = [];
  for (const ids of chunks([...share.keys()])) {
    events.push(
      ...((await db(TABLES.Event)
        .where({ tenantId })
        .whereIn('id', ids)
        .andWhere('ts', '<=', w.conversionUntil)
        .whereNotIn('type', CORRECTIVE_EVENT_TYPES as unknown as string[])
        .select(
          'id',
          'type',
          'value',
          'currency',
          'ts',
          db.raw(`metadata->>'stripeInvoiceId' as "invoiceId"`),
          db.raw(`metadata->>'stripePaymentIntentId' as "paymentIntentId"`),
        )) as EventLite[]),
    );
  }

  const sales = events.filter((e) => Number(e.value ?? 0) > 0);
  const apiRefunds = new Map<string, { refunded: number; nullRefund: boolean }>();
  for (const ids of chunks(sales.map((e) => e.id))) {
    const rows = (await db(TABLES.Event)
      .where({ tenantId })
      .whereIn('type', REFUND_TYPES)
      .whereIn(db.raw(`metadata->>'conversionEventId'`) as unknown as string, ids)
      .groupByRaw(`metadata->>'conversionEventId'`)
      .select(
        db.raw(`metadata->>'conversionEventId' as "eventId"`),
        db.raw('sum(greatest(-coalesce(value, 0), 0)) as refunded'),
        db.raw('bool_or(value is null) as "nullRefund"'),
      )) as Array<{ eventId: string; refunded: string; nullRefund: boolean }>;
    for (const r of rows) apiRefunds.set(r.eventId, { refunded: Number(r.refunded), nullRefund: r.nullRefund });
  }
  // Stripe refunds name the invoice or PaymentIntent, which only an
  // invoice_paid conversion carries; the largest share reported wins.
  const stripeShares = async (key: 'stripeInvoiceId' | 'stripePaymentIntentId', values: string[]) => {
    const out = new Map<string, number>();
    for (const ks of chunks(values)) {
      const rows = (await db(`${TABLES.Event} as r`)
        .where('r.tenantId', tenantId)
        .andWhere('r.type', 'refund')
        .whereRaw(`r.metadata->>'conversionEventId' is null`)
        .whereIn(db.raw(`r.metadata->>'${key}'`) as unknown as string, ks)
        .groupByRaw('1')
        .select(db.raw(`r.metadata->>'${key}' as k`), db.raw(`max(${STRIPE_SHARE}) as share`))) as Array<{ k: string; share: string }>;
      for (const r of rows) out.set(r.k, Number(r.share));
    }
    return out;
  };
  const invoicePaid = sales.filter((e) => e.type === 'invoice_paid');
  const byInvoice = await stripeShares('stripeInvoiceId', invoicePaid.flatMap((e) => (e.invoiceId ? [e.invoiceId] : [])));
  const byIntent = await stripeShares('stripePaymentIntentId', invoicePaid.flatMap((e) => (e.paymentIntentId ? [e.paymentIntentId] : [])));

  const revenueByCurrency: Record<string, number> = {};
  const refundedByCurrency: Record<string, number> = {};
  let refundedSales = 0;
  for (const e of sales) {
    const s = share.get(e.id)!;
    const value = Number(e.value);
    const currency = (e.currency ?? LEGACY_NULL_CURRENCY).toUpperCase();
    const api = apiRefunds.get(e.id);
    const stripeShare =
      e.type === 'invoice_paid'
        ? Math.max(e.invoiceId ? (byInvoice.get(e.invoiceId) ?? 0) : 0, e.paymentIntentId ? (byIntent.get(e.paymentIntentId) ?? 0) : 0)
        : 0;
    const kept = api?.nullRefund ? 0 : Math.max(0, Math.min(value - (api?.refunded ?? 0), value * (1 - stripeShare)));
    if ((api || stripeShare > 0) && kept <= 0) refundedSales += 1;
    add(revenueByCurrency, currency, value * s);
    add(refundedByCurrency, currency, (value - kept) * s);
  }

  const daily = new Map<string, { date: string; clicks: number; leads: number; sales: number }>();
  const lastDay = new Date(Math.min(w.conversionUntil.getTime(), Date.now()));
  for (let t = Date.parse(utcDay(w.clickSince)); t <= lastDay.getTime(); t += DAY_MS) {
    const date = utcDay(new Date(t));
    daily.set(date, { date, clicks: 0, leads: 0, sales: 0 });
  }
  for (const r of clickDays) {
    const d = daily.get(r.day);
    if (d) d.clicks = r.n;
  }
  for (const e of events) {
    const d = daily.get(utcDay(new Date(e.ts)));
    if (!d) continue;
    if (LEAD_TYPES.has(e.type)) d.leads += 1;
    if (Number(e.value ?? 0) > 0) d.sales += 1;
  }

  const roundAll = (m: Record<string, number>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round2(v)]).filter(([, v]) => v !== 0));
  return {
    clicks: clickDays.reduce((sum, r) => sum + r.n, 0),
    bySource,
    leads: events.filter((e) => LEAD_TYPES.has(e.type)).length,
    sales: sales.length,
    refundedSales,
    revenueByCurrency: roundAll(revenueByCurrency),
    refundedByCurrency: roundAll(refundedByCurrency),
    daily: [...daily.values()],
  };
}
