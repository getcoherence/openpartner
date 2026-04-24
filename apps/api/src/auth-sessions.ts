/**
 * Magic-link + session primitives.
 *
 * Tokens and session tokens share the same sha256-at-rest pattern API
 * keys already use: we store prefix (for indexed lookup) + hash, never
 * the plaintext. Cookies carry the plaintext; comparisons use
 * constant-time equality on the hash.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import {
  TABLES,
  type MagicLinkClaim,
  type MagicLinkPurpose,
  type MagicLinkTokenRow,
  type SessionPrincipalKind,
  type SessionRow,
} from '@openpartner/db';
import { db } from './db.js';

export const SESSION_COOKIE_NAME = 'op_session';
const MAGIC_PREFIX_LEN = 8;
const SESSION_PREFIX_LEN = 8;

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---- Magic-link tokens ----

export interface IssuedToken {
  id: string;
  plaintext: string;
}

export async function issueMagicLink(params: {
  email: string;
  purpose: MagicLinkPurpose;
  claim?: MagicLinkClaim;
  ttlSeconds?: number;
}): Promise<IssuedToken> {
  const plaintext = `mlt_${randomBytes(32).toString('base64url')}`;
  const prefix = plaintext.slice(0, MAGIC_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const id = ulid();
  const expiresAt = new Date(Date.now() + (params.ttlSeconds ?? 15 * 60) * 1000); // 15 min default

  await db<MagicLinkTokenRow>(TABLES.MagicLinkToken).insert({
    id,
    prefix,
    tokenHash,
    email: params.email.toLowerCase(),
    purpose: params.purpose,
    claim: params.claim ? (JSON.stringify(params.claim) as unknown as never) : null,
    expiresAt,
  });

  return { id, plaintext };
}

export type ConsumeResult =
  | { ok: true; token: MagicLinkTokenRow }
  | { ok: false; error: 'not_found' | 'expired' | 'already_consumed' };

export async function consumeMagicLink(plaintext: string): Promise<ConsumeResult> {
  if (plaintext.length < MAGIC_PREFIX_LEN) return { ok: false, error: 'not_found' };
  const prefix = plaintext.slice(0, MAGIC_PREFIX_LEN);
  const tokenHash = hash(plaintext);

  const candidates = await db<MagicLinkTokenRow>(TABLES.MagicLinkToken).where({ prefix });
  const match = candidates.find((row) => constantTimeStringEqual(row.tokenHash, tokenHash));
  if (!match) return { ok: false, error: 'not_found' };
  if (match.consumedAt) return { ok: false, error: 'already_consumed' };
  if (new Date(match.expiresAt).getTime() < Date.now()) return { ok: false, error: 'expired' };

  // Atomic single-use consumption: conditional update on consumedAt IS NULL.
  const updated = await db<MagicLinkTokenRow>(TABLES.MagicLinkToken)
    .where({ id: match.id })
    .whereNull('consumedAt')
    .update({ consumedAt: new Date() })
    .returning('*');

  if (updated.length === 0) return { ok: false, error: 'already_consumed' };
  return { ok: true, token: updated[0]! };
}

// ---- Sessions ----

const SESSION_TTL_DAYS = 30;

export async function createSession(params: {
  principalKind: SessionPrincipalKind;
  principalId: string;
}): Promise<IssuedToken> {
  const plaintext = `ops_${randomBytes(32).toString('base64url')}`;
  const prefix = plaintext.slice(0, SESSION_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const id = ulid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db<SessionRow>(TABLES.Session).insert({
    id,
    prefix,
    tokenHash,
    principalKind: params.principalKind,
    principalId: params.principalId,
    expiresAt,
    lastSeenAt: new Date(),
  });

  return { id, plaintext };
}

export async function resolveSession(plaintext: string): Promise<SessionRow | null> {
  if (plaintext.length < SESSION_PREFIX_LEN) return null;
  const prefix = plaintext.slice(0, SESSION_PREFIX_LEN);
  const tokenHash = hash(plaintext);

  const candidates = await db<SessionRow>(TABLES.Session)
    .where({ prefix })
    .whereNull('revokedAt');
  const match = candidates.find((row) => constantTimeStringEqual(row.tokenHash, tokenHash));
  if (!match) return null;
  if (new Date(match.expiresAt).getTime() < Date.now()) return null;

  // Non-blocking lastSeen bump — we don't await.
  void db<SessionRow>(TABLES.Session).where({ id: match.id }).update({ lastSeenAt: new Date() });
  return match;
}

export async function revokeSession(id: string): Promise<void> {
  await db<SessionRow>(TABLES.Session).where({ id }).update({ revokedAt: new Date() });
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}
