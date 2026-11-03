/**
 * A brand's own PayPal REST app, for Pay with PayPal
 * (docs/paypal-payouts.md). The brand creates an app in its PayPal
 * developer dashboard and pastes the client id and secret, once for live
 * and, if it wants to test, once for sandbox. OpenPartner then calls the
 * Payouts API as that app: the brand's PayPal balance pays its partners.
 *
 *   - **Verified on save.** A client-credentials token call proves the
 *     pair works in that environment before anything is stored. The
 *     token's scopes say whether Payouts is enabled (PayPal turns it on
 *     per account; without it every send is refused).
 *   - **Sealed.** The secret, the cached token and the webhook id are
 *     AES-256-GCM envelopes under SECRETS_ENCRYPTION_KEY (crypto.ts). The
 *     secret never leaves the API again: no response, export, log line
 *     or error carries it. Disconnecting wipes all three.
 *   - **Never exported.** Credentials for one deployment, like
 *     TenantStripeConnection (docs/data-portability.md "Credentials").
 *   - **Webhook.** On save, OpenPartner registers a webhook on the
 *     brand's app pointing at /webhooks/paypal/<connection id>, for the
 *     Payouts events. A deployment PayPal can't reach (PORTAL_URL not a
 *     public https address) registers none; batches are polled instead.
 *   - **One active environment.** "Pay with PayPal" uses whichever is
 *     active. Connecting the first one makes it active; switching is the
 *     admin's explicit choice, never automatic, so a sandbox setup never
 *     silently turns into live sends.
 *   - **In-flight batches pin their connection.** Disconnecting, or
 *     replacing credentials with another app's, is refused while a batch
 *     sent with them is still open: its status can only be read with
 *     them. A new secret for the SAME app (a rotation) moves the batches
 *     over.
 *
 * The same connection can also report the payments the brand's checkout
 * takes (docs/paypal-payments.md): turning that on adds the payment events
 * to its webhook. When the checkout runs on another app than the one Pay
 * with PayPal sends from, the brand connects that app too, the same way,
 * as a `checkout` connection: it only reports payments and never sends.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES, type PaypalConnectionPurpose, type PaypalConnectionRow, type PaypalEnvironment } from '@openpartner/db';
import { decryptSecret, encryptSecret } from './crypto.js';
import {
  PAYPAL_PAYMENT_EVENTS,
  PAYPAL_WEBHOOK_EVENTS,
  PaypalApiError,
  createWebhook,
  deleteWebhook,
  fetchAccessToken,
  getWebhookEventTypes,
  hasPayoutsScope,
  listWebhooks,
  setWebhookEventTypes,
  type PaypalToken,
} from './paypal-api.js';

export const PAYPAL_ENVIRONMENTS = ['live', 'sandbox'] as const;

/** Batches still in flight (paypal-payouts.ts). */
const OPEN_BATCH_STATES = ['intent', 'posted', 'submitted', 'reconcile_required'];

/** Refresh a cached token this long before PayPal says it expires. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

export type PaypalConnectErrorCode =
  | 'credentials_refused'
  | 'paypal_unreachable'
  | 'open_batches'
  | 'not_connected'
  | 'credentials_unreadable'
  | 'same_app_as_payouts'
  | 'already_tracked';

export class PaypalConnectError extends Error {
  constructor(
    readonly code: PaypalConnectErrorCode,
    message: string,
    readonly openBatches?: number,
  ) {
    super(message);
    this.name = 'PaypalConnectError';
  }
}

/** What the admin Settings card shows. Never the secret. */
export interface PaypalConnectionView {
  id: string;
  environment: PaypalEnvironment;
  /** The client id's first 6 and last 4 characters. */
  clientIdPreview: string;
  appId: string | null;
  /** PayPal granted the Payouts scope. False: ask PayPal to enable
   *  Payouts on the account; sends would be refused. */
  payoutsEnabled: boolean;
  webhook: { registered: boolean; error: string | null };
  active: boolean;
  connectedAt: Date;
  verifiedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  /** Batches sent with this connection that are still in flight. */
  openBatches: number;
}

function preview(clientId: string): string {
  return clientId.length <= 12 ? `${clientId.slice(0, 2)}…` : `${clientId.slice(0, 6)}…${clientId.slice(-4)}`;
}

/** Open an envelope without throwing: null when it can't be (sealed under
 *  another deployment's key, or damaged). */
