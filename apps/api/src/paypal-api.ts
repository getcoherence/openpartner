/**
 * PayPal REST client for Pay with PayPal (docs/paypal-payouts.md): OAuth
 * tokens, the Payouts API, and webhook management and verification, all
 * with a BRAND's own app credentials. OpenPartner has no PayPal account in
 * this flow.
 *
 * Checked against PayPal's Payouts v1 OpenAPI document
 * (developer.paypal.com/api/payments.payouts-batch/v1/schema.yaml) and the
 * webhook event names page, 2026-10-22.
 *
 * Secrets: the client secret only ever goes in the Basic header of the
 * token call, and the bearer token only in the Authorization header.
 * Nothing here logs, and no error carries a header, a request body or a
 * response body: a PaypalApiError says PayPal's error `name`, its
 * `message` and `debug_id`, which name fields but never echo credentials.
 *
 * Tests swap the transport with __setPaypalFetchForTests (a fake PayPal,
 * __tests__/fake-paypal.ts). Hosts are fixed per environment, so no URL
 * here comes from a brand or a partner.
 */

import type { PaypalEnvironment } from '@openpartner/db';

export const PAYPAL_API_BASE: Record<PaypalEnvironment, string> = {
  live: 'https://api-m.paypal.com',
  sandbox: 'https://api-m.sandbox.paypal.com',
};

/** The Payouts webhook events (developer.paypal.com/api/rest/webhooks/
 *  event-names, "Payouts"). Batch events carry no item data, so every
 *  event only prompts a fresh read of the batch. */
export const PAYPAL_WEBHOOK_EVENTS = [
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTSBATCH.PROCESSING',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.HELD',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
] as const;

/** The payment events a connection tracking payments subscribes to
 *  (docs/paypal-payments.md, paypal-payments.ts): checkout captures,
 *  subscription payments (the v1 sale events PayPal still sends for
 *  them), refunds, reversals (PayPal taking a payment back, for example a
 *  card chargeback), new subscriptions, and disputes opened and resolved. */
export const PAYPAL_PAYMENT_EVENTS = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.SALE.COMPLETED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
  'BILLING.SUBSCRIPTION.CREATED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.RESOLVED',
] as const;

/** Wall-clock limit on one call. A POST that times out may still have
 *  landed: the caller treats it as an unknown outcome, never a failure. */
const TIMEOUT_MS = 30_000;

export interface PaypalHttpResponse {
  status: number;
  text(): Promise<string>;
}
export type PaypalFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<PaypalHttpResponse>;

let fetchOverride: PaypalFetch | null = null;

/** Tests: route every PayPal call to a fake. Null restores real fetch. */
export function __setPaypalFetchForTests(f: PaypalFetch | null): void {
  fetchOverride = f;
}

/**
 * A PayPal call that didn't succeed.
 *
 *   - `kind: 'network'`: no response (timeout, reset, DNS). For a POST the
 *     outcome is UNKNOWN.
 *   - `kind: 'http'`: PayPal answered `status`. A 5xx, 429 or 409 is
 *     transient; other 4xx are PayPal refusing this request.
 */
export class PaypalApiError extends Error {
  constructor(
    readonly kind: 'http' | 'network',
    readonly status: number | null,
    /** PayPal's error name (`VALIDATION_ERROR`, `INSUFFICIENT_FUNDS`…). */
    readonly errorName: string | null,
    message: string,
    readonly debugId: string | null,
    /** The parsed error body, for callers that read `details` or `links`.
     *  Never logged. */
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'PaypalApiError';
  }

  /** PayPal didn't process the request and a retry may succeed. */
  get transient(): boolean {
    return this.kind === 'network' || this.status === null || this.status >= 500 || this.status === 429 || this.status === 409;
  }

  /** A one-line summary safe to store and show: name, message, the first
   *  detail's field and issue (never its value), debug id. */
  get summary(): string {
    const detail = (this.body as { details?: Array<{ field?: unknown; issue?: unknown }> } | null)?.details?.[0];
    const issue = typeof detail?.issue === 'string' ? detail.issue.slice(0, 120) : null;
    const field = typeof detail?.field === 'string' ? detail.field.slice(0, 80) : null;
    const issueText = issue ? (field ? `${field}: ${issue}` : issue) : null;
    return [this.errorName, this.message, issueText, this.debugId ? `debug_id ${this.debugId}` : null].filter(Boolean).join(' · ');
  }
}

