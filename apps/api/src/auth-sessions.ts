/**
 * Magic-link token + session primitives. Generic over principal kind:
 * both admins and partners use the same magic-link verify + session
 * cookie flow, differing only in which table we check + activate on
 * verify.
 *
 * Tokens look like `opml_<hex>` and sessions look like `ops_<hex>`. Both
 * use the same prefix+hash lookup as ApiKey — plaintext is only ever
 * held at generation + verify time.
 *
 * Multi-tenant: every function takes a `Knex` (typically `req.db`, the
 * per-request transaction with `app.tenant_id` set). issueMagicLink and
 * createSession also take `tenantId` because RLS WITH CHECK rejects
 * inserts that don't match the GUC, and the tenantId is needed to stamp
 * the row.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type MagicLinkTokenRow,
  type MagicLinkPurpose,
  type PrincipalKind,
  type SessionRow,
} from '@openpartner/db';

export const SESSION_COOKIE_NAME = 'op_session';
const TOKEN_PREFIX_LEN = 8;
const MAGIC_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hash(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function generate(prefixLiteral: string): { plaintext: string; prefix: string; tokenHash: string } {
  const raw = randomBytes(24).toString('hex');
  const plaintext = `${prefixLiteral}_${raw}`;
  return { plaintext, prefix: plaintext.slice(0, TOKEN_PREFIX_LEN), tokenHash: hash(plaintext) };
}

export interface IssuedMagicLink {
  plaintext: string;
  expiresAt: Date;
}

export async function issueMagicLink(
  db: Knex,
  params: {
    tenantId: string;
    email: string;
    purpose: MagicLinkPurpose;
    principalKind: PrincipalKind;
    principalId: string;
  },
): Promise<IssuedMagicLink> {
  const { plaintext, prefix, tokenHash } = generate('opml');
  const expiresAt = new Date(Date.now() + MAGIC_TTL_MS);
  await db<MagicLinkTokenRow>(TABLES.MagicLinkToken).insert({
    id: ulid(),
    tenantId: params.tenantId,
    prefix,
    tokenHash,
    email: params.email.toLowerCase(),
    purpose: params.purpose,
    principalKind: params.principalKind,
    principalId: params.principalId,
    expiresAt,
  });
  return { plaintext, expiresAt };
}

export interface ConsumedMagicLink {
  token: MagicLinkTokenRow;
}

export async function consumeMagicLink(db: Knex, plaintext: string): Promise<ConsumedMagicLink | null> {
  if (plaintext.length < TOKEN_PREFIX_LEN) return null;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const now = new Date();

  const updated = await db<MagicLinkTokenRow>(TABLES.MagicLinkToken)
    .where({ prefix, tokenHash })
    .whereNull('consumedAt')
    .andWhere('expiresAt', '>', now)
    .update({ consumedAt: now })
    .returning('*');

  const row = updated[0];
  return row ? { token: row as MagicLinkTokenRow } : null;
}

export interface IssuedSession {
  plaintext: string;
  id: string;
  expiresAt: Date;
}

export async function createSession(
  db: Knex,
  params: {
    tenantId: string;
    principalKind: PrincipalKind;
    principalId: string;
  },
): Promise<IssuedSession> {
  const { plaintext, prefix, tokenHash } = generate('ops');
  const id = ulid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db<SessionRow>(TABLES.Session).insert({
    id,
    tenantId: params.tenantId,
    prefix,
    tokenHash,
    principalKind: params.principalKind,
    principalId: params.principalId,
    expiresAt,
  });
  return { plaintext, id, expiresAt };
}

/**
 * Resolve a session cookie.
 *
 * `expectTenantId` is REQUIRED rather than optional, and that is deliberate.
 * This lookup used to match on `{prefix, tokenHash}` alone and rely on RLS to
 * keep it inside the request's tenant — but `appDb` falls back to the
 * privileged `DATABASE_URL` when `DATABASE_URL_APP` is unset (a configuration
 * db.ts documents as supported), and there RLS is bypassed. Tenant A's cookie
 * then resolved against `/t/tenant-b/...` and `resolvePrincipal` handed back
 * an admin principal for B (round 8). The API-key path was bound in round 7;
 * this is the other half of the same hole.
 *
 * Pass `null` ONLY where the caller is deliberately tenant-discovering and
 * does not grant a principal from the result — `/session/home` is the one
 * such caller. An optional parameter would have been the wrong shape here:
 * the whole failure mode is a security predicate someone forgets to pass.
 */
export async function resolveSession(
  db: Knex,
  plaintext: string,
  expectTenantId: string | null,
): Promise<SessionRow | null> {
  if (!plaintext || plaintext.length < TOKEN_PREFIX_LEN) return null;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const now = new Date();
  const q = db<SessionRow>(TABLES.Session)
    .where({ prefix, tokenHash })
    .whereNull('revokedAt')
    .andWhere('expiresAt', '>', now);
  if (expectTenantId !== null) q.andWhere({ tenantId: expectTenantId });
  const row = await q.first();
  if (!row) return null;

  // Defense-in-depth: if the principal was revoked but somehow a session
  // slipped through, reject here too.
  // Scoped to the session's own tenant as well: on the privileged pool a
  // bare principalId lookup would happily match another tenant's row.
  if (row.principalKind === 'partner') {
    const partner = (await db('Partner')
      .where({ id: row.principalId, tenantId: row.tenantId })
      .first()) as { revokedAt: Date | null } | undefined;
    if (!partner || partner.revokedAt) return null;
  } else if (row.principalKind === 'admin') {
    const admin = (await db('Admin')
      .where({ id: row.principalId, tenantId: row.tenantId })
      .first()) as { revokedAt: Date | null; activatedAt: Date | null } | undefined;
    if (!admin || admin.revokedAt || !admin.activatedAt) return null;
  }

  void db<SessionRow>(TABLES.Session).where({ id: row.id }).update({ lastSeenAt: now });
  return row;
}

export async function revokeSession(db: Knex, id: string): Promise<void> {
  await db<SessionRow>(TABLES.Session).where({ id }).update({ revokedAt: new Date() });
}

/**
 * Revoke whatever session a token names, WITHOUT resolving a principal and
 * WITHOUT filtering by tenant.
 *
 * Signout used to go through `resolveSession`, which round 8 correctly bound
 * to the request tenant — and that silently broke logout (round 9). The
 * `op_session` cookie is host-wide at `path: '/'`, so entering a second
 * workspace overwrites it; a signout from a stale tab then carries tenant
 * B's token to tenant A's URL. The tenant-filtered lookup found nothing, the
 * route cleared the browser cookie and returned 200 — and B's session stayed
 * valid server-side. "Logged out" that leaves a live token is worse than the
 * cross-tenant read the binding was added to prevent.
 *
 * Revoking a token the caller already holds grants nothing and leaks
 * nothing, so it needs no tenant predicate — it is strictly a destruction of
 * the bearer's own credential. That is why this is separate from
 * `resolveSession` rather than a flag on it: the two operations have
 * genuinely different safety requirements, and one function serving both is
 * how the binding got applied where it did not belong.
 */
export async function revokeSessionByToken(db: Knex, plaintext: string): Promise<boolean> {
  if (!plaintext || plaintext.length < TOKEN_PREFIX_LEN) return false;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const updated = await db<SessionRow>(TABLES.Session)
    .where({ prefix, tokenHash })
    .whereNull('revokedAt')
    .update({ revokedAt: new Date() });
  return updated > 0;
}

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}
