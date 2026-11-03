/**
 * PayPal payments as conversions (docs/paypal-payments.md): what the brand's
 * own PayPal app reports, by webhook or through the hourly catch-up
 * (paypal-payments-catchup.ts), recorded the way Stripe payments are.
 *
 * The click rides the payment. The brand's checkout puts the visitor's
 * click reference (`openpartner.getReferral()`) in the order's
 * `purchase_units[].custom_id`, or a subscription's `custom_id`. PayPal
 * returns it on the capture, and for subscriptions keeps it on the
 * subscription, which is stored here (PaypalSubscription) and joined to
 * each renewal on its id. `invoice_id` is never read: PayPal holds it unique
 * per merchant, so a click there couldn't buy twice.
 *
 * Every webhook event and Transaction Search row is first turned into one
 * provider-neutral fact (a capture, a sale, a refund, a subscription, a
 * dispute), keyed on PayPal's own id for it. The fact is then settled once:
 *
 *   capture, sale  the click's user (clickUserId, as a conversion call
 *                  without a userId) is stitched to the click, and an
 *                  `invoice_paid` Event is recorded and attributed, keyed
 *                  on PayPal's transaction id. Every payment of one click's
 *                  subscription lands on the same user, so attribution's
 *                  renewal rule (Program.renewalsStayWithPartner) keeps
 *                  them with the partner who won the customer, as for a
 *                  Stripe customer.
 *   refund         POST /attribution/refunds' own path (recordRefund)
 *                  against the payment's Event: each refund its own
 *                  amount, so partial refunds add up and the commissions
 *                  are reduced, reversed or clawed back by the share
 *                  refunded so far.
 *   subscription   CREATED stores the custom_id; ACTIVATED (the buyer
 *                  approved it) records `subscription_created`.
 *   dispute        `dispute_created` under the payment's user, reversing
 *                  nothing: disputes can be won. A lost one is reported as
 *                  a chargeback (POST /attribution/refunds), as for Stripe.
 *
 * Settling a fact writes a PaymentEventLog row with what became of it, in
 * the same transaction, so the webhook, its redeliveries and the catch-up
 * never settle it twice and Tracking health can count payments that came
 * without a click. The Event's key (tenantId, externalEventId) is the
 * second guard, and keeps a conversion the brand also forwarded under the
 * PayPal transaction id from counting twice.
 *
 * A sandbox app is a rehearsal, as for Pay with PayPal: its payments record
 * no Event. One that carries an admin's test click links the test
 * (test-clicks.ts), which is how a brand proves its checkout passes the
 * click without paying anything real.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES, type ClickRow, type EventRow, type PaypalConnectionRow, type PaypalSubscriptionRow } from '@openpartner/db';
import { attributeEvent } from './attribution.js';
import { clickUserId } from './conversion-ingest.js';
import { ingestCurrency } from './currency.js';
import {
  getSubscription,
  listSubscriptionTransactionIds,
  type PaypalTransactionInfo,
  type PaypalWebhookEvent,
} from './paypal-api.js';
import { recordRefund, type RecordRefundInput, type RefundAnnouncements } from './refunds.js';
import { recordTestLink } from './test-clicks.js';
import { looksLikeClickId, noteTrackingIssue } from './tracking-issues.js';

export interface PaypalAmount {
  /** PayPal's decimal string ("10.50"; whole units for JPY, HUF, TWD). */
  value: string;
  currency: string;
}

export type PaypalFact =
  | { kind: 'capture'; id: string; amount: PaypalAmount; customId: string | null; orderId: string | null; at: Date }
  | { kind: 'sale'; id: string; amount: PaypalAmount; subscriptionId: string | null; custom: string | null; at: Date }
  | { kind: 'refund'; id: string; amount: PaypalAmount; paymentId: string | null; at: Date }
  | {
      kind: 'subscription';
      id: string;
      customId: string | null;
      planId: string | null;
      status: string | null;
      createdAt: Date | null;
      activated: boolean;
      at: Date;
    }
  | { kind: 'dispute'; id: string; amount: PaypalAmount | null; transactionIds: string[]; reason: string | null; status: string | null; at: Date };

