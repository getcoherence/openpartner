// @vitest-environment jsdom
/**
 * Verified work on a creator's storefront (the Network's
 * docs/campaign-reports.md §10): the brand's in-app storefront shows the
 * bookings the creator picked, with what each brand shares and never a
 * price, and leaves those brands out of the creator's own list; the
 * storefront editor picks, orders and hides them, with the preview following.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NetworkCreatorStorefrontPage } from '../pages/admin/NetworkCreatorStorefront.js';
import { CreatorStorefrontPage } from '../pages/creator/CreatorStorefront.js';
import type { CaseStudy } from '../pages/creator/CaseStudies.js';
import type { CaseStudyChoice } from '../pages/creator/CreatorStorefront.js';

const ZETA: CaseStudy = {
  title: 'YouTube integration',
  platform: 'youtube',
  brand: { name: 'Zeta', logoUrl: null },
  completedAt: '2026-10-28T10:00:00Z',
  posts: [
    {
      url: 'https://youtu.be/abc',
      platform: 'youtube',
      label: 'YouTube',
      publishedAt: '2026-10-20T10:00:00Z',
      verifiedAccount: true,
      youtube: { views: 12_000, likes: 800, comments: null },
      reported: null,
    },
  ],
  currency: 'USD',
  results: { clicks: 40, leads: 5, sales: 2, netRevenueByCurrency: { EUR: 89, USD: 250 }, asOf: '2026-10-31T10:00:00Z', final: false },
};
const REEL: CaseStudy['posts'][number] = {
  url: 'https://www.instagram.com/reel/DAbc/',
  platform: 'instagram',
  label: 'instagram',
  publishedAt: '2026-10-21T10:00:00Z',
  verifiedAccount: true,
  youtube: null,
  social: { platform: 'instagram', views: 52_000, likes: 812, comments: 46, shares: null },
  reported: null,
};
const ACME: CaseStudy = {
  title: 'Sponsored LinkedIn post',
  platform: 'linkedin',
  brand: { name: 'Acme', logoUrl: null },
  completedAt: '2026-10-20T10:00:00Z',
  posts: [
    REEL,
    {
      url: 'https://www.linkedin.com/posts/maya_acme-1',
      platform: 'other',
      label: 'linkedin',
      publishedAt: null,
      verifiedAccount: false,
      youtube: null,
      reported: { views: 9000, likes: 120, comments: null, shares: null, reportedAt: '2026-10-22T10:00:00Z' },
    },
  ],
  currency: 'USD',
  results: null,
};

let requests: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
let choices: { max: number; bookings: CaseStudyChoice[] };

const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  requests = [];
  choices = {
    max: 6,
    bookings: [
      { bookingId: 'bkr_zeta', title: 'YouTube integration', brand: ZETA.brand, completedAt: ZETA.completedAt, rank: 1, shareable: true, caseStudy: ZETA },
      { bookingId: 'bkr_acme', title: 'Sponsored LinkedIn post', brand: ACME.brand, completedAt: ACME.completedAt, rank: null, shareable: true, caseStudy: ACME },
      { bookingId: 'bkr_quiet', title: 'Newsletter feature', brand: { name: 'Quiet Co', logoUrl: null }, completedAt: '2026-10-10T10:00:00Z', rank: null, shareable: false, caseStudy: null },
    ],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const path = url.pathname.replace('/api/creator-api', '');
    requests.push({ method, path, body });
    if (path === '/creators/by-handle/mayabuilds') {
      return json(200, {
        id: 'crt_1',
        name: 'Maya Chen',
        handle: 'mayabuilds',
        avatarUrl: null,
        bio: null,
        categories: [],
        audienceLocations: [],
        audienceAgeRange: null,
        portfolioLinks: [],
        pastBrands: ['zeta', 'Northwind'],
        platforms: [],
        bookingsOpen: false,
        packages: [],
        caseStudies: [ZETA, ACME],
      });
    }
    if (path === '/creators/me/storefront' && method === 'GET') {
      return json(200, { bookingsOpen: false, handle: 'mayabuilds', profileComplete: true, maxPackages: 12, packages: [], platforms: [] });
    }
    if (path === '/creators/me' && method === 'GET') {
      return json(200, { id: 'crt_1', name: 'Maya Chen', handle: 'mayabuilds', avatarUrl: null, pastBrands: ['Acme', 'Northwind'], profileComplete: true });
    }
    if (path === '/creators/me/case-studies' && method === 'GET') return json(200, choices);
    if (path === '/creators/me/case-studies' && method === 'PUT') {
      const ids = body!.bookingIds as string[];
      choices = { ...choices, bookings: choices.bookings.map((b) => ({ ...b, rank: ids.includes(b.bookingId) ? ids.indexOf(b.bookingId) + 1 : null })) };
      return json(200, choices);
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => cleanup());

function renderAt(path: string, routePath: string, element: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the brand's view of a storefront", () => {
  it('shows verified work with what each brand shares, and leaves those brands out of the own list', async () => {
    renderAt('/admin/network/creators/mayabuilds', '/admin/network/creators/:handle', <NetworkCreatorStorefrontPage />);
    const section = (await screen.findByRole('heading', { name: 'Verified work' })).parentElement!;
    const w = within(section);
    expect(w.getAllByText('✓ Verified booking')).toHaveLength(2);
    expect(w.getByText('Zeta')).toBeTruthy();
    expect(w.getByText(/YouTube integration · YouTube ·/)).toBeTruthy();
    // YouTube's numbers apart from what OpenPartner tracked.
    expect(w.getByText('12,000 views')).toBeTruthy();
    expect(w.getByText('Comments hidden')).toBeTruthy();
    expect(w.getByText('· not YouTube data', { exact: false })).toBeTruthy();
    expect(w.getByText(/40 clicks · 5 signups · 2 sales · \$250\.00 \+ €89\.00 revenue/)).toBeTruthy();
    // The creator's own numbers, labelled; no results where the brand shares posts only.
    expect(w.getByText('Reported by the creator')).toBeTruthy();
    expect(w.getByText('9,000 impressions')).toBeTruthy();
    // A reel on their verified Instagram, with what Instagram says.
    expect(w.getByText('Instagram')).toBeTruthy();
    expect(w.getByText('52,000 views')).toBeTruthy();
    expect(w.getAllByText(/Tracked by OpenPartner/)).toHaveLength(1);
    // Zeta is shown verified, so their own list keeps only Northwind.
    const past = (await screen.findByRole('heading', { name: 'Past collaborations' })).parentElement!;
    expect(within(past).getByText('Northwind')).toBeTruthy();
    expect(within(past).queryByText('zeta')).toBeNull();
  });
});

describe('the storefront editor', () => {
  it('shows, orders and hides verified work, with the preview following', async () => {
    renderAt('/creator/storefront', '/creator/storefront', <CreatorStorefrontPage />);
    const card = (await screen.findByText('Show up to 6 completed bookings, with what each brand lets you share.')).parentElement!;
    const w = within(card);
    // The brand keeps one private: it can't be picked.
    expect(w.getByText('Private')).toBeTruthy();
    expect(w.getAllByRole('button', { name: 'Show' })).toHaveLength(1);

    fireEvent.click(w.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true));
    expect(requests.find((r) => r.method === 'PUT')!.body).toEqual({ bookingIds: ['bkr_zeta', 'bkr_acme'] });
    // The preview shows both, and Acme drops out of the own list there.
    await waitFor(() => expect(screen.getAllByText('✓ Verified booking')).toHaveLength(2));
    expect(screen.getByText('Northwind')).toBeTruthy();

    fireEvent.click((await w.findAllByRole('button', { name: 'Up' }))[1]!);
    await waitFor(() => expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(2));
    expect(requests.filter((r) => r.method === 'PUT')[1]!.body).toEqual({ bookingIds: ['bkr_acme', 'bkr_zeta'] });

    fireEvent.click((await w.findAllByRole('button', { name: 'Hide' }))[0]!);
    await waitFor(() => expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(3));
    expect(requests.filter((r) => r.method === 'PUT')[2]!.body).toEqual({ bookingIds: ['bkr_zeta'] });
  });

  it('says where completed bookings will show while there are none', async () => {
    choices = { max: 6, bookings: [] };
    renderAt('/creator/storefront', '/creator/storefront', <CreatorStorefrontPage />);
    expect(await screen.findByText('Completed bookings show up here to add to your storefront.')).toBeTruthy();
  });
});
