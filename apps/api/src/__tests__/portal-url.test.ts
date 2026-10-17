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
let savedTenancy: string | undefined;

beforeEach(() => {
  savedPortalUrl = process.env.PORTAL_URL;
  savedTenancy = process.env.OPENPARTNER_TENANCY;
  process.env.PORTAL_URL = 'https://app.openpartner.dev/';
});

afterEach(() => {
  if (savedPortalUrl === undefined) delete process.env.PORTAL_URL;
  else process.env.PORTAL_URL = savedPortalUrl;

  if (savedTenancy === undefined) delete process.env.OPENPARTNER_TENANCY;
  else process.env.OPENPARTNER_TENANCY = savedTenancy;
});

describe('getPortalBaseUrl', () => {
  it('uses the custom domain when the tenant has one (white-label)', () => {
    process.env.OPENPARTNER_TENANCY = 'multi';
    expect(getPortalBaseUrl({ slug: 'xispark', customDomain: 'portal.xispark.com' })).toBe(
      'https://portal.xispark.com',
    );
  });

  it('falls back to the path-based /t/<slug> URL without a custom domain in multi-tenant mode', () => {
    process.env.OPENPARTNER_TENANCY = 'multi';
    expect(getPortalBaseUrl({ slug: 'xispark', customDomain: null })).toBe(
      'https://app.openpartner.dev/t/xispark',
    );
  });

  it('keeps the internal default tenant at the portal root in single-tenant mode', () => {
    process.env.PORTAL_URL = 'https://affiliate.warsowerk.de/';
    process.env.OPENPARTNER_TENANCY = 'single';
    expect(getPortalBaseUrl({ slug: 'default', customDomain: null })).toBe(
      'https://affiliate.warsowerk.de',
    );
  });

  it('defaults to single-tenant URL behavior when OPENPARTNER_TENANCY is unset', () => {
    process.env.PORTAL_URL = 'https://affiliate.warsowerk.de/';
    delete process.env.OPENPARTNER_TENANCY;
    expect(getPortalBaseUrl({ slug: 'default', customDomain: null })).toBe(
      'https://affiliate.warsowerk.de',
    );
  });

  it('falls back to bare PORTAL_URL with no tenant (platform / pre-tenant)', () => {
    expect(getPortalBaseUrl()).toBe('https://app.openpartner.dev');
    expect(getPortalBaseUrl(null)).toBe('https://app.openpartner.dev');
  });
});

describe('buildMagicLinkUrl', () => {
  it('white-label tenant links land on the custom domain root (SPA at /)', () => {
    process.env.OPENPARTNER_TENANCY = 'multi';
    expect(buildMagicLinkUrl('tok123', { slug: 'xispark', customDomain: 'portal.xispark.com' })).toBe(
      'https://portal.xispark.com/auth/magic?token=tok123',
    );
  });

  it('path-based tenant links carry the /t/<slug> prefix in multi-tenant mode', () => {
    process.env.OPENPARTNER_TENANCY = 'multi';
    expect(buildMagicLinkUrl('tok123', { slug: 'acme' })).toBe(
      'https://app.openpartner.dev/t/acme/auth/magic?token=tok123',
    );
  });

  it('single-tenant links do not expose the internal /t/default prefix', () => {
    process.env.PORTAL_URL = 'https://affiliate.warsowerk.de';
    process.env.OPENPARTNER_TENANCY = 'single';
    expect(buildMagicLinkUrl('tok123', { slug: 'default' })).toBe(
      'https://affiliate.warsowerk.de/auth/magic?token=tok123',
    );
  });

  it('platform links (no tenant) stay on PORTAL_URL', () => {
    expect(buildMagicLinkUrl('tok123')).toBe('https://app.openpartner.dev/auth/magic?token=tok123');
  });

  it('URL-encodes the token', () => {
    process.env.OPENPARTNER_TENANCY = 'multi';
    expect(buildMagicLinkUrl('a b&c', { slug: 'acme' })).toBe(
      'https://app.openpartner.dev/t/acme/auth/magic?token=a%20b%26c',
    );
  });
});
