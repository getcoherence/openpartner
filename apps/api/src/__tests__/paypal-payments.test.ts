/**
 * PayPal payments as conversions (docs/paypal-payments.md), against a fake
 * PayPal (fake-paypal.ts) and PayPal's documented webhook and Transaction
 * Search payloads:
 *
 *   - tracking adds the payment events to the app's webhook; a checkout
 *     app gets a webhook of its own and never sends; Pay with PayPal's own
 *     app can't be connected twice;
 *   - a capture whose custom_id names a click records one attributed
 *     invoice_paid under the click's user, whatever redelivers it; no
 *     reference, a foreign one or an unknown click records nothing and is
 *     counted; a sandbox app's payments are recorded the same way and
 *     never billed; a test click is linked instead;
 *   - subscriptions: the custom_id is stored at CREATED, ACTIVATED records
 *     subscription_created, each renewal joins on billing_agreement_id (or
 *     the subscription's transactions, or PayPal's read of it), and
 *     renewals follow Program.renewalsStayWithPartner;
 *   - refunds go through POST /attribution/refunds' path (partials add up),
 *     a reversal is a chargeback, disputes reverse nothing until resolved
 *     against the brand: then the refunds PayPal lists, each once, keyed as
 *     their own events are; a refund that beats its payment waits for it;
 *   - the catch-up records what no webhook delivered, from the events list
 *     and from Transaction Search, once, never before tracking began, and
 *     keeps each app's webhook on the events OpenPartner reads;
 *   - Tracking health counts PayPal payments by what became of them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { FakePaypal } from './fake-paypal.js';

const ADMIN_KEY = 'op_test_paypal_payments_admin_0123456789ab';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.CSL_API_KEY = '';

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { __setMailerForTests } = await import('../mailer.js');
const { __setPaypalFetchForTests, PAYPAL_PAYMENT_EVENTS, PAYPAL_WEBHOOK_EVENTS } = await import('../paypal-api.js');
const { runPaypalPaymentsCatchup, SEARCH_LAG_HOURS, SEARCH_RECHECK_HOURS } = await import('../paypal-payments-catchup.js');
const { sumBillableBasis } = await import('../usage-ledger.js');

const T = DEFAULT_TENANT_ID;
const OTHER = 'paypal-payments-other';
const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const CLIENT_ID = 'AbCdEfPaymentsClient0123456789';
const SECRET = 'PaymentsSecretNeverToBeSeen0123456789xyz';
const CHECKOUT_ID = 'ChEcKoutAppClient0123456789';
const CHECKOUT_SECRET = 'CheckoutSecretNeverSeen0123456789abc';
const DAY = 86_400_000;
const RECURRING_20 = [{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 20, recurring: true }];

const admin = {
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${ADMIN_KEY}`),
  post: (path: string, body: object = {}) => request(app).post(path).set('Authorization', `Bearer ${ADMIN_KEY}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer ${ADMIN_KEY}`),
};

let fake: FakePaypal;
let liveApp: ReturnType<FakePaypal['addApp']>;
let checkoutApp: ReturnType<FakePaypal['addApp']>;
const logs: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };
/** A test click linked by a sandbox payment passes the brand's tracking
 *  test; put it back as it was. */
let trackingTestPassedAt: Date | null = null;

async function program(o: { renewalsStayWithPartner?: boolean; tenantId?: string } = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId: o.tenantId ?? T,
    name: `Program ${id}`,
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify(RECURRING_20),
    destinationUrl: 'https://brand.example/',
    renewalsStayWithPartner: o.renewalsStayWithPartner ?? true,
  });
  return id;
}

/** A partner's click in `programId`, `daysAgo` old. */
async function click(programId: string, daysAgo = 1, tenantId = T): Promise<{ clickId: string; partnerId: string }> {
  const partnerId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId, name: 'P', email: `p-${partnerId.toLowerCase()}@example.com` });
  await db(TABLES.Link).insert({ id: linkId, tenantId, partnerId, programId, linkKey: `lk-${linkId}` });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://brand.example/',
    ts: new Date(Date.now() - daysAgo * DAY),
  });
  return { clickId, partnerId };
}

async function connect(environment: 'live' | 'sandbox' = 'live'): Promise<{ id: string; webhookId: string | null }> {
  const res = await admin.post('/config/paypal', { environment, clientId: CLIENT_ID, clientSecret: SECRET });
  expect(res.status).toBe(201);
  const on = await admin.post(`/config/paypal/${environment}/payments`, { tracking: true });
  expect(on.status).toBe(200);
  const hook = fake.webhookAt(`https://portal.brand.example/api/webhooks/paypal/${res.body.connection.id}`);
  return { id: res.body.connection.id, webhookId: hook?.id ?? null };
}

/** Tracking began `days` ago, so the catch-up's window reaches back. */
async function sinceDaysAgo(connectionId: string, days: number): Promise<void> {
  await db(TABLES.PaypalConnection).where({ id: connectionId }).update({ paymentsSince: new Date(Date.now() - days * DAY) });
}

function deliver(conn: { id: string; webhookId: string | null }, event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const d = fake.signDelivery(conn.webhookId!, body);
  return request(app).post(`/webhooks/paypal/${conn.id}`).set(d.headers).send(d.body);
}

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

function capture(o: { id?: string; customId?: string | null; value?: string; currency?: string; at?: string } = {}) {
  const id = o.id ?? `CAP${ulid().slice(0, 14)}`;
  return {
    id: `WH-${ulid()}`,
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    create_time: o.at ?? iso(),
    resource_type: 'capture',
    resource: {
      id,
      status: 'COMPLETED',
      amount: { currency_code: o.currency ?? 'USD', value: o.value ?? '100.00' },
      final_capture: true,
      ...(o.customId === null ? {} : { custom_id: o.customId }),
      supplementary_data: { related_ids: { order_id: `ORD${ulid().slice(0, 14)}` } },
      create_time: o.at ?? iso(),
    },
  };
}

function sale(o: { id?: string; subscriptionId?: string | null; value?: string; at?: string }) {
  return {
    id: `WH-${ulid()}`,
    event_type: 'PAYMENT.SALE.COMPLETED',
    create_time: o.at ?? iso(),
    resource_type: 'sale',
    resource: {
      id: o.id ?? `SALE${ulid().slice(0, 13)}`,
      state: 'completed',
      amount: { total: o.value ?? '49.00', currency: 'USD', details: { subtotal: o.value ?? '49.00' } },
      payment_mode: 'INSTANT_TRANSFER',
      ...(o.subscriptionId ? { billing_agreement_id: o.subscriptionId } : {}),
      create_time: o.at ?? iso(),
    },
  };
}

function subscriptionEvent(type: 'CREATED' | 'ACTIVATED', id: string, customId: string | null, at = iso()) {
  return {
    id: `WH-${ulid()}`,
    event_type: `BILLING.SUBSCRIPTION.${type}`,
    create_time: at,
    resource_type: 'subscription',
    resource: { id, plan_id: 'P-PLAN123', status: type === 'CREATED' ? 'APPROVAL_PENDING' : 'ACTIVE', custom_id: customId ?? undefined, create_time: at },
  };
}

