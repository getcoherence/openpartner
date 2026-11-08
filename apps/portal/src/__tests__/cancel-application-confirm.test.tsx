// @vitest-environment jsdom
/**
 * "Cancel application" asks first, on both the creator portal and a brand's
 * partner portal. One click used to withdraw the application, and a brand
 * can't approve a cancelled one: the creator has to apply again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorMyRequestsPage } from '../pages/creator/CreatorMyRequests.js';
import { MyRequestsPage } from '../pages/partner/MyRequests.js';

const REQUEST = {
  id: 'req_1',
  status: 'pending',
  message: null,
  preferredSlug: 'ada',
  decisionNote: null,
  createdAt: '2026-11-08T17:54:19.000Z',
  decidedAt: null,
  offeringId: 'off_1',
  offeringTitle: 'Earn 50%',
  vendorId: 'ven_1',
  vendorName: 'Acme',
};

let posts: string[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'POST') {
      posts.push(url);
      return json(200, { ok: true });
    }
    if (url.endsWith('/me/requests')) return json(200, { requests: [REQUEST] });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderPage(page: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{page}</QueryClientProvider>
    </MemoryRouter>,
  );
}

describe.each([
  ['creator portal', () => <CreatorMyRequestsPage />, '/api/creator-api/creators/me/requests/req_1/cancel'],
  ['partner portal', () => <MyRequestsPage />, '/api/network/me/requests/req_1/cancel'],
])('Cancel application on the %s', (_name, page, cancelUrl) => {
  it('sends nothing until Yes', async () => {
    const view = renderPage(page());
    fireEvent.click(await view.findByRole('button', { name: 'Cancel application' }));
    expect(view.getByText('Cancel your application to Acme?')).toBeTruthy();
    expect(posts).toEqual([]);

    fireEvent.click(view.getByRole('button', { name: 'Yes, cancel it' }));
    await waitFor(() => expect(posts).toEqual([cancelUrl]));
  });

  it('Keep it leaves the application alone', async () => {
    const view = renderPage(page());
    fireEvent.click(await view.findByRole('button', { name: 'Cancel application' }));
    fireEvent.click(view.getByRole('button', { name: 'Keep it' }));
    expect(view.getByRole('button', { name: 'Cancel application' })).toBeTruthy();
    expect(posts).toEqual([]);
  });
});
