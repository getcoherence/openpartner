/**
 * Two-step sign-in for brand admins (docs/two-step-sign-in.md): a code
 * from an authenticator app (totp.ts) after the email link, password or
 * Google, with one-time recovery codes for a lost phone.
 *
 * The authenticator belongs to the person (their email), like their
 * password: one covers every brand they admin and their OpenPartner
 * account. Stored in TwoFactorCredential on the privileged pool only.
 *
 * Enforcement is on sessions, not on each way in. createSession and
 * createPlatformSession make a session for someone with two-step on
 * pending; resolveSession and resolvePlatformSession never return a
 * pending one; the code endpoints are the only lookups that do, and a
 * right code clears it. So a way of signing in that forgets about two-step
 * still can't hand out a working session.
 *
 * A brand can require it (`admin_security` Config): requireAuth then
 * refuses an admin session that hasn't proven a code, except on the routes
 * that set one up (TWO_FACTOR_SETUP_ROUTES).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type AdminRow, type TwoFactorCredentialRow } from '@openpartner/db';
import { db as platformDb } from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { getConfig, setConfig } from './config.js';
import { KeyedLimiter } from './middleware/rate-limit.js';
import { platformCredential } from './passwords.js';
import { generateTotpSecret, matchTotp, otpauthUri } from './totp.js';

export const TWO_FACTOR_ISSUER = 'OpenPartner';
export const RECOVERY_CODE_COUNT = 10;
/** Wrong codes one pending session may take before it's ended. */
export const MAX_CODE_ATTEMPTS = 5;
/** How long a pending session waits for its code. */
export const PENDING_TTL_MS = 10 * 60_000;

/** Wrong codes per person across sessions: 10 per 15 minutes, then 429.
 *  Keyed by email, so spreading guesses across sessions or IPs doesn't
 *  help (passwords.ts passwordFailures does the same for passwords). */
export const codeFailures = new KeyedLimiter(10, 15 * 60_000);

/** Routes an admin may reach while their brand requires two-step and
 *  their session hasn't proven a code: enough to set it up. */
export const TWO_FACTOR_SETUP_ROUTES: Readonly<Record<string, string>> = {
  'GET /auth/whoami': 'the portal reads who is signed in',
  'GET /auth/two-factor': 'whether it is on',
  'POST /auth/two-factor/setup': 'a new authenticator',
  'POST /auth/two-factor/enable': 'its first code',
};

// ---------- The credential ----------

function keyOf(email: string): Pick<TwoFactorCredentialRow, 'tenantId' | 'principalKind' | 'principalId'> {
  return { ...platformCredential(email), principalKind: 'platform' };
}

async function credentialOf(db: Knex, email: string): Promise<TwoFactorCredentialRow | undefined> {
  return db<TwoFactorCredentialRow>(TABLES.TwoFactorCredential).where(keyOf(email)).first();
}

/** Two-step is on for this address: every new session for it starts pending. */
export async function twoFactorEnabled(email: string): Promise<boolean> {
  const row = await platformDb<TwoFactorCredentialRow>(TABLES.TwoFactorCredential)
    .where(keyOf(email))
    .whereNotNull('enabledAt')
    .first('id');
  return !!row;
}

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: Date | null;
  recoveryCodesLeft: number;
}

export async function twoFactorStatus(email: string): Promise<TwoFactorStatus> {
  const row = await credentialOf(platformDb, email);
  if (!row?.enabledAt) return { enabled: false, enabledAt: null, recoveryCodesLeft: 0 };
  return {
    enabled: true,
    enabledAt: row.enabledAt,
    recoveryCodesLeft: row.recoveryCodes.filter((c) => !c.usedAt).length,
  };
}

/** Which of these addresses have two-step on (the Admins list). */
export async function twoFactorEnabledFor(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await platformDb<TwoFactorCredentialRow>(TABLES.TwoFactorCredential)
    .where({ tenantId: DEFAULT_TENANT_ID, principalKind: 'platform' })
    .whereIn('principalId', emails.map((e) => e.toLowerCase()))
    .whereNotNull('enabledAt')
    .select('principalId');
  return new Set(rows.map((r) => r.principalId));
}