function openSealed(envelope: string | null): string | null {
  if (!envelope) return null;
  try {
    return decryptSecret(envelope) || null;
  } catch {
    return null;
  }
}

/** The PayPal webhook id this connection registered, opened; null when it
 *  has none or it can't be opened. */
export function openWebhookId(conn: Pick<PaypalConnectionRow, 'webhookIdEnc'>): string | null {
  return openSealed(conn.webhookIdEnc);
}

/**
 * Where PayPal should deliver this connection's webhooks: the API behind
 * PORTAL_URL (the ingress strips /api, as for /webhooks/stripe-app). Null
 * when PayPal couldn't reach it: not https, or a local or test host.
 */
export function paypalWebhookUrl(connectionId: string): string | null {
  const base = (process.env.PORTAL_URL ?? '').replace(/\/$/, '');
  let url: URL;
  try {
    url = new URL(`${base}/api/webhooks/paypal/${connectionId}`);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (url.protocol !== 'https:') return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.test') || host.endsWith('.local')) return null;
  if (/^(127\.|10\.|192\.168\.|0\.)/.test(host) || host === '[::1]') return null;
  return url.toString();
}

async function openBatchCount(db: Knex, tenantId: string, connectionId: string): Promise<number> {
  const [row] = (await db(TABLES.PaypalPayoutBatch)
    .where({ tenantId, connectionId })
    .whereIn('state', OPEN_BATCH_STATES)
    .count<Array<{ count: string }>>({ count: '*' })) as Array<{ count: string }>;
  return Number(row?.count ?? 0);
}

function toView(conn: PaypalConnectionRow, openBatches: number): PaypalConnectionView {
  return {
    id: conn.id,
    environment: conn.environment,
    clientIdPreview: preview(conn.clientId),
    appId: conn.appId,
    payoutsEnabled: conn.payoutsScope,
    webhook: { registered: !!conn.webhookIdEnc, error: conn.webhookError },
    active: conn.active,
    connectedAt: conn.connectedAt,
    verifiedAt: conn.verifiedAt,
    lastError: conn.lastError,
    lastErrorAt: conn.lastErrorAt,
    openBatches,
  };
}

/** The tenant's connected PayPal apps (live and/or sandbox). */
export async function listPaypalConnections(db: Knex, tenantId: string): Promise<PaypalConnectionView[]> {
  const rows = (await db<PaypalConnectionRow>(TABLES.PaypalConnection)
    .where({ tenantId, purpose: 'payouts' })
    .whereNull('disconnectedAt')
    .orderBy('environment', 'asc')) as PaypalConnectionRow[];
  // One at a time: `db` is usually the request's transaction, one connection.
  const views: PaypalConnectionView[] = [];
  for (const r of rows) views.push(toView(r, await openBatchCount(db, tenantId, r.id)));
  return views;
}

/** Pay with PayPal's app for `environment` (never a checkout app). */
export async function liveConnection(db: Knex, tenantId: string, environment: PaypalEnvironment): Promise<PaypalConnectionRow | null> {
  return (
    ((await db<PaypalConnectionRow>(TABLES.PaypalConnection)
      .where({ tenantId, environment, purpose: 'payouts' })
      .whereNull('disconnectedAt')
      .first()) as PaypalConnectionRow | undefined) ?? null
  );
}

/** The connection "Pay with PayPal" sends with, or null. */
export async function activePaypalConnection(db: Knex, tenantId: string): Promise<PaypalConnectionRow | null> {
  return (
    ((await db<PaypalConnectionRow>(TABLES.PaypalConnection)
      .where({ tenantId, active: true })
      .whereNull('disconnectedAt')
      .first()) as PaypalConnectionRow | undefined) ?? null
  );
}

/** A connection by id, for the executor and the webhook route, which
 *  carry the tenant themselves. */
export async function connectionById(db: Knex, tenantId: string, id: string): Promise<PaypalConnectionRow | null> {
  return ((await db<PaypalConnectionRow>(TABLES.PaypalConnection).where({ tenantId, id }).first()) as PaypalConnectionRow | undefined) ?? null;
}

function connectErrorFrom(err: unknown): PaypalConnectError {
  if (err instanceof PaypalApiError && err.kind === 'http' && (err.status === 401 || err.status === 400 || err.status === 403)) {
    return new PaypalConnectError('credentials_refused', 'PayPal refused this client id and secret for this environment');
  }
  return new PaypalConnectError('paypal_unreachable', 'Could not reach PayPal to check the credentials. Try again.');
}

async function recordError(db: Knex, conn: PaypalConnectionRow, message: string): Promise<void> {
  await db(TABLES.PaypalConnection)
    .where({ id: conn.id, tenantId: conn.tenantId })
    .whereNull('disconnectedAt')
    .update({ lastError: message.slice(0, 300), lastErrorAt: new Date(), updatedAt: new Date() });
}

/**
 * A bearer token for this connection: the cached one while it has more
 * than five minutes left, else a fresh one (cached, sealed). Throws
 * PaypalConnectError `credentials_refused` (recorded on the connection)
 * when PayPal refuses the secret, `credentials_unreadable` when it can't
 * be opened, or the PaypalApiError of a call that didn't get an answer.
 */
export async function paypalAccessToken(db: Knex, conn: PaypalConnectionRow, opts: { fresh?: boolean } = {}): Promise<string> {
  if (conn.disconnectedAt) throw new PaypalConnectError('not_connected', 'This PayPal connection was disconnected');
  if (!opts.fresh && conn.accessTokenEnc && conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - Date.now() > TOKEN_MARGIN_MS) {
    const cached = openSealed(conn.accessTokenEnc);
    if (cached) return cached;
  }
  const secret = openSealed(conn.clientSecretEnc);
  if (!secret) {
    await recordError(db, conn, 'The saved secret can’t be read on this deployment. Enter it again.');
    throw new PaypalConnectError('credentials_unreadable', 'The saved PayPal secret can’t be read; enter it again');
  }
  let token: PaypalToken;
  try {
    token = await fetchAccessToken(conn.environment, conn.clientId, secret);
  } catch (err) {
    const e = connectErrorFrom(err);
    if (e.code === 'credentials_refused') {
      await recordError(db, conn, 'PayPal refused the saved client id and secret. Connect PayPal again with current ones.');
      throw e;
    }
    throw err;
  }
  await db(TABLES.PaypalConnection)
    .where({ id: conn.id, tenantId: conn.tenantId })
    .whereNull('disconnectedAt')
    .update({
      accessTokenEnc: encryptSecret(token.accessToken),
      accessTokenExpiresAt: new Date(Date.now() + token.expiresIn * 1000),
      payoutsScope: hasPayoutsScope(token.scope),
      verifiedAt: new Date(),
      lastError: null,
      lastErrorAt: null,
      updatedAt: new Date(),
    });
  return token.accessToken;
}

/** The events a connection's webhook receives: the Payouts events for
 *  Pay with PayPal's app, plus the payment events while it tracks
 *  payments; a checkout app, the payment events alone. */
export function webhookEventTypes(conn: Pick<PaypalConnectionRow, 'purpose' | 'paymentsSince'>): string[] {
  if (conn.purpose === 'checkout') return [...PAYPAL_PAYMENT_EVENTS];
  return [...PAYPAL_WEBHOOK_EVENTS, ...(conn.paymentsSince ? PAYPAL_PAYMENT_EVENTS : [])];
}

const DISPUTE_EVENTS: ReadonlySet<string> = new Set(['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.RESOLVED']);

/** Kept as the webhook's note while it is registered without them. The
 *  hourly catch-up asks for them again (syncPaypalWebhook). */
export const DISPUTES_REFUSED =
  'PayPal won’t send this app dispute events. Turn on Customer disputes for it in the PayPal developer dashboard: they’re added within the hour.';

/** PayPal refused the set of events, not the webhook itself (its URL,
 *  PayPal's limit of 10). */
function refusesEventSet(err: unknown): boolean {
  return (
    err instanceof PaypalApiError &&
    err.kind === 'http' &&
    (err.status === 400 || err.status === 422) &&
    err.errorName !== 'WEBHOOK_URL_ALREADY_EXISTS' &&
    err.errorName !== 'WEBHOOK_NUMBER_LIMIT_EXCEEDED'
  );
}

/**
 * A webhook write with `eventTypes`, and once more without the dispute
 * events when PayPal refuses the set: an app without the Customer disputes
 * feature may not take them, and payments, refunds and subscriptions
 * shouldn't wait on disputes. A refusal about the webhook itself isn't
 * retried.
 */
async function withDisputeFallback<T>(
  eventTypes: readonly string[],
  write: (types: readonly string[]) => Promise<T>,
): Promise<{ result: T; disputesRefused: boolean }> {
  try {
    return { result: await write(eventTypes), disputesRefused: false };
  } catch (err) {
    const without = eventTypes.filter((t) => !DISPUTE_EVENTS.has(t));
    if (!refusesEventSet(err) || without.length === eventTypes.length) throw err;
    return { result: await write(without), disputesRefused: true };
  }
}

/** Register (or find) this connection's webhook on the brand's app. */
async function registerWebhook(
  environment: PaypalEnvironment,
  token: string,
  connectionId: string,
  eventTypes: readonly string[] = PAYPAL_WEBHOOK_EVENTS,
  fallback = 'Batch status is checked every few minutes instead.',
): Promise<{ webhookIdEnc: string | null; webhookError: string | null }> {
  const url = paypalWebhookUrl(connectionId);
  if (!url) {
    return {
      webhookIdEnc: null,
      webhookError: `This deployment isn’t at a public https address, so PayPal can’t send it updates. ${fallback}`,
    };
  }
  try {
    const made = await withDisputeFallback(eventTypes, (types) => createWebhook(environment, token, url, types));
    return { webhookIdEnc: encryptSecret(made.result), webhookError: made.disputesRefused ? DISPUTES_REFUSED : null };
  } catch (err) {
    if (err instanceof PaypalApiError && err.errorName === 'WEBHOOK_URL_ALREADY_EXISTS') {
      try {
        const hit = (await listWebhooks(environment, token)).find((w) => w.url === url);
        if (hit) {
          const set = await withDisputeFallback(eventTypes, (types) => setWebhookEventTypes(environment, token, hit.id, types));
          return { webhookIdEnc: encryptSecret(hit.id), webhookError: set.disputesRefused ? DISPUTES_REFUSED : null };
        }
      } catch {
        // Fall through to the error below.
      }
    }
    const why = err instanceof PaypalApiError && err.errorName === 'WEBHOOK_NUMBER_LIMIT_EXCEEDED'
      ? 'Your PayPal app already has the most webhooks PayPal allows (10). Remove one in the PayPal developer dashboard, then connect again.'
      : `PayPal didn’t accept the webhook. ${fallback}`;
    return { webhookIdEnc: null, webhookError: why };
  }
}

/** Remove a connection's webhook from the brand's app. Best effort: a
 *  leftover webhook only posts to a route that ignores it. */
async function removeWebhook(db: Knex, conn: PaypalConnectionRow, token?: string): Promise<void> {
  const webhookId = openWebhookId(conn);
  if (!webhookId) return;
  try {
    await deleteWebhook(conn.environment, token ?? (await paypalAccessToken(db, conn)), webhookId);
  } catch {
    console.warn(`[paypal] could not remove the webhook of connection ${conn.id}; PayPal may keep posting to an inactive route`);
  }
}

export interface ConnectPaypalInput {
  environment: PaypalEnvironment;
  clientId: string;
  clientSecret: string;
  adminId: string | null;
}

/**
 * Save (or replace) the brand's credentials for one environment, after a
 * token call proves them. Replacing another app's credentials is refused
 * while batches sent with the old ones are in flight (`open_batches`).
 */
export async function connectPaypal(db: Knex, tenantId: string, input: ConnectPaypalInput): Promise<PaypalConnectionView> {
  let token: PaypalToken;
  try {
    token = await fetchAccessToken(input.environment, input.clientId, input.clientSecret);
  } catch (err) {
    throw connectErrorFrom(err);
  }

  const existing = await liveConnection(db, tenantId, input.environment);
  const open = existing ? await openBatchCount(db, tenantId, existing.id) : 0;
  const sameApp = !!existing && !!existing.appId && existing.appId === token.appId;
  if (existing && open > 0 && !sameApp) {
    throw new PaypalConnectError(
      'open_batches',
      'PayPal batches sent with the current credentials are still in progress. Connect a new app once they finish, or enter a new secret for the same app.',
      open,
    );
  }

  const id = ulid();
  const active = await activePaypalConnection(db, tenantId);
  const makeActive = !active || active.id === existing?.id;
  const now = new Date();
  // A new secret for the same app keeps reporting its payments, from when
  // it started. Another app starts with payment tracking off: its checkout
  // may not be this one's (docs/paypal-payments.md).
  const paymentsSince = sameApp && existing ? existing.paymentsSince : null;

  if (existing) {
    // The old webhook goes with the old row. Same app: the new token can
    // remove it even when the old secret has been revoked.
    await removeWebhook(db, existing, sameApp ? token.accessToken : undefined);
    await db(TABLES.PaypalConnection).where({ id: existing.id, tenantId }).update({
      disconnectedAt: now,
      disconnectReason: 'replaced',
      active: false,
      clientSecretEnc: null,
      accessTokenEnc: null,
      accessTokenExpiresAt: null,
      webhookIdEnc: null,
      updatedAt: now,
    });
  }

  const webhook = await registerWebhook(input.environment, token.accessToken, id, webhookEventTypes({ purpose: 'payouts', paymentsSince }));
  const row: Partial<PaypalConnectionRow> = {
    id,
    tenantId,
    environment: input.environment,
    purpose: 'payouts',
    paymentsSince,
    clientId: input.clientId,
    clientSecretEnc: encryptSecret(input.clientSecret),
    accessTokenEnc: encryptSecret(token.accessToken),
    accessTokenExpiresAt: new Date(Date.now() + token.expiresIn * 1000),
    appId: token.appId,
    payoutsScope: hasPayoutsScope(token.scope),
    webhookIdEnc: webhook.webhookIdEnc,
    webhookError: webhook.webhookError,
    active: makeActive,
    connectedByAdminId: input.adminId,
    connectedAt: now,
    verifiedAt: now,
    updatedAt: now,
  };
  await db(TABLES.PaypalConnection).insert(row);
  if (token.appId) {
    // Every batch sent with this same PayPal app, finished ones too (a paid
    // item can still be refunded, and only this app can read it), whether
    // its old row was replaced just now (a secret rotation) or
    // disconnected earlier (connecting the app again).
    const sameAppRows = (await db(TABLES.PaypalConnection)
      .where({ tenantId, environment: input.environment, appId: token.appId, purpose: 'payouts' })
      .whereNot({ id })
      .select('id')) as Array<{ id: string }>;
    if (sameAppRows.length > 0) {
      await db(TABLES.PaypalPayoutBatch)
        .where({ tenantId })
        .whereIn(
          'connectionId',
          sameAppRows.map((r) => r.id),
        )
        .update({ connectionId: id, updatedAt: now });
      await moveSubscriptions(db, tenantId, sameAppRows.map((r) => r.id), id);
      // Finished batches a disconnect stopped following resume, within
      // their 90 days.
      await db(TABLES.PaypalPayoutBatch)
        .where({ tenantId, connectionId: id, state: 'completed' })
        .whereNull('nextSyncAt')
        .where('completedAt', '>', new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000))
        .update({ nextSyncAt: now });
    }
  }
  const saved = (await connectionById(db, tenantId, id))!;
  return toView(saved, await openBatchCount(db, tenantId, id));
}

