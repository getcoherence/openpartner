/**
 * Envelope encryption for federation keys.
 *
 * Why: the Network needs to call out to a vendor's OpenPartner instance
 * admin API on partnership approval. That means holding the plaintext key
 * somewhere — a sha256 hash would be useless for outbound calls.
 *
 * We use AES-256-GCM with a master key pulled from NETWORK_ENCRYPTION_KEY
 * (32 bytes, base64 or hex). In dev, if no key is set, we use a fixed
 * dev-only key and log a warning — this is NEVER OK in production. The
 * env-loader startup check enforces presence in production builds.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12; // GCM recommends 12 bytes

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.NETWORK_ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('NETWORK_ENCRYPTION_KEY is required in production');
    }
    console.warn('[network.crypto] NETWORK_ENCRYPTION_KEY not set — using dev-only fallback. DO NOT USE IN PROD.');
    cachedKey = Buffer.alloc(32, 0x42);
    return cachedKey;
  }
  // accept either hex or base64
  const buf = raw.length === 64 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('NETWORK_ENCRYPTION_KEY must decode to exactly 32 bytes');
  cachedKey = buf;
  return buf;
}

export function encryptKey(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptKey(envelope: string): string {
  const buf = Buffer.from(envelope, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const ct = buf.subarray(IV_LEN + 16);
  const decipher = createDecipheriv(ALG, masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