/** A fresh secret, waiting for its first code. Starting again replaces one
 *  that never got it; one that's on stays until it's turned off. One
 *  statement decides, so a setup racing the first code can't replace the
 *  secret that code just turned on. */
export async function startSetup(email: string): Promise<{ secret: string; otpauthUri: string } | 'already_enabled'> {
  const secret = generateTotpSecret();
  const sealed = encryptSecret(secret);
  const written = await platformDb<TwoFactorCredentialRow>(TABLES.TwoFactorCredential)
    .insert({ id: ulid(), ...keyOf(email), secret: sealed })
    .onConflict(['tenantId', 'principalKind', 'principalId'])
    .merge({ secret: sealed, lastUsedStep: null, updatedAt: new Date() })
    .whereNull(`${TABLES.TwoFactorCredential}.enabledAt`)
    .returning('id');
  if (written.length === 0) return 'already_enabled';
  return { secret, otpauthUri: otpauthUri(secret, email.toLowerCase(), TWO_FACTOR_ISSUER) };
}

/** The first code turns it on. Returns the recovery codes, shown once. */
export async function confirmSetup(
  email: string,
  code: string,
): Promise<{ recoveryCodes: string[] } | 'no_setup' | 'already_enabled' | 'invalid_code'> {
  return platformDb.transaction(async (trx) => {
    const row = await trx<TwoFactorCredentialRow>(TABLES.TwoFactorCredential).where(keyOf(email)).forUpdate().first();
    if (!row) return 'no_setup';
    if (row.enabledAt) return 'already_enabled';
    const step = matchTotp(decryptSecret(row.secret), normalizeCode(code));
    if (step === null) return 'invalid_code';
    const minted = mintRecoveryCodes();
    await trx<TwoFactorCredentialRow>(TABLES.TwoFactorCredential)
      .where({ id: row.id })
      .update({
        enabledAt: new Date(),
        lastUsedStep: String(step),
        recoveryCodes: JSON.stringify(minted.stored) as unknown as TwoFactorCredentialRow['recoveryCodes'],
        recoverySalt: minted.salt,
        updatedAt: new Date(),
      });
    return { recoveryCodes: minted.codes };
  });
}

export type CodeKind = 'totp' | 'recovery_code';

/**
 * Check a code from the person's authenticator, or one of their recovery
 * codes, and spend it: an authenticator code is only taken for a step
 * after the last one accepted, and a recovery code works once.
 */
export async function checkCode(email: string, code: string): Promise<CodeKind | null> {
  return platformDb.transaction(async (trx) => {
    const row = await trx<TwoFactorCredentialRow>(TABLES.TwoFactorCredential)
      .where(keyOf(email))
      .whereNotNull('enabledAt')
      .forUpdate()
      .first();
    if (!row) return null;
    const given = normalizeCode(code);
    if (/^\d{6}$/.test(given)) {
      const after = row.lastUsedStep === null ? null : Number(row.lastUsedStep);
      const step = matchTotp(decryptSecret(row.secret), given, { afterStep: after });
      if (step === null) return null;
      await trx(TABLES.TwoFactorCredential).where({ id: row.id }).update({ lastUsedStep: String(step), updatedAt: new Date() });
      return 'totp';
    }
    const recovery = normalizeRecoveryCode(given);
    if (recovery.length !== RECOVERY_CODE_LENGTH || !row.recoverySalt) return null;
    const wanted = Buffer.from(hashRecoveryCode(row.recoverySalt, recovery));
    const idx = row.recoveryCodes.findIndex((c) => !c.usedAt && timingSafeEqual(Buffer.from(c.hash), wanted));
    if (idx < 0) return null;
    const codes = row.recoveryCodes.map((c, i) => (i === idx ? { ...c, usedAt: new Date().toISOString() } : c));
    await trx(TABLES.TwoFactorCredential)
      .where({ id: row.id })
      .update({ recoveryCodes: JSON.stringify(codes), updatedAt: new Date() });
    return 'recovery_code';
  });
}

