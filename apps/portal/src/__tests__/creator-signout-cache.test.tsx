// @vitest-environment jsdom
/**
 * Signing out of the creator portal forgets everything read for that
 * creator, so the next creator to sign in on the same tab never sees it:
 * their rate history (the Network's docs/rate-suggestions.md §5), bookings,
 * storefront and the rest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorShell } from '../pages/creator/CreatorShell.js';
import { RATE_SUGGESTIONS_KEY } from '../pages/creator/storefront-shared.js';

const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/creator-api', '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/creators/whoami') {
      return json(200, { creator: { id: 'crt_a', name: 'Ada', email: 'ada@example.test', handle: 'ada', avatarUrl: null, bio: null } });
    }
    if (path === '/creators/signout') return json(200, { ok: true });
    return json(404, { error: 'not_found' });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('creator sign-out', () => {
  it('clears the query cache', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(RATE_SUGGESTIONS_KEY, { niche: 'general', suggestions: [], reasons: {}, history: [{ platform: 'youtube', format: 'dedicated', median: 4000, count: 3, currency: 'USD' }] });
    qc.setQueryData(['creator-storefront'], { packages: [] });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/creator/profile']}>
          <Routes>
            <Route path="/creator/*" element={<CreatorShell />} />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click((await screen.findAllByRole('button', { name: /Sign out/ }))[0]!);
    await waitFor(() => expect(calls).toContain('POST /creators/signout'));
    await screen.findByText('Home');
    expect(qc.getQueryData(RATE_SUGGESTIONS_KEY)).toBeUndefined();
    expect(qc.getQueryData(['creator-storefront'])).toBeUndefined();
  });
});
