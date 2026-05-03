/**
 * Vendor-side client for the OpenPartner Network.
 *
 * The Network is the marketplace coordinator at network.openpartner.dev
 * (a separate service in the openpartner-network repo). Vendors push
 * partner upserts and revokes to it so a creator joining one vendor's
 * program can be matched with other vendors' programs.
 *
 * Hard rule: a vendor request that succeeds locally must never fail
 * because the Network is down. Every push goes through `dispatch()`
 * which tries the call once with a 5s timeout and, on failure,
 * persists a NetworkOutbox row for the scheduler to drain.
 *
 * Per-tenant: every call is scoped via `network_membership` Config.
 * Tenants without that row treat the Network as disabled and short-
 * circuit (the partner mutation path is a no-op for them).
 *
 * The wire contract is documented in docs/network-protocol.md. If you
 * change a payload shape here, update the doc — the Network repo
 * builds against it.
 */

import { ulid } from 'ulid';
import type { Knex } from 'knex';
import { TABLES, type NetworkOutboxRow } from '@openpartner/db';
import { decryptSecret, encryptSecret } from './crypto.js';

const CONFIG_KEY = 'network_membership';
// Outbox / fire-and-forget pushes — short timeout, the scheduler retries.
const PUSH_TIMEOUT_MS = 5_000;
// Synchronous admin proxy calls (/admin/network/*). Network can cold-start
// from idle on App Platform basic-xs, which takes 10-20s, so a 5s budget
// here meant every first-after-idle render of the Network admin page
// failed with 504. Keep it generous; the request blocks the admin UI.
const PROXY_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 8; // exponential backoff: ~24h max wall time

// ---------- config shape ----------

export interface NetworkMembership {
  enabled: boolean;
  networkUrl: string; // e.g. https://network.openpartner.dev
  vendorTokenCiphertext: string; // encrypted bearer for vendor → Network
  scopedKeyId: string | null; // ApiKey.id of the scoped key Network calls back with
  autoEnroll: boolean;
  /** Network's id for our vendor row. Persisted at signup so account
   *  restore can call /vendors/admin-restore (which needs the id —
   *  by then the vendorToken is gone). Optional for backward compat
   *  with rows written before this field existed. */
  vendorId?: string;
}

interface PublicNetworkMembership {
  enabled: boolean;
  networkUrl: string;
  hasVendorToken: boolean;
  scopedKeyId: string | null;
  autoEnroll: boolean;
}

export async function getNetworkMembership(
  db: Knex,
  tenantId: string,
): Promise<NetworkMembership | null> {
  const row = await db(TABLES.Config).where({ tenantId, key: CONFIG_KEY }).first();
  return (row?.value as NetworkMembership | undefined) ?? null;
}

export async function getPublicNetworkMembership(
  db: Knex,
  tenantId: string,
): Promise<PublicNetworkMembership> {
  const m = await getNetworkMembership(db, tenantId);
  if (!m) {
    return { enabled: false, networkUrl: '', hasVendorToken: false, scopedKeyId: null, autoEnroll: false };
  }
  return {
    enabled: m.enabled,
    networkUrl: m.networkUrl,
    hasVendorToken: !!m.vendorTokenCiphertext,
    scopedKeyId: m.scopedKeyId,
    autoEnroll: m.autoEnroll,
  };
}

export interface SaveNetworkMembershipInput {
  enabled?: boolean;
  networkUrl?: string;
  /** Plaintext token. Undefined = keep existing; '' = clear. */
  vendorToken?: string;
  scopedKeyId?: string | null;
  autoEnroll?: boolean;
  vendorId?: string;
}