/** What became of a fact, as PaymentEventLog keeps it. */
export type PaypalOutcome =
  | 'recorded'
  /** A subscription stored with the click it named; nothing to record yet. */
  | 'linked'
  | 'no_reference'
  | 'unknown_click'
  | 'foreign_reference'
  | 'test_click'
  /** A sandbox app's: never recorded. */
  | 'sandbox'
  /** A refund or dispute of a payment OpenPartner didn't record. */
  | 'not_tracked'
  | 'ignored';

export interface PaypalFactResult {
  /** `duplicate`: settled before. `unresolved`: a renewal whose
   *  subscription couldn't be found yet; not logged, so a later pass
   *  (Transaction Search names the subscription) settles it. */
  outcome: PaypalOutcome | 'duplicate' | 'unresolved';
  eventIds: string[];
  /** What a refund did to commissions: announced after commit. */
  refunds: Array<{ refundEventId: string; announce: RefundAnnouncements }>;
}

export interface PaypalSource {
  conn: Pick<PaypalConnectionRow, 'id' | 'tenantId' | 'environment'>;
  via: 'webhook' | 'catchup';
  /** PayPal's event type, or the transaction's event code. */
  type: string;
  /** A bearer token for the app, for the reads a renewal may need. */
  token: () => Promise<string>;
}

/** Subscriptions a renewal without its subscription id is looked for in. */
const ORPHAN_SALE_CANDIDATES = 20;
const ENDED_SUBSCRIPTION = ['CANCELLED', 'EXPIRED'];

