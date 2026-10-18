// @vitest-environment jsdom
/**
 * Paying a partner a bonus from the admin partner page (POST /bonuses), and
 * how bonus commissions read in the commission lists (docs/bounties.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { AdminPartnerCommission } from '../pages/AdminPartnerCommission.js';
import { CommissionsPage } from '../pages/Commissions.js';
import { commissionSourceLabel } from '../lib/commission-source.js';

let requests: Array<{ method: string; path: string; search: string; body: Record<string, unknown> | undefined }> = [];
let bonusResponse: { status: number; body: unknown };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PROGRAMS = [
  { id: 'prog_1', name: 'Launch program', granted: true, commissionRule: [{ trigger: 'every', type: 'percent', value: 20 }], holdbackDays: 14, commission: null },
  { id: 'prog_2', name: 'Not granted', granted: false, commissionRule: [{ trigger: 'every', type: 'percent', value: 10 }], holdbackDays: null, commission: null },
];

beforeEach(() => {
  requests = [];
  bonusResponse = {
    status: 201,
    body: { bonus: { id: 'bon_1', amount: '50.00', currency: 'EUR' }, commission: { id: 'c_1', status: 'approved' } },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, search: url.search, body });
    if (path === '/partners/p_ada') return json(200, { id: 'p_ada', name: 'Ada Partner', email: 'ada@example.com' });
    if (path === '/partners/p_ada/commission-snapshot') return json(200, { snapshot: null });
    if (path === '/partners/p_ada/programs') return json(200, { programs: PROGRAMS });
    if (path === '/config/program') return json(200, { defaultCurrency: 'EUR' });
    if (path === '/bonuses' && method === 'POST') return json(bonusResponse.status, bonusResponse.body);
    if (path === '/bonuses') {
      return json(200, {
        bonuses: [
          {
            id: 'bon_0', amount: '20.00', currency: 'EUR', source: 'manual', note: 'Launch week',
            createdAt: '2026-10-10T00:00:00.000Z', commission: { id: 'c_0', status: 'paid' },
          },
        ],
        nextCursor: null,
      });
    }
    if (path === '/commissions') {
      return json(200, {
        commissions: [
          {
            id: 'c_sale', partnerId: 'p_ada', amount: '12.00', currency: 'USD', status: 'approved',
            accruedAt: '2026-10-10T00:00:00.000Z', paidAt: null, campaignName: 'Launch program', source: 'attribution', bonus: null,
          },
          {
            id: 'c_bonus', partnerId: 'p_ada', amount: '50.00', currency: 'USD', status: 'approved',
            accruedAt: '2026-10-11T00:00:00.000Z', paidAt: null, campaignName: null, source: 'bonus',
            bonus: { id: 'bon_1', source: 'manual', note: 'Top referrer in October', bountyId: null },
          },
        ],
        nextCursor: null,
      });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithClient(ui: ReactElement, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

function partnerPage() {
  return renderWithClient(
    <Routes>
      <Route path="/admin/partners/:id/commission" element={<AdminPartnerCommission />} />
    </Routes>,
    '/admin/partners/p_ada/commission',
  );
}

async function openForm(page: ReturnType<typeof render>) {
  fireEvent.click(await page.findByRole('button', { name: 'Pay a bonus' }));
  return within(await page.findByRole('region', { name: 'Pay Ada Partner a bonus' }));
}

const posts = () => requests.filter((r) => r.method === 'POST' && r.path === '/bonuses');

describe('admin partner page: pay a bonus', () => {
  it("lists the partner's recent bonuses", async () => {
    const page = partnerPage();
    expect(await page.findByText('Bonus: Launch week')).toBeTruthy();
    expect(requests.find((r) => r.path === '/bonuses')?.search).toBe('?partnerId=p_ada&limit=10');
  });

  it('pays in the default currency with a note and a granted program, and says it goes out next run', async () => {
    const page = partnerPage();
    const form = await openForm(page);

    await waitFor(() => expect((form.getByLabelText('Bonus currency') as HTMLInputElement).value).toBe('EUR'));
    fireEvent.change(form.getByLabelText('Bonus amount'), { target: { value: '50' } });
    await form.findByRole('option', { name: 'Launch program' });
    // Only programs the partner is in.
    expect(form.queryByRole('option', { name: 'Not granted' })).toBeNull();
    fireEvent.change(form.getByLabelText('Bonus program'), { target: { value: 'prog_1' } });
    fireEvent.change(form.getByLabelText('Bonus note'), { target: { value: '  Top referrer in October  ' } });
    fireEvent.click(form.getByRole('button', { name: /^Pay / }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    const sent = posts()[0]!.body!;
    expect(sent).toMatchObject({ partnerId: 'p_ada', amount: 50, currency: 'EUR', programId: 'prog_1', note: 'Top referrer in October' });
    expect(sent.hold).toBeUndefined();
    // An idempotency key, so a double submit pays once.
    expect(sent.externalRef).toMatch(/^portal-/);

    expect((await page.findByRole('status')).textContent).toMatch(/approved, and paid in the next payout run/);
    expect(page.queryByRole('region', { name: 'Pay Ada Partner a bonus' })).toBeNull();
  });

  it('refuses more than two decimals before sending, and can hold for the holdback', async () => {
    bonusResponse = {
      status: 201,
      body: { bonus: { id: 'bon_2', amount: '10.00', currency: 'EUR' }, commission: { id: 'c_2', status: 'accrued' } },
    };
    const page = partnerPage();
    const form = await openForm(page);

    fireEvent.change(form.getByLabelText('Bonus amount'), { target: { value: '10.005' } });
    expect(form.getByText('A positive amount with at most two decimals.')).toBeTruthy();
    expect((form.getByRole('button', { name: 'Pay bonus' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(form.getByLabelText('Bonus amount'), { target: { value: '10' } });
    fireEvent.click(form.getByRole('checkbox'));
    fireEvent.click(form.getByRole('button', { name: /^Pay / }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toMatchObject({ amount: 10, hold: true });
    expect((await page.findByRole('status')).textContent).toMatch(/held until the holdback ends/);
  });

  it('shows the API error and keeps the form open', async () => {
    bonusResponse = { status: 409, body: { error: 'partner_revoked', detail: 'This partner is revoked. Reinstate them to pay a bonus.' } };
    const page = partnerPage();
    const form = await openForm(page);
    fireEvent.change(form.getByLabelText('Bonus amount'), { target: { value: '5' } });
    fireEvent.click(form.getByRole('button', { name: /^Pay / }));
    expect(await form.findByText(/Reinstate them to pay a bonus/)).toBeTruthy();
  });
});

describe('commission lists: where each commission came from', () => {
  it('labels a bonus with its note and a sale as a sale', async () => {
    const page = renderWithClient(<CommissionsPage principal={{ role: 'admin' }} />);
    const bonus = within((await page.findByText('Bonus: Top referrer in October')).closest('tr') as HTMLElement);
    expect(bonus.getByText('approved')).toBeTruthy();
    const sale = within((await page.findByText('Sale')).closest('tr') as HTMLElement);
    expect(sale.getByText('Launch program')).toBeTruthy();
  });

  it('names Network bounties, and rows from before the field are sales', () => {
    expect(commissionSourceLabel({ source: 'bonus', bonus: { source: 'network', note: 'Unboxing video', bountyId: null } })).toBe(
      'Network bounty: Unboxing video',
    );
    expect(commissionSourceLabel({ source: 'bonus', bonus: { source: 'manual', note: null, bountyId: null } })).toBe('Bonus');
    expect(commissionSourceLabel({})).toBe('Sale');
  });
});
