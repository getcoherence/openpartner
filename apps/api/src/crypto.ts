/**
 * AES-256-GCM envelope encryption for secrets stored in Config.
 *
 * One master key — SECRETS_ENCRYPTION_KEY env, 32 raw bytes as hex
 * (64 chars) or base64 (44 chars). Required in production; dev falls
 * back to a fixed dev-only key and logs a warning, which means
 * encrypted values don't survive a rotation but local development
 * doesn't need to care.
 *
 * Envelope: 12-byte IV || 16-byte auth tag || ciphertext, base64 encoded.
 * The tag catches tampering so bad-faith DB writes can't silently return
 * different plaintext than what was stored.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SECRETS_ENCRYPTION_KEY is required in production');
    }
    // Dev fallback — deterministic so local restarts keep decrypting
    // previously-encrypted rows, but obviously not safe for prod.
    console.warn('[crypto] SECRETS_ENCRYPTION_KEY not set — using dev-only fallback. DO NOT USE IN PROD.');
    cachedKey = Buffer.alloc(32, 0x42);
    return cachedKey;
  }
  const buf = raw.length === 64 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('SECRETS_ENCRYPTION_KEY must decode to exactly 32 bytes');
  cachedKey = buf;
  return buf;
}

/**
 * Keyed MAC for signed links (e.g. one-click unsubscribe). The key is derived
 * per `purpose` from the master secret, so a MAC minted for one purpose never
 * verifies for another and the master key itself never signs user-visible
 * values. base64url, safe to drop in a query string.
 */
export function macValue(purpose: string, value: string): string {
  const k = createHmac('sha256', masterKey()).update(`openpartner-mac:${purpose}`).digest();
  return createHmac('sha256', k).update(value).digest('base64url');
}

/** Constant-time check of a macValue() output. */
export function verifyMac(purpose: string, value: string, mac: string): boolean {
  const expected = Buffer.from(macValue(purpose, value));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(envelope: string): string {
  const buf = Buffer.from(envelope, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const ct = buf.subarray(IV_LEN + 16);
  // authTagLength: 16 is required to refuse short tags on decrypt. Without
  // it Node accepts any tag 4–16 bytes, which weakens GCM forgery resistance
  // (Semgrep gcm-no-tag-length).
  const decipher = createDecipheriv(ALG, masterKey(), iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** For tests. Resets the cached master key so a test can set env + re-encrypt. */
export function __resetCryptoKeyForTests(): void {
  cachedKey = null;
}