/** Check the saved credentials again (a fresh token call). */
export async function reverifyPaypal(db: Knex, tenantId: string, environment: PaypalEnvironment): Promise<PaypalConnectionView> {
  const conn = await liveConnection(db, tenantId, environment);
  if (!conn) throw new PaypalConnectError('not_connected', `No ${environment} PayPal app is connected`);
  try {
    await paypalAccessToken(db, conn, { fresh: true });
  } catch (err) {
    if (err instanceof PaypalConnectError) throw err;
    throw connectErrorFrom(err);
  }
  return toView((await connectionById(db, tenantId, conn.id))!, await openBatchCount(db, tenantId, conn.id));
}

/** Make `environment` the one "Pay with PayPal" sends with. */
export async function setActivePaypalEnvironment(db: Knex, tenantId: string, environment: PaypalEnvironment): Promise<PaypalConnectionView> {
  const conn = await liveConnection(db, tenantId, environment);
  if (!conn) throw new PaypalConnectError('not_connected', `No ${environment} PayPal app is connected`);
  const now = new Date();
  await db(TABLES.PaypalConnection).where({ tenantId, active: true }).whereNot({ id: conn.id }).update({ active: false, updatedAt: now });
  await db(TABLES.PaypalConnection).where({ tenantId, id: conn.id }).update({ active: true, updatedAt: now });
  return toView((await connectionById(db, tenantId, conn.id))!, await openBatchCount(db, tenantId, conn.id));
}