export async function saveNetworkMembership(
  db: Knex,
  tenantId: string,
  input: SaveNetworkMembershipInput,
): Promise<void> {
  const current = (await getNetworkMembership(db, tenantId)) ?? {
    enabled: false,
    networkUrl: '',
    vendorTokenCiphertext: '',
    scopedKeyId: null,
    autoEnroll: false,
  };

  const next: NetworkMembership = {
    enabled: input.enabled ?? current.enabled,
    networkUrl: input.networkUrl ?? current.networkUrl,
    vendorTokenCiphertext:
      input.vendorToken === undefined
        ? current.vendorTokenCiphertext
        : input.vendorToken === ''
          ? ''
          : encryptSecret(input.vendorToken),
    scopedKeyId: input.scopedKeyId === undefined ? current.scopedKeyId : input.scopedKeyId,
    autoEnroll: input.autoEnroll ?? current.autoEnroll,
    vendorId: input.vendorId ?? current.vendorId,
  };

  const now = new Date();
  await db(TABLES.Config)
    .insert({ tenantId, key: CONFIG_KEY, value: next as unknown as never, updatedAt: now })
    .onConflict(['tenantId', 'key'])
    .merge({ value: next as unknown as never, updatedAt: now });
}

// ---------- payload shapes (must match docs/network-protocol.md) ----------

export interface PartnerUpsertPayload {
  vendorPartnerId: string;
  email: string;
  name: string;
  profile?: Record<string, unknown>;
  joinedVendorAt: string;
  status: 'pending' | 'active' | 'revoked';
  metadata?: { source: 'self_signup' | 'admin_invite' | 'backfill' };
}

export interface PartnerUpsertResponse {
  networkCreatorId: string;
  alreadyExisted: boolean;
  affiliations: Array<{
    vendorId: string;
    vendorPartnerId: string;
    status: string;
    displayName: string;
  }>;
}

// ---------- dispatch ----------

/**
 * Run an op against the Network. Tries once synchronously with a short
 * timeout; on failure persists to NetworkOutbox and returns null. The
 * caller MUST treat null as a non-fatal "queued for retry".
 *
 * Returns the parsed response on success. Specific call sites that
 * care about the response (e.g. signup wanting networkCreatorId
 * immediately) await this; revoke fires void.
 */
export async function dispatch<T>(
  db: Knex,
  tenantId: string,
  op: NetworkOutboxRow['op'],
  payload: Record<string, unknown>,
): Promise<T | null> {
  const m = await getNetworkMembership(db, tenantId);
  if (!m || !m.enabled || !m.vendorTokenCiphertext) {
    return null; // Network not configured for this tenant — silent no-op.
  }

  // Same fallback as callNetwork: heal tenants that ended up with an
  // empty networkUrl on their membership row (email-verify path before
  // /start-connect was called) by reading from process.env.NETWORK_URL.
  const networkUrl = m.networkUrl || process.env.NETWORK_URL;
  if (!networkUrl) {
    console.error('[network] no networkUrl on membership and NETWORK_URL env unset');
    return null;
  }

  let token: string;
  try {
    token = decryptSecret(m.vendorTokenCiphertext);
  } catch (err) {
    // Bad ciphertext (encryption key rotated without re-storing). Don't
    // queue — the outbox would have the same problem on every retry.
    console.error('[network] vendor token undecryptable, skipping push', err);
    return null;
  }

  const url = endpointForOp(networkUrl, op);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': 'OpenPartner-Vendor/1',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`network ${res.status}: ${await res.text().catch(() => '<no body>')}`);
    }
    return (await res.json().catch(() => null)) as T | null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await enqueue(db, tenantId, op, payload, msg);
    return null;
  }
}

async function enqueue(
  db: Knex,
  tenantId: string,
  op: NetworkOutboxRow['op'],
  payload: Record<string, unknown>,
  err: string,
): Promise<void> {
  await db(TABLES.NetworkOutbox).insert({
    id: ulid(),
    tenantId,
    op,
    payload: payload as unknown as never,
    attempts: 1,
    nextAttemptAt: nextBackoff(1),
    lastAttemptAt: new Date(),
    lastError: err,
    status: 'pending',
  });
}

function nextBackoff(attempts: number): Date {
  // 30s, 1m, 2m, 5m, 15m, 1h, 4h, 12h — total ~24h with MAX_ATTEMPTS=8.
  const schedule = [30, 60, 120, 300, 900, 3600, 14400, 43200];
  const seconds = schedule[Math.min(attempts - 1, schedule.length - 1)] ?? 43200;
  return new Date(Date.now() + seconds * 1000);
}

