// @vitest-environment jsdom
/**
 * Payout statements in the portal:
 *   - every payout row, the partner's own and the admin's, links to its
 *     statement (GET /payouts/:id/statement) under the tenant's API prefix;
 *   - signed in with a pasted API key, which a plain link can't carry, the
 *     click fetches the statement with the key and opens it in the new tab;
 *   - Settings edits what statements print.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { PayoutsPage } from '../pages/Payouts.js';
import { PayoutStatementsSection } from '../pages/admin/Settings.js';

let requests: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const NOW = new Date().toISOString();
const payout = (over: Record<string, unknown>) => ({
  tenantId: 't_1', currency: 'INR', method: 'manual', status: 'paid', stripeTransferId: null,
  metadata: {}, createdAt: NOW, completedAt: NOW, ...over,
});

let statementSettings = { legalName: null as string | null, address: null as string | null, footer: null as string | null, numberPrefix: null as string | null };

beforeEach(() => {
  requests = [];
  statementSettings = { legalName: 'Volza Technologies Pvt Ltd', address: null, footer: null, numberPrefix: 'VZ-' };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api(\/t\/[a-z0-9-]+)?/, '');
    const auth = new Headers(init?.headers).get('Authorization');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: url.pathname, auth, body });
    if (path === '/partners/p_ada/payouts') return json(200, { payouts: [payout({ id: 'po_ada_1', partnerId: 'p_ada', amount: '1730.50' })] });
    if (path === '/payouts/holds') return json(200, { holds: [] });
    if (path === '/payouts/runs') return json(200, { runs: [], nextCursor: null });
    if (path === '/payouts') {
      return json(200, { payouts: [payout({ id: 'po_ravi_1', partnerId: 'p_ravi', partnerName: 'Ravi Shah', amount: '40.00', currency: 'USD' })], nextCursor: null });
    }
    if (path === '/payouts/po_ada_1/statement') return new Response('<!doctype html><title>Payout statement</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (path === '/config/payout-statements' && method === 'GET') return json(200, { ...statementSettings, taxLines: { enabled: false, labels: ['Tax withheld'] } });
    if (path === '/config/payout-statements' && method === 'POST') {
      statementSettings = { ...statementSettings, ...(body as object) };
      return json(200, { ...statementSettings, taxLines: { enabled: false, labels: ['Tax withheld'] } });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

function renderAt(ui: ReactElement, path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/payouts" element={ui} />
          <Route path="/settings" element={ui} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Statement links', () => {
  it("links each of a partner's own payouts to its statement", async () => {
    const page = renderAt(<PayoutsPage principal={{ role: 'partner', partnerId: 'p_ada' }} />, '/payouts');
    const row = within((await page.findByText('₹1,730.50')).closest('tr') as HTMLElement);
    const link = row.getByRole('link', { name: 'Payout statement' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/payouts/po_ada_1/statement');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it("links every row of the admin's payout list, under the tenant's prefix", async () => {
    window.history.replaceState({}, '', '/t/volza/payouts');
    const page = renderAt(<PayoutsPage principal={{ role: 'admin' }} />, '/payouts');
    const row = within((await page.findByText('Ravi Shah')).closest('tr') as HTMLElement);
    expect((row.getByRole('link', { name: 'Payout statement' }) as HTMLAnchorElement).getAttribute('href')).toBe(
      '/api/t/volza/payouts/po_ravi_1/statement',
    );
  });

  it('fetches the statement with a pasted API key and opens it in the new tab', async () => {
    localStorage.setItem('op:apiKey', 'op_test_key');
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    URL.createObjectURL = vi.fn(() => 'blob:statement');
    URL.revokeObjectURL = vi.fn();

    const page = renderAt(<PayoutsPage principal={{ role: 'partner', partnerId: 'p_ada' }} />, '/payouts');
    fireEvent.click(await page.findByRole('link', { name: 'Payout statement' }));

    expect(open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('blob:statement'));
    expect(tab.opener).toBeNull();
    expect(requests.find((r) => r.path === '/api/payouts/po_ada_1/statement')?.auth).toBe('Bearer op_test_key');
  });
});

describe('Settings: payout statements', () => {
  it('shows what statements print and saves changes', async () => {
    const page = renderAt(<PayoutStatementsSection />, '/settings');
    const legal = (await page.findByDisplayValue('Volza Technologies Pvt Ltd')) as HTMLInputElement;
    expect(page.getByDisplayValue('VZ-')).toBeTruthy();
    fireEvent.change(legal, { target: { value: 'Volza Tech Pvt Ltd' } });
    fireEvent.change(page.getAllByRole('textbox')[3]!, { target: { value: 'Payout questions: payouts@volza.test' } });
    fireEvent.click(page.getByRole('button', { name: 'Save statement settings' }));
    expect(await page.findByText('Saved.')).toBeTruthy();
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      legalName: 'Volza Tech Pvt Ltd',
      address: '',
      footer: 'Payout questions: payouts@volza.test',
      numberPrefix: 'VZ-',
    });
  });
});
