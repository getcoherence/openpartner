/**
 * Host-based tenant resolution — the edge-trust decision (spec §4.3/§7.5).
 * Pure header logic, no DB.
 *
 * The load-bearing case: a request sent DIRECTLY to the platform origin
 * with a forged `X-Forwarded-Host: portal.xispark.com` must resolve from
 * the genuine Host header, not the forgery — otherwise anyone can curl
 * app.openpartner.dev and get RLS-scoped to another tenant's context
 * (brand config, /branding, public signup surfaces).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inboundHost, isPlatformHost, timingSafeEqualStr } from '../tenancy.js';

function req(headers: Record<string, string>): { header: (name: string) => string | undefined } {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name: string) => lower[name.toLowerCase()] };
}

const ENV_KEYS = ['EDGE_TRUST_SECRET', 'PORTAL_URL'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('inboundHost — X-Forwarded-Host spoofing guard', () => {
  it('ignores a forged X-Forwarded-Host when no edge secret is configured (DO-native path)', () => {
    expect(
      inboundHost(
        req({ host: 'app.openpartner.dev', 'x-forwarded-host': 'portal.xispark.com' }),
      ),
    ).toBe('app.openpartner.dev');
  });

  it('ignores a forged X-Forwarded-Host when the edge token is missing', () => {
    process.env.EDGE_TRUST_SECRET = 's3cret-s3cret-s3cret';
    expect(
      inboundHost(
        req({ host: 'app.openpartner.dev', 'x-forwarded-host': 'portal.xispark.com' }),
      ),
    ).toBe('app.openpartner.dev');
  });

  it('ignores a forged X-Forwarded-Host when the edge token is wrong', () => {
    process.env.EDGE_TRUST_SECRET = 's3cret-s3cret-s3cret';
    expect(
      inboundHost(
        req({
          host: 'app.openpartner.dev',
          'x-forwarded-host': 'portal.xispark.com',
          'x-op-edge-token': 'guess',
        }),
      ),
    ).toBe('app.openpartner.dev');
  });

  it('honors X-Forwarded-Host behind a valid edge token (droplet path)', () => {
    process.env.EDGE_TRUST_SECRET = 's3cret-s3cret-s3cret';
    expect(
      inboundHost(
        req({
          host: 'app.openpartner.dev',
          'x-forwarded-host': 'portal.xispark.com',
          'x-op-edge-token': 's3cret-s3cret-s3cret',
        }),
      ),
    ).toBe('portal.xispark.com');
  });

  it('an empty configured secret never trusts the edge (empty-vs-empty must not match)', () => {
    process.env.EDGE_TRUST_SECRET = '';
    expect(
      inboundHost(
        req({
          host: 'app.openpartner.dev',
          'x-forwarded-host': 'portal.xispark.com',
          'x-op-edge-token': '',
        }),
      ),
    ).toBe('app.openpartner.dev');
  });

  it('normalizes port, case, and comma-lists', () => {
    expect(inboundHost(req({ host: 'Portal.Xispark.com:443' }))).toBe('portal.xispark.com');
    expect(inboundHost(req({ host: 'portal.xispark.com, evil.example' }))).toBe(
      'portal.xispark.com',
    );
    expect(inboundHost(req({}))).toBe('');
  });
});

describe('isPlatformHost', () => {
  it('rejects platform origins from host-based resolution', () => {
    expect(isPlatformHost('app.openpartner.dev')).toBe(true);
    expect(isPlatformHost('api.openpartner.dev')).toBe(true);
    expect(isPlatformHost('network.openpartner.dev')).toBe(true);
    expect(isPlatformHost('openpartner.dev')).toBe(true);
    expect(isPlatformHost('openpartner-abc123.ondigitalocean.app')).toBe(true);
    expect(isPlatformHost('localhost')).toBe(true);
    expect(isPlatformHost('127.0.0.1')).toBe(true);
    expect(isPlatformHost('')).toBe(true);
  });

  it('treats the PORTAL_URL host as platform even off openpartner.dev', () => {
    process.env.PORTAL_URL = 'https://portal.example.io';
    expect(isPlatformHost('portal.example.io')).toBe(true);
  });

  it('lets a genuine customer domain through', () => {
    expect(isPlatformHost('portal.xispark.com')).toBe(false);
  });

  it('does not treat a lookalike suffix as platform', () => {
    expect(isPlatformHost('notopenpartner.dev.evil.example')).toBe(false);
    expect(isPlatformHost('fakeopenpartner.dev')).toBe(false);
  });
});

describe('timingSafeEqualStr', () => {
  it('matches equal strings and rejects different ones (any length)', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });
});
