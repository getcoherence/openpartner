/**
 * Time-based one-time passwords (RFC 6238), the codes authenticator apps
 * show: HMAC-SHA1 over the 30-second step, six digits. node:crypto only.
 *
 * Secrets are 20 random bytes, shown to the person as base32 (RFC 4648,
 * no padding), which is what authenticator apps take.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** Steps either side of now a code is still taken for: clock drift and the
 *  seconds it takes to type. */
const WINDOW = 1;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The step a moment falls in. */
export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** RFC 4226 HOTP for one counter value. */
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return binary.toString().padStart(digits, '0');
}

/** The code for a moment (tests, and nothing else, need it). */
export function totpCode(secretBase32: string, atMs: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpStep(atMs));
}

/**
 * The step `code` is valid for, within the window around `atMs`, if any
 * step after `afterStep` matches. The caller stores the step it accepted
 * and passes it back as `afterStep`, so no code works twice.
 */
export function matchTotp(
  secretBase32: string,
  code: string,
  opts: { atMs?: number; afterStep?: number | null } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const now = totpStep(opts.atMs);
  const given = Buffer.from(code);
  for (let step = now - WINDOW; step <= now + WINDOW; step += 1) {
    if (opts.afterStep != null && step <= opts.afterStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), given)) return step;
  }
  return null;
}

/** What an authenticator app reads from the QR code. */
export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}
