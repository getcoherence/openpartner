/**
 * Pure-unit coverage for the brand-approval building blocks — no DB, always
 * runs. The route-matching + email parsing are the bits most likely to
 * silently drift (a renamed route, a bad @-split), so pin them here.
 */

import { describe, expect, it } from 'vitest';
import { isGoLiveRoute } from '../middleware/approval-gate.js';
import { emailDomain, normalizeEmail } from '../brand-review.js';

describe('isGoLiveRoute', () => {
  it('gates the go-live write actions', () => {
    expect(isGoLiveRoute('POST', '/partners')).toBe(true);
    expect(isGoLiveRoute('POST', '/partner-signup')).toBe(true);
    expect(isGoLiveRoute('POST', '/import/partners-csv')).toBe(true);
    expect(isGoLiveRoute('POST', '/admin/network/offerings')).toBe(true);
    expect(isGoLiveRoute('POST', '/admin/network/requests/req_123/approve')).toBe(true);
  });

  it('leaves configuration + reads open', () => {
    // Creating a program / setting branding is configuration, not going live.
    expect(isGoLiveRoute('POST', '/programs')).toBe(false);
    expect(isGoLiveRoute('POST', '/config/program')).toBe(false);
    // Reads are never gated.
    expect(isGoLiveRoute('GET', '/partners')).toBe(false);
    // A partner-scoped subpath must not be caught by the /partners rule.
    expect(isGoLiveRoute('POST', '/partners/p_1/coupons')).toBe(false);
  });
});

describe('email parsing', () => {
  it('normalizes case + whitespace', () => {
    expect(normalizeEmail('  Danny@YouPlusJuice.com ')).toBe('danny@youplusjuice.com');
  });

  it('extracts the domain', () => {
    expect(emailDomain('danny@youplusjuice.com')).toBe('youplusjuice.com');
    expect(emailDomain('a@b@evil.test')).toBe('evil.test'); // last @ wins
  });

  it('returns null for a malformed address', () => {
    expect(emailDomain('no-at-sign')).toBeNull();
    expect(emailDomain('trailing@')).toBeNull();
  });
});
