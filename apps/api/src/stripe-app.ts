/**
 * The OpenPartner Stripe App: a hosted brand connects its OWN Stripe
 * account by installing the app (OAuth), and its Stripe events then drive
 * attribution the way they do on a single-tenant self-host — Payment Link
 * checkouts, invoices, refunds, disputes and promo-code redemptions, with no
 * forwarding from the brand's server. docs/stripe-app.md is the setup guide.
 *
 * Hosted only (OPENPARTNER_MODE flat / revshare). A self-host's
 * STRIPE_SECRET_KEY already IS the brand's account, and keeps using
 * /webhooks/stripe unchanged.
 *
 * The app is published from its own Stripe developer account, separate
 * from OpenPartner's billing / Connect platform account, so brand events
 * never share a webhook destination with plan billing (Destination A) or
 * partner payouts (Destination B). Its keys and signing secret are their
 * own env vars (STRIPE_APP_*).
 *
 * We never move the brand's money (CLAUDE.md principle 4): the permissions
 * are read-only except coupons + promotion codes, which customer rewards
 * mint in the brand's account. A disconnect — from the portal, or an
 * uninstall in Stripe — wipes the tokens and stops processing; the events
 * already recorded stay (principle 5).
 *
 * Tokens (docs.stripe.com/stripe-apps/api-authentication/oauth):
 *   - the install's one-time code (5 minutes) is exchanged at
 *     POST https://api.stripe.com/v1/oauth/token with the developer key of
 *     the link's mode (live / test / sandbox);
 *   - the access token lasts 1 hour and is used as the API key;
 *   - the refresh token lasts a year and ROTATES on every refresh — the old
 *     one dies — so refreshes are single-flight per connection (a row lock,
 *     plus an in-process promise) and the new one is stored before anyone
 *     else may refresh.
 */

import Stripe from 'stripe';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type StripeAppKeyMode,
  type TenantRow,
  type TenantStripeConnectionRow,
} from '@openpartner/db';
import { db } from './db.js';
import { decryptSecret, encryptSecret, macValue, verifyMac } from './crypto.js';
import { opsStripeAppReconnectEmail } from './email-templates.js';
import { sendOpsEmail } from './platform-ops-mail.js';
import { getMode } from './stripe.js';
import { withTenantTransaction } from './tenancy.js';

// ---------------------------------------------------------------------------
// Permissions — keep in step with stripe-app/stripe-app.json (a test holds
// them together). Bump the version whenever the list changes: a connection
// records the version its brand accepted.
// ---------------------------------------------------------------------------

export const STRIPE_APP_PERMISSIONS_VERSION = 1;

/** Each permission, what the brand is shown at install, and the code that
 *  needs it. docs/stripe-app.md has the same table. */
export const STRIPE_APP_PERMISSIONS: ReadonlyArray<{ permission: string; purpose: string }> = [
  {
    permission: 'event_read',
    purpose: 'Receive the checkout, invoice, refund and dispute events that credit your partners.',
  },
  {
    permission: 'checkout_session_read',
    purpose: 'Read completed Checkout Sessions and Payment Link purchases to match them to the partner link the buyer clicked.',
  },
  {
    permission: 'customer_read',
    purpose: 'Read a customer’s metadata to match their payments to the user your app identified.',
  },
  {
    permission: 'subscription_read',
    purpose: 'Record new subscriptions for referred customers.',
  },
  {
    permission: 'invoice_read',
    purpose: 'Record paid invoices for referred customers so partners earn commission on them, including the promo code used.',
  },
  {
    permission: 'charge_read',
    purpose: 'Read refunds and disputed charges so commissions on refunded revenue are reversed or flagged.',
  },
  {
    permission: 'dispute_read',
    purpose: 'Flag commissions on disputed payments for your review.',
  },
  {
    permission: 'promotion_code_read',
    purpose: 'Match promotion codes used at checkout to your partners’ codes.',
  },
  {
    permission: 'promotion_code_write',
    purpose: 'Create each partner’s customer-discount promotion code in your account, and deactivate it when the code is retired.',
  },
  {
    permission: 'coupon_read',
    purpose: 'Check that a new partner code doesn’t collide with one of your own coupons.',
  },
  {
    permission: 'coupon_write',
    purpose: 'Create the coupon behind each partner’s customer discount.',
  },
];

