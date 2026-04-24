/**
 * Magic-link token + session primitives — partner auth only.
 *
 * Tokens look like `opml_<hex>` and sessions look like `ops_<hex>`. Both
 * use the same pattern as ApiKey: store a sha256 hash + an 8-char prefix
 * so lookups are indexed and plaintext is only ever held for the
 * moment we generate / verify.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import { ulid } from 'ulid';
import {
  TABLES,
  type MagicLinkTokenRow,
  type MagicLinkPurpose,
  type SessionRow,
} from '@openpartner/db';
import { db } from './db.js';

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

export async function issueMagicLink(params: {
  email: string;
  purpose: MagicLinkPurpose;
  partnerId: string;
}): Promise<IssuedMagicLink> {
  const { plaintext, prefix, tokenHash } = generate('opml');
  const expiresAt = new Date(Date.now() + MAGIC_TTL_MS);
  await db<MagicLinkTokenRow>(TABLES.MagicLinkToken).insert({
    id: ulid(),
    prefix,
    tokenHash,
    email: params.email.toLowerCase(),
    purpose: params.purpose,
    partnerId: params.partnerId,
    expiresAt,
  });
  return { plaintext, expiresAt };
}

export interface ConsumedMagicLink {
  token: MagicLinkTokenRow;
}

/**
 * Consume a magic-link token atomically. Rejects expired, already-consumed,
 * and unknown tokens. Returns the full token row on success so callers can
 * branch on purpose + partnerId.
 */
export async function consumeMagicLink(plaintext: string): Promise<ConsumedMagicLink | null> {
  if (plaintext.length < TOKEN_PREFIX_LEN) return null;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const now = new Date();

  // Conditional UPDATE: only marks the row consumed if it's still
  // consumable — race-safe against duplicate clicks.
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

export async function createSession(partnerId: string): Promise<IssuedSession> {
  const { plaintext, prefix, tokenHash } = generate('ops');
  const id = ulid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db<SessionRow>(TABLES.Session).insert({
    id,
    prefix,
    tokenHash,
    partnerId,
    expiresAt,
  });
  return { plaintext, id, expiresAt };
}

export async function resolveSession(plaintext: string): Promise<SessionRow | null> {
  if (!plaintext || plaintext.length < TOKEN_PREFIX_LEN) return null;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const now = new Date();
  const row = await db<SessionRow>(TABLES.Session)
    .where({ prefix, tokenHash })
    .whereNull('revokedAt')
    .andWhere('expiresAt', '>', now)
    .first();
  if (!row) return null;
  void db<SessionRow>(TABLES.Session).where({ id: row.id }).update({ lastSeenAt: now });
  return row;
}

export async function revokeSession(id: string): Promise<void> {
  await db<SessionRow>(TABLES.Session).where({ id }).update({ revokedAt: new Date() });
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
