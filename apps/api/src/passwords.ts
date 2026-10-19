/**
 * Password credentials.
 *
 * A password never mints a session itself. It is one more way to prove who
 * you are; once proven, the route issues the same single-use sign-in token
 * an emailed link carries (signin-handoff.ts) and the client redeems it at
 * the existing verify endpoint. So every session still comes out of the
 * magic-link verify paths, with their review, portal-access, activation
 * and country checks.
 *
 * Storage is the PasswordCredential table — privileged pool only (see its
 * migration for the key shapes). Callers pass the privileged `db`, never
 * `req.db`: the openpartner_app role has no grant on the table.
 *
 * Hashing is scrypt from node:crypto (no native dependency): N=2^15, r=8,
 * p=1 — about 32 MiB and ~100 ms per check, stored self-describing so the
 * cost can be raised later without invalidating existing hashes.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  DEFAULT_TENANT_ID,
  TABLES,
  type AdminRow,
  type MagicLinkTokenRow,
  type PasswordCredentialKind,
  type PasswordCredentialRow,
} from '@openpartner/db';
import { KeyedLimiter } from './middleware/rate-limit.js';

const COST = { N: 32_768, r: 8, p: 1 };
const KEY_LEN = 64;
// 128 * N * r = 32 MiB; Node's default maxmem is exactly that, and the
// check is strict, so give it headroom.
const MAX_MEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;
/** NIST 800-63B shape: a length floor, a generous ceiling, no composition rules. */
export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(200);

function scrypt(password: string, salt: Buffer, keyLen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, { ...COST, maxmem: MAX_MEM });
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (!expected.length) return false;
  try {
    const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: MAX_MEM });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// Checked against when there is no credential, so "no such account" costs
// the same as "wrong password".
let dummyHash: Promise<string> | null = null;
function dummy(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

// ---------- Credential keys ----------

export interface CredentialKey {
  tenantId: string;
  principalKind: PasswordCredentialKind;
  principalId: string;
}

/** A brand admin's or operator's password: it belongs to the email. */
export function platformCredential(email: string): CredentialKey {
  return { tenantId: DEFAULT_TENANT_ID, principalKind: 'platform', principalId: email.trim().toLowerCase() };
}

/** A partner's password on one brand's portal. */
export function partnerCredential(tenantId: string, partnerId: string): CredentialKey {
  return { tenantId, principalKind: 'partner', principalId: partnerId };
}

const UNIQUE = ['tenantId', 'principalKind', 'principalId'];

export async function hasPassword(db: Knex, key: CredentialKey): Promise<boolean> {
  return !!(await db<PasswordCredentialRow>(TABLES.PasswordCredential).where(key).first('id'));
}

export async function setPassword(db: Knex, key: CredentialKey, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await db<PasswordCredentialRow>(TABLES.PasswordCredential)
    .insert({ id: ulid(), ...key, passwordHash })
    .onConflict(UNIQUE)
    .merge({ passwordHash, updatedAt: new Date() });
}

/** Does `password` match the credential at `key`? A null key (no eligible
 *  account) still pays for one hash. */
export async function checkPassword(db: Knex, key: CredentialKey | null, password: string): Promise<boolean> {
  const row = key ? await db<PasswordCredentialRow>(TABLES.PasswordCredential).where(key).first() : undefined;
  if (!row) {
    await verifyPassword(password, await dummy());
    return false;
  }
  return verifyPassword(password, row.passwordHash);
}

// ---------- Password chosen at signup ----------

/** Hold the signup form's password against its activation link. */
export async function holdSignupPassword(
  db: Knex,
  params: { tenantId: string; tokenId: string; password: string },
): Promise<void> {
  await db<PasswordCredentialRow>(TABLES.PasswordCredential).insert({
    id: ulid(),
    tenantId: params.tenantId,
    principalKind: 'signup',
    principalId: params.tokenId,
    passwordHash: await hashPassword(params.password),
  });
}

/**
 * The activation link a signup mailed was redeemed: the password typed on
 * that form becomes the email's password. Only that link can do this (the
 * held row is keyed by its token id), and it never replaces a password the
 * email already has — someone signing up with your address can't reset
 * yours by getting you to click their activation mail.
 */
export async function claimSignupPassword(
  db: Knex,
  token: Pick<MagicLinkTokenRow, 'id' | 'tenantId' | 'email'>,
): Promise<boolean> {
  const held = await db<PasswordCredentialRow>(TABLES.PasswordCredential)
    .where({ tenantId: token.tenantId, principalKind: 'signup', principalId: token.id })
    .first();
  if (!held) return false;
  const inserted = await db<PasswordCredentialRow>(TABLES.PasswordCredential)
    .insert({ id: ulid(), ...platformCredential(token.email), passwordHash: held.passwordHash })
    .onConflict(UNIQUE)
    .ignore()
    .returning('id');
  await db<PasswordCredentialRow>(TABLES.PasswordCredential).where({ id: held.id }).del();
  return inserted.length > 0;
}

// ---------- After a reset ----------

/**
 * A platform password was reset: end every session that identity holds —
 * platform identity, ops console, and each brand it admins — so a stolen
 * session doesn't outlive the reset.
 */
export async function signOutIdentityEverywhere(db: Knex, email: string): Promise<void> {
  const now = new Date();
  const address = email.toLowerCase();
  await db(TABLES.PlatformSession).where({ email: address }).whereNull('revokedAt').update({ revokedAt: now });
  await db(TABLES.PlatformAdminSession).where({ email: address }).whereNull('revokedAt').update({ revokedAt: now });
  const adminIds = (await db<AdminRow>(TABLES.Admin).where({ email: address }).select('id')).map((a) => a.id);
  if (adminIds.length > 0) {
    await db(TABLES.Session)
      .where({ principalKind: 'admin' })
      .whereIn('principalId', adminIds)
      .whereNull('revokedAt')
      .update({ revokedAt: now });
  }
}

// ---------- Throttles ----------

/** Wrong passwords per account: 10 per 15 minutes, then 429 until the
 *  window ends. Keyed by credential, so spreading guesses across IPs
 *  doesn't help. An emailed link still works while an account is held. */
export const passwordFailures = new KeyedLimiter(10, 15 * 60_000);

/** Reset mails per address: 3 per 15 minutes, so the form can't bury an
 *  inbox. Extra requests get the same 200 and no mail. */
export const resetMailLimit = new KeyedLimiter(3, 15 * 60_000);

/** `scope` is 'platform' or the tenant id — keyed by the address typed, so
 *  an address with no account is throttled the same as one with. */
export function failureKey(scope: string, email: string): string {
  return `${scope}|${email.trim().toLowerCase()}`;
}