function endpointForOp(networkUrl: string, op: NetworkOutboxRow['op']): string {
  const base = networkUrl.replace(/\/$/, '');
  switch (op) {
    case 'partner_upsert':
    case 'partner_revoke':
    case 'backfill_partner':
      return `${base}/partners/upsert`;
    default:
      throw new Error(`unknown network op: ${op}`);
  }
}

// ---------- public surface ----------

export async function pushPartnerUpsert(
  db: Knex,
  tenantId: string,
  payload: PartnerUpsertPayload,
): Promise<PartnerUpsertResponse | null> {
  return dispatch<PartnerUpsertResponse>(db, tenantId, 'partner_upsert', payload as unknown as Record<string, unknown>);
}

export async function pushPartnerRevoke(
  db: Knex,
  tenantId: string,
  vendorPartnerId: string,
): Promise<void> {
  await dispatch(db, tenantId, 'partner_revoke', {
    vendorPartnerId,
    status: 'revoked',
    revokedAt: new Date().toISOString(),
  });
}

// ---------- backfill (used by Settings → Network → "Backfill") ----------

export interface BackfillPartnersResult {
  total: number;
  pushed: number;
  queued: number; // pushed to outbox after Network failure
}

export async function backfillPartners(
  db: Knex,
  tenantId: string,
  partners: Array<{ id: string; email: string; name: string; createdAt: Date; activatedAt: Date | null; revokedAt: Date | null }>,
): Promise<BackfillPartnersResult> {
  let pushed = 0;
  let queued = 0;
  for (const p of partners) {
    const status: PartnerUpsertPayload['status'] = p.revokedAt
      ? 'revoked'
      : p.activatedAt
        ? 'active'
        : 'pending';
    const result = await pushPartnerUpsert(db, tenantId, {
      vendorPartnerId: p.id,
      email: p.email,
      name: p.name,
      joinedVendorAt: p.createdAt.toISOString(),
      status,
      metadata: { source: 'backfill' },
    });
    if (result) {
      // Stamp the canonical Network id back onto the Partner row so
      // future admin views can show "this creator is on the Network".
      await db(TABLES.Partner)
        .where({ id: p.id })
        .update({
          metadata: db.raw(
            `jsonb_set(coalesce("metadata", '{}'::jsonb), '{network}', ?::jsonb, true)`,
            [
              JSON.stringify({
                creatorId: result.networkCreatorId,
                preExisting: result.alreadyExisted,
                affiliations: result.affiliations.length,
                syncedAt: new Date().toISOString(),
              }),
            ],
          ),
          updatedAt: new Date(),
        });
      pushed += 1;
    } else {
      queued += 1;
    }
  }
  return { total: partners.length, pushed, queued };
}

// ---------- Self-serve onboarding helpers ----------
// These talk to Network /vendors/signup + /vendors/verify-and-issue-token.
// Unlike the upsert path, failures here surface to the admin immediately
// (no outbox); a failed signup is something the admin will retry by hand.

export interface SignupInput {
  networkUrl: string;
  instanceUrl: string;
  scopedKey: string;
  displayName: string;
  contactEmail: string;
  contactName?: string;
  tier: 'hosted' | 'self_hosted';
  portalCallbackUrl: string;
  /** When set, send as admin bearer for the fast-path signup (skips
   *  email verify, returns vendorToken inline). Only set on hosted
   *  tenants where the brand admin's email was already verified by
   *  openpartner's signup. */
  adminAuthToken?: string;
}

export type SignupResult =
  | { vendorId: string; status: 'pending'; emailSent: boolean }
  | { vendorId: string; vendorToken: string; status: 'active'; displayName: string };

export async function signupWithNetwork(input: SignupInput): Promise<SignupResult> {
  const url = `${input.networkUrl.replace(/\/$/, '')}/vendors/signup`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'OpenPartner-Vendor/1',
  };
  if (input.adminAuthToken) {
    headers.authorization = `Bearer ${input.adminAuthToken}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      instanceUrl: input.instanceUrl,
      scopedKey: input.scopedKey,
      displayName: input.displayName,
      tier: input.tier,
      contact: { email: input.contactEmail, name: input.contactName },
      portalCallbackUrl: input.portalCallbackUrl,
    }),
    // Network's signup is synchronous: row insert + magic-link insert +
    // Postmark send all inside one transaction. Cold-start can push the
    // mail send past the old 10s budget; bump to 30s so we don't ETIMEDOUT
    // a request that ultimately succeeds (the user gets the email but
    // sees a 502 in the UI, then double-clicks and lands on already-pending).
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`network signup failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as SignupResult;
}

