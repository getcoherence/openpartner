// @vitest-environment jsdom
/**
 * The OpenPartner pitch beside the sign-up and sign-in forms is for the
 * platform's own pages only. AuthFrame also renders partner logins and
 * white-label brands' sign-in pages, so it drops the panel whenever the
 * page resolves to a tenant, even if a caller passes one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthFrame, AuthPanel } from '../pages/auth/Shared.js';

const PLATFORM = {
  tenantSlug: null,
  programName: null,
  supportEmail: null,
  logoUrl: null,
  faviconUrl: null,
  brandColor: null,
  programTermsUrl: null,
  whiteLabel: false,
};

/** jsdom has no matchMedia; answer every query the same way. */
function setWide(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: wide,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

function renderFrame(branding: Record<string, unknown> | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // usePublicBrand keys by the /t/<slug>/ URL prefix; jsdom runs at '/'.
  if (branding) qc.setQueryData(['public-branding', null], branding);
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AuthFrame title="Sign in" panel={<AuthPanel variant="brand" />}>
          form
        </AuthFrame>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setWide(true);
  // An unseeded /branding query stays in flight.
  globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuthFrame side panel', () => {
  it('shows on a platform page at desktop width', () => {
    const { queryByTestId, container } = renderFrame(PLATFORM);
    expect(queryByTestId('auth-panel')).not.toBeNull();
    expect(container.textContent).toContain('Every partner paid.');
  });

  it('is absent on a white-label page', () => {
    const { queryByTestId, container } = renderFrame({
      ...PLATFORM,
      tenantSlug: 'acme',
      programName: 'Acme Partners',
      whiteLabel: true,
    });
    expect(queryByTestId('auth-panel')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/openpartner/i);
    expect(container.textContent).toContain('Acme Partners');
  });

  it('is absent on a tenant page that is not white-label', () => {
    const { queryByTestId, container } = renderFrame({ ...PLATFORM, tenantSlug: 'acme', programName: 'Acme Partners' });
    expect(queryByTestId('auth-panel')).toBeNull();
    expect(container.textContent).not.toContain('Every partner paid.');
  });

  it('is absent on a single-tenant install', () => {
    const { queryByTestId } = renderFrame({ ...PLATFORM, tenantSlug: 'default' });
    expect(queryByTestId('auth-panel')).toBeNull();
  });

  it('is absent while the brand is still resolving', () => {
    const { queryByTestId } = renderFrame(undefined);
    expect(queryByTestId('auth-panel')).toBeNull();
  });

  it('is absent below the split width', () => {
    setWide(false);
    const { queryByTestId } = renderFrame(PLATFORM);
    expect(queryByTestId('auth-panel')).toBeNull();
  });

  it('is absent when the page did not ask for it', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(['public-branding', null], PLATFORM);
    const { queryByTestId } = render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <AuthFrame title="Sign in">form</AuthFrame>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(queryByTestId('auth-panel')).toBeNull();
  });
});