/** Event types the app path maps to attribution — the brand-event subset
 *  of what /webhooks/stripe maps on self-host. Anything else is
 *  acknowledged and skipped. Never billing (customer.subscription.updated
 *  / deleted) or payout (account.updated, transfer.*) events: those belong
 *  to OpenPartner's own account, not a brand's. */
export const STRIPE_APP_ATTRIBUTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.created',
  'customer.subscription.created',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const STRIPE_APP_KEY_MODES: readonly StripeAppKeyMode[] = ['live', 'test', 'sandbox'];

interface KeyConfig {
  clientId: string;
  secretKey: string;
}

/** The developer-account client id + secret key for one link type:
 *  STRIPE_APP_CLIENT_ID / STRIPE_APP_SECRET_KEY for live, with a _TEST or
 *  _SANDBOX suffix for the others. Both must be set. */
function keyConfig(mode: StripeAppKeyMode): KeyConfig | null {
  const suffix = mode === 'live' ? '' : `_${mode.toUpperCase()}`;
  const clientId = (process.env[`STRIPE_APP_CLIENT_ID${suffix}`] ?? '').trim();
  const secretKey = (process.env[`STRIPE_APP_SECRET_KEY${suffix}`] ?? '').trim();
  return clientId && secretKey ? { clientId, secretKey } : null;
}

export function isHostedMode(): boolean {
  const mode = getMode();
  return mode === 'flat' || mode === 'revshare';
}

/** Link types this deployment can install with. Empty off hosted. */
export function configuredKeyModes(): StripeAppKeyMode[] {
  if (!isHostedMode()) return [];
  return STRIPE_APP_KEY_MODES.filter((m) => keyConfig(m) !== null);
}

/** The OAuth callback. Must exactly match one of the manifest's
 *  allowed_redirect_uris. The ingress strips /api before the API sees it. */
export function stripeAppRedirectUri(): string {
  const explicit = (process.env.STRIPE_APP_REDIRECT_URI ?? '').trim();
  if (explicit) return explicit;
  const portal = (process.env.PORTAL_URL ?? 'http://localhost:5673').replace(/\/$/, '');
  return `${portal}/api/stripe-app/oauth/callback`;
}

/** Signing secrets for /webhooks/stripe-app — one per endpoint (live, test
 *  mode, sandbox), comma-separated. Distinct from every STRIPE_WEBHOOK_*
 *  secret, so a brand-app event can't be replayed into /webhooks/stripe or
 *  the other way round. */
