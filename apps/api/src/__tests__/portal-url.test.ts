/**
 * getPortalBaseUrl + buildMagicLinkUrl — the one chokepoint every emailed
 * link flows through (spec §4.4/§7.1). Host-only session cookies mean the
 * link's host IS the auth host: a white-label tenant's links must land on
 * its custom domain, never the platform origin.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPortalBaseUrl } from '../portal-url.js';
import { buildMagicLinkUrl } from '../email-templates.js';

let savedPortalUrl: string | undefined;

beforeEach(() => {
  savedPortalUrl = process.env.PORTAL_URL;
  process.env.PORTAL_URL = 'https://app.openpartner.dev/';
});

afterEach(() => {
  if (savedPortalUrl === undefined) delete process.env.PORTAL_URL;
  else process.env.PORTAL_URL = savedPortalUrl;
});

describe('getPortalBaseUrl', () => {
  it('uses the custom domain when the tenant has one (white-label)', () => {
    expect(getPortalBaseUrl({ slug: 'xispark', customDomain: 'portal.xispark.com' })).toBe(
      'https://portal.xispark.com',
    );
  });

  it('falls back to the path-based /t/<slug> URL without a custom domain', () => {
    expect(getPortalBaseUrl({ slug: 'xispark', customDomain: null })).toBe(
      'https://app.openpartner.dev/t/xispark',
    );
  });

  it('falls back to bare PORTAL_URL with no tenant (platform / pre-tenant)', () => {
    expect(getPortalBaseUrl()).toBe('https://app.openpartner.dev');
    expect(getPortalBaseUrl(null)).toBe('https://app.openpartner.dev');
  });
});

describe('buildMagicLinkUrl', () => {
  it('white-label tenant links land on the custom domain root (SPA at /)', () => {
    expect(buildMagicLinkUrl('tok123', { slug: 'xispark', customDomain: 'portal.xispark.com' })).toBe(
      'https://portal.xispark.com/auth/magic?token=tok123',
    );
  });

  it('path-based tenant links carry the /t/<slug> prefix so verify can resolve the tenant', () => {
    expect(buildMagicLinkUrl('tok123', { slug: 'acme' })).toBe(
      'https://app.openpartner.dev/t/acme/auth/magic?token=tok123',
    );
  });

  it('platform links (no tenant) stay on PORTAL_URL', () => {
    expect(buildMagicLinkUrl('tok123')).toBe('https://app.openpartner.dev/auth/magic?token=tok123');
  });

  it('URL-encodes the token', () => {
    expect(buildMagicLinkUrl('a b&c', { slug: 'acme' })).toBe(
      'https://app.openpartner.dev/t/acme/auth/magic?token=a%20b%26c',
    );
  });
});
