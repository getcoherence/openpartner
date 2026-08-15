/**
 * White-label domain lifecycle — DB-free logic tier (spec §4.2, §7.6).
 *
 * Load-bearing cases:
 *   - reserved/platform hosts are rejected loudly at registration;
 *   - the TXT check accepts chunked answers and rejects near-misses;
 *   - staleness: a verified row whose last check is older than the TTL is
 *     refused by the gate until re-verified (dangling-CNAME takeover guard).
 */

import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_STALE_AFTER_MS,
  checkDomainTxt,
  domainRegistrationError,
  expectedTxtValue,
  isStaleVerification,
  newVerificationToken,
  txtContainsToken,
  txtRecordName,
} from '../portal-domains.js';

describe('domainRegistrationError', () => {
  it('accepts a customer subdomain', () => {
    expect(domainRegistrationError('portal.xispark.com')).toBeNull();
    expect(domainRegistrationError('partners.deep.example.co.uk')).toBeNull();
  });

  it('rejects platform / reserved hosts loudly', () => {
    expect(domainRegistrationError('app.openpartner.dev')).toBe('reserved_host');
    expect(domainRegistrationError('anything.openpartner.dev')).toBe('reserved_host');
    expect(domainRegistrationError('my-app.ondigitalocean.app')).toBe('reserved_host');
  });

  it('rejects apex domains in v1 (subdomains only)', () => {
    expect(domainRegistrationError('xispark.com')).toBe('subdomain_required');
  });

  it('rejects syntactically invalid hosts', () => {
    expect(domainRegistrationError('')).toBe('invalid_domain');
    expect(domainRegistrationError('has space.example.com')).toBe('invalid_domain');
    expect(domainRegistrationError('-leading.example.com')).toBe('invalid_domain');
    expect(domainRegistrationError('trailing-.example.com')).toBe('invalid_domain');
    expect(domainRegistrationError(`${'a'.repeat(64)}.example.com`)).toBe('invalid_domain');
    expect(domainRegistrationError(`${'a.'.repeat(130)}com`)).toBe('invalid_domain');
  });
});

describe('TXT ownership proof', () => {
  it('builds the record name + value the customer must publish', () => {
    expect(txtRecordName('portal.xispark.com')).toBe('_openpartner.portal.xispark.com');
    expect(expectedTxtValue('abc123')).toBe('openpartner-verify=abc123');
  });

  it('matches an exact record, including chunked answers', () => {
    expect(txtContainsToken([['openpartner-verify=tok']], 'tok')).toBe(true);
    expect(txtContainsToken([['openpartner-', 'verify=tok']], 'tok')).toBe(true);
    expect(txtContainsToken([['unrelated'], ['openpartner-verify=tok']], 'tok')).toBe(true);
  });

  it('rejects near-misses (wrong token, prefix-only, empty)', () => {
    expect(txtContainsToken([['openpartner-verify=other']], 'tok')).toBe(false);
    expect(txtContainsToken([['openpartner-verify=tokX']], 'tok')).toBe(false);
    expect(txtContainsToken([], 'tok')).toBe(false);
  });

  it('checkDomainTxt treats resolver failure (NXDOMAIN, timeout) as not verified', async () => {
    await expect(
      checkDomainTxt('portal.xispark.com', 'tok', () => Promise.reject(new Error('ENOTFOUND'))),
    ).resolves.toBe(false);
    await expect(
      checkDomainTxt('portal.xispark.com', 'tok', async () => [['openpartner-verify=tok']]),
    ).resolves.toBe(true);
  });
});

describe('isStaleVerification', () => {
  const now = new Date('2026-07-02T12:00:00Z');

  it('fresh lastCheckedAt within the TTL is not stale', () => {
    expect(
      isStaleVerification(
        { verifiedAt: new Date('2026-01-01'), lastCheckedAt: new Date('2026-07-01') },
        now,
      ),
    ).toBe(false);
  });

  it('a check older than the TTL is stale', () => {
    const old = new Date(now.getTime() - VERIFICATION_STALE_AFTER_MS - 1);
    expect(isStaleVerification({ verifiedAt: old, lastCheckedAt: old }, now)).toBe(true);
  });

  it('falls back to verifiedAt when never re-checked; no timestamps = stale', () => {
    expect(isStaleVerification({ verifiedAt: now, lastCheckedAt: null }, now)).toBe(false);
    expect(isStaleVerification({ verifiedAt: null, lastCheckedAt: null }, now)).toBe(true);
  });
});

describe('newVerificationToken', () => {
  it('is hex, long enough, and unique per call (rotation-safe)', () => {
    const a = newVerificationToken();
    const b = newVerificationToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});