export interface VerifyResult {
  vendorId: string;
  vendorToken: string;
  displayName: string;
  issuedAt: string;
}

export async function completeNetworkConnect(networkUrl: string, ntoken: string): Promise<VerifyResult> {
  const url = `${networkUrl.replace(/\/$/, '')}/vendors/verify-and-issue-token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'OpenPartner-Vendor/1' },
    body: JSON.stringify({ token: ntoken }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`network verify failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as VerifyResult;
}

// ---------- Direct Network proxy calls (used by /admin/network/* routes) ----------
//
// The vendor admin's portal needs to manage offerings + review
// partnership requests against the Network. Both require the
// vendorToken (server-side secret in network_membership). The portal
// can't hold it, so the openpartner backend proxies on behalf of the
// admin: load membership → use vendorToken → call Network → return.

async function callNetwork<T>(
  db: Knex,
  tenantId: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts?: { actingVendorPartnerId?: string },
): Promise<T> {
  const m = await getNetworkMembership(db, tenantId);
  if (!m || !m.enabled || !m.vendorTokenCiphertext) {
    throw new NetworkProxyError(503, 'network_not_configured');
  }
  // Fall back to process.env.NETWORK_URL when the membership row has
  // an empty networkUrl. Some tenants ended up in this state when the
  // email-verify path ran without a prior /start-connect to seed the
  // row — they still have a vendorToken but no URL. Heal silently
  // here; the next saveNetworkMembership write persists the env value.
  const networkUrl = m.networkUrl || process.env.NETWORK_URL;
  if (!networkUrl) {
    throw new NetworkProxyError(503, 'network_url_unresolvable');
  }
  let token: string;
  try {
    token = decryptSecret(m.vendorTokenCiphertext);
  } catch (err) {
    throw new NetworkProxyError(500, `vendor_token_undecryptable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const url = `${networkUrl.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'user-agent': 'OpenPartner-Vendor/1',
  };
  if (opts?.actingVendorPartnerId) {
    // Tells the Network: this call is the vendor proxying on behalf of one
    // of its own partners. The Network resolves the Creator via
    // VendorAffiliation(vendorId, vendorPartnerId).
    headers['x-act-as-vendor-partner'] = opts.actingVendorPartnerId;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    // Log the full upstream response so federation_failed / similar
    // errors with a long detail field are visible in API logs without
    // having to dig through browser devtools. Status ≥400 only — 2xx
    // would be noisy.
    console.error('[network-client] upstream error', {
      method,
      path,
      status: res.status,
      body: text.length > 1000 ? `${text.slice(0, 1000)}…(truncated)` : text,
    });
    throw new NetworkProxyError(res.status, text.slice(0, 500) || `http_${res.status}`);
  }
  return text ? (JSON.parse(text) as T) : (null as unknown as T);
}

export class NetworkProxyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'NetworkProxyError';
  }
}