export async function regenerateRecoveryCodes(email: string): Promise<string[]> {
  const minted = mintRecoveryCodes();
  await platformDb(TABLES.TwoFactorCredential)
    .where(keyOf(email))
    .update({ recoveryCodes: JSON.stringify(minted.stored), recoverySalt: minted.salt, updatedAt: new Date() });
  return minted.codes;
}

export async function removeTwoFactor(email: string): Promise<void> {
  await platformDb(TABLES.TwoFactorCredential).where(keyOf(email)).del();
}

/** Digits with spaces, as apps show them, still match. */
function normalizeCode(code: string): string {
  return code.replace(/\s+/g, '').trim();
}

// ---------- Recovery codes ----------

/** Crockford base32: no I, L, O or U to misread. */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CODE_LENGTH = 12;

/** Upper-cased, separators dropped, and the letters people type for digits
 *  read as those digits. */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

function hashRecoveryCode(salt: string, normalized: string): string {
  return createHash('sha256').update(`${salt}:${normalized}`).digest('hex');
}

function mintRecoveryCodes(): { codes: string[]; salt: string; stored: Array<{ hash: string; usedAt: null }> } {
  const salt = randomBytes(16).toString('hex');
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    const raw = [...randomBytes(RECOVERY_CODE_LENGTH)].map((b) => RECOVERY_ALPHABET[b & 31]).join('');
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`);
  }
  return {
    codes,
    salt,
    stored: codes.map((c) => ({ hash: hashRecoveryCode(salt, normalizeRecoveryCode(c)), usedAt: null })),
  };
}

// ---------- Sessions ----------

export type SessionTable = typeof TABLES.Session | typeof TABLES.PlatformSession;

/** The fields createSession / createPlatformSession stamp on a new row. */
export async function newSessionSecondFactor(
  email: string | null,
  provenAt: Date | null | undefined,
): Promise<{ secondFactorPending: boolean; secondFactorAt: Date | null }> {
  if (provenAt) return { secondFactorPending: false, secondFactorAt: provenAt };
  const pending = !!email && (await twoFactorEnabled(email));
  return { secondFactorPending: pending, secondFactorAt: null };
}

/** A pending row that may still take a code. */
export function pendingAndLive(row: { secondFactorPending: boolean; secondFactorAttempts: number; createdAt: Date }): boolean {
  return (
    row.secondFactorPending &&
    row.secondFactorAttempts < MAX_CODE_ATTEMPTS &&
    row.createdAt.getTime() > Date.now() - PENDING_TTL_MS
  );
}

/**
 * For someone with two-step on, a session counts only if it proved a code
 * for the authenticator they have now: proved after it was turned on.
 * resolveSession and resolvePlatformSession ask this of every session.
 * Without it, a session made in the moment two-step was turned on (after
 * the sign-in read "off", before the turn-on's sweep could see it) would
 * work with no code, and one carrying a proof from before it was turned
 * off and on again (entering a brand from an older account session) would
 * outlive the new authenticator.
 */
export async function lacksRequiredCode(row: { secondFactorAt: Date | null }, email: string): Promise<boolean> {
  const credential = await platformDb<TwoFactorCredentialRow>(TABLES.TwoFactorCredential)
    .where(keyOf(email))
    .whereNotNull('enabledAt')
    .first('enabledAt');
  if (!credential?.enabledAt) return false;
  return row.secondFactorAt === null || row.secondFactorAt < credential.enabledAt;
}

/** Two-step was turned off: the sessions this browser keeps no longer
 *  count as having proven a code, so a brand that requires it asks for
 *  setup instead of taking the old proof. */
export async function clearSecondFactor(db: Knex, table: SessionTable, id: string): Promise<void> {
  await db(table).where({ id }).update({ secondFactorAt: null });
}

/** This browser just proved a code (turning two-step on): its sessions
 *  count as two-step from now on. */
export async function passSecondFactor(db: Knex, table: SessionTable, id: string): Promise<void> {
  await db(table).where({ id }).update({ secondFactorPending: false, secondFactorAt: new Date() });
}

/**
 * Spend one of a pending session's tries before its code is checked, so
 * parallel requests can't each slip in under the limit: the row's update
 * is the gate. The number of tries spent, or null when it has none left,
 * was ended, or isn't waiting for a code.
 */
export async function reserveCodeAttempt(db: Knex, table: SessionTable, id: string): Promise<number | null> {
  const [row] = (await db(table)
    .where({ id, secondFactorPending: true })
    .whereNull('revokedAt')
    .andWhere('secondFactorAttempts', '<', MAX_CODE_ATTEMPTS)
    .increment('secondFactorAttempts', 1)
    .returning('secondFactorAttempts')) as Array<{ secondFactorAttempts: number }>;
  return row ? row.secondFactorAttempts : null;
}

/** The code was wrong. Returns the tries left; at none the session is
 *  ended and the person signs in again. */
export async function wrongCode(db: Knex, table: SessionTable, id: string, spent: number): Promise<number> {
  const left = Math.max(0, MAX_CODE_ATTEMPTS - spent);
  // Only while it's still waiting: a right code checked in parallel may
  // already have finished the sign-in, and a late wrong one mustn't end it.
  if (left === 0) {
    await db(table).where({ id, secondFactorPending: true }).whereNull('revokedAt').update({ revokedAt: new Date() });
  }
  return left;
}

/** The code was right: the pending session works from now on. False when
 *  it was ended meanwhile (out of tries, signed out). */
export async function finishPendingSignIn(db: Knex, table: SessionTable, id: string): Promise<boolean> {
  const updated = await db(table)
    .where({ id, secondFactorPending: true })
    .whereNull('revokedAt')
    .update({ secondFactorPending: false, secondFactorAt: new Date() });
  return updated > 0;
}

/**
 * Two-step was turned on or off: end every other session this person
 * holds — their OpenPartner account and each brand they admin — keeping the
 * ones named. Privileged pool: the sessions span brands.
 */
export async function endOtherSessions(email: string, keep: { sessionId?: string; platformSessionId?: string }): Promise<void> {
  const now = new Date();
  const address = email.toLowerCase();
  const platform = platformDb(TABLES.PlatformSession).where({ email: address }).whereNull('revokedAt');
  if (keep.platformSessionId) platform.andWhereNot({ id: keep.platformSessionId });
  await platform.update({ revokedAt: now });
  const adminIds = (await platformDb<AdminRow>(TABLES.Admin).where({ email: address }).select('id')).map((a) => a.id);
  if (adminIds.length > 0) {
    const sessions = platformDb(TABLES.Session).where({ principalKind: 'admin' }).whereIn('principalId', adminIds).whereNull('revokedAt');
    if (keep.sessionId) sessions.andWhereNot({ id: keep.sessionId });
    await sessions.update({ revokedAt: now });
  }
}

// ---------- The brand's rule ----------

export const ADMIN_SECURITY_CONFIG_KEY = 'admin_security';

export interface AdminSecuritySettings {
  /** Every admin of this brand signs in with two-step. */
  requireTwoFactor: boolean;
}

export async function getAdminSecurity(db: Knex, tenantId: string): Promise<AdminSecuritySettings> {
  const stored = await getConfig<Partial<AdminSecuritySettings>>(db, tenantId, ADMIN_SECURITY_CONFIG_KEY);
  return { requireTwoFactor: stored?.requireTwoFactor === true };
}

export async function setAdminSecurity(db: Knex, tenantId: string, settings: AdminSecuritySettings): Promise<void> {
  await setConfig(db, tenantId, ADMIN_SECURITY_CONFIG_KEY, settings);
}
