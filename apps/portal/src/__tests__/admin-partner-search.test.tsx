// @vitest-environment jsdom
/**
 * Admin partner lists at program scale (a prospect runs 30,000 partners).
 * Admin → Partners and the admin Links hub used to fetch GET /partners
 * once and show only its first 100 rows. Both now page with the keyset
 * cursor and search the whole roster server-side (?q=), and row actions
 * that invalidate ['partners'] still refresh the paged list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminPartners } from '../pages/AdminPartners.js';
import { LinksPage } from '../pages/Links.js';

interface FakePartner {
  id: string;
  name: string;
  email: string;
  stripeConnectAccountId: null;
  createdAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
  metadata: Record<string, unknown>;
}

function partner(id: string, name: string, email: string, extra: Partial<FakePartner> = {}): FakePartner {
  return {
    id,
    name,
    email,
    stripeConnectAccountId: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    activatedAt: '2026-10-02T00:00:00.000Z',
    revokedAt: null,
    metadata: {},
    ...extra,
  };
}

const bulk = (n: number) => Array.from({ length: n }, (_, i) => partner(`p_${i}`, `Bulk ${i}`, `bulk-${i}@example.com`));
const ADA = partner('p_ada', 'Ada Lovelace', 'ada@example.com');

/** Server-side roster behind the fake GET /partners. The cursor is just an
 *  offset here; the real keyset cursor is covered by the API suite. */
let roster: FakePartner[] = [];
let requests: Array<{ method: string; url: URL }> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const listRequests = () => requests.filter((r) => r.method === 'GET' && r.url.pathname === '/api/partners');

beforeEach(() => {
  roster = [];
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    requests.push({ method, url });
    if (method === 'GET' && url.pathname === '/api/partners') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const matches = roster.filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.includes(q));
      return json(200, {
        partners: matches.slice(start, start + limit),
        nextCursor: start + limit < matches.length ? String(start + limit) : null,
      });
    }
    if (method === 'POST' && url.pathname.endsWith('/reinstate')) return json(200, { ok: true });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

// A page is 100 full table rows, which jsdom renders slowly. Re-rendering
// it (a search swapping 100 rows for 1, a second page loading) can take
// longer than findBy/waitFor's default 1s on a busy CI runner, so every
// wait after a big render gets this allowance. Passing tests don't wait any
// longer; only a genuine failure takes the full 5s to report.
const SLOW = { timeout: 5_000 };

describe('Admin → Partners at scale', { timeout: 15_000 }, () => {
  it('pages past the first 100 with Load more', async () => {
    roster = bulk(150);
    const page = renderWithClient(<AdminPartners />);

    expect(await page.findByText('Showing 100 partners', {}, SLOW)).toBeTruthy();
    expect(listRequests()[0]!.url.searchParams.get('limit')).toBe('100');
    expect(listRequests()[0]!.url.searchParams.has('cursor')).toBe(false);
    expect(page.queryByText('Bulk 149')).toBeNull();

    fireEvent.click(page.getByRole('button', { name: 'Load more' }));
    expect(await page.findByText('Showing 150 partners', {}, SLOW)).toBeTruthy();
    expect(listRequests().at(-1)!.url.searchParams.get('cursor')).toBe('100');
    expect(page.getByText('Bulk 149')).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('searches the whole roster on the server, not just the loaded rows', async () => {
    roster = [...bulk(250), ADA]; // Ada is far past the first page
    const page = renderWithClient(<AdminPartners />);
    await page.findByText('Showing 100 partners', {}, SLOW);
    expect(page.queryByText('Ada Lovelace')).toBeNull();

    const box = page.getByRole('searchbox', { name: 'Search partners' });
    fireEvent.change(box, { target: { value: '  Lovelace ' } });
    expect(await page.findByText('Showing 1 partner matching “Lovelace”', {}, SLOW)).toBeTruthy();
    expect(listRequests().at(-1)!.url.searchParams.get('q')).toBe('Lovelace');
    expect(page.getByText('Ada Lovelace')).toBeTruthy();
    expect(page.queryByText('Bulk 0')).toBeNull();

    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(await page.findByText('No partners match “zzz”', {}, SLOW)).toBeTruthy();
    // The search box stays put so the admin can correct the term.
    expect(page.getByRole('searchbox', { name: 'Search partners' })).toBe(box);

    fireEvent.change(box, { target: { value: '' } });
    expect(await page.findByText('Showing 100 partners', {}, SLOW)).toBeTruthy();
  });

  it("refetches every loaded page when a row action invalidates ['partners']", async () => {
    const rita = partner('p_rita', 'Revoked Rita', 'rita@example.com', { revokedAt: '2026-10-05T00:00:00.000Z' });
    roster = [rita, ...bulk(150)];
    const page = renderWithClient(<AdminPartners />);
    await page.findByText('Showing 100 partners', {}, SLOW);
    fireEvent.click(page.getByRole('button', { name: 'Load more' }));
    await page.findByText('Showing 151 partners', {}, SLOW);

    const before = listRequests().length;
    roster[0] = { ...rita, revokedAt: null }; // what the reinstate does server-side
    fireEvent.click(page.getByRole('button', { name: 'Reinstate' }));

    await waitFor(() => expect(page.queryByRole('button', { name: 'Reinstate' })).toBeNull(), SLOW);
    expect(requests.some((r) => r.method === 'POST' && r.url.pathname === '/api/partners/p_rita/reinstate')).toBe(true);
    const refetched = listRequests().slice(before);
    expect(refetched.map((r) => r.url.searchParams.get('cursor'))).toEqual([null, '100']);
    expect(page.getByText('Showing 151 partners')).toBeTruthy();
  });
});

describe('admin Links hub', { timeout: 15_000 }, () => {
  it('is a searchable picker over the whole roster', async () => {
    roster = [...bulk(250), ADA];
    const page = renderWithClient(<LinksPage principal={{ role: 'admin' }} />);

    expect(await page.findByText('Bulk 0', {}, SLOW)).toBeTruthy();
    expect(listRequests()[0]!.url.searchParams.get('limit')).toBe('30');
    expect(page.getAllByRole('link')).toHaveLength(30);

    fireEvent.click(page.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(page.getAllByRole('link')).toHaveLength(60), SLOW);

    fireEvent.change(page.getByRole('searchbox', { name: 'Search partners' }), { target: { value: 'ada@' } });
    await waitFor(() => expect(page.queryByText('Bulk 0')).toBeNull(), SLOW);
    expect(listRequests().at(-1)!.url.searchParams.get('q')).toBe('ada@');
    expect(page.getByRole('link', { name: /Ada Lovelace/ }).getAttribute('href')).toBe('/links?partnerId=p_ada');
    expect(page.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