export function stripeAppWebhookSecrets(): string[] {
  return (process.env.STRIPE_APP_WEBHOOK_SECRET ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// OAuth state — CSRF protection for the install round trip
// ---------------------------------------------------------------------------

const STATE_PURPOSE = 'stripe-app-oauth';
const STATE_TTL_SECONDS = 30 * 60;

export interface StripeAppOAuthState {
  /** Tenant the connection is for. */
  t: string;
  /** Admin who started it; only they can finish it. */
  a: string;
  /** Link type — which developer key exchanges the code. */
  m: StripeAppKeyMode;
  /** Portal page to come back to (validated at start). */
  r: string;
  /** Expiry, unix seconds. */
  e: number;
  /** Nonce, so two starts never share a state. */
  n: string;
}

/** `<base64url JSON>.<MAC>`. Signed with a key derived for this purpose
 *  alone (crypto.ts macValue), so it can't be forged or reused as any
 *  other signed value. Carries nothing secret: Stripe echoes it in a URL. */
export function signOAuthState(input: Omit<StripeAppOAuthState, 'e' | 'n'>, now = Date.now()): string {
  const state: StripeAppOAuthState = { ...input, e: Math.floor(now / 1000) + STATE_TTL_SECONDS, n: ulid() };
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${payload}.${macValue(STATE_PURPOSE, payload)}`;
}

/** The state if the signature holds and it hasn't expired, else null.
 *  Who may use it is the caller's check (tenant + admin). */
export function verifyOAuthState(raw: string, now = Date.now()): StripeAppOAuthState | null {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  if (!verifyMac(STATE_PURPOSE, payload, raw.slice(dot + 1))) return null;
  let state: StripeAppOAuthState;
  try {
    state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as StripeAppOAuthState;
  } catch {
    return null;
  }
  if (typeof state.e !== 'number' || state.e * 1000 < now) return null;
  if (!STRIPE_APP_KEY_MODES.includes(state.m)) return null;
  if (typeof state.t !== 'string' || typeof state.a !== 'string' || typeof state.r !== 'string') return null;
  return state;
}

const PUBLIC_AUTHORIZE_URL = 'https://marketplace.stripe.com/oauth/v2/authorize';
const AUTHORIZE_PATH = /^\/oauth\/v2\/(chnlink_[A-Za-z0-9]+\/)?authorize$/;

/**
 * Where the install link points. The public link, the default, only works
 * once App Review has published the app. Before that, Stripe's External test
 * links carry a channel in the path (…/oauth/v2/chnlink_…/authorize).
 * STRIPE_APP_AUTHORIZE_URL takes one of those links, pasted whole: only its
 * origin and path are kept, and client_id still comes from
 * STRIPE_APP_CLIENT_ID[_TEST|_SANDBOX]. A _TEST / _SANDBOX variant overrides
 * it for that mode. Live and test links have shared one channel so far.
 * Anything that isn't a marketplace.stripe.com authorize path is ignored
 * (logged), so a typo can't send admins elsewhere. Unset it once the app is
 * published.
 */
export function stripeAppAuthorizeBase(mode: StripeAppKeyMode): string {
  const own = `STRIPE_APP_AUTHORIZE_URL${mode === 'live' ? '' : `_${mode.toUpperCase()}`}`;
  const name = (process.env[own] ?? '').trim() ? own : 'STRIPE_APP_AUTHORIZE_URL';
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return PUBLIC_AUTHORIZE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && url.hostname === 'marketplace.stripe.com' && AUTHORIZE_PATH.test(url.pathname)) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Falls through to the warning.
  }
  console.error(`[stripe-app] ignoring ${name}: not a marketplace.stripe.com OAuth authorize link`);
  return PUBLIC_AUTHORIZE_URL;
}

/** The Stripe install link for one link type. */
export function stripeAppInstallUrl(mode: StripeAppKeyMode, state: string): string {
  const cfg = keyConfig(mode);
  if (!cfg) throw new Error(`Stripe App ${mode} keys are not configured`);
  const url = new URL(stripeAppAuthorizeBase(mode));
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', stripeAppRedirectUri());
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Where the callback may send the admin back to: a portal page on the
 * platform origin (PORTAL_URL) or on the tenant's own verified custom
 * domain. The URL comes from the browser (the page the admin started on,
 * so a white-label admin lands back on the host their session cookie is
 * for) and is signed into the state, so the callback is never an open
 * redirect. Returns the normalized URL, or null.
 */
export function allowedReturnUrl(raw: string, tenant: Pick<TenantRow, 'customDomain'>): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const origins = new Set<string>();
  try {
    origins.add(new URL(process.env.PORTAL_URL ?? 'http://localhost:5673').origin);
  } catch {
    // Malformed PORTAL_URL — only the custom domain can match.
  }
  if (tenant.customDomain) origins.add(`https://${tenant.customDomain.toLowerCase()}`);
  if (!origins.has(url.origin)) return null;
  url.hash = '';
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

const OAUTH_TOKEN_URL = 'https://api.stripe.com/v1/oauth/token';
/** Stripe's access-token lifetime. */
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Refresh this long before expiry, so a token handed out is good for the
 *  whole webhook or request using it. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  stripe_user_id: string;
  livemode: boolean;
}

/** A refusal from Stripe's token endpoint. `code` is its OAuth error
 *  (invalid_grant, invalid_request, …). */
export class StripeAppOAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StripeAppOAuthError';
  }
}

