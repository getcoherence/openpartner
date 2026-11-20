// @vitest-environment jsdom
/**
 * /admin/webhooks: deleting an endpoint, and the status labels.
 *
 * The trash button used to send a plain DELETE, which the API treats as
 * "deactivate" (the same as Disable), so the endpoint stayed on the list
 * and couldn't be got rid of. It now asks first, then deletes for real
 * (`?hard=1`); Disable still keeps an endpoint and its delivery log.
 *
 * Statuses used to borrow other pages' words for their colours: a delivered
 * event read "paid", a disabled endpoint "pending".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WebhooksPage } from '../pages/admin/Webhooks.js';

let requests: Array<{ method: string; path: string; search: string; body: unknown }> = [];
let endpoints: Array<Record<string, unknown>>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  requests = [];
  endpoints = [
    {
      id: 'whe_1',
      url: 'http://127.0.0.1:9000/webhook',
      secretPrefix: 'whsec_ab',
      events: ['coupon.registered'],
      active: true,
      label: null,
      createdAt: '2026-11-15T09:00:00.000Z',
      lastUsedAt: null,
    },
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, search: url.search, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (path === '/webhooks' && method === 'GET') return json(200, { endpoints });
    if (path === '/webhooks/whe_1' && method === 'DELETE') {
      endpoints = url.searchParams.get('hard') === '1' ? [] : endpoints.map((e) => ({ ...e, active: false }));
      return json(200, { ok: true });
    }
    if (path === '/webhooks/whe_1/deliveries') {
      return json(200, {
        deliveries: [
          { id: 'd_ok', endpointId: 'whe_1', eventId: 'evt_1', eventType: 'coupon.registered', status: 'delivered', httpStatus: 200, error: null, attempts: 1, createdAt: '2026-11-15T09:20:00.000Z', deliveredAt: '2026-11-15T09:20:00.000Z', lastAttemptAt: '2026-11-15T09:20:00.000Z' },
          { id: 'd_bad', endpointId: 'whe_1', eventId: 'evt_2', eventType: 'coupon.registered', status: 'failed', httpStatus: null, error: 'fetch failed', attempts: 5, createdAt: '2026-11-15T09:17:00.000Z', deliveredAt: null, lastAttemptAt: '2026-11-15T09:19:00.000Z' },
        ],
      });
    }
    if (path === '/webhooks/whe_1' && method === 'PATCH') {
      endpoints = endpoints.map((e) => ({ ...e, active: false }));
      return json(200, { endpoint: endpoints[0] });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => cleanup());

function page() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/admin/webhooks']}>
      <QueryClientProvider client={qc}>
        <WebhooksPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const deletes = () => requests.filter((r) => r.method === 'DELETE');

describe('/admin/webhooks', () => {
  it('asks first, then deletes it for good, and it leaves the list', async () => {
    const view = page();
    expect(await view.findByText('http://127.0.0.1:9000/webhook')).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Delete endpoint' }));
    // Nothing is sent until it's confirmed.
    expect(deletes()).toEqual([]);
    fireEvent.click(await view.findByRole('button', { name: 'Yes, delete' }));

    await waitFor(() => expect(deletes()).toEqual([{ method: 'DELETE', path: '/webhooks/whe_1', search: '?hard=1', body: undefined }]));
    await waitFor(() => expect(view.queryByText('http://127.0.0.1:9000/webhook')).toBeNull());
  });

  it('Disable still keeps the endpoint, without deleting it', async () => {
    const view = page();
    fireEvent.click(await view.findByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'PATCH' && (r.body as { active?: boolean }).active === false)).toBe(true));
    expect(deletes()).toEqual([]);
    expect(await view.findByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(view.getByText('http://127.0.0.1:9000/webhook')).toBeTruthy();
  });

  it('labels deliveries delivered / failed, never with commission words like "paid"', async () => {
    const view = page();
    fireEvent.click(await view.findByRole('button', { name: 'Deliveries' }));
    expect(await view.findByText('delivered')).toBeTruthy();
    expect(view.getByText('failed')).toBeTruthy();
    expect(view.queryByText('paid')).toBeNull();
  });

  it('labels a disabled endpoint "disabled", not "pending"', async () => {
    endpoints = endpoints.map((e) => ({ ...e, active: false }));
    const view = page();
    expect(await view.findByText('disabled')).toBeTruthy();
    expect(view.queryByText('pending')).toBeNull();
  });
});
