// @vitest-environment jsdom
/**
 * The creator shell is mounted on a splat route (/creator/*) and its own
 * index + catch-all routes redirect to the Discover page. Under React
 * Router 7, a relative path inside a splat route resolves against the
 * WHOLE matched URL, not the route's base: a relative "discover" from
 * /creator/no/such/page became /creator/no/such/page/discover, which hit
 * the catch-all again and redirected forever. Both redirects must land on
 * /creator/discover however deep the unknown path is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorShell } from '../pages/creator/CreatorShell.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/creator-api/creators/whoami')) {
      return json(200, { creator: { id: 'crt_1', name: 'Ada', email: 'ada@example.com', handle: 'ada', avatarUrl: null, bio: null } });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function LocationProbe() {
  return <output data-testid="pathname">{useLocation().pathname}</output>;
}

function renderShellAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <LocationProbe />
        <Routes>
          <Route path="/creator/*" element={<CreatorShell />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('creator shell redirects', () => {
  it.each([
    ['the shell root', '/creator'],
    ['an unknown page', '/creator/nope'],
    ['an unknown nested page', '/creator/no/such/page'],
  ])('sends %s to /creator/discover', async (_label, path) => {
    const page = renderShellAt(path);
    await waitFor(() => expect(page.getByTestId('pathname').textContent).toBe('/creator/discover'));
    // Settle, then make sure it stayed put rather than redirecting again.
    await new Promise((r) => setTimeout(r, 20));
    expect(page.getByTestId('pathname').textContent).toBe('/creator/discover');
  });
});
