// @vitest-environment jsdom
/**
 * Manual payouts in the portal (docs/manual-payout-files.md):
 *   - the admin Payouts page shows the files made from a run, what's ready
 *     for a new file, why the rest are in none, and warnings worth reading
 *     before sending; it makes a file, and marks a file sent or discards
 *     it only after asking; a payout in no file is marked sent one at a
 *     time, with its payment reference if the brand has one;
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
const RUN_ID = '01RUN0000000000000000000AA';

const RUN = {
  runId: RUN_ID,
  createdAt: LAST_MONTH,
  pendingCount: 4,
  ready: [{ provider: 'wise', currency: 'GBP', count: 1, total: '40.00' }],
  exports: [
    {
      exportId: 'exp_1',
      provider: 'paypal',
      currency: 'USD',
      createdAt: LAST_MONTH,
      createdBy: 'admin',
      pendingCount: 1,
      pendingTotal: '125.50',
      changedCount: 1,
      doNotPayCount: 0,
    },
  ],
  excluded: [
    { reason: 'pay_individually', count: 1 },
    { reason: 'screening_confirmed', count: 1 },
  ],
};

const payout = (over: Record<string, unknown>) => ({
  partnerEmail: `${String(over.partnerName).toLowerCase()}@example.com`,
  currency: 'USD',
  createdAt: LAST_MONTH,
  destination: null,
  export: null,
  ready: null,
  excluded: null,
  complianceWarning: null,
  doNotPay: null,
  ...over,
});

const PAYOUTS = [
  payout({
    payoutId: 'po_ana',
    partnerId: 'p_ana',
    partnerName: 'Ana',
    amount: '125.50',
    destination: { method: 'paypal', country: null, summary: 'PayPal a•••@pay.test', updatedAt: NOW, updatedBy: 'partner' },
    export: { exportId: 'exp_1', provider: 'paypal', createdAt: LAST_MONTH, reference: 'po_ana', destinationChanged: true },
    complianceWarning: 'screening_review',
  }),
  payout({
    payoutId: 'po_cleo',
    partnerId: 'p_cleo',
    partnerName: 'Cleo',
    amount: '40.00',
    currency: 'GBP',
    destination: { method: 'bank', country: 'GB', summary: 'Bank account •••• 6819 (GBP)', updatedAt: LAST_MONTH, updatedBy: 'partner' },
    ready: 'wise',
  }),
  payout({
    payoutId: 'po_esha',
    partnerId: 'p_esha',
    partnerName: 'Esha',
    amount: '10.00',
    destination: { method: 'upi', country: 'IN', summary: 'UPI e•••@okaxis', updatedAt: LAST_MONTH, updatedBy: 'partner' },
    excluded: 'pay_individually',
  }),
  payout({
    payoutId: 'po_ivan',
    partnerId: 'p_ivan',
    partnerName: 'Ivan',
    amount: '50.00',
    excluded: 'screening_confirmed',
    complianceWarning: 'screening_confirmed',
    doNotPay: 'screening_confirmed',
  }),
];

beforeEach(() => {
  requests = [];
  putResponse = () => json(200, { profile: null, paidVia: 'manual' });
  // jsdom has no object URLs; saving a file only needs them to exist.
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, body });
    if (path === '/payouts/holds') return json(200, { holds: [] });
    if (path === '/payouts/runs') {
      return json(200, {
        runs: [{ runId: RUN_ID, createdAt: LAST_MONTH, pendingCount: 4, pendingTotals: [{ currency: 'USD', amount: '185.50' }] }],
        nextCursor: null,
      });
    }
    if (path === `/payouts/runs/${RUN_ID}`) return json(200, RUN);
    if (path === `/payouts/runs/${RUN_ID}/payouts`) return json(200, { payouts: PAYOUTS, nextCursor: null });
    if (path === `/payouts/runs/${RUN_ID}/exports` && method === 'POST') {
      return json(201, {
        export: { exportId: 'exp_2', runId: RUN_ID, provider: 'wise', currency: 'GBP', createdAt: NOW, createdBy: 'admin', payoutIds: ['po_cleo'], count: 1, total: '40.00' },
        filename: 'wise-payouts-exp_2-GBP.csv',
        csv: 'name,recipientEmail\r\nCleo,c@example.com\r\n',
      });
    }
    if (path === '/payouts/exports/exp_1/confirm' && method === 'POST') return json(200, { confirmed: [], notConfirmable: [] });
    if (path === '/payouts/exports/exp_1/discard' && method === 'POST') return json(200, { released: 1 });
    if (path === '/payouts/confirm' && method === 'POST') return json(200, { confirmed: [], notConfirmable: [] });
    if (path === '/payouts/po_esha/confirm' && method === 'POST') return json(200, { payout: { id: 'po_esha', status: 'paid' } });
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
  it('shows files made, what a new file would take, and warnings before sending', async () => {
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    await view.findByText('Manual payouts to send');
    await view.findByText('PayPal a•••@pay.test');
    expect(view.getByText(/1 payout to confirm · \$125\.50/)).toBeTruthy();
    expect(view.getByText(/1 partner changed their payout details since this file was made/)).toBeTruthy();
    expect(view.getByText(/· GBP · 1 payout · £40\.00/)).toBeTruthy();
    expect(view.getByText('Ready for Wise')).toBeTruthy();
    expect(view.getByText(/Pay this one yourself/)).toBeTruthy();
    expect(view.getByText(/Confirmed sanctions-list match/)).toBeTruthy();
    expect(view.getByText(/possible match\. OpenPartner is reviewing it\. Check before you send it/)).toBeTruthy();
    expect(view.getByText('Payout details changed since this file was made.')).toBeTruthy();
  });

  it('marks a file as sent only after asking, and confirms that file’s payouts', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    await view.findByText('PayPal a•••@pay.test');
    // One for the file, plus one for the payout in no file that may be paid
    // by hand: Esha's UPI. None for Ivan's confirmed match.
    const buttons = view.getAllByRole('button', { name: 'Mark sent' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Mark this PayPal file’s payout as sent?'));
    expect(requests.some((r) => r.path.includes('/confirm'))).toBe(false);

    confirm.mockReturnValue(true);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.path === '/payouts/exports/exp_1/confirm')).toBe(true));
    expect(requests.some((r) => r.path === '/payouts/confirm')).toBe(false);
  });

  it('marks a payout in no file as sent with its payment reference, which may be left blank', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    await view.findByText('UPI e•••@okaxis');
    const markEsha = () => fireEvent.click(view.getAllByRole('button', { name: 'Mark sent' })[1]!);

    // Cancel sends nothing.
    markEsha();
    fireEvent.change(view.getByLabelText('Payment reference (optional)'), { target: { value: 'wrong one' } });
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByLabelText('Payment reference (optional)')).toBeNull();

    markEsha();
    const field = view.getByLabelText('Payment reference (optional)') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.maxLength).toBe(100);
    expect(view.getByText(/printed on Esha’s statement/)).toBeTruthy();
    fireEvent.change(field, { target: { value: '  UPI 412345678901 ' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST' && r.path === '/payouts/po_esha/confirm')?.body).toEqual({ reference: 'UPI 412345678901' }),
    );
    expect(requests.some((r) => r.path === '/payouts/confirm')).toBe(false);
    expect(confirm).not.toHaveBeenCalled();

    // Blank: confirmed with no reference.
    requests = [];
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    markEsha();
    fireEvent.submit((view.getByLabelText('Payment reference (optional)') as HTMLInputElement).closest('form')!);
    await waitFor(() => expect(requests.find((r) => r.method === 'POST' && r.path === '/payouts/po_esha/confirm')?.body).toEqual({}));
  });

  it('makes a file from what’s ready, and discards one only after asking', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    fireEvent.click(await view.findByRole('button', { name: 'Make file' }));
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST' && r.path === `/payouts/runs/${RUN_ID}/exports`)?.body).toEqual({
        provider: 'wise',
        currency: 'GBP',
      }),
    );
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());

    fireEvent.click(view.getByRole('button', { name: 'Discard' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Only do this if you never uploaded it'));
    expect(requests.some((r) => r.path.endsWith('/discard'))).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(view.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.path === '/payouts/exports/exp_1/discard')).toBe(true));
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
