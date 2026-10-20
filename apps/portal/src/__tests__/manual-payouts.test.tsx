// @vitest-environment jsdom
/**
 * Manual payouts in the portal (docs/manual-payout-files.md):
 *   - the admin Payouts page shows a run's PayPal and Wise files, why the
 *     rest are in no file, and warnings worth reading before sending; and
 *     marks a file's payouts as sent only after asking;
 *   - the partner's Payout details form sends only the fields the
 *     account's route needs, and shows field errors from the API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { PayoutsPage } from '../pages/Payouts.js';
import { PayoutDetailsPage } from '../pages/PayoutDetails.js';

let requests: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
let putResponse: () => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const NOW = new Date().toISOString();
const LAST_MONTH = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

const RUN = {
  runId: '01RUN0000000000000000000AA',
  createdAt: LAST_MONTH,
  payouts: [
    {
      payoutId: 'po_ana',
      partnerId: 'p_ana',
      partnerName: 'Ana',
      partnerEmail: 'ana@example.com',
      amount: '125.50',
      currency: 'USD',
      status: 'pending',
      createdAt: LAST_MONTH,
      completedAt: null,
      destination: { method: 'paypal', country: null, summary: 'PayPal a•••@pay.test', updatedAt: NOW, updatedBy: 'partner' },
      file: { provider: 'paypal', currency: 'USD', part: 1, reference: 'po_ana' },
      excluded: null,
      complianceWarning: 'screening_review',
      lastExport: null,
    },
    {
      payoutId: 'po_esha',
      partnerId: 'p_esha',
      partnerName: 'Esha',
      partnerEmail: 'esha@example.com',
      amount: '10.00',
      currency: 'USD',
      status: 'pending',
      createdAt: LAST_MONTH,
      completedAt: null,
      destination: { method: 'upi', country: 'IN', summary: 'UPI e•••@okaxis', updatedAt: LAST_MONTH, updatedBy: 'partner' },
      file: null,
      excluded: 'pay_individually',
      complianceWarning: null,
      lastExport: null,
    },
    {
      payoutId: 'po_ivan',
      partnerId: 'p_ivan',
      partnerName: 'Ivan',
      partnerEmail: 'ivan@example.com',
      amount: '50.00',
      currency: 'USD',
      status: 'pending',
      createdAt: LAST_MONTH,
      completedAt: null,
      destination: null,
      file: null,
      excluded: 'screening_confirmed',
      complianceWarning: 'screening_confirmed',
      lastExport: null,
    },
  ],
  files: [{ provider: 'paypal', currency: 'USD', part: 1, count: 1, total: '125.50' }],
};

beforeEach(() => {
  requests = [];
  putResponse = () => json(200, { profile: null, paidVia: 'manual' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, body });
    if (path === '/payouts/holds') return json(200, { holds: [] });
    if (path === '/payouts/runs') {
      return json(200, {
        runs: [{ runId: RUN.runId, createdAt: RUN.createdAt, payoutCount: 3, pendingCount: 3, pendingTotals: [{ currency: 'USD', amount: '185.50' }] }],
      });
    }
    if (path === `/payouts/runs/${RUN.runId}`) return json(200, RUN);
    if (path === '/payouts/confirm' && method === 'POST') return json(200, { confirmed: [], notConfirmable: [] });
    if (path === '/partners/p_me/payout-profile' && method === 'GET') return json(200, { profile: null, paidVia: 'manual' });
    if (path === '/partners/p_me/payout-profile' && method === 'PUT') return putResponse();
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('admin manual payout files', () => {
  it('shows each file, the payouts in none, and warnings before sending', async () => {
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    await view.findByText('Manual payouts to send');
    await view.findByText('PayPal a•••@pay.test');
    expect(view.getByText(/1 payout · \$125\.50/)).toBeTruthy();
    expect(view.getByText(/Pay this one yourself/)).toBeTruthy();
    expect(view.getByText(/Confirmed sanctions-list match/)).toBeTruthy();
    expect(view.getByText(/possible match\. OpenPartner is reviewing it\. Check before you send it/)).toBeTruthy();
    expect(view.getByText(/Details changed .* by the partner/)).toBeTruthy();
  });

  it('marks a file as sent only after asking, and never offers it for a confirmed match', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    await view.findByText('PayPal a•••@pay.test');
    // One per file, plus one per payout in no file that may be paid by
    // hand: Esha's UPI, not Ivan's confirmed match.
    const buttons = view.getAllByRole('button', { name: 'Mark sent' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Mark this PayPal payout as sent?'));
    expect(requests.some((r) => r.path === '/payouts/confirm')).toBe(false);

    confirm.mockReturnValue(true);
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(requests.find((r) => r.path === '/payouts/confirm')?.body).toEqual({ payoutIds: ['po_ana'] }),
    );
  });
});

describe('partner payout details', () => {
  async function fillUkAccount() {
    const view = renderWithClient(<PayoutDetailsPage principal={{ role: 'partner', partnerId: 'p_me' }} />);
    await view.findByLabelText('How should we pay you?');
    const set = (label: string, value: string) => fireEvent.change(view.getByLabelText(label), { target: { value } });
    set('How should we pay you?', 'bank');
    set('Name on the account', 'Cleo Smith');
    set('Bank’s country', 'GB');
    set('Account currency', 'GBP');
    set('Account identified by', 'local');
    set('Account number', '31926819');
    set('Sort code', '23-14-70');
    fireEvent.submit(view.getByRole('button', { name: 'Save details' }).closest('form')!);
    return view;
  }

  it('sends only what a UK account number needs', async () => {
    await fillUkAccount();
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
        method: 'bank',
        accountHolderName: 'Cleo Smith',
        accountHolderType: 'person',
        country: 'GB',
        currency: 'GBP',
        accountNumber: '31926819',
        sortCode: '23-14-70',
      }),
    );
  });

  it('shows the API’s field errors next to the field', async () => {
    putResponse = () => json(400, { error: 'invalid_body', detail: { formErrors: [], fieldErrors: { sortCode: ['sortCode must be 6 digits'] } } });
    const view = await fillUkAccount();
    await view.findByText('sortCode must be 6 digits');
  });
});