function captureRefund(captureId: string, value: string, o: { id?: string; at?: string; reversed?: boolean } = {}) {
  return {
    id: `WH-${ulid()}`,
    event_type: o.reversed ? 'PAYMENT.CAPTURE.REVERSED' : 'PAYMENT.CAPTURE.REFUNDED',
    create_time: o.at ?? iso(),
    resource_type: 'refund',
    resource: {
      id: o.id ?? `REF${ulid().slice(0, 14)}`,
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value },
      links: [
        { href: `https://api.paypal.com/v2/payments/refunds/X`, rel: 'self', method: 'GET' },
        { href: `https://api.paypal.com/v2/payments/captures/${captureId}`, rel: 'up', method: 'GET' },
      ],
      create_time: o.at ?? iso(),
    },
  };
}

/** CUSTOMER.DISPUTE.RESOLVED as the sandbox sent it (Nov 2026): the outcome,
 *  who the money moved from, and the refund transactions PayPal made. */
function disputeResolved(o: {
  captureIds: string[];
  refunds?: Array<{ id: string; value: string }>;
  outcome?: string;
  reason?: string;
  sellerDebited?: boolean;
  deprecatedMovements?: boolean;
  at?: string;
}) {
  const at = o.at ?? iso();
  const settled = (o.refunds ?? []).reduce((n, r) => n + Number(r.value), 0).toFixed(2);
  const movements = [
    { party: 'BUYER', amount: { currency_code: 'USD', value: settled }, initiated_time: at, type: 'CREDIT', reason: 'DISPUTE_SETTLEMENT' },
    ...(o.sellerDebited === false ? [] : [{ party: 'SELLER', amount: { currency_code: 'USD', value: settled }, initiated_time: at, type: 'DEBIT', reason: 'DISPUTE_SETTLEMENT' }]),
  ];
  return {
    id: `WH-${ulid()}`,
    event_type: 'CUSTOMER.DISPUTE.RESOLVED',
    create_time: at,
    resource_type: 'dispute',
    resource: {
      dispute_id: `PP-R-${ulid().slice(0, 12)}`,
      create_time: iso(DAY),
      update_time: at,
      status: 'RESOLVED',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      disputed_transactions: o.captureIds.map((id) => ({ seller_transaction_id: id, gross_amount: { currency_code: 'USD', value: '100.00' } })),
      dispute_outcome: { outcome_code: o.outcome ?? 'RESOLVED_BUYER_FAVOUR', ...(o.reason ? { outcome_reason: o.reason } : {}) },
      ...(o.deprecatedMovements
        ? { money_movements: movements.map(({ party, ...m }) => ({ affected_party: party, ...m })) }
        : { fund_movements: [{ party: 'RECEIVER', amount: { currency_code: 'USD', value: '91.60' }, initiated_time: iso(DAY), type: 'DEBIT', reason: 'HOLD_PLACED' }, ...movements] }),
      refund_details: {
        allowed_refund_amount: { currency_code: 'USD', value: '100.00' },
        ...(o.refunds ? { transactions: o.refunds.map((r) => ({ id: r.id, gross_amount: { currency_code: 'USD', value: r.value }, create_time: at })) } : {}),
      },
    },
  };
}

async function eventsOf(externalEventId: string) {
  return db(TABLES.Event).where({ tenantId: T, externalEventId });
}

async function commissionsOf(eventId: string) {
  return db(TABLES.Commission)
    .join(TABLES.Attribution, `${TABLES.Attribution}.id`, `${TABLES.Commission}.attributionId`)
    .where(`${TABLES.Attribution}.eventId`, eventId)
    .orderBy(`${TABLES.Commission}.id`)
    .select(`${TABLES.Commission}.*`);
}

async function cleanup(): Promise<void> {
  const tenants = [T, OTHER];
  for (const t of [
    TABLES.PaymentEventLog,
    TABLES.CommissionAdjustment,
    TABLES.Commission,
    TABLES.Attribution,
    TABLES.Event,
    TABLES.Identity,
    TABLES.Click,
    TABLES.Link,
    TABLES.TestClick,
    TABLES.TrackingIssue,
    TABLES.PaypalSubscription,
    TABLES.PaypalPayoutBatch,
    TABLES.PaypalConnection,
    TABLES.PartnerProgram,
    TABLES.Program,
    TABLES.Partner,
  ]) {
    await db(t).whereIn('tenantId', tenants).del();
  }
  await db(TABLES.Tenant).where({ id: OTHER }).del();
}

