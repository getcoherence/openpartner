// @vitest-environment jsdom
/**
 * Partner postback URLs are sealed at rest and may hold the tracker's
 * secret, so the Postbacks page lists each one by its masked `urlPreview`
 * and only the edit form loads the URL itself (GET …/url, which answers the
 * owning partner only). Saving sends `url` only when it changed, so editing
 * the events never rewrites it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PartnerPostbacksPage } from '../pages/partner/Postbacks.js';

const SECRET = 'trk_s3cr3t_9f2a17c0';
const FULL_URL = `https://t.example/v1/pb?cid={click_id}&secret=${SECRET}`;
const PREVIEW = 'https://t.example/•••?cid={click_id}&•••';

const ROW = {
  id: 'pb1',
  partnerId: 'p1',
  urlPreview: PREVIEW,
  events: ['commission.accrued'],
  enabled: true,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
  lastFiredAt: null,
  lastStatus: null,
  lastError: null,
  successCount: 0,
  failureCount: 0,
};

let requests: Array<{ method: string; path: string; body: unknown }> = [];
let urlResponse: { status: number; body: unknown } = { status: 200, body: { url: FULL_URL } };
let rows: Array<typeof ROW | (Omit<typeof ROW, 'urlPreview'> & { urlPreview: string | null })> = [ROW];
let createStatus = 201;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  requests = [];
  urlResponse = { status: 200, body: { url: FULL_URL } };
  rows = [ROW];
  createStatus = 201;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, body });
    if (path === '/partners/p1/postbacks' && method === 'GET') return json(200, { postbacks: rows, supportedEvents: [] });
    if (path === '/partners/p1/postbacks' && method === 'POST') {
      return createStatus === 201 ? json(201, { ...ROW, id: 'pb2' }) : json(createStatus, { error: 'destination_not_allowed' });
    }
    if (path === '/partners/p1/postbacks/pb1/url') return json(urlResponse.status, urlResponse.body);
    if (path === '/partners/p1/postbacks/pb1' && method === 'PATCH') return json(200, { ...ROW, ...body });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const page = render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <PartnerPostbacksPage principal={{ role: 'partner', partnerId: 'p1' }} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return Object.assign(page, { qc });
}

/** Everything the query and mutation caches still hold. */
function cached(qc: QueryClient): string {
  return JSON.stringify([
    qc.getQueryCache().getAll().map((q) => q.state.data),
    qc.getMutationCache().getAll().map((m) => m.state.variables),
  ]);
}

describe('partner postbacks: masked URLs', () => {
  it('lists the masked preview and never asks for the URL until Edit', async () => {
    const page = show();
    expect(await page.findByText(PREVIEW)).toBeTruthy();
    expect(page.container.textContent).not.toContain(SECRET);
    expect(requests.some((r) => r.path.endsWith('/url'))).toBe(false);
  });

  it('Edit loads the full URL for the partner; saving events alone leaves the URL out', async () => {
    const page = show();
    fireEvent.click(await page.findByText('Edit'));
    const input = (await page.findByDisplayValue(FULL_URL)) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(requests.filter((r) => r.path === '/partners/p1/postbacks/pb1/url')).toHaveLength(1);

    fireEvent.click(page.getByLabelText('commission.paid'));
    fireEvent.click(page.getByText('Save'));
    await waitFor(() => expect(requests.some((r) => r.method === 'PATCH')).toBe(true));
    const patch = requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body).toEqual({ events: ['commission.accrued', 'commission.paid'] });
  });

  it('a changed URL is sent', async () => {
    const page = show();
    fireEvent.click(await page.findByText('Edit'));
    const input = (await page.findByDisplayValue(FULL_URL)) as HTMLInputElement;
    const next = 'https://t.example/v2?cid={click_id}&secret=rotated';
    fireEvent.change(input, { target: { value: next } });
    fireEvent.click(page.getByText('Save'));
    await waitFor(() => expect(requests.some((r) => r.method === 'PATCH')).toBe(true));
    expect(requests.find((r) => r.method === 'PATCH')!.body).toEqual({ url: next, events: ['commission.accrued'] });
    // The form closes, and neither the URL it loaded nor the one it sent
    // stays in memory.
    await waitFor(() => expect(page.queryByText('Save')).toBeNull());
    await waitFor(() => {
      expect(cached(page.qc)).not.toContain(SECRET);
      expect(cached(page.qc)).not.toContain('rotated');
    });
  });

  it('Cancel drops the loaded URL from the cache', async () => {
    const page = show();
    fireEvent.click(await page.findByText('Edit'));
    await page.findByDisplayValue(FULL_URL);
    expect(cached(page.qc)).toContain(SECRET);
    fireEvent.click(page.getByText('Cancel'));
    await waitFor(() => expect(cached(page.qc)).not.toContain(SECRET));
  });

  it('Add postback: nothing keeps the URL once the form closes, after a create or a failed one', async () => {
    const page = show();
    const typeAndCreate = async () => {
      fireEvent.click(await page.findByText('Add postback'));
      fireEvent.change(page.getByPlaceholderText(/tracker\.example\.com/), { target: { value: FULL_URL } });
      fireEvent.click(page.getByText('Create'));
    };

    await typeAndCreate();
    await waitFor(() => expect(page.queryByText('New postback URL')).toBeNull());
    await waitFor(() => expect(cached(page.qc)).not.toContain(SECRET));

    createStatus = 400;
    await typeAndCreate();
    expect(await page.findByText(/destination_not_allowed|400/)).toBeTruthy();
    expect(cached(page.qc)).toContain(SECRET);
    fireEvent.click(page.getByText('Cancel'));
    await waitFor(() => expect(cached(page.qc)).not.toContain(SECRET));
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(2);
  });

  it("a URL this deployment can't open: the list says so, and Edit asks for it again", async () => {
    rows = [{ ...ROW, urlPreview: null }];
    urlResponse = { status: 409, body: { error: 'url_unreadable' } };
    const page = show();
    expect(await page.findByText(/can't be read here/)).toBeTruthy();
    fireEvent.click(page.getByText('Edit'));
    expect(await page.findByText(/Enter it again/)).toBeTruthy();
    expect((page.getByPlaceholderText(/tracker\.example\.com/) as HTMLInputElement).value).toBe('');
  });
});
