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
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES, type PaypalConnectionRow, type PaypalEnvironment } from '@openpartner/db';
import { decryptSecret, encryptSecret } from './crypto.js';
import {
  PaypalApiError,
  createWebhook,
  deleteWebhook,
  fetchAccessToken,
  hasPayoutsScope,
  listWebhooks,
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
  | 'credentials_unreadable';

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
    .where({ tenantId })
    .whereNull('disconnectedAt')
    .orderBy('environment', 'asc')) as PaypalConnectionRow[];
  // One at a time: `db` is usually the request's transaction, one connection.
  const views: PaypalConnectionView[] = [];
  for (const r of rows) views.push(toView(r, await openBatchCount(db, tenantId, r.id)));
  return views;
}

export async function liveConnection(db: Knex, tenantId: string, environment: PaypalEnvironment): Promise<PaypalConnectionRow | null> {
  return (
    ((await db<PaypalConnectionRow>(TABLES.PaypalConnection)
      .where({ tenantId, environment })
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

/** Register (or find) this connection's webhook on the brand's app. */
async function registerWebhook(
  environment: PaypalEnvironment,
  token: string,
  connectionId: string,
): Promise<{ webhookIdEnc: string | null; webhookError: string | null }> {
  const url = paypalWebhookUrl(connectionId);
  if (!url) {
    return {
      webhookIdEnc: null,
      webhookError: 'This deployment isn’t at a public https address, so PayPal can’t send it updates. Batch status is checked every few minutes instead.',
    };
  }
  try {
    return { webhookIdEnc: encryptSecret(await createWebhook(environment, token, url)), webhookError: null };
  } catch (err) {
    if (err instanceof PaypalApiError && err.errorName === 'WEBHOOK_URL_ALREADY_EXISTS') {
      try {
        const hit = (await listWebhooks(environment, token)).find((w) => w.url === url);
        if (hit) return { webhookIdEnc: encryptSecret(hit.id), webhookError: null };
      } catch {
        // Fall through to the error below.
      }
    }
    const why = err instanceof PaypalApiError && err.errorName === 'WEBHOOK_NUMBER_LIMIT_EXCEEDED'
      ? 'Your PayPal app already has the most webhooks PayPal allows (10). Remove one in the PayPal developer dashboard, then connect again.'
      : 'PayPal didn’t accept the webhook. Batch status is checked every few minutes instead.';
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

  const webhook = await registerWebhook(input.environment, token.accessToken, id);
  const row: Partial<PaypalConnectionRow> = {
    id,
    tenantId,
    environment: input.environment,
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
  if (existing && sameApp && open > 0) {
    await db(TABLES.PaypalPayoutBatch)
      .where({ tenantId, connectionId: existing.id })
      .whereIn('state', OPEN_BATCH_STATES)
      .update({ connectionId: id, updatedAt: now });
  }
  const saved = (await connectionById(db, tenantId, id))!;
  return toView(saved, sameApp ? open : 0);
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