// ---------------------------------------------------------------------------
// Facts from PayPal's payloads
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function date(...vs: unknown[]): Date {
  for (const v of vs) {
    if (typeof v !== 'string') continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

const DECIMAL = /^-?\d{1,12}(\.\d{1,3})?$/;

function amountOf(value: unknown, currency: unknown): PaypalAmount | null {
  const v = typeof value === 'number' ? String(value) : str(value);
  const c = str(currency);
  if (!v || !DECIMAL.test(v) || !c || !/^[A-Za-z]{3}$/.test(c)) return null;
  return { value: v.replace(/^-/, ''), currency: c.toUpperCase() };
}

/** The capture a v2 refund belongs to: its `up` link names it. */
function capturedBy(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  for (const l of links) {
    const { rel, href } = (l ?? {}) as { rel?: unknown; href?: unknown };
    if (rel !== 'up' || typeof href !== 'string') continue;
    const m = /\/v2\/payments\/captures\/([A-Za-z0-9]{1,64})(?:[/?#]|$)/.exec(href);
    if (m) return m[1]!;
  }
  return null;
}

/** The fact a webhook event (or an events-list entry) reports, or null for
 *  one this doesn't record (a pending capture, a refund not yet done). */
export function factFromWebhookEvent(event: PaypalWebhookEvent): PaypalFact | null {
  const r = (event.resource ?? {}) as Record<string, unknown>;
  const at = date(r.create_time, event.create_time);
  switch (event.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const id = str(r.id);
      const amount = r.amount as { value?: unknown; currency_code?: unknown } | undefined;
      const a = amountOf(amount?.value, amount?.currency_code);
      if (!id || !a || r.status !== 'COMPLETED') return null;
      const related = (r.supplementary_data as { related_ids?: { order_id?: unknown } } | undefined)?.related_ids;
      return { kind: 'capture', id, amount: a, customId: str(r.custom_id), orderId: str(related?.order_id), at };
    }
    case 'PAYMENT.SALE.COMPLETED': {
      const id = str(r.id);
      const amount = r.amount as { total?: unknown; currency?: unknown } | undefined;
      const a = amountOf(amount?.total, amount?.currency);
      if (!id || !a || String(r.state ?? '').toLowerCase() !== 'completed') return null;
      const agreement = str(r.billing_agreement_id);
      return { kind: 'sale', id, amount: a, subscriptionId: agreement, custom: str(r.custom), at };
    }
    case 'PAYMENT.CAPTURE.REFUNDED': {
      const id = str(r.id);
      const amount = r.amount as { value?: unknown; currency_code?: unknown } | undefined;
      const a = amountOf(amount?.value, amount?.currency_code);
      if (!id || !a || (r.status != null && r.status !== 'COMPLETED')) return null;
      return { kind: 'refund', id, amount: a, paymentId: capturedBy(r.links), at };
    }
    case 'PAYMENT.SALE.REFUNDED': {
      const id = str(r.id);
      const amount = r.amount as { total?: unknown; currency?: unknown } | undefined;
      const a = amountOf(amount?.total, amount?.currency);
      if (!id || !a || (r.state != null && String(r.state).toLowerCase() !== 'completed')) return null;
      return { kind: 'refund', id, amount: a, paymentId: str(r.sale_id), at };
    }
    case 'BILLING.SUBSCRIPTION.CREATED':
    case 'BILLING.SUBSCRIPTION.ACTIVATED': {
      const id = str(r.id);
      if (!id) return null;
      return {
        kind: 'subscription',
        id,
        customId: str(r.custom_id),
        planId: str(r.plan_id),
        status: str(r.status),
        createdAt: typeof r.create_time === 'string' ? date(r.create_time) : null,
        activated: event.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED',
        at: date(event.create_time, r.update_time, r.create_time),
      };
    }
    case 'CUSTOMER.DISPUTE.CREATED': {
      const id = str(r.dispute_id);
      if (!id) return null;
      const disputed = Array.isArray(r.disputed_transactions) ? (r.disputed_transactions as Array<Record<string, unknown>>) : [];
      const amount = r.dispute_amount as { value?: unknown; currency_code?: unknown } | undefined;
      return {
        kind: 'dispute',
        id,
        amount: amountOf(amount?.value, amount?.currency_code),
        transactionIds: disputed.flatMap((t) => (str(t.seller_transaction_id) ? [String(t.seller_transaction_id)] : [])),
        reason: str(r.reason),
        status: str(r.status),
        at,
      };
    }
    default:
      return null;
  }
}

/**
 * The fact a Transaction Search row reports. Only finished ones (status S):
 *   T1107        a refund; paypal_reference_id is the refunded payment.
 *   T00xx, > 0   a payment received. One whose reference is a
 *                subscription (SUB), or a subscription payment (T0002),
 *                is a sale; any other is a capture.
 * Everything else (payouts sent, holds, fees, transfers) is skipped.
 */
export function factFromTransaction(t: PaypalTransactionInfo): PaypalFact | null {
  const id = str(t.transaction_id);
  const code = str(t.transaction_event_code);
  const a = amountOf(t.transaction_amount?.value, t.transaction_amount?.currency_code);
  if (!id || !code || !a || t.transaction_status !== 'S') return null;
  const negative = String(t.transaction_amount?.value ?? '').startsWith('-');
  const ref = str(t.paypal_reference_id);
  const at = date(t.transaction_initiation_date);
  if (code === 'T1107') return negative && ref ? { kind: 'refund', id, amount: a, paymentId: ref, at } : null;
  if (!/^T00\d\d$/.test(code) || negative || Number(a.value) <= 0) return null;
  if (t.paypal_reference_id_type === 'SUB' || code === 'T0002') {
    return { kind: 'sale', id, amount: a, subscriptionId: t.paypal_reference_id_type === 'SUB' ? ref : null, custom: str(t.custom_field), at };
  }
  return { kind: 'capture', id, amount: a, customId: str(t.custom_field), orderId: t.paypal_reference_id_type === 'ODR' ? ref : null, at };
}

/** PaymentEventLog's key for a fact: its kind and PayPal's id for it. */
export function factKey(fact: PaypalFact): string {
  if (fact.kind === 'subscription') return `${fact.activated ? 'subscription_activated' : 'subscription'}:${fact.id}`;
  return `${fact.kind}:${fact.id}`;
}

// ---------------------------------------------------------------------------
// The click reference
// ---------------------------------------------------------------------------

/** A ULID-shaped token anywhere in the value, standing on its own. */
const CLICK_TOKEN = /(?:^|[^0-9A-Za-z])([0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26})(?![0-9A-Za-z])/g;

/**
 * The click ids a custom_id may carry. Usually the whole value is one
 * (`custom_id: openpartner.getReferral()`). A brand that already uses
 * custom_id for its own reference adds the click id after a space or `|`
 * ("order-1042|01J…"); every click-shaped token is tried, in order.
 */
export function clickReferences(customId: string | null): string[] {
  if (!customId) return [];
  return [...new Set([...customId.matchAll(CLICK_TOKEN)].map((m) => m[1]!.toUpperCase()))].filter(looksLikeClickId);
}

type Reference =
  | { kind: 'click'; click: ClickRow }
  | { kind: 'test_click' }
  | { kind: 'unknown_click'; ref: string }
  | { kind: 'foreign_reference'; ref: string }
  | { kind: 'no_reference' };

/**
 * The click a custom_id names in this tenant. A test click is linked here
 * (the first time), and an unknown one counted for Tracking health when
 * `note` is set: once per payment, never again for a subscription's
 * renewals, and never for a sandbox app, which has no real clicks.
 */
async function resolveReference(trx: Knex, tenantId: string, customId: string | null, note: boolean): Promise<Reference> {
  if (!customId) return { kind: 'no_reference' };
  const tokens = clickReferences(customId);
  for (const id of tokens) {
    const click = (await trx<ClickRow>(TABLES.Click).where({ id, tenantId }).first()) as ClickRow | undefined;
    if (click) return { kind: 'click', click };
  }
  for (const id of tokens) {
    if (await recordTestLink(trx, tenantId, id, 'paypal')) return { kind: 'test_click' };
  }
  const reference: Reference = tokens.length > 0 ? { kind: 'unknown_click', ref: tokens[0]! } : { kind: 'foreign_reference', ref: customId };
  if (note) await noteTrackingIssue(trx, tenantId, reference.kind === 'unknown_click' ? 'paypal_unknown_click' : 'paypal_foreign_reference', reference.ref);
  return reference;
}

// ---------------------------------------------------------------------------
// Settling a fact
// ---------------------------------------------------------------------------

/**
 * Settle one fact in the caller's tenant transaction: skipped when the log
 * already has it, else recorded and logged. Facts for the same PayPal id
 * are serialised on an advisory lock, so a webhook and the catch-up racing
 * on one payment settle it once.
 */
export async function processPaypalFact(trx: Knex.Transaction, source: PaypalSource, fact: PaypalFact): Promise<PaypalFactResult> {
  const tenantId = source.conn.tenantId;
  const key = factKey(fact);
  await trx.raw(`select pg_advisory_xact_lock(hashtext(?::text))`, [`paypal-fact:${tenantId}:${key}`]);
  const logged = await trx(TABLES.PaymentEventLog).where({ tenantId, provider: 'paypal', eventKey: key }).first('outcome');
  if (logged) return { outcome: 'duplicate', eventIds: [], refunds: [] };

  const result = await settle(trx, source, fact);
  if (result.outcome !== 'unresolved' && result.outcome !== 'duplicate') {
    await trx(TABLES.PaymentEventLog)
      .insert({ tenantId, provider: 'paypal', eventKey: key, connectionId: source.conn.id, type: source.type.slice(0, 100), via: source.via, outcome: result.outcome })
      .onConflict(['tenantId', 'provider', 'eventKey'])
      .ignore();
  }
  return result;
}

const done = (outcome: PaypalOutcome, eventIds: string[] = []): PaypalFactResult => ({ outcome, eventIds, refunds: [] });

async function settle(trx: Knex.Transaction, source: PaypalSource, fact: PaypalFact): Promise<PaypalFactResult> {
  switch (fact.kind) {
    case 'capture':
      return settlePayment(trx, source, fact, fact.customId, { paypalCaptureId: fact.id, ...(fact.orderId ? { paypalOrderId: fact.orderId } : {}) }, true);
    case 'sale':
      return settleSale(trx, source, fact);
    case 'refund':
      return settleRefund(trx, source, fact);
    case 'subscription':
      return settleSubscription(trx, source, fact);
    case 'dispute':
      return settleDispute(trx, source, fact);
  }
}

function eventMetadata(source: PaypalSource, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    // `via`, as the Stripe App's Events carry it: metadata.source is how a
    // conversion was attributed ('coupon').
    via: 'paypal',
    paypalEventType: source.type,
    ...extra,
    ...(source.via === 'catchup' ? { recoveredBy: 'paypal_catchup' } : {}),
  };
}

const sandbox = (source: PaypalSource) => source.conn.environment === 'sandbox';

/** A payment (a capture or a sale) recorded as the click's conversion. */
async function settlePayment(
  trx: Knex.Transaction,
  source: PaypalSource,
  fact: Extract<PaypalFact, { kind: 'capture' | 'sale' }>,
  customId: string | null,
  ids: Record<string, string>,
  note: boolean,
): Promise<PaypalFactResult> {
  const tenantId = source.conn.tenantId;
  const ref = await resolveReference(trx, tenantId, customId, note && !sandbox(source));
  if (sandbox(source)) return done(ref.kind === 'test_click' ? 'test_click' : 'sandbox');
  if (ref.kind !== 'click') return done(ref.kind);
  const value = Number(fact.amount.value);
  if (!(value > 0)) return done('ignored');

  const userId = clickUserId(ref.click.id);
  await trx(TABLES.Identity).insert({ id: ulid(), tenantId, clickId: ref.click.id, userId }).onConflict(['clickId', 'userId']).ignore();
  const [event] = (await trx<EventRow>(TABLES.Event)
    .insert({
      id: ulid(),
      tenantId,
      userId,
      type: 'invoice_paid',
      value: value.toFixed(2),
      currency: await ingestCurrency(trx, tenantId, fact.amount.currency),
      externalEventId: fact.id,
      metadata: eventMetadata(source, { ...ids, ...(customId ? { paypalCustomId: customId.slice(0, 255) } : {}) }),
      ts: fact.at,
    })
    .onConflict(['tenantId', 'externalEventId'])
    .ignore()
    .returning('*')) as EventRow[];
  if (!event) {
    const existing = (await trx<EventRow>(TABLES.Event).where({ tenantId, externalEventId: fact.id }).first()) as EventRow | undefined;
    if (existing && existing.metadata?.via !== 'paypal') {
      // The brand forwarded this payment itself (POST /attribution/
      // conversions keyed on the PayPal transaction id): one record of it.
      console.warn('[paypal-payments] payment already recorded by a forwarded conversion; not recorded again', {
        tenantId,
        paypalId: fact.id,
        heldBy: existing.id,
      });
    }
    return done('recorded', existing ? [existing.id] : []);
  }
  await attributeEvent(trx, event);
  return done('recorded', [event.id]);
}

/** A subscription payment: joined to its subscription's custom_id. */
async function settleSale(trx: Knex.Transaction, source: PaypalSource, fact: Extract<PaypalFact, { kind: 'sale' }>): Promise<PaypalFactResult> {
  let subscriptionId = fact.subscriptionId;
  if (!subscriptionId && !fact.custom) {
    subscriptionId = await findSaleSubscription(trx, source, fact);
    // Transaction Search names the subscription; its catch-up settles it.
    if (!subscriptionId) return { outcome: 'unresolved', eventIds: [], refunds: [] };
  }
  const sub = subscriptionId ? await subscriptionFor(trx, source, subscriptionId) : null;
  const customId = sub ? sub.customId : fact.custom;
  return settlePayment(
    trx,
    source,
    fact,
    customId,
    { paypalSaleId: fact.id, ...(subscriptionId ? { paypalSubscriptionId: subscriptionId } : {}) },
    // A subscription's reference was counted when it was first seen.
    !sub,
  );
}

/**
 * The stored subscription, or PayPal's read of it (stored for the next
 * renewal) when its CREATED event hasn't been seen: it came late, or before
 * payment tracking was on. Null when PayPal has no such subscription.
 */
async function subscriptionFor(trx: Knex.Transaction, source: PaypalSource, subscriptionId: string): Promise<PaypalSubscriptionRow | null> {
  const tenantId = source.conn.tenantId;
  const stored = (await trx<PaypalSubscriptionRow>(TABLES.PaypalSubscription).where({ tenantId, subscriptionId }).first()) as
    | PaypalSubscriptionRow
    | undefined;
  if (stored) return stored;
  const sub = await getSubscription(source.conn.environment, await source.token(), subscriptionId);
  if (!sub) return null;
  const ref = await resolveReference(trx, tenantId, str(sub.custom_id), !sandbox(source));
  return storeSubscription(trx, source, {
    id: sub.id,
    customId: str(sub.custom_id),
    clickId: ref.kind === 'click' ? ref.click.id : null,
    planId: str(sub.plan_id),
    status: str(sub.status),
    createdAt: sub.create_time ? date(sub.create_time) : null,
  });
}

async function storeSubscription(
  trx: Knex.Transaction,
  source: PaypalSource,
  s: { id: string; customId: string | null; clickId: string | null; planId: string | null; status: string | null; createdAt: Date | null },
): Promise<PaypalSubscriptionRow> {
  const tenantId = source.conn.tenantId;
  const now = new Date();
  await trx(TABLES.PaypalSubscription)
    .insert({
      tenantId,
      subscriptionId: s.id,
      connectionId: source.conn.id,
      environment: source.conn.environment,
      customId: s.customId?.slice(0, 255) ?? null,
      clickId: s.clickId,
      planId: s.planId?.slice(0, 64) ?? null,
      status: s.status?.slice(0, 24) ?? null,
      createdAt: s.createdAt,
      firstSeenAt: now,
      updatedAt: now,
    })
    .onConflict(['tenantId', 'subscriptionId'])
    .ignore();
  return (await trx<PaypalSubscriptionRow>(TABLES.PaypalSubscription).where({ tenantId, subscriptionId: s.id }).first()) as PaypalSubscriptionRow;
}

/**
 * A renewal whose webhook left out billing_agreement_id (reported for some
 * sale webhooks): look for it in the transactions of this app's recent
 * subscriptions that named a click, the only ones it could credit. Bounded;
 * null when none has it.
 */
async function findSaleSubscription(trx: Knex.Transaction, source: PaypalSource, fact: Extract<PaypalFact, { kind: 'sale' }>): Promise<string | null> {
  const candidates = (await trx<PaypalSubscriptionRow>(TABLES.PaypalSubscription)
    .where({ tenantId: source.conn.tenantId, connectionId: source.conn.id })
    .whereNotNull('clickId')
    .where((q) => q.whereNull('status').orWhereNotIn('status', ENDED_SUBSCRIPTION))
    .orderBy('createdAt', 'desc')
    .limit(ORPHAN_SALE_CANDIDATES)
    .select('subscriptionId')) as Array<{ subscriptionId: string }>;
  if (candidates.length === 0) return null;
  const token = await source.token();
  const window = { start: new Date(fact.at.getTime() - 2 * 86_400_000), end: new Date(fact.at.getTime() + 86_400_000) };
  for (const c of candidates) {
    const ids = await listSubscriptionTransactionIds(source.conn.environment, token, c.subscriptionId, window);
    if (ids.includes(fact.id)) return c.subscriptionId;
  }
  return null;
}

async function settleSubscription(
  trx: Knex.Transaction,
  source: PaypalSource,
  fact: Extract<PaypalFact, { kind: 'subscription' }>,
): Promise<PaypalFactResult> {
  const tenantId = source.conn.tenantId;
  const stored = (await trx<PaypalSubscriptionRow>(TABLES.PaypalSubscription).where({ tenantId, subscriptionId: fact.id }).first()) as
    | PaypalSubscriptionRow
    | undefined;
  // The custom_id it was first seen with stays: a renewal's partner can't
  // change under it.
  const customId = stored ? stored.customId : fact.customId;
  const ref = await resolveReference(trx, tenantId, customId, !stored && !sandbox(source));
  if (stored) {
    await trx(TABLES.PaypalSubscription)
      .where({ tenantId, subscriptionId: fact.id })
      .update({ status: fact.status?.slice(0, 24) ?? stored.status, planId: stored.planId ?? fact.planId, updatedAt: new Date() });
  } else {
    await storeSubscription(trx, source, {
      id: fact.id,
      customId: fact.customId,
      clickId: ref.kind === 'click' ? ref.click.id : null,
      planId: fact.planId,
      status: fact.status,
      createdAt: fact.createdAt,
    });
  }
  if (sandbox(source)) return done(ref.kind === 'test_click' ? 'test_click' : 'sandbox');
  if (ref.kind !== 'click') return done(ref.kind);
  if (!fact.activated) return done('linked');

  const userId = clickUserId(ref.click.id);
  await trx(TABLES.Identity).insert({ id: ulid(), tenantId, clickId: ref.click.id, userId }).onConflict(['clickId', 'userId']).ignore();
  const [event] = (await trx<EventRow>(TABLES.Event)
    .insert({
      id: ulid(),
      tenantId,
      userId,
      type: 'subscription_created',
      currency: await ingestCurrency(trx, tenantId, undefined),
      externalEventId: fact.id,
      metadata: eventMetadata(source, {
        paypalSubscriptionId: fact.id,
        ...(fact.planId ? { paypalPlanId: fact.planId } : {}),
        ...(customId ? { paypalCustomId: customId } : {}),
      }),
      ts: fact.at,
    })
    .onConflict(['tenantId', 'externalEventId'])
    .ignore()
    .returning('*')) as EventRow[];
  if (!event) return done('recorded');
  await attributeEvent(trx, event);
  return done('recorded', [event.id]);
}

/** The payment Event a refund or dispute names, by PayPal's id for it. */
async function paymentEvent(trx: Knex, tenantId: string, paymentId: string): Promise<EventRow | null> {
  return ((await trx<EventRow>(TABLES.Event).where({ tenantId, externalEventId: paymentId, type: 'invoice_paid' }).first()) as EventRow | undefined) ?? null;
}

async function settleRefund(trx: Knex.Transaction, source: PaypalSource, fact: Extract<PaypalFact, { kind: 'refund' }>): Promise<PaypalFactResult> {
  if (sandbox(source)) return done('sandbox');
  const tenantId = source.conn.tenantId;
  const conversion = fact.paymentId ? await paymentEvent(trx, tenantId, fact.paymentId) : null;
  if (!conversion) return done('not_tracked');

  const paymentKey = conversion.metadata?.paypalSaleId != null ? 'paypalSaleId' : 'paypalCaptureId';
  const input: RecordRefundInput = {
    conversionEventId: conversion.id,
    amount: Number(fact.amount.value),
    currency: fact.amount.currency,
    kind: 'refund',
    externalEventId: fact.id,
    ts: fact.at,
    metadata: eventMetadata(source, { paypalRefundId: fact.id, [paymentKey]: fact.paymentId }),
  };
  // A redelivery repeats exactly what was recorded, so the refund finishes
  // anything it left held in transfer instead of conflicting with itself.
  const existing = (await trx<EventRow>(TABLES.Event).where({ tenantId, externalEventId: fact.id }).first()) as EventRow | undefined;
  if (existing) {
    const stored = (existing.metadata as { requestedAmount?: unknown } | null)?.requestedAmount;
    input.amount = stored == null ? undefined : Number(stored);
  }
  let result = await recordRefund(trx, tenantId, input);
  if (!result.ok && result.error === 'refund_exceeds_remaining') {
    // More than what's left: other refunds of this conversion were
    // reported another way (POST /attribution/refunds). What's left goes.
    result = await recordRefund(trx, tenantId, { ...input, amount: undefined, metadata: { ...input.metadata, cappedToRemaining: true } });
  }
  if (!result.ok) {
    if (result.error !== 'nothing_to_refund') {
      console.warn('[paypal-payments] refund not applied', { tenantId, paypalRefundId: fact.id, error: result.error });
    }
    return done('ignored');
  }
  return { outcome: 'recorded', eventIds: [result.body.refundEventId], refunds: [{ refundEventId: result.body.refundEventId, announce: result.announce }] };
}

async function settleDispute(trx: Knex.Transaction, source: PaypalSource, fact: Extract<PaypalFact, { kind: 'dispute' }>): Promise<PaypalFactResult> {
  if (sandbox(source)) return done('sandbox');
  const tenantId = source.conn.tenantId;
  const disputed: EventRow[] = [];
  for (const id of fact.transactionIds) {
    const e = await paymentEvent(trx, tenantId, id);
    if (e) disputed.push(e);
  }
  const first = disputed[0];
  if (!first) return done('not_tracked');
  const [event] = (await trx<EventRow>(TABLES.Event)
    .insert({
      id: ulid(),
      tenantId,
      userId: first.userId,
      type: 'dispute_created',
      value: fact.amount ? (-Number(fact.amount.value)).toFixed(2) : null,
      currency: await ingestCurrency(trx, tenantId, fact.amount?.currency ?? first.currency ?? undefined),
      externalEventId: fact.id,
      metadata: eventMetadata(source, {
        paypalDisputeId: fact.id,
        paypalTransactionIds: fact.transactionIds,
        disputedEventIds: disputed.map((e) => e.id),
        reason: fact.reason,
        status: fact.status,
      }),
      ts: fact.at,
    })
    .onConflict(['tenantId', 'externalEventId'])
    .ignore()
    .returning('id')) as Array<{ id: string }>;
  return done('recorded', event ? [event.id] : []);
}
