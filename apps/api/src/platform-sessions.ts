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
import { TABLES, type PlatformSessionBundleRow, type PlatformSessionRow } from '@openpartner/db';

export const PLATFORM_SESSION_COOKIE = 'op_platform_session';
export const PLATFORM_BUNDLE_COOKIE = 'op_bundle_id';
/** Max alive sessions in a bundle. Beyond this, oldest is evicted on
 *  attach. Most users run 1-3 identities; 5 is a soft humane cap. */
export const PLATFORM_BUNDLE_MAX_SESSIONS = 5;
const TOKEN_PREFIX_LEN = 8;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Re-export for verify-time bundle attach: createPlatformSession returns
 *  plaintext, but the caller needs the row id to attach to the bundle.
 *  Hashing the plaintext + looking up by tokenHash is cheaper than
 *  changing the create function's return shape (which other callers rely on). */
export function platformSessionTokenHash(plaintext: string): string {
  return hash(plaintext);
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

/** Same options as the platform-session cookie, but applied to the
 *  separate bundle-id cookie. Two cookies because the session token
 *  rotates on every switch (so the bundle id can't ride on the same
 *  cookie that also carries the rotating plaintext). */
export function platformBundleCookieOptions(): CookieOptions {
  return platformSessionCookieOptions();
}

// ---------- Bundle helpers ----------

/** Create a fresh bundle row and return the id. The id IS the cookie value. */
export async function createPlatformBundle(db: Knex): Promise<string> {
  const id = ulid();
  await db<PlatformSessionBundleRow>(TABLES.PlatformSessionBundle).insert({ id });
  return id;
}

/** Verify the bundle id exists + isn't expired-by-association (we don't
 *  expire bundles themselves; sessions inside them carry the TTL).
 *  Returns the row when valid, null otherwise. */
export async function resolveBundle(db: Knex, bundleId: string | null): Promise<PlatformSessionBundleRow | null> {
  if (!bundleId) return null;
  const row = await db<PlatformSessionBundleRow>(TABLES.PlatformSessionBundle).where({ id: bundleId }).first();
  return row ?? null;
}

/** Bump lastUsedAt — drives the future "stale bundle" hygiene job. */
export async function touchBundle(db: Knex, bundleId: string): Promise<void> {
  await db<PlatformSessionBundleRow>(TABLES.PlatformSessionBundle)
    .where({ id: bundleId })
    .update({ lastUsedAt: new Date() });
}

/**
 * Attach a freshly-issued platform session to a bundle.
 *
 * Two invariants enforced here:
 *   1. Dedup by email — if the bundle already contains an alive session
 *      for the same email, that session is revoked. Keeps the switcher
 *      from showing the same identity twice.
 *   2. Cap enforcement — if attaching pushes the bundle over the cap,
 *      the oldest alive session (other than this one) is revoked.
 */
export async function attachSessionToBundle(
  db: Knex,
  sessionId: string,
  bundleId: string,
): Promise<void> {
  const session = await db<PlatformSessionRow>(TABLES.PlatformSession).where({ id: sessionId }).first();
  if (!session) return;

  // Dedup: revoke prior alive session for same email in the same bundle.
  const dupes = await db<PlatformSessionRow>(TABLES.PlatformSession)
    .where({ bundleId, email: session.email })
    .whereNull('revokedAt')
    .andWhere('id', '!=', sessionId);
  if (dupes.length > 0) {
    await db<PlatformSessionRow>(TABLES.PlatformSession)
      .whereIn('id', dupes.map((d) => d.id))
      .update({ revokedAt: new Date() });
  }

  await db<PlatformSessionRow>(TABLES.PlatformSession)
    .where({ id: sessionId })
    .update({ bundleId });
  await touchBundle(db, bundleId);

  // Cap enforcement: evict oldest if over limit.
  const alive = await db<PlatformSessionRow>(TABLES.PlatformSession)
    .where({ bundleId })
    .whereNull('revokedAt')
    .orderBy('createdAt', 'asc');
  const overflow = alive.length - PLATFORM_BUNDLE_MAX_SESSIONS;
  if (overflow > 0) {
    const toEvict = alive
      .filter((s) => s.id !== sessionId)
      .slice(0, overflow)
      .map((s) => s.id);
    if (toEvict.length > 0) {
      await db<PlatformSessionRow>(TABLES.PlatformSession)
        .whereIn('id', toEvict)
        .update({ revokedAt: new Date() });
    }
  }
}

/** List alive sessions in a bundle, oldest first. */
export async function listBundleSessions(
  db: Knex,
  bundleId: string,
): Promise<PlatformSessionRow[]> {
  return db<PlatformSessionRow>(TABLES.PlatformSession)
    .where({ bundleId })
    .whereNull('revokedAt')
    .andWhere('expiresAt', '>', new Date())
    .orderBy('createdAt', 'asc');
}

/**
 * Rotate a platform session's token plaintext. Used by /identities/switch
 * — when switching to a bundled session, we mint a fresh plaintext, store
 * its hash, and hand the new plaintext to the browser via cookie. The
 * old plaintext (which is what the browser was holding for some OTHER
 * identity before the switch) is no longer valid for THIS session id.
 *
 * Same TTL semantics as createPlatformSession: bumps expiresAt to now+TTL
 * so a long-stacked identity stays alive when the user actually uses it.
 */
export async function rotatePlatformSessionToken(
  db: Knex,
  sessionId: string,
): Promise<IssuedPlatformSession> {
  const raw = randomBytes(24).toString('hex');
  const plaintext = `opsplat_${raw}`;
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LEN);
  const tokenHash = hash(plaintext);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db<PlatformSessionRow>(TABLES.PlatformSession)
    .where({ id: sessionId })
    .update({ prefix, tokenHash, expiresAt, lastSeenAt: new Date() });
  return { plaintext, expiresAt };
}

/** Resolve a session row by id (no token verification — caller is
 *  expected to have authenticated some other way, e.g. via the bundle
 *  cookie carrying an active sibling session). */
export async function findPlatformSessionById(db: Knex, id: string): Promise<PlatformSessionRow | null> {
  const row = await db<PlatformSessionRow>(TABLES.PlatformSession).where({ id }).first();
  return row ?? null;
}
