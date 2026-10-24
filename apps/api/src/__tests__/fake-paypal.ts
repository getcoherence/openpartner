/**
 * An in-memory PayPal for the Pay with PayPal tests, behind
 * __setPaypalFetchForTests. It keeps the rules the rail relies on:
 *
 *   - OAuth client credentials per app and environment;
 *   - Payouts: a repeated PayPal-Request-Id answers with what the first
 *     request created; a sender_batch_id already used by the account is
 *     refused with USER_BUSINESS_ERROR and a link to the original batch;
 *   - batch reads paged by page/page_size, items by sender_item_id;
 *   - cancel only for UNCLAIMED items;
 *   - webhooks registered per app, and verify-webhook-signature checking
 *     a signature over the EXACT bytes of the event and the webhook id.
 *
 * Faults are queued per operation: `network_before` (nothing created, no
 * answer), `network_after` (created, no answer), `500_before`,
 * `500_after`, or a definite PayPal error.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { PaypalFetch, PaypalHttpResponse } from '../paypal-api.js';

type Env = 'live' | 'sandbox';
export type Fault =
  | 'network_before'
  | 'network_after'
  | '500_before'
  | '500_after'
  /** Created, then a 2xx whose body isn't JSON. */
  | 'garbled_after'
  | { status: number; name: string; message?: string };

interface App {
  env: Env;
  clientId: string;
  secret: string;
  appId: string;
  payouts: boolean;
}

export interface FakeItem {
  payout_item_id: string;
  transaction_id?: string;
  transaction_status: string;
  sender_item_id: string;
  amount: { value: string; currency: string };
  receiver: string;
  errors?: { name: string; message: string };
}

export interface FakeBatch {
  payout_batch_id: string;
  sender_batch_id: string;
  batch_status: string;
  account: string;
  items: FakeItem[];
  request: unknown;
}

