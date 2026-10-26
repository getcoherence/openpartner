// @vitest-environment jsdom
/**
 * The creator's Getting started checklist on Discover: the profile and
 * storefront steps have buttons that go there, the storefront step can be
 * declined ("No thanks", remembered by the Network), a partnership a brand
 * started counts as a first program, and the card goes away when every
 * step is done or declined.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorDiscoverPage } from '../pages/creator/CreatorDiscover.js';

type Req = { method: string; path: string; body: Record<string, unknown> | undefined };
let requests: Req[] = [];
let me: Record<string, unknown>;
let storefront: Record<string, unknown>;
let applications: unknown[];
let affiliations: unknown[];

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  requests = [];
  me = {
    id: 'crt_1',
    name: 'Ada Reyes',
    handle: 'ada',
    bio: null,
    profileComplete: false,
    profileMissing: [{ field: 'bio', label: 'Write a bio' }],
    reviewStatus: 'pending',
  };
  storefront = { bookingsOpen: false, packages: [], setupDismissedAt: null };
  applications = [];
  affiliations = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const path = url.pathname.replace('/api/creator-api', '');
    requests.push({ method, path, body });
    if (path === '/creators/me' && method === 'GET') return json(200, me);
    if (path === '/creators/me/requests') return json(200, { requests: applications });
    if (path === '/creators/me/affiliations') return json(200, { affiliations });
    if (path === '/creators/me/storefront' && method === 'GET') return json(200, storefront);
    if (path === '/creators/me/storefront' && method === 'PUT') {
      storefront = { ...storefront, setupDismissedAt: body?.setupDismissed ? '2026-10-26T10:00:00.000Z' : null };
      return json(200, { bookingsOpen: storefront.bookingsOpen, setupDismissedAt: storefront.setupDismissedAt });
    }
    if (path === '/offerings') return json(200, { offerings: [] });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => cleanup());

function renderDiscover() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/creator/discover']}>
        <Routes>
          <Route path="/creator/discover" element={<CreatorDiscoverPage />} />
          <Route path="/creator/profile" element={<p>Profile editor</p>} />
          <Route path="/creator/storefront" element={<p>Storefront editor</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Getting started', () => {
  it('lists the steps without "Account created", with buttons on the profile and storefront rows', async () => {
    renderDiscover();
    expect(await screen.findByText('Set up your storefront')).toBeTruthy();
    expect(screen.queryByText('Account created')).toBeNull();
    expect(screen.getByText('Complete your profile so brands can find you')).toBeTruthy();
    expect(screen.getByText('Get approved by OpenPartner')).toBeTruthy();
    expect(screen.getByText('Apply to your first program')).toBeTruthy();
    expect(screen.queryByText(/Card disappears when done/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Finish profile' }));
    expect(await screen.findByText('Profile editor')).toBeTruthy();
  });

  it('goes to the storefront editor from Set up', async () => {
    renderDiscover();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up' }));
    expect(await screen.findByText('Storefront editor')).toBeTruthy();
  });

  it('drops the storefront step on No thanks, and the Network remembers it', async () => {
    renderDiscover();
    fireEvent.click(await screen.findByRole('button', { name: 'No thanks' }));
    await waitFor(() => expect(screen.queryByText('Set up your storefront')).toBeNull());
    expect(requests.find((r) => r.method === 'PUT')).toMatchObject({ path: '/creators/me/storefront', body: { setupDismissed: true } });
    // Still there for the rest.
    expect(screen.getByText('Getting started')).toBeTruthy();

    cleanup();
    renderDiscover();
    await screen.findByText('Getting started');
    expect(screen.queryByText('Set up your storefront')).toBeNull();
  });

  it('goes away once everything is done; a partnership a brand started counts as a first program', async () => {
    me = { ...me, profileComplete: true, profileMissing: [], reviewStatus: 'approved' };
    storefront = { ...storefront, bookingsOpen: true, packages: [{ id: 'pkg_1' }] };
    affiliations = [{ id: 'aff_1' }];
    renderDiscover();
    await waitFor(() => expect(requests.some((r) => r.path === '/creators/me/storefront')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Getting started')).toBeNull();
  });

  it('goes away when the storefront was declined and the rest is done', async () => {
    me = { ...me, profileComplete: true, profileMissing: [], reviewStatus: 'approved' };
    storefront = { ...storefront, setupDismissedAt: '2026-10-20T00:00:00.000Z' };
    applications = [{ id: 'req_1', status: 'pending' }];
    renderDiscover();
    await waitFor(() => expect(requests.some((r) => r.path === '/creators/me/storefront')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Getting started')).toBeNull();
  });

  it('shows the storefront step ticked while other steps remain', async () => {
    storefront = { ...storefront, bookingsOpen: true, packages: [{ id: 'pkg_1' }] };
    renderDiscover();
    await screen.findByText('Set up your storefront');
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'No thanks' })).toBeNull();
  });

  it('doesn’t offer the storefront step on a Network that can’t remember No thanks', async () => {
    storefront = { bookingsOpen: false, packages: [] };
    renderDiscover();
    await screen.findByText('Getting started');
    expect(screen.queryByText('Set up your storefront')).toBeNull();
  });
});