interface CallOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  auth: { bearer: string } | { basic: { clientId: string; clientSecret: string } };
  /** A JSON body, already serialised (so a retry sends identical bytes). */
  json?: string;
  form?: string;
  requestId?: string;
}

async function call<T>(env: PaypalEnvironment, opts: CallOptions): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  headers.Authorization =
    'bearer' in opts.auth
      ? `Bearer ${opts.auth.bearer}`
      : `Basic ${Buffer.from(`${opts.auth.basic.clientId}:${opts.auth.basic.clientSecret}`).toString('base64')}`;
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.form !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: PaypalHttpResponse;
  let text: string;
  try {
    const doFetch: PaypalFetch = fetchOverride ?? ((url, init) => fetch(url, init));
    res = await doFetch(`${PAYPAL_API_BASE[env]}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.json ?? opts.form,
      signal: ac.signal,
    });
    text = await res.text();
  } catch (err) {
    // The underlying error can quote the URL; nothing else. Keep only
    // whether it was our timeout.
    const timedOut = ac.signal.aborted || (err as { name?: string })?.name === 'AbortError';
    throw new PaypalApiError('network', null, null, timedOut ? 'PayPal did not answer in time' : 'Could not reach PayPal', null, null);
  } finally {
    clearTimeout(timer);
  }

  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (res.status >= 200 && res.status < 300) return { status: res.status, data: data as T };

  const e = (data ?? {}) as { name?: unknown; message?: unknown; debug_id?: unknown; error?: unknown; error_description?: unknown };
  // The token endpoint answers OAuth-style ({ error, error_description }).
  const name = typeof e.name === 'string' ? e.name : typeof e.error === 'string' ? e.error : null;
  const message =
    typeof e.message === 'string' ? e.message : typeof e.error_description === 'string' ? e.error_description : `PayPal answered ${res.status}`;
  throw new PaypalApiError('http', res.status, name, message.slice(0, 300), typeof e.debug_id === 'string' ? e.debug_id : null, data);
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export interface PaypalToken {
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  appId: string | null;
  scope: string;
}

/** Client-credentials token. A 401 means the id or secret is wrong (or the
 *  app was deleted), for the environment asked. */
export async function fetchAccessToken(env: PaypalEnvironment, clientId: string, clientSecret: string): Promise<PaypalToken> {
  const { data } = await call<{ access_token?: string; expires_in?: number; app_id?: string; scope?: string }>(env, {
    method: 'POST',
    path: '/v1/oauth2/token',
    auth: { basic: { clientId, clientSecret } },
    form: 'grant_type=client_credentials',
  });
  if (!data?.access_token) throw new PaypalApiError('http', 200, null, 'PayPal returned no access token', null, null);
  return {
    accessToken: data.access_token,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600,
    appId: typeof data.app_id === 'string' ? data.app_id : null,
    scope: typeof data.scope === 'string' ? data.scope : '',
  };
}

/** Whether a token's scopes include Payouts. PayPal lists scopes as URIs
 *  (…/services/payments/payouts); an app without Payouts enabled lacks it. */
export function hasPayoutsScope(scope: string): boolean {
  return scope.split(/\s+/).some((s) => /\/payouts$/.test(s));
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

export interface PaypalPayoutItemRequest {
  recipient_type: 'EMAIL';
  receiver: string;
  amount: { value: string; currency: string };
  sender_item_id: string;
  note: string;
  recipient_wallet: 'PAYPAL';
  purpose: 'SERVICES';
}

export interface PaypalCreateBatchRequest {
  sender_batch_header: { sender_batch_id: string; email_subject: string; email_message: string };
  items: PaypalPayoutItemRequest[];
}

export interface PaypalBatchHeader {
  payout_batch_id: string;
  batch_status: string;
  sender_batch_header?: { sender_batch_id?: string };
  time_completed?: string;
}

export interface PaypalBatchItem {
  payout_item_id: string;
  transaction_id?: string;
  transaction_status?: string;
  payout_batch_id: string;
  payout_item: { sender_item_id?: string; amount?: { value?: string; currency?: string }; receiver?: string };
  time_processed?: string;
  errors?: { name?: string; message?: string };
}

export interface PaypalBatch {
  batch_header: PaypalBatchHeader;
  items?: PaypalBatchItem[];
  total_items?: number;
  total_pages?: number;
}

/** POST /v1/payments/payouts. `body` is the frozen request, serialised
 *  once; `requestId` makes PayPal answer a retry with the batch the first
 *  attempt created (its key store keeps it 30 days). */
export async function createPayoutBatch(env: PaypalEnvironment, token: string, requestId: string, body: string): Promise<PaypalBatch> {
  const { data } = await call<PaypalBatch>(env, { method: 'POST', path: '/v1/payments/payouts', auth: { bearer: token }, json: body, requestId });
  if (!data?.batch_header?.payout_batch_id) {
    // PayPal said yes, but the answer can't be read (truncated, not JSON,
    // no id). The batch may well exist: an UNKNOWN outcome, never a
    // refusal, so the caller re-sends with the same ids instead of
    // releasing the payouts.
    throw new PaypalApiError('network', null, null, 'PayPal accepted the batch but its answer couldn’t be read', null, null);
  }
  return data;
}

/** One page of a batch, PayPal's largest (1,000 items). */
export async function getPayoutBatch(env: PaypalEnvironment, token: string, payoutBatchId: string, page = 1): Promise<PaypalBatch> {
  const q = `page=${page}&page_size=1000&total_required=true`;
  const { data } = await call<PaypalBatch>(env, {
    method: 'GET',
    path: `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}?${q}`,
    auth: { bearer: token },
  });
  return data;
}

/** Every item of a batch, all pages (a batch here holds at most 5,000). */
export async function getWholePayoutBatch(env: PaypalEnvironment, token: string, payoutBatchId: string): Promise<PaypalBatch> {
  const first = await getPayoutBatch(env, token, payoutBatchId, 1);
  const items = [...(first.items ?? [])];
  const pages = Math.min(first.total_pages ?? 1, 15);
  for (let page = 2; page <= pages; page += 1) {
    items.push(...((await getPayoutBatch(env, token, payoutBatchId, page)).items ?? []));
  }
  return { ...first, items };
}

/** Cancel an UNCLAIMED item: PayPal returns the money to the sender and
 *  the item becomes RETURNED. */
export async function cancelPayoutItem(env: PaypalEnvironment, token: string, payoutItemId: string): Promise<PaypalBatchItem> {
  const { data } = await call<PaypalBatchItem>(env, {
    method: 'POST',
    path: `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}/cancel`,
    auth: { bearer: token },
    json: '{}',
  });
  return data;
}

/**
 * The batch an error says already uses our sender_batch_id, if it says
 * one. PayPal "rejects the request with an error message that shows the
 * duplicate sender_batch_id and includes a HATEOAS link to the original
 * payout". The caller GETs the linked batch and checks its
 * sender_batch_id before trusting it.
 */
export function duplicateBatchLink(err: PaypalApiError): string | null {
  if (err.kind !== 'http' || err.status === null || err.status >= 500) return null;
  const hrefs: string[] = [];
  const collect = (links: unknown) => {
    if (!Array.isArray(links)) return;
    for (const l of links) if (l && typeof (l as { href?: unknown }).href === 'string') hrefs.push((l as { href: string }).href);
  };
  const body = (err.body ?? {}) as { links?: unknown; details?: unknown };
  collect(body.links);
  if (Array.isArray(body.details)) for (const d of body.details) collect((d as { link?: unknown; links?: unknown })?.link ?? (d as { links?: unknown })?.links);
  for (const href of hrefs) {
    const m = /\/v1\/payments\/payouts\/([A-Za-z0-9]{1,64})(?:[/?#]|$)/.exec(href);
    if (m) return m[1]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export async function createWebhook(
  env: PaypalEnvironment,
  token: string,
  url: string,
  eventTypes: readonly string[] = PAYPAL_WEBHOOK_EVENTS,
): Promise<string> {
  const { data } = await call<{ id?: string }>(env, {
    method: 'POST',
    path: '/v1/notifications/webhooks',
    auth: { bearer: token },
    json: JSON.stringify({ url, event_types: eventTypes.map((name) => ({ name })) }),
  });
  if (!data?.id) throw new PaypalApiError('http', 201, null, 'PayPal created the webhook but returned no id', null, null);
  return data.id;
}

/** Replace the events a webhook receives (PATCH, a JSON Patch `replace`
 *  of /event_types). */
export async function setWebhookEventTypes(env: PaypalEnvironment, token: string, webhookId: string, eventTypes: readonly string[]): Promise<void> {
  await call(env, {
    method: 'PATCH',
    path: `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`,
    auth: { bearer: token },
    json: JSON.stringify([{ op: 'replace', path: '/event_types', value: eventTypes.map((name) => ({ name })) }]),
  });
}

/** The events a webhook receives, as PayPal holds them; null when PayPal
 *  has no such webhook (removed in its dashboard). */
export async function getWebhookEventTypes(env: PaypalEnvironment, token: string, webhookId: string): Promise<string[] | null> {
  try {
    const { data } = await call<{ event_types?: Array<{ name?: unknown }> }>(env, {
      method: 'GET',
      path: `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`,
      auth: { bearer: token },
    });
    return (data?.event_types ?? []).map((e) => e?.name).filter((n): n is string => typeof n === 'string');
  } catch (err) {
    if (err instanceof PaypalApiError && err.kind === 'http' && err.status === 404) return null;
    throw err;
  }
}

export async function listWebhooks(env: PaypalEnvironment, token: string): Promise<Array<{ id: string; url: string }>> {
  const { data } = await call<{ webhooks?: Array<{ id?: string; url?: string }> }>(env, {
    method: 'GET',
    path: '/v1/notifications/webhooks',
    auth: { bearer: token },
  });
  return (data?.webhooks ?? []).filter((w): w is { id: string; url: string } => typeof w.id === 'string' && typeof w.url === 'string');
}

export async function deleteWebhook(env: PaypalEnvironment, token: string, webhookId: string): Promise<void> {
  await call(env, { method: 'DELETE', path: `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`, auth: { bearer: token } });
}

/** The PAYPAL-* headers a delivery's signature needs. */
export interface PaypalSignatureHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

/**
 * Ask PayPal whether a delivery is genuine and meant for `webhookId`
 * (POST /v1/notifications/verify-webhook-signature). PayPal checks the
 * certificate itself, so this never fetches the delivery's cert_url.
 *
 * `rawBody` goes in as the exact bytes received: re-serialising the
 * parsed event can reorder or re-escape it and fail a genuine signature.
 * The caller has already checked it parses as a JSON object.
 */
export async function verifyWebhookSignature(
  env: PaypalEnvironment,
  token: string,
  webhookId: string,
  headers: PaypalSignatureHeaders,
  rawBody: string,
): Promise<boolean> {
  const head = JSON.stringify({
    auth_algo: headers.authAlgo,
    cert_url: headers.certUrl,
    transmission_id: headers.transmissionId,
    transmission_sig: headers.transmissionSig,
    transmission_time: headers.transmissionTime,
    webhook_id: webhookId,
  });
  const body = `${head.slice(0, -1)},"webhook_event":${rawBody}}`;
  const { data } = await call<{ verification_status?: string }>(env, {
    method: 'POST',
    path: '/v1/notifications/verify-webhook-signature',
    auth: { bearer: token },
    json: body,
  });
  return data?.verification_status === 'SUCCESS';
}

// ---------------------------------------------------------------------------
// Payments (docs/paypal-payments.md): what the brand's checkout took
// ---------------------------------------------------------------------------

/** PayPal's timestamps, to the second (Transaction Search refuses
 *  fractions). */
export function paypalTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A webhook event as PayPal sends it, and as the events list returns it. */
export interface PaypalWebhookEvent {
  id?: unknown;
  event_type?: unknown;
  create_time?: unknown;
  resource?: Record<string, unknown>;
}

/** One page of the webhook events PayPal generated for this app
 *  (GET /v1/notifications/webhooks-events). `next` is the query of
 *  PayPal's next-page link, sent again to the same path on the same fixed
 *  host: nothing here follows a URL from a response. */
export async function listWebhookEvents(
  env: PaypalEnvironment,
  token: string,
  page: { start: Date; end: Date } | { next: string },
): Promise<{ events: PaypalWebhookEvent[]; next: string | null }> {
  const query =
    'next' in page
      ? page.next
      : // 100 is PayPal's most per page; it refuses more (INVALID_REQUEST).
        new URLSearchParams({ page_size: '100', start_time: paypalTime(page.start), end_time: paypalTime(page.end) }).toString();
  const { data } = await call<{ events?: unknown; links?: unknown }>(env, {
    method: 'GET',
    path: `/v1/notifications/webhooks-events?${query}`,
    auth: { bearer: token },
  });
  const events = Array.isArray(data?.events) ? (data.events as PaypalWebhookEvent[]) : [];
  return { events, next: nextQuery(data?.links, '/v1/notifications/webhooks-events') };
}

function nextQuery(links: unknown, path: string): string | null {
  if (!Array.isArray(links)) return null;
  for (const l of links) {
    const { rel, href } = (l ?? {}) as { rel?: unknown; href?: unknown };
    if (rel !== 'next' || typeof href !== 'string') continue;
    try {
      const u = new URL(href);
      if (u.pathname === path && u.search.length > 1) return u.search.slice(1);
    } catch {
      // Not a URL: no next page.
    }
  }
  return null;
}

/** Transaction Search's `transaction_info`: the fields the catch-up reads. */
export interface PaypalTransactionInfo {
  transaction_id?: string;
  paypal_reference_id?: string;
  /** ODR (order), TXN (another transaction), SUB (subscription), PAP. */
  paypal_reference_id_type?: string;
  transaction_event_code?: string;
  transaction_initiation_date?: string;
  transaction_amount?: { currency_code?: string; value?: string };
  /** S (success), P (pending), V (reversed), D (denied), F (refunded). */
  transaction_status?: string;
  custom_field?: string;
}

/** One page of Transaction Search (GET /v1/reporting/transactions): at
 *  most 31 days, up to three hours behind, 500 to a page. A 403 means
 *  PayPal hasn't given this app Transaction Search. */
export async function searchTransactions(
  env: PaypalEnvironment,
  token: string,
  window: { start: Date; end: Date },
  page: number,
): Promise<{ transactions: PaypalTransactionInfo[]; totalPages: number }> {
  const query = new URLSearchParams({
    start_date: paypalTime(window.start),
    end_date: paypalTime(window.end),
    fields: 'transaction_info',
    page_size: '500',
    page: String(page),
  });
  const { data } = await call<{ transaction_details?: Array<{ transaction_info?: PaypalTransactionInfo }>; total_pages?: number }>(env, {
    method: 'GET',
    path: `/v1/reporting/transactions?${query.toString()}`,
    auth: { bearer: token },
  });
  const transactions = (data?.transaction_details ?? []).flatMap((d) => (d?.transaction_info ? [d.transaction_info] : []));
  return { transactions, totalPages: typeof data?.total_pages === 'number' ? data.total_pages : 1 };
}

export interface PaypalSubscriptionResource {
  id: string;
  plan_id?: string;
  status?: string;
  custom_id?: string;
  create_time?: string;
}

/** GET /v1/billing/subscriptions/{id}; null when this app has no such
 *  subscription. */
export async function getSubscription(env: PaypalEnvironment, token: string, subscriptionId: string): Promise<PaypalSubscriptionResource | null> {
  try {
    const { data } = await call<PaypalSubscriptionResource>(env, {
      method: 'GET',
      path: `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
      auth: { bearer: token },
    });
    return data && typeof data.id === 'string' ? data : null;
  } catch (err) {
    if (err instanceof PaypalApiError && err.kind === 'http' && err.status === 404) return null;
    throw err;
  }
}

/** The ids of a subscription's transactions between two times
 *  (GET /v1/billing/subscriptions/{id}/transactions). */
export async function listSubscriptionTransactionIds(
  env: PaypalEnvironment,
  token: string,
  subscriptionId: string,
  window: { start: Date; end: Date },
): Promise<string[]> {
  const query = new URLSearchParams({ start_time: paypalTime(window.start), end_time: paypalTime(window.end) });
  try {
    const { data } = await call<{ transactions?: Array<{ id?: unknown }> }>(env, {
      method: 'GET',
      path: `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/transactions?${query.toString()}`,
      auth: { bearer: token },
    });
    return (data?.transactions ?? []).flatMap((t) => (typeof t?.id === 'string' ? [t.id] : []));
  } catch (err) {
    if (err instanceof PaypalApiError && err.kind === 'http' && err.status === 404) return [];
    throw err;
  }
}