beforeAll(async () => {
  if (skipIntegration) return;
  trackingTestPassedAt = (await db(TABLES.Tenant).where({ id: T }).first('trackingTestPassedAt'))?.trackingTestPassedAt ?? null;
  __setMailerForTests({ async send() {} });
  for (const k of ['log', 'warn', 'error'] as const) {
    console[k] = (...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }
});

beforeEach(async () => {
  if (skipIntegration) return;
  await cleanup();
  fake = new FakePaypal();
  liveApp = fake.addApp({ env: 'live', clientId: CLIENT_ID, secret: SECRET });
  fake.addApp({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET });
  checkoutApp = fake.addApp({ env: 'live', clientId: CHECKOUT_ID, secret: CHECKOUT_SECRET, payouts: false });
  __setPaypalFetchForTests(fake.fetch);
  process.env.PORTAL_URL = 'https://portal.brand.example';
});

afterAll(async () => {
  Object.assign(console, original);
  const all = logs.join('\n');
  expect(all).not.toContain(SECRET);
  expect(all).not.toContain(CHECKOUT_SECRET);
  __setMailerForTests(null);
  __setPaypalFetchForTests(null);
  if (!skipIntegration) {
    await cleanup();
    await db(TABLES.Tenant).where({ id: T }).update({ trackingTestPassedAt });
  }
  await db.destroy();
});

// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('turning payment tracking on', () => {
  it('adds the payment events to Pay with PayPal’s webhook, and takes them off again', async () => {
    const res = await admin.post('/config/paypal', { environment: 'live', clientId: CLIENT_ID, clientSecret: SECRET });
    const url = `https://portal.brand.example/api/webhooks/paypal/${res.body.connection.id}`;
    expect(fake.webhookAt(url)!.eventTypes).toEqual([...PAYPAL_WEBHOOK_EVENTS]);

    const on = await admin.post('/config/paypal/live/payments', { tracking: true });
    expect(on.status).toBe(200);
    expect(on.body.app).toMatchObject({ environment: 'live', purpose: 'payouts', tracking: true, webhook: { registered: true } });
    expect(fake.webhookAt(url)!.eventTypes).toEqual([...PAYPAL_WEBHOOK_EVENTS, ...PAYPAL_PAYMENT_EVENTS]);

    const list = await admin.get('/config/paypal-payments');
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.apps).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(SECRET);

    // A new secret for the same app keeps tracking, and its webhook.
    const rotated = await admin.post('/config/paypal', { environment: 'live', clientId: CLIENT_ID, clientSecret: SECRET });
    const rotatedUrl = `https://portal.brand.example/api/webhooks/paypal/${rotated.body.connection.id}`;
    expect(fake.webhookAt(rotatedUrl)!.eventTypes).toEqual([...PAYPAL_WEBHOOK_EVENTS, ...PAYPAL_PAYMENT_EVENTS]);
    expect((await admin.get('/config/paypal-payments')).body.apps[0]).toMatchObject({ tracking: true, trackingSince: on.body.app.trackingSince });

    const off = await admin.post('/config/paypal/live/payments', { tracking: false });
    expect(off.body.app.tracking).toBe(false);
    expect(fake.webhookAt(rotatedUrl)!.eventTypes).toEqual([...PAYPAL_WEBHOOK_EVENTS]);
    expect((await admin.post('/config/paypal/sandbox/payments', { tracking: true })).status).toBe(404);
    expect((await admin.post('/config/paypal/live/payments', { tracking: 'yes' })).status).toBe(400);
  });

  it('changes the webhook already on an existing connection in place, with the saved secret', async () => {
    const res = await admin.post('/config/paypal', { environment: 'live', clientId: CLIENT_ID, clientSecret: SECRET });
    const url = `https://portal.brand.example/api/webhooks/paypal/${res.body.connection.id}`;
    const before = fake.webhookAt(url)!.id;
    expect((await admin.post('/config/paypal/live/payments', { tracking: true })).status).toBe(200);
    // No token call with the secret pasted again, and no second webhook.
    expect([...fake.webhooks.values()].filter((w) => w.account === FakePaypal.account(liveApp))).toHaveLength(1);
    expect(fake.webhookAt(url)!.id).toBe(before);

    // Removed in PayPal's dashboard since: registered again.
    await admin.post('/config/paypal/live/payments', { tracking: false });
    fake.webhooks.delete(before);
    const again = await admin.post('/config/paypal/live/payments', { tracking: true });
    expect(again.body.app.webhook).toEqual({ registered: true, error: null });
    expect(fake.webhookAt(url)!.eventTypes).toEqual([...PAYPAL_WEBHOOK_EVENTS, ...PAYPAL_PAYMENT_EVENTS]);
  });

  it('records payments without disputes on an app PayPal won’t send dispute events for, and says so', async () => {
    fake.noDisputes.add(liveApp.appId);
    fake.noDisputes.add(checkoutApp.appId);
    const res = await admin.post('/config/paypal', { environment: 'live', clientId: CLIENT_ID, clientSecret: SECRET });
    const on = await admin.post('/config/paypal/live/payments', { tracking: true });
    expect(on.status).toBe(200);
    expect(on.body.app.webhook).toMatchObject({ registered: true, error: expect.stringContaining('Customer disputes') });
    const hook = fake.webhookAt(`https://portal.brand.example/api/webhooks/paypal/${res.body.connection.id}`)!;
    expect(hook.eventTypes).toContain('PAYMENT.CAPTURE.COMPLETED');
    expect(hook.eventTypes).not.toContain('CUSTOMER.DISPUTE.CREATED');
    expect(hook.eventTypes).not.toContain('CUSTOMER.DISPUTE.RESOLVED');
    // Pay with PayPal's own card still reads the webhook as working.
    expect((await admin.get('/config/paypal')).body.connections[0].webhook.registered).toBe(true);
    // Off again: the note goes with the payment events.
    expect((await admin.post('/config/paypal/live/payments', { tracking: false })).body.app.webhook.error).toBeNull();

    const checkout = await admin.post('/config/paypal-payments', { environment: 'live', clientId: CHECKOUT_ID, clientSecret: CHECKOUT_SECRET });
    expect(checkout.status).toBe(201);
    expect(checkout.body.app.webhook.error).toContain('Customer disputes');
    expect(fake.webhookAt(`https://portal.brand.example/api/webhooks/paypal/${checkout.body.app.id}`)!.eventTypes).toEqual(
      PAYPAL_PAYMENT_EVENTS.filter((t) => !t.startsWith('CUSTOMER.DISPUTE.')),
    );
  });

  it('connects a separate checkout app that only reports payments and never sends', async () => {
    await admin.post('/config/paypal', { environment: 'live', clientId: CLIENT_ID, clientSecret: SECRET });
    const same = await admin.post('/config/paypal-payments', { environment: 'live', clientId: CLIENT_ID, clientSecret: SECRET });
    expect(same.status).toBe(409);
    expect(same.body.error).toBe('same_app_as_payouts');

    const res = await admin.post('/config/paypal-payments', { environment: 'live', clientId: CHECKOUT_ID, clientSecret: CHECKOUT_SECRET });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(CHECKOUT_SECRET);
    expect(res.body.app).toMatchObject({ purpose: 'checkout', tracking: true, webhook: { registered: true } });
    const hook = fake.webhookAt(`https://portal.brand.example/api/webhooks/paypal/${res.body.app.id}`)!;
    expect(hook.eventTypes).toEqual([...PAYPAL_PAYMENT_EVENTS]);
    expect(hook.account).toBe(FakePaypal.account(checkoutApp));

    // Pay with PayPal still sees only its own app, and a checkout app can
    // never be the one that sends.
    expect((await admin.get('/config/paypal')).body.connections).toHaveLength(1);
    expect((await admin.get('/config/paypal-payments')).body.apps).toHaveLength(2);
    await expect(db(TABLES.PaypalConnection).where({ id: res.body.app.id }).update({ active: true })).rejects.toThrow();

    expect((await admin.delete('/config/paypal-payments/live')).status).toBe(204);
    expect(fake.webhooks.has(hook.id)).toBe(false);
    expect((await admin.delete('/config/paypal-payments/live')).status).toBe(404);
    expect((await admin.get('/config/paypal')).body.connections).toHaveLength(1);
  });
});

