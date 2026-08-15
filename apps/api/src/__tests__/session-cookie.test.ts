/**
 * Session-cookie scope regression (spec §7.3).
 *
 * White-label custom domains rely on HOST-ONLY session cookies: a cookie
 * set on portal.xispark.com is sent only there and can never leak to
 * app.openpartner.dev or another tenant's domain. That requires the cookie
 * options to carry NO `domain` attribute — on set AND on clear (Express's
 * clearCookie only matches when the attributes match). Adding a Domain
 * later would silently break white-label session isolation, so this pins
 * it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { sessionCookieOptions } from '../auth-sessions.js';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('sessionCookieOptions', () => {
  it('is host-only: no domain attribute, ever', () => {
    expect('domain' in sessionCookieOptions()).toBe(false);
  });

  it('keeps the attributes clearCookie must match: path=/, httpOnly, sameSite=lax', () => {
    const opts = sessionCookieOptions();
    expect(opts.path).toBe('/');
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
  });

  it('is secure in production (custom domains are always https)', () => {
    process.env.NODE_ENV = 'production';
    expect(sessionCookieOptions().secure).toBe(true);
  });
});