async function postOAuthToken(mode: StripeAppKeyMode, params: Record<string, string>): Promise<OAuthTokenResponse> {
  const cfg = keyConfig(mode);
  if (!cfg) throw new Error(`Stripe App ${mode} keys are not configured`);
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.secretKey}:`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.error === 'string' ? body.error : `http_${res.status}`;
    const description =
      typeof body.error_description === 'string'
        ? body.error_description
        : typeof (body.error as { message?: unknown } | undefined)?.message === 'string'
          ? String((body.error as { message: string }).message)
          : `Stripe token endpoint answered ${res.status}`;
    throw new StripeAppOAuthError(res.status, code, description);
  }
  const { access_token, refresh_token, stripe_user_id, livemode } = body;
  if (
    typeof access_token !== 'string' ||
    typeof refresh_token !== 'string' ||
    typeof stripe_user_id !== 'string' ||
    typeof livemode !== 'boolean'
  ) {
    throw new StripeAppOAuthError(502, 'malformed_token_response', 'Stripe token endpoint returned an unexpected body');
  }
  return { access_token, refresh_token, stripe_user_id, livemode };
}

/** A live link must produce a live install and the other two a test one —
 *  otherwise the wrong developer key would refresh it. */
function livemodeMatchesKey(mode: StripeAppKeyMode, livemode: boolean): boolean {
  return mode === 'live' ? livemode : !livemode;
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

export type CompleteConnectionResult =
  | { ok: true; connection: TenantStripeConnectionRow; replaced: boolean }
  | { ok: false; status: 409; error: 'stripe_account_connected_elsewhere' }
  | { ok: false; status: 409; error: 'connection_in_progress' }
  | { ok: false; status: 400; error: 'livemode_mismatch' }
  | { ok: false; status: 400; error: 'oauth_code_rejected'; detail: string };

/**
 * Exchange the install's code and store the connection.
 *
 *   - Same tenant, same account and mode → a reconnect: fresh tokens on the
 *     existing row, "reconnect needed" cleared.
 *   - Same tenant, different account (or live ↔ test) → the old connection
 *     is closed as 'replaced' and a new one opened.
 *   - The account is live on ANOTHER tenant → refused. One brand's Stripe
 *     events must never credit another brand's partners.
 *
 * Runs on the privileged pool: refusing an account connected elsewhere
 * means looking across tenants. Every write names the caller's tenant
 * explicitly. An advisory lock on the account serializes two tenants
 * racing for the same one; the partial unique indexes back it up.
 */
export async function completeConnection(input: {
  tenantId: string;
  adminId: string;
  code: string;
  keyMode: StripeAppKeyMode;
}): Promise<CompleteConnectionResult> {
  let tokens: OAuthTokenResponse;
  try {
    tokens = await postOAuthToken(input.keyMode, { grant_type: 'authorization_code', code: input.code });
  } catch (err) {
    if (err instanceof StripeAppOAuthError && err.status < 500) {
      return { ok: false, status: 400, error: 'oauth_code_rejected', detail: err.message };
    }
    throw err;
  }
  if (!livemodeMatchesKey(input.keyMode, tokens.livemode)) {
    return { ok: false, status: 400, error: 'livemode_mismatch' };
  }

  const now = new Date();
  const fresh = {
    livemode: tokens.livemode,
    keyMode: input.keyMode,
    refreshTokenEnc: encryptSecret(tokens.refresh_token),
    accessTokenEnc: encryptSecret(tokens.access_token),
    accessTokenExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
    permissionsVersion: STRIPE_APP_PERMISSIONS_VERSION,
    connectedByAdminId: input.adminId,
    lastRefreshedAt: now,
    refreshFailedAt: null,
    refreshError: null,
    updatedAt: now,
  };

  try {
    const result = await db.transaction(async (trx) => {
      await trx.raw(`select pg_advisory_xact_lock(hashtext(?::text))`, [`stripe-app:${tokens.stripe_user_id}`]);
      const elsewhere = await trx<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
        .where({ stripeAccountId: tokens.stripe_user_id })
        .whereNull('disconnectedAt')
        .whereNot({ tenantId: input.tenantId })
        .first('id');
      if (elsewhere) return { ok: false as const, status: 409 as const, error: 'stripe_account_connected_elsewhere' as const };

      const current = (await trx<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
        .where({ tenantId: input.tenantId })
        .whereNull('disconnectedAt')
        .forUpdate()
        .first()) as TenantStripeConnectionRow | undefined;

      if (current && current.stripeAccountId === tokens.stripe_user_id && current.livemode === tokens.livemode) {
        const [row] = (await trx<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
          .where({ id: current.id })
          .update(fresh)
          .returning('*')) as TenantStripeConnectionRow[];
        return { ok: true as const, connection: row!, replaced: false, closedId: null as string | null };
      }
      if (current) await closeConnection(trx, current.id, 'replaced', now);
      const [row] = (await trx<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
        .insert({
          id: `tsc_${ulid()}`,
          tenantId: input.tenantId,
          stripeAccountId: tokens.stripe_user_id,
          connectedAt: now,
          ...fresh,
        })
        .returning('*')) as TenantStripeConnectionRow[];
      return { ok: true as const, connection: row!, replaced: current != null, closedId: current?.id ?? null };
    });
    if (!result.ok) return result;
    forgetToken(result.connection.id);
    if (result.closedId) forgetToken(result.closedId);
    return { ok: true, connection: result.connection, replaced: result.replaced };
  } catch (err) {
    // The other partial unique index: two connects for this tenant at
    // once. The advisory lock only covers the account.
    if ((err as { code?: string }).code === '23505') {
      return { ok: false, status: 409, error: 'connection_in_progress' };
    }
    throw err;
  }
}

async function closeConnection(
  trx: Knex,
  connectionId: string,
  reason: NonNullable<TenantStripeConnectionRow['disconnectReason']>,
  now: Date,
): Promise<number> {
  return trx<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
    .where({ id: connectionId })
    .whereNull('disconnectedAt')
    .update({
      disconnectedAt: now,
      disconnectReason: reason,
      refreshTokenEnc: null,
      accessTokenEnc: null,
      accessTokenExpiresAt: null,
      updatedAt: now,
    });
}

/** The admin's Disconnect. Wipes the tokens; the install stays on the
 *  brand's Stripe account until they uninstall it there (Stripe has no API
 *  for an app to uninstall itself), but nothing reads it any more. */
export async function disconnectTenant(knex: Knex, tenantId: string): Promise<TenantStripeConnectionRow | null> {
  const current = await activeConnectionForTenant(knex, tenantId);
  if (!current) return null;
  await closeConnection(knex, current.id, 'admin', new Date());
  forgetToken(current.id);
  return current;
}

/**
 * Stripe says the app was uninstalled from this account (or the install
 * deleted). Close the live connection in that mode. An uninstall from the
 * test-mode sandbox leaves a live connection alone, and vice versa.
 */
export async function disconnectAccount(stripeAccountId: string, livemode: boolean): Promise<string[]> {
  const rows = (await db<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
    .where({ stripeAccountId, livemode })
    .whereNull('disconnectedAt')
    .select('id', 'tenantId')) as Array<Pick<TenantStripeConnectionRow, 'id' | 'tenantId'>>;
  const now = new Date();
  for (const row of rows) {
    await closeConnection(db, row.id, 'deauthorized', now);
    forgetToken(row.id);
  }
  return rows.map((r) => r.tenantId);
}

/** Record what Stripe says the brand granted (apps.install.created /
 *  updated). Customer rewards check it for the write permissions. */
export async function recordPermissionsGranted(
  stripeAccountId: string,
  livemode: boolean,
  permissions: string[],
): Promise<number> {
  return db<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
    .where({ stripeAccountId, livemode })
    .whereNull('disconnectedAt')
    .update({ permissionsGranted: JSON.stringify(permissions) as unknown as string[], updatedAt: new Date() });
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** The live connection for an account, across tenants (privileged pool) —
 *  how an inbound app event finds its tenant. Never from event metadata:
 *  the brand controls its own objects' metadata. */
export async function activeConnectionForAccount(stripeAccountId: string): Promise<TenantStripeConnectionRow | null> {
  const row = await db<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
    .where({ stripeAccountId })
    .whereNull('disconnectedAt')
    .first();
  return (row as TenantStripeConnectionRow | undefined) ?? null;
}

/** Explicit tenant filter, not RLS alone: appDb falls back to the
 *  privileged role when DATABASE_URL_APP is unset. */
export async function activeConnectionForTenant(knex: Knex, tenantId: string): Promise<TenantStripeConnectionRow | null> {
  const row = await knex<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
    .where({ tenantId })
    .whereNull('disconnectedAt')
    .first();
  return (row as TenantStripeConnectionRow | undefined) ?? null;
}

/** Should this tenant's Stripe events be processed? Not while it's
 *  inactive or inside its deletion grace window: every request to it 410s
 *  then, and a brand that asked to be deleted has asked us to stop. Its
 *  connection rows go with the tenant at hard delete (FK cascade). */
export async function tenantAcceptsStripeEvents(tenantId: string): Promise<boolean> {
  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['status', 'pendingDeletionAt']);
  return tenant != null && tenant.status === 'active' && tenant.pendingDeletionAt == null;
}

/** Best-effort "last event received" stamp for the portal. */
export async function touchConnection(connectionId: string): Promise<void> {
  try {
    await db(TABLES.TenantStripeConnection).where({ id: connectionId }).update({ lastEventAt: new Date() });
  } catch (err) {
    console.warn('[stripe-app] lastEventAt update failed', { connectionId, err });
  }
}

/** Has the brand granted both reward write permissions? Unknown (Stripe
 *  hasn't sent the install's grant list) counts as yes: version 1 of the
 *  manifest requests them, and a refused call is logged and non-fatal. */
export function grantsRewardWrites(conn: Pick<TenantStripeConnectionRow, 'permissionsGranted'>): boolean {
  const granted = conn.permissionsGranted;
  if (!Array.isArray(granted)) return true;
  return granted.includes('coupon_write') && granted.includes('promotion_code_write');
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

/** The connection can't be used: disconnected, or Stripe refused the
 *  refresh and the brand has to reconnect. */
export class StripeConnectionUnavailableError extends Error {
  constructor(
    readonly reason: 'disconnected' | 'reconnect_needed',
    readonly connectionId: string,
  ) {
    super(`stripe_connection_${reason}`);
    this.name = 'StripeConnectionUnavailableError';
  }
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const inflight = new Map<string, Promise<string>>();

function forgetToken(connectionId: string): void {
  tokenCache.delete(connectionId);
}

/** For tests: drop every cached access token. */
export function __resetStripeAppTokenCacheForTests(): void {
  tokenCache.clear();
  inflight.clear();
}

/** A Stripe client acting on the brand's account with the connection's
 *  access token, refreshed first when it's within REFRESH_MARGIN_MS of
 *  expiring. Throws StripeConnectionUnavailableError when there's no usable
 *  connection; a transient refresh failure (network, Stripe 5xx) throws
 *  as-is so the caller can retry. */
export async function brandStripe(conn: Pick<TenantStripeConnectionRow, 'id' | 'tenantId'>): Promise<Stripe> {
  return new Stripe(await accessToken(conn.id, conn.tenantId), { maxNetworkRetries: 1 });
}

async function accessToken(connectionId: string, tenantId: string): Promise<string> {
  const cached = tokenCache.get(connectionId);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;
  // One refresh per connection per process; other processes queue on the
  // row lock inside refreshAccessToken.
  let pending = inflight.get(connectionId);
  if (!pending) {
    pending = refreshAccessToken(connectionId, tenantId).finally(() => inflight.delete(connectionId));
    inflight.set(connectionId, pending);
  }
  return pending;
}

type RefreshOutcome =
  | { kind: 'ok'; token: string; expiresAt: number }
  | { kind: 'disconnected' }
  | { kind: 'reconnect_needed' }
  | { kind: 'refresh_refused'; error: string; stripeAccountId: string };

/**
 * Hand out a valid access token, refreshing under the connection's row
 * lock. Exported for the concurrency test; callers use brandStripe().
 *
 * The lock is what keeps a rotating refresh token alive across processes:
 * whoever holds it either finds a token another holder just stored and
 * uses that, or refreshes and stores the NEW refresh token before letting
 * go. Without it, two refreshes would each present the same refresh token
 * and the loser's rotation would kill the winner's.
 *
 * Only invalid_grant (revoked, expired, already used) marks the connection
 * "reconnect needed" — that's the brand's grant gone. Any other refusal is
 * most likely OUR misconfiguration (a wrong developer key), which
 * reconnecting wouldn't fix: it's thrown, loudly, and nothing is marked.
 *
 * Residual risk: if Stripe rotates the token and our COMMIT then fails, the
 * new refresh token is lost and the old one is dead. The brand sees
 * "reconnect needed" on the next refresh.
 */
export async function refreshAccessToken(connectionId: string, tenantId: string): Promise<string> {
  const outcome = await withTenantTransaction(tenantId, async (trx): Promise<RefreshOutcome> => {
    const row = (await trx<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
      .where({ id: connectionId, tenantId })
      .forUpdate()
      .first()) as TenantStripeConnectionRow | undefined;
    if (!row || row.disconnectedAt || !row.refreshTokenEnc) return { kind: 'disconnected' };
    if (row.refreshFailedAt) return { kind: 'reconnect_needed' };
    const storedExpiry = row.accessTokenExpiresAt ? new Date(row.accessTokenExpiresAt).getTime() : 0;
    if (row.accessTokenEnc && storedExpiry - REFRESH_MARGIN_MS > Date.now()) {
      return { kind: 'ok', token: decryptSecret(row.accessTokenEnc), expiresAt: storedExpiry };
    }

    let tokens: OAuthTokenResponse;
    try {
      tokens = await postOAuthToken(row.keyMode, {
        grant_type: 'refresh_token',
        refresh_token: decryptSecret(row.refreshTokenEnc),
      });
    } catch (err) {
      if (err instanceof StripeAppOAuthError && err.code === 'invalid_grant') {
        await trx<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
          .where({ id: row.id })
          .update({
            refreshFailedAt: new Date(),
            refreshError: err.message.slice(0, 500),
            accessTokenEnc: null,
            accessTokenExpiresAt: null,
            updatedAt: new Date(),
          });
        return { kind: 'refresh_refused', error: err.message, stripeAccountId: row.stripeAccountId };
      }
      if (err instanceof StripeAppOAuthError) {
        console.error(
          `[stripe-app] ALERT: token refresh for connection ${row.id} refused with ${err.code} (${err.status}) — check STRIPE_APP_SECRET_KEY for ${row.keyMode} mode; connection left as is`,
        );
      }
      throw err;
    }
    if (tokens.stripe_user_id !== row.stripeAccountId) {
      console.error(
        `[stripe-app] ALERT: refresh for connection ${row.id} returned account ${tokens.stripe_user_id}, expected ${row.stripeAccountId} — tokens stored, investigate`,
      );
    }
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;
    await trx<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
      .where({ id: row.id })
      .update({
        refreshTokenEnc: encryptSecret(tokens.refresh_token),
        accessTokenEnc: encryptSecret(tokens.access_token),
        accessTokenExpiresAt: new Date(expiresAt),
        lastRefreshedAt: new Date(),
        updatedAt: new Date(),
      });
    return { kind: 'ok', token: tokens.access_token, expiresAt };
  });

  switch (outcome.kind) {
    case 'ok':
      tokenCache.set(connectionId, { token: outcome.token, expiresAt: outcome.expiresAt });
      return outcome.token;
    case 'disconnected':
      forgetToken(connectionId);
      throw new StripeConnectionUnavailableError('disconnected', connectionId);
    case 'reconnect_needed':
      forgetToken(connectionId);
      throw new StripeConnectionUnavailableError('reconnect_needed', connectionId);
    case 'refresh_refused': {
      forgetToken(connectionId);
      // Fires once per failure: later calls stop at refreshFailedAt above.
      console.error(
        `[stripe-app] ALERT: Stripe refused to refresh connection ${connectionId} (tenant ${tenantId}, ${outcome.stripeAccountId}): ${outcome.error} — brand must reconnect; its Stripe events are skipped until then`,
      );
      const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['displayName', 'slug']);
      await sendOpsEmail(
        db,
        opsStripeAppReconnectEmail(tenant?.displayName ?? tenantId, tenant?.slug ?? tenantId, outcome.stripeAccountId, outcome.error),
        'ops_stripe_app_reconnect',
      );
      throw new StripeConnectionUnavailableError('reconnect_needed', connectionId);
    }
  }
}

/** Would brandStripeForRewards find a usable connection? A state check for
 *  the admin UI (customerRewardDelivery) — it never refreshes a token. */
export async function stripeAppRewardsAvailable(tenantId: string): Promise<boolean> {
  if (configuredKeyModes().length === 0) return false;
  const conn = await activeConnectionForTenant(db, tenantId);
  return conn != null && !conn.refreshFailedAt && grantsRewardWrites(conn);
}

/**
 * The brand's Stripe client for customer rewards, or null when this tenant
 * has no usable connection that grants coupon + promotion-code writes.
 * Never OpenPartner's own account: a reward minted there would be
 * redeemable against OpenPartner's plans and never reach the brand's
 * checkout (customer-rewards.ts).
 */
export async function brandStripeForRewards(tenantId: string): Promise<Stripe | null> {
  if (configuredKeyModes().length === 0) return null;
  const conn = await activeConnectionForTenant(db, tenantId);
  if (!conn || conn.refreshFailedAt || !grantsRewardWrites(conn)) return null;
  try {
    return await brandStripe(conn);
  } catch (err) {
    if (err instanceof StripeConnectionUnavailableError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Forwarded conversions vs. Stripe-sourced revenue
// ---------------------------------------------------------------------------

/** Stripe ids the app records revenue under: an invoice (invoice.paid) or
 *  a Checkout Session (a one-time Checkout / Payment Link purchase). */
const STRIPE_TRANSACTION_KEY = /^(in|cs_(live|test))_[A-Za-z0-9]+$/;

/**
 * Is this externalEventId a Stripe transaction the brand's connected
 * Stripe account reports to us itself? Then a forwarded conversion under
 * that key is refused (409 recorded_from_stripe), whichever arrives first:
 * the Stripe-sourced Event — Stripe's amount, Stripe's customer — is the
 * one record of that payment, and the forwarded copy can neither pay the
 * partner twice nor understate the amount the platform fee is billed on.
 *
 * Only while the connection is healthy: a connection waiting for a
 * reconnect isn't recording anything, so forwarding is the brand's only
 * path. A conversion forwarded under the brand's own order id can't be
 * matched to a Stripe payment; docs/stripe-app.md tells brands to stop
 * forwarding Stripe-billed revenue once connected.
 */
export async function recordedFromStripe(knex: Knex, tenantId: string, externalEventId: string | null | undefined): Promise<boolean> {
  if (!externalEventId || !STRIPE_TRANSACTION_KEY.test(externalEventId) || !isHostedMode()) return false;
  const row = await knex<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
    .where({ tenantId })
    .whereNull('disconnectedAt')
    .whereNull('refreshFailedAt')
    .first('id');
  return row != null;
}

export const RECORDED_FROM_STRIPE_DETAIL =
  "Your Stripe account is connected, so Stripe invoices and Checkout payments (and partner codes entered at Stripe Checkout) are recorded from Stripe directly. Don't report them here: link the Stripe customer to your user instead (client_reference_id at Checkout, or metadata.openpartner_user_id on the Customer).";
