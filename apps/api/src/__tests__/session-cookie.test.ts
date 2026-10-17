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

import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { sessionCookieOptions } from '../auth-sessions.js';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  vi.unstubAllEnvs();
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

it.each([
  ['/auth/signout', ['op_session']],
  ['/auth/platform-signout', ['op_platform_session', 'op_bundle_id', 'op_session']],
  ['/platform-admin/signout', ['op_platform_admin_session']],
])('expires browser cookies on %s instead of renewing empty cookies', async (path, names) => {
  if (path === '/platform-admin/signout') vi.stubEnv('OPENPARTNER_TENANCY', 'multi');
  const response = await request(createApp()).post(path as string).send({}).expect(200);
  const cookies = response.headers['set-cookie'] as unknown as string[];
  for (const name of names) {
    const cookie = cookies.find((value) => value.startsWith(`${name}=`))!;
    expect(cookie).not.toContain('Max-Age=');
    const expiry = cookie.match(/Expires=([^;]+)/)?.[1];
    expect(expiry).toBeDefined();
    expect(Date.parse(expiry!)).toBeLessThan(Date.now());
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
  }
});
