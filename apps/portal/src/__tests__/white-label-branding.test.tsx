// @vitest-environment jsdom
/**
 * White-label branding regression (spec §5.1's durable guard).
 *
 * Renders the real portal shell chrome with a white-label-effective brand
 * and asserts NO platform branding ("OpenPartner") and NO shared-Network
 * surface text is in the DOM. Strings creep back in after merges — a
 * grep-proof render test is the only durable fix.
 *
 * The inverse case (whiteLabel=false ⇒ Network nav present) proves the
 * assertions can fail, so a broken gate can't pass silently.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '../App.js';
import { AuthFrame } from '../pages/auth/Shared.js';
import type { Principal } from '../api.js';

const BRAND = {
  programName: 'Acme Partners',
  supportEmail: null,
  logoUrl: null,
  brandColor: null,
  programTermsUrl: null,
  whiteLabel: true,
};

function makeClient(whiteLabel: boolean): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // Seed the caches useBrand()/usePublicBrand() read so no fetch happens.
  qc.setQueryData(['program-settings'], { ...BRAND, whiteLabel });
  qc.setQueryData(['public-branding'], { ...BRAND, whiteLabel, tenantSlug: 'acme' });
  return qc;
}

function renderWithProviders(ui: React.ReactElement, whiteLabel: boolean) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={makeClient(whiteLabel)}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const adminPrincipal: Principal = {
  role: 'admin',
  admin: { id: 'a1', name: 'Ada Admin', email: 'ada@acme.example' },
};
const partnerPrincipal: Principal = {
  role: 'partner',
  partnerId: 'p1',
  partner: { id: 'p1', name: 'Pat Partner', email: 'pat@example.com', stripeConnected: false },
};

beforeEach(() => {
  // IdentitySwitcher probes platform-session endpoints; a white-label
  // domain has no platform session, so 401 mirrors production.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'no_platform_session' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
});

afterEach(() => {
  cleanup();
});

describe('white-label portal renders no platform branding', () => {
  it('admin sidebar: no OpenPartner, no Network surfaces', () => {
    const { container } = renderWithProviders(<Sidebar principal={adminPrincipal} />, true);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/openpartner/i);
    expect(text).not.toMatch(/\bnetwork\b/i);
    // The brand's own name renders instead.
    expect(text).toContain('Acme Partners');
    // And no platform logo sneaks in via an <img alt>.
    for (const img of Array.from(container.querySelectorAll('img'))) {
      expect(img.getAttribute('alt') ?? '').not.toMatch(/openpartner/i);
      expect(img.getAttribute('src') ?? '').not.toMatch(/logo-mark-green/);
    }
  });

  it('partner sidebar: no OpenPartner, no Network nav section', () => {
    const { container } = renderWithProviders(<Sidebar principal={partnerPrincipal} />, true);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/openpartner/i);
    expect(text).not.toMatch(/\bnetwork\b/i);
  });

  it('pre-auth AuthFrame: brand name + monogram, no platform mark', () => {
    const { container } = renderWithProviders(<AuthFrame title="Sign in">x</AuthFrame>, true);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/openpartner/i);
    expect(text).toContain('Acme Partners');
    expect(container.querySelector('img[src*="logo-mark-green"]')).toBeNull();
  });
});

describe('the assertions can fail (inverse case)', () => {
  it('a non-white-label admin sidebar DOES show the Network section', () => {
    const { container } = renderWithProviders(<Sidebar principal={adminPrincipal} />, false);
    expect(container.textContent ?? '').toMatch(/network/i);
  });
});