function res(status: number, body: unknown): PaypalHttpResponse {
  return { status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
}

function id(prefix: string): string {
  return `${prefix}${randomBytes(6).toString('hex').toUpperCase()}`;
}

export class FakePaypal {
  readonly apps: App[] = [];
  readonly tokens = new Map<string, App>();
  readonly batches = new Map<string, FakeBatch>();
  private readonly bySender = new Map<string, string>();
  private readonly requestIds = new Map<string, { status: number; body: unknown }>();
  readonly webhooks = new Map<string, { id: string; url: string; account: string }>();
  readonly faults: { create: Fault[]; token: Fault[]; get: Fault[] } = { create: [], token: [], get: [] };
  /** Every POST /v1/payments/payouts that reached PayPal. */
  createCalls = 0;
  /** Batches actually created. */
  created = 0;
  verifyCalls = 0;
  /** Every request's Authorization and PayPal-Request-Id headers. */
  readonly seen: Array<{ method: string; path: string; authorization: string; requestId: string | null; body: string | undefined }> = [];
  private readonly signingKey = randomBytes(32);

  addApp(app: Partial<App> & Pick<App, 'clientId' | 'secret'>): App {
    const full: App = { env: 'sandbox', appId: id('APP-'), payouts: true, ...app };
    this.apps.push(full);
    return full;
  }

  /** PayPal forgets request ids (past their 30 days, say); sender_batch_id
   *  dedupe still holds. */
  forgetRequestIds(): void {
    this.requestIds.clear();
  }

  batchBySender(senderBatchId: string): FakeBatch | undefined {
    for (const b of this.batches.values()) if (b.sender_batch_id === senderBatchId) return b;
    return undefined;
  }

  setItem(senderBatchId: string, senderItemId: string, status: string, error?: string): void {
    const b = this.batchBySender(senderBatchId)!;
    const it = b.items.find((i) => i.sender_item_id === senderItemId)!;
    it.transaction_status = status;
    if (status === 'SUCCESS') it.transaction_id ??= id('TX');
    if (error) it.errors = { name: error, message: error.toLowerCase() };
  }

  setBatchStatus(senderBatchId: string, status: string): void {
    this.batchBySender(senderBatchId)!.batch_status = status;
  }

  /** A delivery as PayPal would send it to `webhookId`. */
  signDelivery(webhookId: string, rawBody: string, opts: { certUrl?: string } = {}): { headers: Record<string, string>; body: string } {
    const transmissionId = randomBytes(8).toString('hex');
    const time = new Date().toISOString();
    return {
      headers: {
        'content-type': 'application/json',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': opts.certUrl ?? 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270',
        'paypal-transmission-id': transmissionId,
        'paypal-transmission-time': time,
        'paypal-transmission-sig': this.sign(transmissionId, time, webhookId, rawBody),
      },
      body: rawBody,
    };
  }

  private sign(transmissionId: string, time: string, webhookId: string, raw: string): string {
    const digest = createHash('sha256').update(raw).digest('hex');
    return createHmac('sha256', this.signingKey).update(`${transmissionId}|${time}|${webhookId}|${digest}`).digest('base64');
  }

  private auth(env: Env, header: string | undefined): App | null {
    if (!header?.startsWith('Bearer ')) return null;
    const app = this.tokens.get(header.slice(7));
    return app && app.env === env ? app : null;
  }

  private fault(kind: keyof FakePaypal['faults'], when: 'before' | 'after'): PaypalHttpResponse | 'throw' | null {
    const next = this.faults[kind][0];
    if (!next) return null;
    if (typeof next === 'string' && !next.endsWith(when)) return null;
    if (typeof next !== 'string' && when === 'after') return null;
    this.faults[kind].shift();
    if (next === 'garbled_after') return { status: 201, text: async () => '<html>upstream reset</html>' };
    if (next === 'network_before' || next === 'network_after') return 'throw';
    if (next === '500_before' || next === '500_after') return res(500, { name: 'INTERNAL_SERVER_ERROR', message: 'An internal server error occurred.', debug_id: 'dbg500' });
    return res(next.status, { name: next.name, message: next.message ?? next.name, debug_id: 'dbg4xx' });
  }

  readonly fetch: PaypalFetch = async (url, init) => {
    const u = new URL(url);
    const env: Env = u.hostname === 'api-m.sandbox.paypal.com' ? 'sandbox' : 'live';
    const path = u.pathname;
    const headers = init.headers;
    this.seen.push({ method: init.method, path, authorization: headers.Authorization ?? '', requestId: headers['PayPal-Request-Id'] ?? null, body: init.body });

    if (init.method === 'POST' && path === '/v1/oauth2/token') {
      const f = this.fault('token', 'before');
      if (f === 'throw') throw new Error('ECONNRESET');
      if (f) return f;
      const basic = Buffer.from((headers.Authorization ?? '').replace(/^Basic /, ''), 'base64').toString('utf8');
      const [clientId, secret] = [basic.slice(0, basic.indexOf(':')), basic.slice(basic.indexOf(':') + 1)];
      const app = this.apps.find((a) => a.env === env && a.clientId === clientId && a.secret === secret);
      if (!app) return res(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
      const token = `A21AA${randomBytes(16).toString('hex')}`;
      this.tokens.set(token, app);
      const scope = ['https://uri.paypal.com/services/invoicing', ...(app.payouts ? ['https://uri.paypal.com/services/payments/payouts'] : [])].join(' ');
      return res(200, { scope, access_token: token, token_type: 'Bearer', app_id: app.appId, expires_in: 32400 });
    }

    const app = this.auth(env, headers.Authorization);
    if (!app) return res(401, { name: 'AUTHENTICATION_FAILURE', message: 'Authentication failed due to invalid authentication credentials or a missing Authorization header.' });
    const account = `${env}:${app.appId}`;

    if (init.method === 'POST' && path === '/v1/payments/payouts') {
      this.createCalls += 1;
      const rid = headers['PayPal-Request-Id'];
      const replay = rid ? this.requestIds.get(`${account}:${rid}`) : undefined;
      if (replay) return res(replay.status, replay.body);
      const before = this.fault('create', 'before');
      if (before === 'throw') throw new Error('socket hang up');
      if (before) return before;
      const body = JSON.parse(init.body ?? '{}') as {
        sender_batch_header: { sender_batch_id: string };
        items: Array<{ receiver: string; amount: { value: string; currency: string }; sender_item_id: string }>;
      };
      const sender = body.sender_batch_header.sender_batch_id;
      const existing = this.bySender.get(`${account}:${sender}`);
      if (existing) {
        return res(400, {
          name: 'USER_BUSINESS_ERROR',
          message: 'User business error.',
          debug_id: 'dbgdup',
          details: [
            {
              field: 'SENDER_BATCH_ID',
              location: 'body',
              issue: 'Batch with given sender_batch_id already exists',
              link: [{ href: `https://api.sandbox.paypal.com/v1/payments/payouts/${existing}`, rel: 'self', method: 'GET' }],
            },
          ],
        });
      }
      const batch: FakeBatch = {
        payout_batch_id: id('PB'),
        sender_batch_id: sender,
        batch_status: 'PENDING',
        account,
        request: body,
        items: body.items.map((i) => ({
          payout_item_id: id('PI'),
          transaction_status: 'PENDING',
          sender_item_id: i.sender_item_id,
          amount: i.amount,
          receiver: i.receiver,
        })),
      };
      this.batches.set(batch.payout_batch_id, batch);
      this.bySender.set(`${account}:${sender}`, batch.payout_batch_id);
      this.created += 1;
      const answer = {
        batch_header: { payout_batch_id: batch.payout_batch_id, batch_status: 'PENDING', sender_batch_header: { sender_batch_id: sender } },
        links: [{ href: `https://api.sandbox.paypal.com/v1/payments/payouts/${batch.payout_batch_id}`, rel: 'self', method: 'GET' }],
      };
      if (rid) this.requestIds.set(`${account}:${rid}`, { status: 201, body: answer });
      const after = this.fault('create', 'after');
      if (after === 'throw') throw new Error('ETIMEDOUT');
      if (after) return after;
      return res(201, answer);
    }

    const batchPath = /^\/v1\/payments\/payouts\/([A-Za-z0-9]+)$/.exec(path);
    if (init.method === 'GET' && batchPath) {
      const f = this.fault('get', 'before');
      if (f === 'throw') throw new Error('ECONNRESET');
      if (f) return f;
      const b = this.batches.get(batchPath[1]!);
      if (!b || b.account !== account) return res(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.' });
      const page = Number(u.searchParams.get('page') ?? '1');
      const size = Number(u.searchParams.get('page_size') ?? '1000');
      const items = b.items.slice((page - 1) * size, page * size).map((i) => ({
        payout_item_id: i.payout_item_id,
        transaction_id: i.transaction_id,
        transaction_status: i.transaction_status,
        payout_batch_id: b.payout_batch_id,
        payout_item: { sender_item_id: i.sender_item_id, amount: i.amount, receiver: i.receiver, recipient_type: 'EMAIL' },
        time_processed: '2026-10-22T10:00:00Z',
        ...(i.errors ? { errors: i.errors } : {}),
      }));
      return res(200, {
        batch_header: { payout_batch_id: b.payout_batch_id, batch_status: b.batch_status, sender_batch_header: { sender_batch_id: b.sender_batch_id } },
        items,
        total_items: b.items.length,
        total_pages: Math.max(1, Math.ceil(b.items.length / size)),
      });
    }

    const cancelPath = /^\/v1\/payments\/payouts-item\/([A-Za-z0-9]+)\/cancel$/.exec(path);
    if (init.method === 'POST' && cancelPath) {
      for (const b of this.batches.values()) {
        if (b.account !== account) continue;
        const it = b.items.find((i) => i.payout_item_id === cancelPath[1]);
        if (!it) continue;
        if (it.transaction_status === 'RETURNED') return res(400, { name: 'ITEM_ALREADY_CANCELLED', message: 'already cancelled' });
        if (it.transaction_status !== 'UNCLAIMED') return res(400, { name: 'ITEM_INCORRECT_STATUS', message: 'You can only cancel items that are unclaimed.' });
        it.transaction_status = 'RETURNED';
        return res(200, {
          payout_item_id: it.payout_item_id,
          transaction_status: 'RETURNED',
          payout_batch_id: b.payout_batch_id,
          payout_item: { sender_item_id: it.sender_item_id, amount: it.amount, receiver: it.receiver },
        });
      }
      return res(404, { name: 'RESOURCE_NOT_FOUND', message: 'not found' });
    }

    if (path === '/v1/notifications/webhooks' && init.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as { url: string };
      for (const w of this.webhooks.values()) {
        if (w.account === account && w.url === body.url) return res(400, { name: 'WEBHOOK_URL_ALREADY_EXISTS', message: 'Webhook URL already exists' });
      }
      const w = { id: id('WH-'), url: body.url, account };
      this.webhooks.set(w.id, w);
      return res(201, { id: w.id, url: w.url, event_types: [] });
    }
    if (path === '/v1/notifications/webhooks' && init.method === 'GET') {
      return res(200, { webhooks: [...this.webhooks.values()].filter((w) => w.account === account).map((w) => ({ id: w.id, url: w.url })) });
    }
    const hookPath = /^\/v1\/notifications\/webhooks\/([A-Za-z0-9-]+)$/.exec(path);
    if (hookPath && init.method === 'DELETE') {
      const w = this.webhooks.get(hookPath[1]!);
      if (!w || w.account !== account) return res(404, { name: 'INVALID_RESOURCE_ID', message: 'not found' });
      this.webhooks.delete(w.id);
      return res(204, undefined);
    }

    if (path === '/v1/notifications/verify-webhook-signature' && init.method === 'POST') {
      this.verifyCalls += 1;
      const text = init.body ?? '';
      const marker = '"webhook_event":';
      const at = text.indexOf(marker);
      const outer = JSON.parse(`${text.slice(0, at).replace(/,$/, '')}}`) as Record<string, string>;
      const raw = text.slice(at + marker.length, -1);
      const hook = this.webhooks.get(outer.webhook_id!);
      const ok =
        !!hook &&
        hook.account === account &&
        outer.transmission_sig === this.sign(outer.transmission_id!, outer.transmission_time!, outer.webhook_id!, raw);
      return res(200, { verification_status: ok ? 'SUCCESS' : 'FAILURE' });
    }

    return res(404, { name: 'NOT_FOUND', message: `${init.method} ${path}` });
  };
}
