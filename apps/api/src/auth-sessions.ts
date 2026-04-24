/**
 * Magic-link token + session primitives. Generic over principal kind:
 * both admins and partners use the same magic-link verify + session
 * cookie flow, differing only in which table we check + activate on
 * verify.
 *
 * Tokens look like `opml_<hex>` and sessions look like `ops_<hex>`. Both
 * use the same prefix+hash lookup as ApiKey — plaintext is only ever
 * held at generation + verify time.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import { ulid } from 'ulid';
import {
  TABLES,
  type MagicLinkTokenRow,
  type MagicLinkPurpose,
  type PrincipalKind,
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
  principalKind: PrincipalKind;
  principalId: string;
}): Promise<IssuedMagicLink> {
  const { plaintext, prefix, tokenHash } = generate('opml');
  const expiresAt = new Date(Date.now() + MAGIC_TTL_MS);
  await db<MagicLinkTokenRow>(TABLES.MagicLinkToken).insert({
    id: ulid(),
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

export async function consumeMagicLink(plaintext: string): Promise<ConsumedMagicLink | null> {
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

export async function createSession(params: {
  principalKind: PrincipalKind;
  principalId: string;
}): Promise<IssuedSession> {
  const { plaintext, prefix, tokenHash } = generate('ops');
  const id = ulid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db<SessionRow>(TABLES.Session).insert({
    id,
    prefix,
    tokenHash,
    principalKind: params.principalKind,
    principalId: params.principalId,
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

  // Defense-in-depth: if the principal was revoked but somehow a session
  // slipped through, reject here too.
  if (row.principalKind === 'partner') {
    const partner = (await db('Partner').where({ id: row.principalId }).first()) as
      | { revokedAt: Date | null }
      | undefined;
    if (!partner || partner.revokedAt) return null;
  } else if (row.principalKind === 'admin') {
    const admin = (await db('Admin').where({ id: row.principalId }).first()) as
      | { revokedAt: Date | null; activatedAt: Date | null }
      | undefined;
    if (!admin || admin.revokedAt || !admin.activatedAt) return null;
  }

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
