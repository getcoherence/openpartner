/**
 * Platform-operator session helpers (brand-review console).
 *
 * Mirrors platform-sessions.ts, but the principal is a PlatformAdmin
 * (cross-tenant Coherence/OpenPartner staff) rather than a customer
 * identity. Tokens look like `opsadm_<hex>`; the cookie is
 * op_platform_admin_session, scoped to '/'. The row lives in
 * PlatformAdminSession — platform-scoped, no RLS, only ever touched by the
 * privileged `db` pool.
 *
 * These sessions authorize cross-tenant reads/writes via `req.platformAdmin
 * = true` (see requirePlatformAdmin in routes/platform-admin.ts); the RLS
 * escape hatch (`app.platform_admin = 'on'`) is set by tenantMiddleware for
 * any request that reaches it with that flag, but the review routes run on
 * the privileged pool BEFORE tenantMiddleware, so they bypass RLS directly.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import type { CookieOptions } from 'express';
import type { Knex } from 'knex';
import { TABLES, type PlatformAdminRow, type PlatformAdminSessionRow } from '@openpartner/db';

export const PLATFORM_ADMIN_SESSION_COOKIE = 'op_platform_admin_session';
const TOKEN_PREFIX_LEN = 8;
/** Shorter than customer sessions on purpose — an operator session grants
 *  cross-tenant reach, so we re-auth weekly rather than monthly. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface IssuedPlatformAdminSession {
  plaintext: string;
  expiresAt: Date;
}

export async function createPlatformAdminSession(
  db: Knex,
  admin: Pick<PlatformAdminRow, 'id' | 'email' | 'role'>,
): Promise<IssuedPlatformAdminSession> {
  const raw = randomBytes(24).toString('hex');
  const plaintext = `opsadm_${raw}`;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db<PlatformAdminSessionRow>(TABLES.PlatformAdminSession).insert({
    id: ulid(),
    prefix,
    tokenHash,
    platformAdminId: admin.id,
    email: admin.email.toLowerCase(),
    role: admin.role,
    expiresAt,
  });
  return { plaintext, expiresAt };
}

/**
 * Resolve a session cookie to the live PlatformAdmin. Defense-in-depth:
 * even with a valid session token, a revoked PlatformAdmin resolves to
 * null so revocation is immediate. Returns the CURRENT role from the
 * PlatformAdmin row (not the stale snapshot on the session).
 */
export async function resolvePlatformAdminSession(
  db: Knex,
  plaintext: string,
): Promise<{ session: PlatformAdminSessionRow; admin: PlatformAdminRow } | null> {
  if (!plaintext || plaintext.length < TOKEN_PREFIX_LEN) return null;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const now = new Date();
  const row = await db<PlatformAdminSessionRow>(TABLES.PlatformAdminSession)
    .where({ prefix, tokenHash })
    .whereNull('revokedAt')
    .andWhere('expiresAt', '>', now)
    .first();
  if (!row) return null;
  if (!constantTimeEqual(row.tokenHash, tokenHash)) return null;

  const admin = await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ id: row.platformAdminId }).first();
  if (!admin || admin.revokedAt) return null;

  void db<PlatformAdminSessionRow>(TABLES.PlatformAdminSession).where({ id: row.id }).update({ lastSeenAt: now });
  return { session: row, admin };
}

export async function revokePlatformAdminSession(db: Knex, plaintext: string): Promise<void> {
  if (!plaintext || plaintext.length < TOKEN_PREFIX_LEN) return;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  await db<PlatformAdminSessionRow>(TABLES.PlatformAdminSession)
    .where({ prefix, tokenHash })
    .update({ revokedAt: new Date() });
}

export function platformAdminSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}