// Thin wrappers — they're a 1:1 with Network endpoints. Kept here so
// the route handlers stay declarative.
export const networkProxy = {
  listOfferings: (db: Knex, tenantId: string) =>
    callNetwork<{ offerings: unknown[] }>(db, tenantId, 'GET', '/vendors/me/offerings'),
  createOffering: (db: Knex, tenantId: string, body: unknown) =>
    callNetwork<unknown>(db, tenantId, 'POST', '/vendors/me/offerings', body),
  updateOffering: (db: Knex, tenantId: string, id: string, body: unknown) =>
    callNetwork<unknown>(db, tenantId, 'PATCH', `/vendors/me/offerings/${encodeURIComponent(id)}`, body),
  deleteOffering: (db: Knex, tenantId: string, id: string) =>
    callNetwork<{ ok: boolean }>(db, tenantId, 'DELETE', `/vendors/me/offerings/${encodeURIComponent(id)}`),
  listRequests: (db: Knex, tenantId: string, status?: string) =>
    callNetwork<{ requests: unknown[] }>(db, tenantId, 'GET', `/vendors/me/requests${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  approveRequest: (db: Knex, tenantId: string, id: string, body: unknown) =>
    callNetwork<unknown>(db, tenantId, 'POST', `/vendors/me/requests/${encodeURIComponent(id)}/approve`, body),
  rejectRequest: (db: Knex, tenantId: string, id: string, body: unknown) =>
    callNetwork<unknown>(db, tenantId, 'POST', `/vendors/me/requests/${encodeURIComponent(id)}/reject`, body),
  whoami: (db: Knex, tenantId: string) =>
    callNetwork<{ id: string; displayName: string; status: string; partnerCount: number }>(
      db,
      tenantId,
      'GET',
      '/vendors/me',
    ),

  /** Brand-side creator discovery — search the Network's creator
   *  directory with full-text + filter params. The querystring is
   *  forwarded verbatim, so the brand UI can pass whatever Network's
   *  schema accepts (q, categories, locations, platforms, minFollowers,
   *  maxFollowers, minRevenue90d, sort, limit). */
  discoverCreators: (db: Knex, tenantId: string, querystring: string) =>
    callNetwork<{ creators: unknown[] }>(
      db,
      tenantId,
      'GET',
      `/vendors/me/discover/creators${querystring ? `?${querystring}` : ''}`,
    ),

  /** Invite a creator to apply to one of this vendor's offerings.
   *  Network mints an OfferingInvitation + emails the creator a
   *  deeplink. Idempotent per (offering, creator) — re-inviting the
   *  same creator refreshes the token + expiry. */
  inviteCreator: (db: Knex, tenantId: string, offeringId: string, body: { creatorId: string; message?: string }) =>
    callNetwork<{ ok: true; expiresAt: string }>(
      db,
      tenantId,
      'POST',
      `/vendors/me/offerings/${encodeURIComponent(offeringId)}/invitations`,
      body,
    ),

  // Billing — same pattern (vendor token held server-side, portal can't
  // hit Stripe directly). Forwards body straight through; the Network's
  // route does all validation.
  getBilling: (db: Knex, tenantId: string) =>
    callNetwork<{
      billingRequired: boolean;
      bundledWithMainPlan: boolean;
      subscriptionStatus: string | null;
      stripeCustomerId: string | null;
      stripeSubscriptionId: string | null;
      currentPeriodEnd: string | null;
      networkPriceConfigured: boolean;
      networkUsagePriceConfigured: boolean;
      billingEnabled: boolean;
    }>(db, tenantId, 'GET', '/vendors/me/billing'),

  createCheckout: (db: Knex, tenantId: string, body: { successUrl: string; cancelUrl: string }) =>
    callNetwork<{ url: string }>(db, tenantId, 'POST', '/vendors/me/billing/checkout', body),

  openPortal: (db: Knex, tenantId: string, body: { returnUrl: string }) =>
    callNetwork<{ url: string }>(db, tenantId, 'POST', '/vendors/me/billing/portal', body),

  // Account deletion lifecycle. delete uses the tenant's vendorToken so
  // the call is naturally scoped to "this vendor"; restore goes through
  // the admin endpoint because by that point the vendorToken is gone.
  deleteVendor: (db: Knex, tenantId: string) =>
    callNetwork<{ ok: boolean }>(db, tenantId, 'POST', '/vendors/me/delete'),
};

export async function adminRestoreVendor(networkUrl: string, vendorId: string): Promise<{ vendorId: string; vendorToken: string }> {
  const adminKey = process.env.NETWORK_ADMIN_API_KEY;
  if (!adminKey) throw new Error('NETWORK_ADMIN_API_KEY not set — cannot restore vendor');
  const url = `${networkUrl.replace(/\/$/, '')}/vendors/admin-restore`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminKey}`,
      'user-agent': 'OpenPartner-Vendor/1',
    },
    body: JSON.stringify({ vendorId }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`network restore failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as { vendorId: string; vendorToken: string };
}

// ---------- Partner-acting Network proxy ----------
// Used by openpartner partner-role routes (/api/network/partner/*) to
// forward calls to Network's existing /creators/me/* + /offerings + /vendors/:id
// endpoints. Auth is the vendor bearer plus an x-act-as-vendor-partner
// header carrying the partner's vendor-local id; Network's requireCreator
// resolves the creator from VendorAffiliation(vendorId, vendorPartnerId).

export const partnerProxy = {
  // Discovery (public on Network — no acting header needed)
  listOfferings: (db: Knex, tenantId: string, qs: string) =>
    callNetwork<{ offerings: unknown[] }>(db, tenantId, 'GET', `/offerings${qs ? `?${qs}` : ''}`),
  getOffering: (db: Knex, tenantId: string, id: string) =>
    callNetwork<unknown>(db, tenantId, 'GET', `/offerings/${encodeURIComponent(id)}`),
  getVendor: (db: Knex, tenantId: string, id: string) =>
    callNetwork<unknown>(db, tenantId, 'GET', `/vendors/${encodeURIComponent(id)}`),

  // Acting-as-creator (need the header)
  applyToOffering: (db: Knex, tenantId: string, vendorPartnerId: string, id: string, body: unknown) =>
    callNetwork<unknown>(db, tenantId, 'POST', `/offerings/${encodeURIComponent(id)}/apply`, body, {
      actingVendorPartnerId: vendorPartnerId,
    }),
  listMyAffiliations: (db: Knex, tenantId: string, vendorPartnerId: string) =>
    callNetwork<{ affiliations: unknown[] }>(db, tenantId, 'GET', '/creators/me/affiliations', undefined, {
      actingVendorPartnerId: vendorPartnerId,
    }),
  getAffiliationEarnings: (db: Knex, tenantId: string, vendorPartnerId: string, affId: string) =>
    callNetwork<unknown>(
      db,
      tenantId,
      'GET',
      `/creators/me/affiliations/${encodeURIComponent(affId)}/earnings`,
      undefined,
      { actingVendorPartnerId: vendorPartnerId },
    ),
  listMyRequests: (db: Knex, tenantId: string, vendorPartnerId: string) =>
    callNetwork<{ requests: unknown[] }>(db, tenantId, 'GET', '/creators/me/requests', undefined, {
      actingVendorPartnerId: vendorPartnerId,
    }),
  cancelRequest: (db: Knex, tenantId: string, vendorPartnerId: string, reqId: string) =>
    callNetwork<{ ok: boolean }>(
      db,
      tenantId,
      'POST',
      `/creators/me/requests/${encodeURIComponent(reqId)}/cancel`,
      undefined,
      { actingVendorPartnerId: vendorPartnerId },
    ),
  getMyProfile: (db: Knex, tenantId: string, vendorPartnerId: string) =>
    callNetwork<unknown>(db, tenantId, 'GET', '/creators/me', undefined, {
      actingVendorPartnerId: vendorPartnerId,
    }),
  updateMyProfile: (db: Knex, tenantId: string, vendorPartnerId: string, body: unknown) =>
    callNetwork<unknown>(db, tenantId, 'PATCH', '/creators/me', body, {
      actingVendorPartnerId: vendorPartnerId,
    }),
};

// ---------- Network-originated payouts reporting ----------
//
// The Network bills self-hosted vendors 3% on payouts whose Partner
// came from the marketplace. Vendor side aggregates the period's
// Network-originated payout total and POSTs to /vendors/me/report-
// payouts; the Network turns it into a Stripe meter event.
//
// Cadence: piggyback on the openpartner scheduler (daily), keyed
// against a Config high-water mark. Hosted-tier vendors get 204'd by
// the Network (their billing is bundled), so this is a no-op cost
// from their perspective.

export interface NetworkPayoutsReportResult {
  rangeStart: Date | null;
  rangeEnd: Date;
  amountUsd: number;
  reported: boolean;
  reason?: string;
}

export async function reportNetworkPayoutsToNetwork(
  db: Knex,
  tenantId: string,
): Promise<NetworkPayoutsReportResult> {
  const m = await getNetworkMembership(db, tenantId);
  const rangeEnd = new Date();
  if (!m || !m.enabled || !m.networkUrl || !m.vendorTokenCiphertext) {
    return { rangeStart: null, rangeEnd, amountUsd: 0, reported: false, reason: 'network_not_configured' };
  }
  let token: string;
  try {
    token = decryptSecret(m.vendorTokenCiphertext);
  } catch {
    return { rangeStart: null, rangeEnd, amountUsd: 0, reported: false, reason: 'token_undecryptable' };
  }

  const { CONFIG_KEYS, getConfig, setConfig } = await import('./config.js');
  const { aggregateNetworkOriginatedPayouts } = await import('./usage-billing.js');

  const lastIso = await getConfig<string>(db, tenantId, CONFIG_KEYS.LastNetworkPayoutsReportedAt);
  const rangeStart = lastIso ? new Date(lastIso) : null;
  const amountUsd = await aggregateNetworkOriginatedPayouts(db, rangeStart, rangeEnd);

  if (amountUsd <= 0) {
    // Advance the high-water mark anyway so we don't re-scan the
    // same window. The Network endpoint short-circuits on 0 too,
    // but skipping the round-trip is cheaper.
    await setConfig(db, tenantId, CONFIG_KEYS.LastNetworkPayoutsReportedAt, rangeEnd.toISOString());
    return { rangeStart, rangeEnd, amountUsd: 0, reported: false, reason: 'no_network_payouts_in_range' };
  }

  const url = `${m.networkUrl.replace(/\/$/, '')}/vendors/me/report-payouts`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'user-agent': 'OpenPartner-Vendor/1',
    },
    body: JSON.stringify({
      amountUsd,
      sinceIso: rangeStart ? rangeStart.toISOString() : null,
      untilIso: rangeEnd.toISOString(),
    }),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    // DON'T advance the high-water mark on Network failures — next
    // tick re-includes this period's payouts. Same idempotency model
    // as the meter event: the Network's identifier dedups at Stripe.
    return {
      rangeStart,
      rangeEnd,
      amountUsd,
      reported: false,
      reason: `network ${res.status}: ${text.slice(0, 200)}`,
    };
  }
  await setConfig(db, tenantId, CONFIG_KEYS.LastNetworkPayoutsReportedAt, rangeEnd.toISOString());
  return { rangeStart, rangeEnd, amountUsd, reported: true };
}

// ---------- Heartbeat (Network liveness probe) ----------
//
// The Network uses partnerCount + lastHeartbeatAt to (a) populate the
// vendor's "active partners" stat in admin UIs, and (b) prune abandoned
// instances from creator-facing search after extended silence.
//
// Cadence: hourly via the scheduler — frequent enough that the displayed
// count feels live to brand admins, infrequent enough to be polite to
// the Network. Also opportunistically fired by `/admin/network/me` so a
// brand admin who just landed on the page after a partner was added
// sees fresh data on the next request.
//
// Counting: non-revoked Partners. lastEventAt is the most recent Event
// timestamp (any kind), giving the Network signal even from tenants
// who haven't added partners but are processing conversions.

export interface HeartbeatResult {
  sent: boolean;
  partnerCount: number;
  reason?: string;
}

export async function sendHeartbeat(db: Knex, tenantId: string): Promise<HeartbeatResult> {
  const m = await getNetworkMembership(db, tenantId);
  if (!m || !m.enabled || !m.networkUrl || !m.vendorTokenCiphertext) {
    return { sent: false, partnerCount: 0, reason: 'network_not_configured' };
  }
  let token: string;
  try {
    token = decryptSecret(m.vendorTokenCiphertext);
  } catch {
    return { sent: false, partnerCount: 0, reason: 'token_undecryptable' };
  }

  // Each local query is independently caught — without this a missing
  // column or RLS denial bubbles up as a generic 500 from whichever
  // route invoked us, hiding the real cause behind a meaningless
  // status code. Returning a descriptive reason lets the admin
  // diagnose without server log access.
  let partnerCount = 0;
  try {
    const partnerRows = await db(TABLES.Partner)
      .whereNull('revokedAt')
      .count<Array<{ count: string }>>({ count: '*' });
    partnerCount = Number(partnerRows[0]?.count ?? 0);
  } catch (err) {
    return { sent: false, partnerCount: 0, reason: `local_partner_count_failed: ${errMsg(err)}` };
  }

  let lastEventAt: string | undefined;
  try {
    // Event uses `ts` for the event timestamp, not `createdAt` — the
    // raw event time is the contract-relevant value (when the
    // conversion happened in the customer's session), not the row
    // insert time. Using `createdAt` here was a typo that 500'd the
    // heartbeat in prod and poisoned the request transaction.
    const lastEventRow = await db(TABLES.Event)
      .orderBy('ts', 'desc')
      .first<{ ts: Date } | undefined>('ts');
    lastEventAt = lastEventRow?.ts ? new Date(lastEventRow.ts).toISOString() : undefined;
  } catch (err) {
    return { sent: false, partnerCount, reason: `local_event_lookup_failed: ${errMsg(err)}` };
  }

  // Mirror Tenant.logoUrl up to the Network so the marketplace
  // listing can show the brand mark next to the vendor name. Empty
  // string clears (vendor uploaded then removed); undefined leaves
  // alone (legacy tenants without a logo column populated).
  let logoUrl = '';
  try {
    const tenantRow = await db(TABLES.Tenant).where({ id: tenantId }).first<{ logoUrl: string | null } | undefined>('logoUrl');
    logoUrl = tenantRow?.logoUrl ?? '';
  } catch (err) {
    // Most likely: Tenant.logoUrl migration not applied. Don't fail
    // the heartbeat — drop the field and continue. partnerCount +
    // lastEventAt still propagate, which is more useful than a 500.
    console.warn('[network-client] tenant logoUrl read failed; skipping logo propagation', err);
  }

  const url = `${m.networkUrl.replace(/\/$/, '')}/vendors/me/heartbeat`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': 'OpenPartner-Vendor/1',
      },
      body: JSON.stringify({
        partnerCount,
        ...(lastEventAt ? { lastEventAt } : {}),
        logoUrl,
      }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>');
      return { sent: false, partnerCount, reason: `network ${res.status}: ${text.slice(0, 200)}` };
    }
    return { sent: true, partnerCount };
  } catch (err) {
    return { sent: false, partnerCount, reason: errMsg(err) };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- outbox drain (called from scheduler.ts) ----------

export async function drainOutbox(db: Knex, tenantId: string): Promise<{ drained: number; succeeded: number; dead: number }> {
  const m = await getNetworkMembership(db, tenantId);
  if (!m || !m.enabled || !m.networkUrl || !m.vendorTokenCiphertext) {
    return { drained: 0, succeeded: 0, dead: 0 };
  }
  let token: string;
  try {
    token = decryptSecret(m.vendorTokenCiphertext);
  } catch {
    return { drained: 0, succeeded: 0, dead: 0 };
  }

  const due = await db<NetworkOutboxRow>(TABLES.NetworkOutbox)
    .where({ status: 'pending' })
    .andWhere('nextAttemptAt', '<=', new Date())
    .orderBy('nextAttemptAt', 'asc')
    .limit(100);

  let succeeded = 0;
  let dead = 0;

  for (const row of due) {
    try {
      const url = endpointForOp(m.networkUrl, row.op);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'user-agent': 'OpenPartner-Vendor/1',
        },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`network ${res.status}`);
      }
      await db(TABLES.NetworkOutbox).where({ id: row.id }).del();
      succeeded += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempts >= MAX_ATTEMPTS) {
        await db(TABLES.NetworkOutbox).where({ id: row.id }).update({
          status: 'dead',
          attempts,
          lastAttemptAt: new Date(),
          lastError: msg,
        });
        dead += 1;
      } else {
        await db(TABLES.NetworkOutbox).where({ id: row.id }).update({
          attempts,
          nextAttemptAt: nextBackoff(attempts),
          lastAttemptAt: new Date(),
          lastError: msg,
        });
      }
    }
  }

  return { drained: due.length, succeeded, dead };
}