/**
 * Disconnect one environment: remove its webhook from the brand's app
 * (best effort) and wipe the secret, token and webhook id. Refused while
 * batches sent with it are in flight. Never activates the other
 * environment: the admin picks it.
 */
export async function disconnectPaypal(db: Knex, tenantId: string, environment: PaypalEnvironment): Promise<void> {
  const conn = await liveConnection(db, tenantId, environment);
  if (!conn) throw new PaypalConnectError('not_connected', `No ${environment} PayPal app is connected`);
  const open = await openBatchCount(db, tenantId, conn.id);
  if (open > 0) {
    throw new PaypalConnectError(
      'open_batches',
      'PayPal batches sent with this app are still in progress; their status can only be read with it. Disconnect once they finish.',
      open,
    );
  }
  await removeWebhook(db, conn);
  await db(TABLES.PaypalConnection).where({ id: conn.id, tenantId }).update({
    disconnectedAt: new Date(),
    disconnectReason: 'admin',
    active: false,
    clientSecretEnc: null,
    accessTokenEnc: null,
    accessTokenExpiresAt: null,
    webhookIdEnc: null,
    updatedAt: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Payment tracking (docs/paypal-payments.md)
// ---------------------------------------------------------------------------

/** An app that reports, or could report, the brand's PayPal payments:
 *  Pay with PayPal's app, or a checkout app. Never the secret. */
export interface PaypalPaymentAppView {
  id: string;
  environment: PaypalEnvironment;
  purpose: PaypalConnectionPurpose;
  clientIdPreview: string;
  tracking: boolean;
  trackingSince: Date | null;
  webhook: { registered: boolean; error: string | null };
  /** The last payment webhook PayPal delivered from this app. */
  lastEventAt: Date | null;
  /** Whether PayPal lets this app search its transactions (the hourly
   *  catch-up's second source); null until it has tried. */
  transactionSearch: 'ok' | 'unavailable' | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

function toPaymentView(conn: PaypalConnectionRow): PaypalPaymentAppView {
  return {
    id: conn.id,
    environment: conn.environment,
    purpose: conn.purpose,
    clientIdPreview: preview(conn.clientId),
    tracking: !!conn.paymentsSince,
    trackingSince: conn.paymentsSince,
    webhook: { registered: !!conn.webhookIdEnc, error: conn.webhookError },
    lastEventAt: conn.lastPaymentEventAt,
    transactionSearch: conn.transactionSearch,
    lastError: conn.lastError,
    lastErrorAt: conn.lastErrorAt,
  };
}

async function liveCheckoutConnection(db: Knex, tenantId: string, environment: PaypalEnvironment): Promise<PaypalConnectionRow | null> {
  return (
    ((await db<PaypalConnectionRow>(TABLES.PaypalConnection)
      .where({ tenantId, environment, purpose: 'checkout' })
      .whereNull('disconnectedAt')
      .first()) as PaypalConnectionRow | undefined) ?? null
  );
}

/** Every connected app, Pay with PayPal's and checkout apps. */
export async function listPaypalPaymentApps(db: Knex, tenantId: string): Promise<PaypalPaymentAppView[]> {
  const rows = (await db<PaypalConnectionRow>(TABLES.PaypalConnection)
    .where({ tenantId })
    .whereNull('disconnectedAt')
    .orderBy([
      { column: 'environment', order: 'asc' },
      { column: 'purpose', order: 'desc' },
    ])) as PaypalConnectionRow[];
  return rows.map(toPaymentView);
}

/** Subscriptions seen through one app follow it to its new row. */
async function moveSubscriptions(db: Knex, tenantId: string, fromIds: string[], toId: string): Promise<void> {
  if (fromIds.length === 0) return;
  await db(TABLES.PaypalSubscription)
    .where({ tenantId })
    .whereIn('connectionId', fromIds)
    .update({ connectionId: toId, updatedAt: new Date() });
}

/**
 * Turn payment tracking on or off for Pay with PayPal's app in one
 * environment: its webhook gains (or loses) the payment events, and the
 * catch-up starts (or stops) reading its payments. Turning it on never
 * reaches back: payments from before are left alone, as a new Stripe
 * connection leaves its account's history.
 */
export async function setPaypalPaymentTracking(
  db: Knex,
  tenantId: string,
  environment: PaypalEnvironment,
  on: boolean,
): Promise<PaypalPaymentAppView> {
  const conn = await liveConnection(db, tenantId, environment);
  if (!conn) throw new PaypalConnectError('not_connected', `No ${environment} PayPal app is connected`);
  if (on === !!conn.paymentsSince) return toPaymentView(conn);
  if (on) {
    const checkout = await liveCheckoutConnection(db, tenantId, environment);
    if (checkout && checkout.appId && checkout.appId === conn.appId) {
      throw new PaypalConnectError('already_tracked', 'This app is already connected as your checkout app, which reports its payments.');
    }
  }
  const paymentsSince = on ? new Date() : null;
  const eventTypes = webhookEventTypes({ purpose: 'payouts', paymentsSince });
  const webhookId = openWebhookId(conn);
  let webhook: { webhookIdEnc?: string | null; webhookError?: string | null } = {};
  try {
    // The webhook OpenPartner already has on the app is changed in place,
    // with the saved credentials: never a second one (PayPal allows 10),
    // and nothing for the brand to paste again.
    const token = await paypalAccessToken(db, conn);
    if (webhookId) {
      try {
        const set = await withDisputeFallback(eventTypes, (types) => setWebhookEventTypes(environment, token, webhookId, types));
        webhook = { webhookError: set.disputesRefused ? DISPUTES_REFUSED : null };
      } catch (err) {
        // Removed in PayPal's dashboard since: register it again.
        if (!(err instanceof PaypalApiError && err.kind === 'http' && err.status === 404)) throw err;
        webhook = await registerWebhook(environment, token, conn.id, eventTypes);
      }
    } else if (on) {
      webhook = await registerWebhook(environment, token, conn.id, eventTypes);
    }
  } catch (err) {
    if (err instanceof PaypalConnectError) throw err;
    throw new PaypalConnectError('paypal_unreachable', 'PayPal didn’t take the change to the app’s webhook. Try again.');
  }
  await db(TABLES.PaypalConnection)
    .where({ id: conn.id, tenantId })
    .whereNull('disconnectedAt')
    .update({ paymentsSince, ...webhook, updatedAt: new Date() });
  return toPaymentView((await connectionById(db, tenantId, conn.id))!);
}

export type PaypalWebhookSync = 'current' | 'updated' | 'registered' | 'none';

/**
 * Bring an app's webhook to the events its connection reads
 * (webhookEventTypes), checked against PayPal's own copy: an app set up
 * before an event was added gets it, one whose webhook was removed in
 * PayPal's dashboard gets a new one, and dispute events PayPal refused are
 * asked for again (once; a refusal leaves the rest as they are). Run by the
 * hourly catch-up for every app recording payments. 'none': there's no
 * webhook to check (the deployment isn't public, or registering failed).
 */
export async function syncPaypalWebhook(db: Knex, conn: PaypalConnectionRow, token: string): Promise<PaypalWebhookSync> {
  const webhookId = openWebhookId(conn);
  if (!webhookId) return 'none';
  const wanted = webhookEventTypes(conn);
  const current = await getWebhookEventTypes(conn.environment, token, webhookId);

  let outcome: PaypalWebhookSync;
  let webhook: { webhookIdEnc?: string | null; webhookError: string | null };
  if (current === null) {
    const fallback = conn.purpose === 'checkout' ? 'Payments are read from PayPal every hour instead.' : undefined;
    webhook = await registerWebhook(conn.environment, token, conn.id, wanted, fallback);
    outcome = 'registered';
  } else {
    const have = new Set(current);
    const missing = wanted.filter((t) => !have.has(t));
    const extra = current.filter((t) => !wanted.includes(t));
    if (missing.length === 0 && extra.length === 0) {
      webhook = { webhookError: null };
      outcome = 'current';
    } else if (extra.length === 0 && missing.every((t) => DISPUTE_EVENTS.has(t))) {
      try {
        await setWebhookEventTypes(conn.environment, token, webhookId, wanted);
        webhook = { webhookError: null };
        outcome = 'updated';
      } catch (err) {
        if (!refusesEventSet(err)) throw err;
        webhook = { webhookError: DISPUTES_REFUSED };
        outcome = 'current';
      }
    } else {
      const set = await withDisputeFallback(wanted, (types) => setWebhookEventTypes(conn.environment, token, webhookId, types));
      webhook = { webhookError: set.disputesRefused ? DISPUTES_REFUSED : null };
      outcome = 'updated';
    }
  }

  if (outcome !== 'current' || webhook.webhookError !== conn.webhookError) {
    // Not over an admin's change made meanwhile (a new webhook, tracking off).
    await db(TABLES.PaypalConnection)
      .where({ id: conn.id, tenantId: conn.tenantId, webhookIdEnc: conn.webhookIdEnc })
      .whereNull('disconnectedAt')
      .whereNotNull('paymentsSince')
      .update({ ...webhook, updatedAt: new Date() });
  }
  return outcome;
}

/**
 * Connect the app the brand's checkout runs on, when it isn't Pay with
 * PayPal's: verified and sealed the same way, with a webhook for the
 * payment events only. It reports payments and never sends. Pay with
 * PayPal's own app is refused (`same_app_as_payouts`): turn tracking on
 * there instead, so one app never has two webhooks for the same payments.
 * Connecting again replaces the environment's checkout app; a new secret
 * for the same app keeps its history.
 */
export async function connectPaypalCheckout(db: Knex, tenantId: string, input: ConnectPaypalInput): Promise<PaypalPaymentAppView> {
  let token: PaypalToken;
  try {
    token = await fetchAccessToken(input.environment, input.clientId, input.clientSecret);
  } catch (err) {
    throw connectErrorFrom(err);
  }
  const payouts = await liveConnection(db, tenantId, input.environment);
  if (payouts && payouts.appId && payouts.appId === token.appId) {
    throw new PaypalConnectError('same_app_as_payouts', 'This is the app Pay with PayPal already uses. Turn on payment tracking for it instead.');
  }

  const existing = await liveCheckoutConnection(db, tenantId, input.environment);
  const sameApp = !!existing && !!existing.appId && existing.appId === token.appId;
  const now = new Date();
  if (existing) {
    await removeWebhook(db, existing, sameApp ? token.accessToken : undefined);
    await db(TABLES.PaypalConnection).where({ id: existing.id, tenantId }).update({
      disconnectedAt: now,
      disconnectReason: 'replaced',
      clientSecretEnc: null,
      accessTokenEnc: null,
      accessTokenExpiresAt: null,
      webhookIdEnc: null,
      updatedAt: now,
    });
  }

  const id = ulid();
  const webhook = await registerWebhook(input.environment, token.accessToken, id, PAYPAL_PAYMENT_EVENTS, 'Payments are read from PayPal every hour instead.');
  await db(TABLES.PaypalConnection).insert({
    id,
    tenantId,
    environment: input.environment,
    purpose: 'checkout',
    clientId: input.clientId,
    clientSecretEnc: encryptSecret(input.clientSecret),
    accessTokenEnc: encryptSecret(token.accessToken),
    accessTokenExpiresAt: new Date(Date.now() + token.expiresIn * 1000),
    appId: token.appId,
    payoutsScope: hasPayoutsScope(token.scope),
    webhookIdEnc: webhook.webhookIdEnc,
    webhookError: webhook.webhookError,
    active: false,
    paymentsSince: sameApp && existing?.paymentsSince ? existing.paymentsSince : now,
    connectedByAdminId: input.adminId,
    connectedAt: now,
    verifiedAt: now,
    updatedAt: now,
  });
  if (token.appId) {
    const sameAppRows = (await db(TABLES.PaypalConnection)
      .where({ tenantId, environment: input.environment, appId: token.appId, purpose: 'checkout' })
      .whereNot({ id })
      .select('id')) as Array<{ id: string }>;
    await moveSubscriptions(db, tenantId, sameAppRows.map((r) => r.id), id);
  }
  return toPaymentView((await connectionById(db, tenantId, id))!);
}

/** Disconnect an environment's checkout app: its webhook is removed (best
 *  effort) and its secret, token and webhook id wiped. What it recorded
 *  stays. */
export async function disconnectPaypalCheckout(db: Knex, tenantId: string, environment: PaypalEnvironment): Promise<void> {
  const conn = await liveCheckoutConnection(db, tenantId, environment);
  if (!conn) throw new PaypalConnectError('not_connected', `No ${environment} checkout app is connected`);
  await removeWebhook(db, conn);
  await db(TABLES.PaypalConnection).where({ id: conn.id, tenantId }).update({
    disconnectedAt: new Date(),
    disconnectReason: 'admin',
    clientSecretEnc: null,
    accessTokenEnc: null,
    accessTokenExpiresAt: null,
    webhookIdEnc: null,
    updatedAt: new Date(),
  });
}
