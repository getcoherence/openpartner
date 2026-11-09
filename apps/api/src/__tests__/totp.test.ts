/**
 * RFC 6238 TOTP (totp.ts) against the RFC's own test vectors, and the
 * window and replay rules two-factor.ts relies on.
 */

import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, matchTotp, otpauthUri, totpCode, totpStep } from '../totp.js';

// RFC 6238 Appendix B: the SHA-1 seed is the ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('matches the RFC 6238 SHA-1 vectors (last six digits)', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, eight] of vectors) {
      expect([seconds, totpCode(RFC_SECRET, seconds * 1000)]).toEqual([seconds, eight.slice(2)]);
    }
  });

  it('round-trips base32, ignoring spaces, case and padding', () => {
    const bytes = Buffer.from('any bytes at all, of any length!');
    const text = base32Encode(bytes);
    expect(base32Decode(text)).toEqual(bytes);
    expect(base32Decode(` ${text.toLowerCase()}== `)).toEqual(bytes);
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('takes a code one step either side of now, and no further', () => {
    const at = 1_800_000_000_000;
    const step = totpStep(at);
    const secret = generateTotpSecret();
    expect(matchTotp(secret, totpCode(secret, at - 30_000), { atMs: at })).toBe(step - 1);
    expect(matchTotp(secret, totpCode(secret, at + 30_000), { atMs: at })).toBe(step + 1);
    expect(matchTotp(secret, totpCode(secret, at - 60_000), { atMs: at })).toBeNull();
    expect(matchTotp(secret, 'abcdef', { atMs: at })).toBeNull();
  });

  it('never takes a code for a step already used', () => {
    const at = 1_800_000_000_000;
    const secret = generateTotpSecret();
    const code = totpCode(secret, at);
    const step = matchTotp(secret, code, { atMs: at });
    expect(step).toBe(totpStep(at));
    expect(matchTotp(secret, code, { atMs: at, afterStep: step })).toBeNull();
  });

  it('builds the URI authenticator apps read', () => {
    expect(otpauthUri('ABCDEF', 'ada@example.com', 'OpenPartner')).toBe(
      'otpauth://totp/OpenPartner%3Aada%40example.com?secret=ABCDEF&issuer=OpenPartner&algorithm=SHA1&digits=6&period=30',
    );
  });
});
