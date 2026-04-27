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
const PUSH_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 8; // exponential backoff: ~24h max wall time

// ---------- config shape ----------

export interface NetworkMembership {
  enabled: boolean;
  networkUrl: string; // e.g. https://network.openpartner.dev
  vendorTokenCiphertext: string; // encrypted bearer for vendor → Network
  scopedKeyId: string | null; // ApiKey.id of the scoped key Network calls back with
  autoEnroll: boolean;
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
  if (!m || !m.enabled || !m.networkUrl || !m.vendorTokenCiphertext) {
    return null; // Network not configured for this tenant — silent no-op.
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

  const url = endpointForOp(m.networkUrl, op);
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
}

export interface SignupResult {
  vendorId: string;
  status: 'pending';
  emailSent: boolean;
}

export async function signupWithNetwork(input: SignupInput): Promise<SignupResult> {
  const url = `${input.networkUrl.replace(/\/$/, '')}/vendors/signup`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'OpenPartner-Vendor/1' },
    body: JSON.stringify({
      instanceUrl: input.instanceUrl,
      scopedKey: input.scopedKey,
      displayName: input.displayName,
      tier: input.tier,
      contact: { email: input.contactEmail, name: input.contactName },
      portalCallbackUrl: input.portalCallbackUrl,
    }),
    signal: AbortSignal.timeout(10_000),
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
