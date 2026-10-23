// @vitest-environment jsdom
/**
 * INR through Pay with PayPal in USD (docs/paypal-payouts.md "Balances
 * PayPal can't send"):
 *   - Settings turns it on, saying whose the conversion at withdrawal is;
 *   - an INR group reads "INR → USD", has no file, and its button quotes
 *     first: the confirm names both totals, the ECB rate and its date, and
 *     the send carries the quote id;
 *   - an expired quote says what to do;
 *   - the partner's payouts show the INR amount and what PayPal sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { PayoutsPage } from '../pages/Payouts.js';
import { PaypalPayoutsCard } from '../pages/admin/PaypalPayoutsCard.js';

let requests: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
let connections: unknown[] = [];
let settings: { sendUnsupportedAs: 'USD' | null } = { sendUnsupportedAs: null };
let sendAnswer: { status: number; body: unknown } = { status: 201, body: {} };
let batches: unknown[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const NOW = new Date().toISOString();
const RUN_ID = '01RUN0000000000000000000IN';

const LIVE = {
  id: 'conn_1',
  environment: 'live',
  clientIdPreview: 'AbCdEf…6789',
  appId: 'APP-1',
  payoutsEnabled: true,
  webhook: { registered: true, error: null },
  active: true,
  connectedAt: NOW,
  verifiedAt: NOW,
  lastError: null,
  lastErrorAt: null,
  openBatches: 0,
};

const RUN = {
  runId: RUN_ID,
  createdAt: NOW,
  pendingCount: 3,
  ready: [{ provider: 'paypal', currency: 'INR', sendAs: 'USD', count: 3, total: '4500.00' }],
  exports: [],
  inPaypalBatches: 0,
  excluded: [],
};

const QUOTE = {
  quoteId: 'payload.mac',
  runId: RUN_ID,
  currency: 'INR',
  sendAs: 'USD',
  rate: '0.011958866935',
  rateSource: 'ecb',
  rateDate: '2026-10-22',
  quotedAt: NOW,
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  count: 3,
  sourceTotal: '4500.00',
  sentTotal: '53.82',
  items: [],
  leftOut: [],
};

const CONVERTED_BATCH = {
  batchId: 'batch_inr',
  runId: RUN_ID,
  environment: 'live',
  currency: 'USD',
  itemCount: 3,
  total: '53.82',
  conversion: { sourceCurrency: 'INR', sourceTotal: '4500.00', rate: '0.011958866935', rateSource: 'ecb', rateDate: '2026-10-22', quotedAt: NOW },
  state: 'submitted',
  payoutBatchId: 'PB1',
  batchStatus: 'PROCESSING',
  summary: { paid: 0, released: 0, unclaimed: 0, processing: 3 },
  rehearsal: null,
  lastError: null,
  createdAt: NOW,
  createdBy: 'admin',
  completedAt: null,
  lastSyncedAt: null,
};

beforeEach(() => {
  requests = [];
  connections = [];
  settings = { sendUnsupportedAs: null };
  sendAnswer = { status: 201, body: { batch: CONVERTED_BATCH } };
  batches = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, body });
    if (path === '/payouts/holds') return json(200, { holds: [] });
    if (path === '/payouts') return json(200, { payouts: [], nextCursor: null });
    if (path === '/config/paypal') return json(200, { connections });
    if (path === '/config/paypal-payouts' && method === 'GET') return json(200, settings);
    if (path === '/config/paypal-payouts' && method === 'POST') {
      settings = { sendUnsupportedAs: (body?.sendUnsupportedAs as 'USD' | null) ?? null };
      return json(200, settings);
    }
    if (path === '/payouts/runs') {
      return json(200, { runs: [{ runId: RUN_ID, createdAt: NOW, pendingCount: 3, pendingTotals: [{ currency: 'INR', amount: '4500.00' }] }], nextCursor: null });
    }
    if (path === `/payouts/runs/${RUN_ID}`) return json(200, RUN);
    if (path === `/payouts/runs/${RUN_ID}/payouts`) return json(200, { payouts: [], nextCursor: null });
    if (path === `/payouts/runs/${RUN_ID}/paypal-batches` && method === 'GET') return json(200, { batches });
    if (path === `/payouts/runs/${RUN_ID}/paypal-batches/quote`) return json(200, { quote: QUOTE });
    if (path === `/payouts/runs/${RUN_ID}/paypal-batches` && method === 'POST') return json(sendAnswer.status, sendAnswer.body);
    if (path === '/partners/p_ravi/payouts') {
      return json(200, {
        payouts: [
          {
            id: '01PAYOUT00000000000000RAVI',
            partnerId: 'p_ravi',
            amount: '1500.00',
            currency: 'INR',
            method: 'manual',
            status: 'paid',
            createdAt: NOW,
            completedAt: NOW,
            stripeTransferId: null,
            sent: { amount: '17.94', currency: 'USD', rate: '0.011958866935', rateSource: 'ecb', rateDate: '2026-10-22' },
          },
        ],
      });
    }
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

describe('Settings: INR in USD', () => {
  it('is off until turned on, and says the conversion at withdrawal is the partner’s', async () => {
    connections = [LIVE];
    const view = renderWithClient(<PaypalPayoutsCard />);
    const box = (await view.findByRole('checkbox', { name: /Pay INR balances with PayPal in USD/ })) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    expect(view.getByText(/PayPal converts it at its own rate; that conversion is between them and PayPal/)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(requests.find((r) => r.method === 'POST' && r.path === '/config/paypal-payouts')?.body).toEqual({ sendUnsupportedAs: 'USD' }));
    await waitFor(() => expect(box.checked).toBe(true));
  });
});

describe('Manual payouts to send: INR → USD', () => {
  it('quotes first, shows both totals and the ECB rate, then sends at that quote', async () => {
    connections = [LIVE];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    await view.findByText(/INR → USD/);
    expect(view.queryByRole('button', { name: 'Make file' })).toBeNull();

    const button = view.getByRole('button', { name: 'Pay with PayPal in USD' });
    fireEvent.click(button);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    const ask = confirm.mock.calls[0]![0] as string;
    expect(ask).toContain('Send 3 payouts totalling ₹4,500.00 as $53.82 from your live PayPal account now?');
    expect(ask).toContain('Rate: 1 INR = 0.011959 USD, the European Central Bank reference rate of 22 Oct');
    expect(ask).toContain('PayPal converts it at its own rate');
    expect(requests.find((r) => r.path.endsWith('/paypal-batches/quote'))?.body).toEqual({ currency: 'INR', sendAs: 'USD' });
    // Declined: nothing sent.
    expect(requests.some((r) => r.method === 'POST' && r.path === `/payouts/runs/${RUN_ID}/paypal-batches`)).toBe(false);

    confirm.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST' && r.path === `/payouts/runs/${RUN_ID}/paypal-batches`)?.body).toEqual({
        currency: 'INR',
        sendAs: 'USD',
        quoteId: 'payload.mac',
      }),
    );
  });

  it('says what to do when the quote expired before sending', async () => {
    connections = [LIVE];
    sendAnswer = { status: 409, body: { error: 'quote_expired' } };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    fireEvent.click(await view.findByRole('button', { name: 'Pay with PayPal in USD' }));
    await view.findByText(/quote expired \(they last 15 minutes\)\. Press the button again/);
  });

  it('points to connecting PayPal when no app is connected', async () => {
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    await view.findByText(/INR → USD/);
    expect(view.getByText(/to send these\./)).toBeTruthy();
    expect(view.queryByRole('button', { name: /Pay with PayPal/ })).toBeNull();
  });

  it('shows a converted batch’s USD total with the INR total and rate', async () => {
    connections = [LIVE];
    batches = [CONVERTED_BATCH];
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    await view.findByText('Sent with PayPal');
    expect(view.getByText(/\$53\.82 \(₹4,500\.00 at 1 INR = 0\.011959 USD, ECB 22 Oct/)).toBeTruthy();
  });
});

describe('the partner’s payouts', () => {
  it('show the INR amount, what PayPal sent and at which rate, and whose the withdrawal conversion is', async () => {
    const view = renderWithClient(<PayoutsPage principal={{ role: 'partner', partnerId: 'p_ravi' }} />);
    await view.findByText('₹1,500.00');
    expect(view.getByText(/sent as \$17\.94 at the ECB rate of 22 Oct/)).toBeTruthy();
    expect(view.getByText(/PayPal paid you in USD/)).toBeTruthy();
    expect(view.getByText(/If you withdraw it in INR, PayPal converts it at its own rate; that conversion is between you and PayPal/)).toBeTruthy();
  });
});
