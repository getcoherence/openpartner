/**
 * Platform-identity session helpers.
 *
 * The multi-tenant deployment's workspace picker hangs on this: after
 * a magic link verifies, we issue a PlatformSession instead of a regular
 * (tenant-scoped) Session. The SPA then reads /api/me/workspaces and
 * exchanges the platform session for a regular Session via
 * /api/workspaces/:slug/enter.
 *
 * Storage table: PlatformSession (no tenantId — this is identity, not
 * a workspace acting state).
 *
 * Cookie: op_platform_session, scoped to '/'.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import type { CookieOptions } from 'express';
import type { Knex } from 'knex';
import { TABLES, type PlatformSessionRow } from '@openpartner/db';

export const PLATFORM_SESSION_COOKIE = 'op_platform_session';
const TOKEN_PREFIX_LEN = 8;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

export interface IssuedPlatformSession {
  plaintext: string;
  expiresAt: Date;
}

export async function createPlatformSession(db: Knex, email: string): Promise<IssuedPlatformSession> {
  const raw = randomBytes(24).toString('hex');
  const plaintext = `opsplat_${raw}`;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db<PlatformSessionRow>(TABLES.PlatformSession).insert({
    id: ulid(),
    prefix,
    tokenHash,
    email: email.toLowerCase(),
    expiresAt,
  });
  return { plaintext, expiresAt };
}

export async function resolvePlatformSession(db: Knex, plaintext: string): Promise<PlatformSessionRow | null> {
  if (!plaintext || plaintext.length < TOKEN_PREFIX_LEN) return null;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const now = new Date();
  const row = await db<PlatformSessionRow>(TABLES.PlatformSession)
    .where({ prefix, tokenHash })
    .whereNull('revokedAt')
    .andWhere('expiresAt', '>', now)
    .first();
  if (!row) return null;
  if (!constantTimeEqual(row.tokenHash, tokenHash)) return null;
  void db<PlatformSessionRow>(TABLES.PlatformSession).where({ id: row.id }).update({ lastSeenAt: now });
  return row;
}

export async function revokePlatformSession(db: Knex, plaintext: string): Promise<void> {
  if (!plaintext || plaintext.length < TOKEN_PREFIX_LEN) return;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  await db<PlatformSessionRow>(TABLES.PlatformSession)
    .where({ prefix, tokenHash })
    .update({ revokedAt: new Date() });
}

export function platformSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}
