// @vitest-environment jsdom
/**
 * A sign-in link the brand's backend minted (POST /partners/{id}/signin-link)
 * can carry ?next=<portal path> (its `returnTo`). The magic-link landing
 * signs the partner in and opens that page under the same /t/<slug> prefix
 * (none on a white-label domain), and safePortalPath keeps it on the site.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { safePortalPath } from '@openpartner/db';
import { MagicLandingPage } from '../pages/auth/MagicLanding.js';

let verified: string[] = [];

beforeEach(() => {
  verified = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/auth/magic/verify')) verified.push(JSON.parse(String(init?.body)).token);
    return new Response(JSON.stringify({ ok: true, role: 'partner' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/auth/magic" element={<MagicLandingPage />} />
          <Route path="/t/:slug/auth/magic" element={<MagicLandingPage />} />
          <Route path="*" element={<div>landed</div>} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

async function landsOn(path: string): Promise<void> {
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe(path), { timeout: 2000 });
}

describe('magic-link landing with ?next=', () => {
  it('opens the portal path under the brand prefix', async () => {
    renderAt(`/t/acme/auth/magic?token=opml_abc&next=${encodeURIComponent('/links?program=p1')}`);
    await landsOn('/t/acme/links?program=p1');
    expect(verified).toEqual(['opml_abc']);
  });

  it('opens it at the root on a white-label domain', async () => {
    renderAt('/auth/magic?token=opml_def&next=%2Fcommissions');
    await landsOn('/commissions');
  });

  it('lands on the dashboard for a next that would leave the site', async () => {
    renderAt(`/t/acme/auth/magic?token=opml_ghi&next=${encodeURIComponent('https://evil.example/links')}`);
    await landsOn('/t/acme/');
  });

  it('lands on the dashboard without one', async () => {
    renderAt('/auth/magic?token=opml_jkl');
    await landsOn('/');
  });
});

describe('safePortalPath', () => {
  it('accepts a same-origin path, query and hash included', () => {
    expect(safePortalPath('/links')).toBe('/links');
    expect(safePortalPath('/commissions?program=p1#top')).toBe('/commissions?program=p1#top');
    expect(safePortalPath('/network/offerings/o1')).toBe('/network/offerings/o1');
    expect(safePortalPath('/links/../payouts')).toBe('/payouts');
  });

  it('rejects anything that could leave the site', () => {
    for (const raw of [
      null,
      undefined,
      '',
      'links',
      'https://evil.example/links',
      '//evil.example/links',
      '/\\evil.example/links',
      '/.//evil.example/links',
      '/links/..//evil.example',
      '/%2e//evil.example',
      'javascript:alert(1)',
      '/links with space',
      `/${'a'.repeat(600)}`,
    ]) {
      expect(safePortalPath(raw)).toBeNull();
    }
  });
});