describe.skipIf(skipIntegration)('captures', () => {
  it('records one attributed invoice_paid for the click its custom_id names, whatever redelivers it', async () => {
    const conn = await connect();
    const { clickId, partnerId } = await click(await program());
    const event = capture({ customId: clickId, value: '100.00' });
    const res = await deliver(conn, event);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('recorded');

    const [row] = await eventsOf(event.resource.id);
    expect(row).toMatchObject({ type: 'invoice_paid', value: '100.00', currency: 'USD', userId: `click:${clickId}` });
    expect(row.metadata).toMatchObject({ via: 'paypal', paypalCaptureId: event.resource.id, paypalCustomId: clickId, paypalEventType: 'PAYMENT.CAPTURE.COMPLETED' });
    const [commission] = await commissionsOf(row.id);
    expect(commission).toMatchObject({ partnerId, amount: '20.00', status: 'accrued' });

    expect((await deliver(conn, event)).body.outcome).toBe('duplicate');
    // The same capture under another webhook event id (PayPal sends some twice).
    expect((await deliver(conn, { ...event, id: `WH-${ulid()}` })).body.outcome).toBe('duplicate');
    expect(await eventsOf(event.resource.id)).toHaveLength(1);
    const log = await db(TABLES.PaymentEventLog).where({ tenantId: T, eventKey: `capture:${event.resource.id}` });
    expect(log).toMatchObject([{ provider: 'paypal', via: 'webhook', outcome: 'recorded', connectionId: conn.id }]);
    const touched = await db(TABLES.PaypalConnection).where({ id: conn.id }).first();
    expect(touched.lastPaymentEventAt).not.toBeNull();
  });

  it('credits a click beside the brand’s own reference; records nothing for no reference, a foreign one or an unknown click', async () => {
    const conn = await connect();
    const { clickId } = await click(await program());
    const beside = capture({ customId: `order-1042|${clickId}` });
    expect((await deliver(conn, beside)).body.outcome).toBe('recorded');
    expect(await eventsOf(beside.resource.id)).toHaveLength(1);

    const none = capture({ customId: null });
    expect((await deliver(conn, none)).body.outcome).toBe('no_reference');
    const foreign = capture({ customId: 'order-1043' });
    expect((await deliver(conn, foreign)).body.outcome).toBe('foreign_reference');
    const unknown = capture({ customId: ulid() });
    expect((await deliver(conn, unknown)).body.outcome).toBe('unknown_click');
    // Another brand's click is a click this one doesn't have.
    await db(TABLES.Tenant).insert({ id: OTHER, slug: OTHER, displayName: 'Other', status: 'active' });
    const theirs = await click(await program({ tenantId: OTHER }), 1, OTHER);
    expect((await deliver(conn, capture({ customId: theirs.clickId }))).body.outcome).toBe('unknown_click');

    for (const e of [none, foreign, unknown]) expect(await eventsOf(e.resource.id)).toHaveLength(0);
    const issues = await db(TABLES.TrackingIssue).where({ tenantId: T }).orderBy('kind');
    expect(issues.map((i) => [i.kind, i.count])).toEqual([
      ['paypal_foreign_reference', 1],
      ['paypal_unknown_click', 2],
    ]);
    expect(await db(TABLES.Event).where({ tenantId: OTHER })).toHaveLength(0);
  });

  it('keeps zero-decimal amounts whole', async () => {
    const conn = await connect();
    const { clickId } = await click(await program());
    const event = capture({ customId: clickId, value: '1500', currency: 'JPY' });
    expect((await deliver(conn, event)).body.outcome).toBe('recorded');
    expect((await eventsOf(event.resource.id))[0]).toMatchObject({ value: '1500.00', currency: 'JPY' });
  });

  it('skips payment events while the app isn’t tracking payments, and refuses a forged one', async () => {
    const res = await admin.post('/config/paypal', { environment: 'live', clientId: CLIENT_ID, clientSecret: SECRET });
    const hook = fake.webhookAt(`https://portal.brand.example/api/webhooks/paypal/${res.body.connection.id}`)!;
    const conn = { id: res.body.connection.id as string, webhookId: hook.id };
    const { clickId } = await click(await program());
    const event = capture({ customId: clickId });
    expect((await deliver(conn, event)).body).toMatchObject({ skipped: 'payments_not_tracked' });

    await admin.post('/config/paypal/live/payments', { tracking: true });
    const body = JSON.stringify(event);
    const signed = fake.signDelivery(hook.id, body);
    const forged = await request(app).post(`/webhooks/paypal/${conn.id}`).set(signed.headers).send(body.replace('100.00', '9999.00'));
    expect(forged.status).toBe(400);
    expect(await eventsOf(event.resource.id)).toHaveLength(0);
    // A capture still pending records nothing until its completion.
    const pending = capture({ customId: clickId });
    (pending.resource as { status: string }).status = 'PENDING';
    expect((await deliver(conn, pending)).body).toMatchObject({ skipped: 'not_final' });
  });

  it('records a sandbox app’s payments the same way, never billed, and links an admin’s test click', async () => {
    const conn = await connect('sandbox');
    const programId = await program();
    const { clickId } = await click(programId);

    const paid = capture({ customId: clickId, value: '100.00' });
    expect((await deliver(conn, paid)).body.outcome).toBe('recorded');
    const [conversion] = await eventsOf(paid.resource.id);
    expect(conversion).toMatchObject({ type: 'invoice_paid', value: '100.00' });
    expect(conversion.metadata).toMatchObject({ via: 'paypal', paypalEnvironment: 'sandbox' });
    expect((await commissionsOf(conversion.id)).map((c) => [c.status, c.amount])).toEqual([['accrued', '20.00']]);
    expect((await deliver(conn, captureRefund(paid.resource.id, '50.00'))).body.outcome).toBe('recorded');
    expect((await commissionsOf(conversion.id)).filter((c) => c.status !== 'reversed').map((c) => c.amount)).toEqual(['10.00']);
    // Test money: the platform fee's basis leaves it out, and a live
    // payment still counts.
    expect(await sumBillableBasis(db, T, null, new Date())).toEqual({});
    const live = await connect('live');
    const { clickId: liveClick } = await click(programId);
    await deliver(live, capture({ customId: liveClick, value: '40.00' }));
    expect(await sumBillableBasis(db, T, null, new Date())).toEqual({ USD: 40 });

    const testId = ulid();
    const testClickId = ulid();
    await db(TABLES.TestClick).insert({
      id: testId,
      tenantId: T,
      programId,
      tokenHash: `hash-${testId}`,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      clickId: testClickId,
      clickedAt: new Date(),
    });
    const test = capture({ customId: testClickId });
    expect((await deliver(conn, test)).body.outcome).toBe('test_click');
    const row = await db(TABLES.TestClick).where({ id: testId }).first();
    expect(row.identifiedAt).not.toBeNull();
    expect(row.linkedVia).toBe('paypal');
    expect(await db(TABLES.TrackingIssue).where({ tenantId: T })).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('subscriptions and renewals', () => {
  it('stores the custom_id at CREATED, records subscription_created at ACTIVATED, and joins each payment on billing_agreement_id', async () => {
    const conn = await connect();
    const { clickId, partnerId } = await click(await program());
    const subId = `I-${ulid().slice(0, 12)}`;
    expect((await deliver(conn, subscriptionEvent('CREATED', subId, clickId))).body.outcome).toBe('linked');
    expect(await db(TABLES.PaypalSubscription).where({ tenantId: T, subscriptionId: subId }).first()).toMatchObject({
      customId: clickId,
      clickId,
      connectionId: conn.id,
      status: 'APPROVAL_PENDING',
    });
    expect((await deliver(conn, subscriptionEvent('ACTIVATED', subId, clickId))).body.outcome).toBe('recorded');
    expect((await eventsOf(subId))[0]).toMatchObject({ type: 'subscription_created', userId: `click:${clickId}` });

    const first = sale({ subscriptionId: subId });
    const second = sale({ subscriptionId: subId });
    expect((await deliver(conn, first)).body.outcome).toBe('recorded');
    expect((await deliver(conn, second)).body.outcome).toBe('recorded');
    for (const s of [first, second]) {
      const [row] = await eventsOf(s.resource.id);
      expect(row).toMatchObject({ type: 'invoice_paid', value: '49.00', userId: `click:${clickId}` });
      expect(row.metadata).toMatchObject({ paypalSaleId: s.resource.id, paypalSubscriptionId: subId });
      expect(await commissionsOf(row.id)).toMatchObject([{ partnerId, amount: '9.80' }]);
    }
    // No PayPal read was needed: the subscription was stored.
    expect(fake.seen.some((r) => r.path.startsWith('/v1/billing/subscriptions'))).toBe(false);
  });

  it('keeps renewals past the window with the partner, and stops them with renewalsStayWithPartner off', async () => {
    const conn = await connect();
    const stays = await click(await program({ renewalsStayWithPartner: true }), 100);
    const ends = await click(await program({ renewalsStayWithPartner: false }), 100);
    for (const c of [stays, ends]) {
      const subId = `I-${ulid().slice(0, 12)}`;
      await deliver(conn, subscriptionEvent('CREATED', subId, c.clickId, iso(95 * DAY)));
      const first = sale({ subscriptionId: subId, at: iso(95 * DAY) });
      const renewal = sale({ subscriptionId: subId });
      await deliver(conn, first);
      await deliver(conn, renewal);
      const [firstRow] = await eventsOf(first.resource.id);
      const [renewalRow] = await eventsOf(renewal.resource.id);
      expect(await commissionsOf(firstRow.id)).toHaveLength(1);
      if (c === stays) expect(await commissionsOf(renewalRow.id)).toMatchObject([{ partnerId: stays.partnerId, amount: '9.80' }]);
      else expect(await commissionsOf(renewalRow.id)).toHaveLength(0);
    }
  });

  it('reads a subscription it hasn’t seen from PayPal, and finds a renewal that came without its subscription id', async () => {
    const conn = await connect();
    const { clickId } = await click(await program());
    const subId = `I-${ulid().slice(0, 12)}`;
    const orphan = sale({});
    fake.addSubscription(liveApp, { id: subId, plan_id: 'P-1', status: 'ACTIVE', custom_id: clickId, create_time: iso(DAY) }, [
      { id: orphan.resource.id, time: iso() },
    ]);

    const early = sale({ subscriptionId: subId });
    expect((await deliver(conn, early)).body.outcome).toBe('recorded');
    expect(await db(TABLES.PaypalSubscription).where({ tenantId: T, subscriptionId: subId }).first()).toMatchObject({ clickId });

    expect((await deliver(conn, orphan)).body.outcome).toBe('recorded');
    expect((await eventsOf(orphan.resource.id))[0].metadata).toMatchObject({ paypalSubscriptionId: subId });

    // One no subscription has stays unsettled for Transaction Search.
    const lost = sale({});
    expect((await deliver(conn, lost)).body.outcome).toBe('unresolved');
    expect(await db(TABLES.PaymentEventLog).where({ tenantId: T, eventKey: `sale:${lost.resource.id}` })).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('refunds and disputes', () => {
  it('reduces the commission by the share refunded so far, through the refunds path; a redelivery changes nothing', async () => {
    const conn = await connect();
    const { clickId } = await click(await program());
    const paid = capture({ customId: clickId, value: '100.00' });
    await deliver(conn, paid);
    const [conversion] = await eventsOf(paid.resource.id);

    const first = captureRefund(paid.resource.id, '30.00');
    expect((await deliver(conn, first)).body.outcome).toBe('recorded');
    const second = captureRefund(paid.resource.id, '20.00');
    expect((await deliver(conn, second)).body.outcome).toBe('recorded');
    expect((await deliver(conn, { ...second, id: `WH-${ulid()}` })).body.outcome).toBe('duplicate');

    const [refund] = await eventsOf(first.resource.id);
    expect(refund).toMatchObject({ type: 'refund', value: '-30.00', userId: conversion.userId });
    expect(refund.metadata).toMatchObject({ conversionEventId: conversion.id, paypalRefundId: first.resource.id, paypalCaptureId: paid.resource.id });
    const live = (await commissionsOf(conversion.id)).filter((c) => c.status !== 'reversed');
    expect(live.map((c) => c.amount)).toEqual(['10.00']);
  });

  it('reverses a renewal’s commission on a full sale refund', async () => {
    const conn = await connect();
    const { clickId } = await click(await program());
    const subId = `I-${ulid().slice(0, 12)}`;
    await deliver(conn, subscriptionEvent('CREATED', subId, clickId));
    const paid = sale({ subscriptionId: subId });
    await deliver(conn, paid);
    const refund = {
      id: `WH-${ulid()}`,
      event_type: 'PAYMENT.SALE.REFUNDED',
      create_time: iso(),
      resource: { id: `SR${ulid().slice(0, 14)}`, state: 'completed', sale_id: paid.resource.id, amount: { total: '49.00', currency: 'USD' } },
    };
    expect((await deliver(conn, refund)).body.outcome).toBe('recorded');
    const [conversion] = await eventsOf(paid.resource.id);
    expect((await commissionsOf(conversion.id)).map((c) => c.status)).toEqual(['reversed']);
    expect((await eventsOf(refund.resource.id))[0].metadata).toMatchObject({ paypalSaleId: paid.resource.id });
  });

  it('records a dispute without reversing anything; a refund of a payment not recorded waits for it, then is left alone', async () => {
    const conn = await connect();
    const { clickId } = await click(await program());
    const paid = capture({ customId: clickId, value: '100.00' });
    await deliver(conn, paid);
    const dispute = {
      id: `WH-${ulid()}`,
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      create_time: iso(),
      resource: {
        dispute_id: `PP-D-${ulid().slice(0, 8)}`,
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        status: 'OPEN',
        dispute_amount: { currency_code: 'USD', value: '100.00' },
        disputed_transactions: [{ seller_transaction_id: paid.resource.id, custom: clickId }],
      },
    };
    expect((await deliver(conn, dispute)).body.outcome).toBe('recorded');
    const [conversion] = await eventsOf(paid.resource.id);
    const [row] = await eventsOf(dispute.resource.dispute_id);
    expect(row).toMatchObject({ type: 'dispute_created', value: '-100.00', userId: conversion.userId });
    expect(row.metadata).toMatchObject({ paypalDisputeId: dispute.resource.dispute_id, disputedEventIds: [conversion.id] });
    expect((await commissionsOf(conversion.id)).map((c) => c.status)).toEqual(['accrued']);

    // Its payment's webhook may only be late: not logged, so the catch-up
    // tries again while it still lists the refund.
    const early = captureRefund('CAPNEVERSEEN0001', '5.00');
    expect((await deliver(conn, early)).body.outcome).toBe('unresolved');
    expect(await db(TABLES.PaymentEventLog).where({ tenantId: T, eventKey: `refund:${early.resource.id}` })).toHaveLength(0);
    const old = captureRefund('CAPNEVERSEEN0002', '5.00', { at: iso(4 * DAY) });
    expect((await deliver(conn, old)).body.outcome).toBe('not_tracked');
  });

  it('records the refund a lost dispute names once, whichever of it and the refund’s own event comes first', async () => {
    const conn = await connect();
    const { clickId } = await click(await program());

    // The brand accepted the claim (live, Nov 2026): the refund's webhook
    // came first, then the resolution naming the same refund.
    const accepted = capture({ customId: clickId, value: '100.00' });
    await deliver(conn, accepted);
    const [first] = await eventsOf(accepted.resource.id);
    const refund = captureRefund(accepted.resource.id, '100.00');
    expect((await deliver(conn, refund)).body.outcome).toBe('recorded');
    const settled = disputeResolved({ captureIds: [accepted.resource.id], refunds: [{ id: refund.resource.id, value: '100.00' }], reason: 'SELLER_ISSUED_REFUND' });
    expect((await deliver(conn, settled)).body.outcome).toBe('recorded');
    expect(await eventsOf(refund.resource.id)).toHaveLength(1);
    expect((await commissionsOf(first.id)).map((c) => c.status)).toEqual(['reversed']);
    expect((await deliver(conn, { ...settled, id: `WH-${ulid()}` })).body.outcome).toBe('duplicate');

    // PayPal decided for the buyer and named its refund before any
    // reversal event: a chargeback for that share, once.
    const decided = capture({ customId: clickId, value: '100.00' });
    await deliver(conn, decided);
    const [second] = await eventsOf(decided.resource.id);
    const refundId = `RV${ulid().slice(0, 15)}`;
    const lost = disputeResolved({ captureIds: [decided.resource.id], refunds: [{ id: refundId, value: '40.00' }] });
    expect((await deliver(conn, lost)).body.outcome).toBe('recorded');
    const [chargeback] = await eventsOf(refundId);
    expect(chargeback).toMatchObject({ type: 'chargeback', value: '-40.00', userId: second.userId });
    expect(chargeback.metadata).toMatchObject({ conversionEventId: second.id, paypalReversalId: refundId, paypalEventType: 'CUSTOMER.DISPUTE.RESOLVED' });
    const commissions = await commissionsOf(second.id);
    expect(commissions.map((c) => [c.status, c.amount])).toEqual([
      ['reversed', '20.00'],
      ['accrued', '12.00'],
    ]);
    expect((await deliver(conn, captureRefund(decided.resource.id, '40.00', { id: refundId, reversed: true }))).body.outcome).toBe('duplicate');
    expect(await eventsOf(refundId)).toHaveLength(1);
  });

  it('keeps the commission when the brand won or PayPal covered the loss, and counts a loss it can’t tie to one payment', async () => {
    const conn = await connect();
    const { clickId } = await click(await program());
    const paid = capture({ customId: clickId, value: '100.00' });
    await deliver(conn, paid);
    const [conversion] = await eventsOf(paid.resource.id);
    const refunds = [{ id: `RV${ulid().slice(0, 15)}`, value: '100.00' }];

    const won = disputeResolved({ captureIds: [paid.resource.id], refunds, outcome: 'RESOLVED_SELLER_FAVOUR' });
    expect((await deliver(conn, won)).body.outcome).toBe('ignored');
    const covered = disputeResolved({ captureIds: [paid.resource.id], refunds, sellerDebited: false });
    expect((await deliver(conn, covered)).body.outcome).toBe('ignored');
    const unnamed = disputeResolved({ captureIds: [paid.resource.id] });
    expect((await deliver(conn, unnamed)).body.outcome).toBe('unmatched');
    const other = capture({ customId: clickId, value: '100.00' });
    await deliver(conn, other);
    const both = disputeResolved({ captureIds: [paid.resource.id, other.resource.id], refunds, deprecatedMovements: true });
    expect((await deliver(conn, both)).body.outcome).toBe('unmatched');

    expect(await eventsOf(refunds[0]!.id)).toHaveLength(0);
    expect((await commissionsOf(conversion.id)).map((c) => c.status)).toEqual(['accrued']);
    const [issue] = await db(TABLES.TrackingIssue).where({ tenantId: T, kind: 'paypal_dispute_unmatched' });
    expect(issue).toMatchObject({ count: 2, sampleRef: both.resource.dispute_id });
  });

  it('records a payment PayPal reverses as a chargeback, reversing its commission', async () => {
    const conn = await connect();
    const { clickId } = await click(await program());
    const paid = capture({ customId: clickId, value: '100.00' });
    await deliver(conn, paid);
    const [conversion] = await eventsOf(paid.resource.id);

    const reversed = captureRefund(paid.resource.id, '100.00', { reversed: true });
    expect((await deliver(conn, reversed)).body.outcome).toBe('recorded');
    const [chargeback] = await eventsOf(reversed.resource.id);
    expect(chargeback).toMatchObject({ type: 'chargeback', value: '-100.00', userId: conversion.userId });
    expect(chargeback.metadata).toMatchObject({ conversionEventId: conversion.id, paypalReversalId: reversed.resource.id, paypalCaptureId: paid.resource.id });
    expect((await commissionsOf(conversion.id)).map((c) => c.status)).toEqual(['reversed']);
    expect((await deliver(conn, { ...reversed, id: `WH-${ulid()}` })).body.outcome).toBe('duplicate');

    // A renewal's reversal, naming its sale only in a link.
    const subId = `I-${ulid().slice(0, 12)}`;
    await deliver(conn, subscriptionEvent('CREATED', subId, clickId));
    const renewal = sale({ subscriptionId: subId });
    await deliver(conn, renewal);
    const saleReversal = {
      id: `WH-${ulid()}`,
      event_type: 'PAYMENT.SALE.REVERSED',
      create_time: iso(),
      resource_type: 'refund',
      resource: {
        id: `SRV${ulid().slice(0, 14)}`,
        state: 'completed',
        amount: { total: '-49.00', currency: 'USD' },
        links: [{ href: `https://api.paypal.com/v1/payments/sale/${renewal.resource.id}`, rel: 'sale', method: 'GET' }],
      },
    };
    expect((await deliver(conn, saleReversal)).body.outcome).toBe('recorded');
    const [renewalEvent] = await eventsOf(renewal.resource.id);
    expect((await eventsOf(saleReversal.resource.id))[0]).toMatchObject({ type: 'chargeback', value: '-49.00' });
    expect((await commissionsOf(renewalEvent.id)).map((c) => c.status)).toEqual(['reversed']);
  });
});

describe.skipIf(skipIntegration)('catch-up', () => {
  it('records a capture the webhook missed, from the events list, once', async () => {
    const conn = await connect();
    await sinceDaysAgo(conn.id, 1);
    const { clickId } = await click(await program());
    const missed = capture({ customId: clickId, at: iso(2 * 3_600_000) });
    const delivered = capture({ customId: clickId, at: iso(3 * 3_600_000) });
    const tooNew = capture({ customId: clickId, at: iso(60_000) });
    for (const e of [missed, delivered, tooNew]) fake.addEvent(liveApp, e);
    await deliver(conn, delivered);
    // From before tracking began: never recorded.
    const before = capture({ customId: clickId, at: iso(30 * 3_600_000) });
    fake.addEvent(liveApp, before);

    const run = await runPaypalPaymentsCatchup();
    const mine = run.connections.find((c) => c.connectionId === conn.id)!;
    expect(mine).toMatchObject({ recovered: 1, transactionSearch: 'ok' });
    expect((await eventsOf(missed.resource.id))[0].metadata).toMatchObject({ recoveredBy: 'paypal_catchup' });
    expect((await eventsOf(delivered.resource.id))[0].metadata.recoveredBy).toBeUndefined();
    expect(await eventsOf(tooNew.resource.id)).toHaveLength(0);
    expect(await eventsOf(before.resource.id)).toHaveLength(0);
    expect((await runPaypalPaymentsCatchup()).connections.find((c) => c.connectionId === conn.id)!.recovered).toBe(0);
  });

  it('settles a refund that came before its payment, and a lost dispute only it heard of, after the payment', async () => {
    const conn = await connect();
    await sinceDaysAgo(conn.id, 1);
    const { clickId } = await click(await program());
    // The payment's webhook never came; its refund's did.
    const paid = capture({ customId: clickId, value: '100.00', at: iso(3 * 3_600_000) });
    const refund = captureRefund(paid.resource.id, '100.00', { at: iso(2 * 3_600_000) });
    // Another payment, lost in a dispute only the events list has.
    const disputed = capture({ customId: clickId, value: '100.00', at: iso(3 * 3_600_000) });
    const refundId = `RV${ulid().slice(0, 15)}`;
    const lost = disputeResolved({ captureIds: [disputed.resource.id], refunds: [{ id: refundId, value: '100.00' }], at: iso(2 * 3_600_000) });
    for (const e of [paid, refund, disputed, lost]) fake.addEvent(liveApp, e);
    expect((await deliver(conn, refund)).body.outcome).toBe('unresolved');
    await deliver(conn, disputed);

    await runPaypalPaymentsCatchup();
    const [conversion] = await eventsOf(paid.resource.id);
    expect((await eventsOf(refund.resource.id))[0]).toMatchObject({ type: 'refund', value: '-100.00', userId: conversion.userId });
    expect((await commissionsOf(conversion.id)).map((c) => c.status)).toEqual(['reversed']);
    const [lostConversion] = await eventsOf(disputed.resource.id);
    expect((await eventsOf(refundId))[0]).toMatchObject({ type: 'chargeback', value: '-100.00' });
    expect((await commissionsOf(lostConversion.id)).map((c) => c.status)).toEqual(['reversed']);
  });

  it('finds payments, renewals and refunds through Transaction Search where PayPal can’t post', async () => {
    process.env.PORTAL_URL = 'http://localhost:5673';
    const conn = await connect();
    expect(conn.webhookId).toBeNull();
    await sinceDaysAgo(conn.id, 1);
    const { clickId } = await click(await program(), 2);
    const subId = `I-${ulid().slice(0, 12)}`;
    fake.addSubscription(liveApp, { id: subId, plan_id: 'P-1', status: 'ACTIVE', custom_id: clickId, create_time: iso(5 * 3_600_000) });
    const capId = `CAP${ulid().slice(0, 14)}`;
    const saleId = `SALE${ulid().slice(0, 13)}`;
    const refundId = `REF${ulid().slice(0, 14)}`;
    const txn = (info: Record<string, unknown>) => fake.addTransaction(liveApp, { transaction_status: 'S', ...info });
    txn({ transaction_id: capId, transaction_event_code: 'T0006', transaction_initiation_date: iso(6 * 3_600_000), transaction_amount: { currency_code: 'USD', value: '80.00' }, custom_field: clickId, paypal_reference_id: 'ORDER1', paypal_reference_id_type: 'ODR' });
    txn({ transaction_id: saleId, transaction_event_code: 'T0002', transaction_initiation_date: iso(5 * 3_600_000), transaction_amount: { currency_code: 'USD', value: '49.00' }, paypal_reference_id: subId, paypal_reference_id_type: 'SUB' });
    txn({ transaction_id: refundId, transaction_event_code: 'T1107', transaction_initiation_date: iso(4 * 3_600_000), transaction_amount: { currency_code: 'USD', value: '-80.00' }, paypal_reference_id: capId, paypal_reference_id_type: 'TXN' });
    // PayPal took the renewal back.
    const reversalId = `REV${ulid().slice(0, 14)}`;
    txn({ transaction_id: reversalId, transaction_event_code: 'T1106', transaction_initiation_date: iso(3.5 * 3_600_000), transaction_amount: { currency_code: 'USD', value: '-49.00' }, paypal_reference_id: saleId, paypal_reference_id_type: 'TXN' });
    // A payout the brand sent, and one from before tracking: skipped.
    txn({ transaction_id: 'PAYOUT1', transaction_event_code: 'T0000', transaction_initiation_date: iso(3 * 3_600_000), transaction_amount: { currency_code: 'USD', value: '-10.00' } });
    txn({ transaction_id: 'OLD1', transaction_event_code: 'T0006', transaction_initiation_date: iso(2 * DAY), transaction_amount: { currency_code: 'USD', value: '10.00' }, custom_field: clickId });

    const run = await runPaypalPaymentsCatchup();
    expect(run.connections.find((c) => c.connectionId === conn.id)).toMatchObject({ recovered: 4, transactionSearch: 'ok' });
    const [cap] = await eventsOf(capId);
    expect(cap).toMatchObject({ type: 'invoice_paid', value: '80.00', userId: `click:${clickId}` });
    expect((await commissionsOf(cap.id)).map((c) => c.status)).toEqual(['reversed']);
    const [renewal] = await eventsOf(saleId);
    expect(renewal.metadata).toMatchObject({ paypalSubscriptionId: subId, recoveredBy: 'paypal_catchup' });
    expect((await eventsOf(reversalId))[0]).toMatchObject({ type: 'chargeback', value: '-49.00' });
    expect((await commissionsOf(renewal.id)).map((c) => c.status)).toEqual(['reversed']);
    expect(await eventsOf('OLD1')).toHaveLength(0);
    expect((await db(TABLES.PaypalConnection).where({ id: conn.id }).first()).transactionSearch).toBe('ok');
  });

  it('leaves Transaction Search alone until tracking is older than PayPal’s lag, then searches from when it began', async () => {
    const conn = await connect();
    await db(TABLES.PaypalConnection).where({ id: conn.id }).update({ paymentsSince: new Date(Date.now() - 3_600_000) });
    const searches = () => fake.seen.filter((r) => r.path === '/v1/reporting/transactions').length;
    const n = searches();
    const early = (await runPaypalPaymentsCatchup()).connections.find((c) => c.connectionId === conn.id)!;
    expect(early).toMatchObject({ transactionSearch: 'skipped', truncated: false });
    expect(early.error).toBeUndefined();
    expect(searches()).toBe(n);
    expect((await db(TABLES.PaypalConnection).where({ id: conn.id }).first()).transactionSearch).toBeNull();

    // A payment made just after tracking began, found once the window is old enough.
    const { clickId } = await click(await program());
    const capId = `CAP${ulid().slice(0, 14)}`;
    const began = new Date(Date.now() - (SEARCH_LAG_HOURS + 1) * 3_600_000);
    await db(TABLES.PaypalConnection).where({ id: conn.id }).update({ paymentsSince: began });
    fake.addTransaction(liveApp, {
      transaction_id: capId,
      transaction_event_code: 'T0006',
      transaction_status: 'S',
      transaction_initiation_date: new Date(began.getTime() + 60_000).toISOString(),
      transaction_amount: { currency_code: 'USD', value: '25.00' },
      custom_field: clickId,
    });
    const later = (await runPaypalPaymentsCatchup()).connections.find((c) => c.connectionId === conn.id)!;
    expect(later).toMatchObject({ transactionSearch: 'ok', recovered: 1 });
    expect(later.error).toBeUndefined();
    expect(await eventsOf(capId)).toHaveLength(1);
  });

  it('marks an app without Transaction Search unavailable, and asks again a day later', async () => {
    const conn = await connect();
    await sinceDaysAgo(conn.id, 1);
    fake.noSearch.add(liveApp.appId);
    const first = await runPaypalPaymentsCatchup();
    expect(first.connections.find((c) => c.connectionId === conn.id)!.transactionSearch).toBe('unavailable');
    expect((await admin.get('/config/paypal-payments')).body.apps[0].transactionSearch).toBe('unavailable');
    const searches = () => fake.seen.filter((r) => r.path === '/v1/reporting/transactions').length;
    const n = searches();
    await runPaypalPaymentsCatchup();
    expect(searches()).toBe(n);
    fake.noSearch.clear();
    await runPaypalPaymentsCatchup({ now: new Date(Date.now() + SEARCH_RECHECK_HOURS * 3_600_000 + 60_000) });
    expect((await db(TABLES.PaypalConnection).where({ id: conn.id }).first()).transactionSearch).toBe('ok');
  });

  const webhookOf = async (connectionId: string) =>
    (await runPaypalPaymentsCatchup()).connections.find((c) => c.connectionId === connectionId)!.webhook;
  const patches = () => fake.seen.filter((r) => r.method === 'PATCH').length;

  it('gives an app set up before an event was added that event, in place, and registers a webhook removed since', async () => {
    const conn = await connect();
    const url = `https://portal.brand.example/api/webhooks/paypal/${conn.id}`;
    const hook = fake.webhookAt(url)!;
    const full = [...PAYPAL_WEBHOOK_EVENTS, ...PAYPAL_PAYMENT_EVENTS];
    // As an app recording before CUSTOMER.DISPUTE.RESOLVED was read.
    hook.eventTypes = full.filter((t) => t !== 'CUSTOMER.DISPUTE.RESOLVED');

    expect(await webhookOf(conn.id)).toBe('updated');
    expect(fake.webhookAt(url)).toMatchObject({ id: hook.id, eventTypes: full });
    const n = patches();
    expect(await webhookOf(conn.id)).toBe('current');
    expect(patches()).toBe(n);

    // Changed in PayPal's dashboard: put back to what OpenPartner reads.
    hook.eventTypes = [...full.filter((t) => t !== 'PAYMENT.CAPTURE.COMPLETED'), 'CHECKOUT.ORDER.APPROVED'];
    expect(await webhookOf(conn.id)).toBe('updated');
    expect(fake.webhookAt(url)!.eventTypes).toEqual(full);

    // Removed there: registered again, and the new one is kept.
    fake.webhooks.delete(hook.id);
    expect(await webhookOf(conn.id)).toBe('registered');
    expect(fake.webhookAt(url)!.id).not.toBe(hook.id);
    expect(fake.webhookAt(url)!.eventTypes).toEqual(full);
    expect((await admin.get('/config/paypal-payments')).body.apps[0].webhook).toEqual({ registered: true, error: null });
    expect(await webhookOf(conn.id)).toBe('current');

    // A checkout app's webhook, the same way.
    const checkout = await admin.post('/config/paypal-payments', { environment: 'live', clientId: CHECKOUT_ID, clientSecret: CHECKOUT_SECRET });
    const checkoutHook = fake.webhookAt(`https://portal.brand.example/api/webhooks/paypal/${checkout.body.app.id}`)!;
    checkoutHook.eventTypes = PAYPAL_PAYMENT_EVENTS.filter((t) => t !== 'CUSTOMER.DISPUTE.RESOLVED');
    expect(await webhookOf(checkout.body.app.id)).toBe('updated');
    expect(checkoutHook.eventTypes).toEqual([...PAYPAL_PAYMENT_EVENTS]);
  });

  it('asks once a run for dispute events PayPal refused, and adds them when it takes them', async () => {
    fake.noDisputes.add(liveApp.appId);
    const conn = await connect();
    const url = `https://portal.brand.example/api/webhooks/paypal/${conn.id}`;
    const without = [...fake.webhookAt(url)!.eventTypes];
    expect(without).not.toContain('CUSTOMER.DISPUTE.CREATED');

    const n = patches();
    expect(await webhookOf(conn.id)).toBe('current');
    // One refused ask; what's there isn't written again.
    expect(patches()).toBe(n + 1);
    expect(fake.webhookAt(url)!.eventTypes).toEqual(without);
    expect((await admin.get('/config/paypal-payments')).body.apps[0].webhook.error).toContain('within the hour');

    // The brand turns Customer disputes on in PayPal.
    fake.noDisputes.delete(liveApp.appId);
    expect(await webhookOf(conn.id)).toBe('updated');
    expect(fake.webhookAt(url)!.eventTypes).toEqual([...PAYPAL_WEBHOOK_EVENTS, ...PAYPAL_PAYMENT_EVENTS]);
    expect((await admin.get('/config/paypal-payments')).body.apps[0].webhook.error).toBeNull();
  });
});

describe.skipIf(skipIntegration)('Tracking health', () => {
  it('counts PayPal payments by what became of them', async () => {
    const conn = await connect();
    await sinceDaysAgo(conn.id, 1);
    const { clickId } = await click(await program());
    await deliver(conn, capture({ customId: clickId }));
    await deliver(conn, capture({ customId: null }));
    await deliver(conn, capture({ customId: 'order-77' }));
    fake.addEvent(liveApp, capture({ customId: clickId, at: iso(2 * 3_600_000) }));
    await runPaypalPaymentsCatchup();

    const res = await admin.get('/admin/tracking-health?days=7');
    expect(res.status).toBe(200);
    expect(res.body.paypal).toEqual({ payments: 4, withClick: 2, withoutReference: 1, unknownReference: 1, recovered: 1 });
    expect(res.body.signals.lastPaypalEventAt).not.toBeNull();
  });

  it('is null for a brand that never tracked PayPal payments', async () => {
    const res = await admin.get('/admin/tracking-health?days=7');
    expect(res.body.paypal).toBeNull();
  });
});
