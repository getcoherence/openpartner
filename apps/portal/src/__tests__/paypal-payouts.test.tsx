// @vitest-environment jsdom
/**
 * Pay with PayPal in the portal (docs/paypal-payouts.md):
 *   - "Manual payouts to send" is there before any run, saying what it is
 *     and where to connect PayPal;
 *   - with a PayPal app connected, a ready PayPal group offers Pay with
 *     PayPal, which asks first, naming the total and the environment;
 *   - batches show where they stand, a held one offers link / retry /
 *     release, and an unclaimed payout can be cancelled after asking;
 *   - Settings connects an app and never shows the secret again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { PayoutsPage } from '../pages/Payouts.js';
import { PaypalPayoutsCard } from '../pages/admin/PaypalPayoutsCard.js';

let requests: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
let runs: unknown[] = [];
let connections: unknown[] = [];
let batches: unknown[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const NOW = new Date().toISOString();
const RUN_ID = '01RUN0000000000000000000PP';
const SECRET = 'EFGhSecretValueNeverToBeSeen0123456789xyz';

const CONNECTED = {
  id: 'conn_1',
  environment: 'sandbox',
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
  ready: [{ provider: 'paypal', currency: 'USD', count: 2, total: '35.50' }],
  exports: [],
  inPaypalBatches: 1,
  excluded: [],
};

const PAYOUTS = [
  {
    payoutId: 'po_una',
    partnerId: 'p_una',
    partnerName: 'Una',
    partnerEmail: 'una@example.com',
    amount: '12.00',
    currency: 'USD',
    createdAt: NOW,
    destination: { method: 'paypal', country: null, summary: 'PayPal u•••@pay.test', updatedAt: NOW, updatedBy: 'partner' },
    export: {
      exportId: 'batch_1',
      provider: 'paypal',
      via: 'api',
      createdAt: NOW,
      reference: 'po_una',
      destinationChanged: false,
      paypal: { itemId: 'PI1', status: 'UNCLAIMED', transactionId: null, amount: '12.00', currency: 'USD', error: 'RECEIVER_UNREGISTERED' },
    },
    ready: null,
    excluded: null,
    complianceWarning: null,
    doNotPay: null,
  },
];

const HELD = {
  batchId: 'batch_1',
  runId: RUN_ID,
  environment: 'sandbox',
  currency: 'USD',
  itemCount: 1,
  total: '12.00',
  state: 'reconcile_required',
  payoutBatchId: null,
  batchStatus: null,
  summary: { paid: 0, released: 0, unclaimed: 1, processing: 0 },
  lastError: 'PayPal never confirmed this batch, and it is too old to re-send safely. Check your PayPal account.',
  createdAt: NOW,
  createdBy: 'admin',
  completedAt: null,
  lastSyncedAt: null,
};

beforeEach(() => {
  requests = [];
  runs = [];
  connections = [];
  batches = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, body });
    if (path === '/payouts/holds') return json(200, { holds: [] });
    if (path === '/payouts') return json(200, { payouts: [], nextCursor: null });
    if (path === '/config/paypal' && method === 'GET') return json(200, { connections });
    if (path === '/config/paypal' && method === 'POST') {
      connections = [CONNECTED];
      return json(201, { connection: CONNECTED });
    }
    if (path === '/payouts/runs') return json(200, { runs, nextCursor: null });
    if (path === `/payouts/runs/${RUN_ID}`) return json(200, RUN);
    if (path === `/payouts/runs/${RUN_ID}/payouts`) return json(200, { payouts: PAYOUTS, nextCursor: null });
    if (path === `/payouts/runs/${RUN_ID}/paypal-batches` && method === 'GET') return json(200, { batches });
    if (path === `/payouts/runs/${RUN_ID}/paypal-batches` && method === 'POST') return json(201, { batch: { ...HELD, state: 'submitted' } });
    if (path.startsWith('/payouts/paypal-batches/') || path.endsWith('/paypal-cancel')) return json(200, { batch: HELD, ok: true, released: true, status: 'RETURNED' });
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

const withRun = () => {
  runs = [{ runId: RUN_ID, createdAt: NOW, pendingCount: 3, pendingTotals: [{ currency: 'USD', amount: '47.50' }] }];
};

describe('Manual payouts to send', () => {
  it('is there before any run, says what it is, and points to connecting PayPal', async () => {
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    await view.findByText('Manual payouts to send');
    await view.findByText(/Nothing to send right now/);
    expect(view.getByText(/Make a file and upload it to your own/)).toBeTruthy();
    expect(view.getByRole('link', { name: 'connect your PayPal app' }).getAttribute('href')).toBe('/admin/settings');
  });

  it('offers Pay with PayPal for a ready PayPal group once an app is connected, and asks first', async () => {
    withRun();
    connections = [{ ...CONNECTED, environment: 'live' }];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    const button = await view.findByRole('button', { name: 'Pay with PayPal' });
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Send 2 payouts totalling \$35\.50 from your live PayPal account now\?/));
    expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/paypal-batches'))).toBe(false);

    confirm.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST' && r.path === `/payouts/runs/${RUN_ID}/paypal-batches`)?.body).toEqual({ currency: 'USD' }),
    );
    // Making a file stays available either way.
    expect(view.getByRole('button', { name: 'Make file' })).toBeTruthy();
  });

  it('calls a sandbox send what it is: a test that marks nothing paid', async () => {
    withRun();
    connections = [CONNECTED];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    fireEvent.click(await view.findByRole('button', { name: 'Test with PayPal sandbox' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('nothing is marked paid'));
    expect(view.getByText(/batches are tests with test money/)).toBeTruthy();
  });

  it('has no Pay with PayPal button without a connected app', async () => {
    withRun();
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    await view.findByRole('button', { name: 'Make file' });
    expect(view.queryByRole('button', { name: /Pay with PayPal/ })).toBeNull();
  });

  it('shows a held batch with its way out, and cancels an unclaimed payout only after asking', async () => {
    withRun();
    connections = [CONNECTED];
    batches = [HELD];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('PB123456');
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);
    await view.findByText('Sent with PayPal');
    expect(view.getByText(/Check this batch in PayPal/)).toBeTruthy();
    expect(view.getByText(/too old to re-send safely/)).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Link PayPal batch' }));
    expect(prompt).toHaveBeenCalled();
    await waitFor(() =>
      expect(requests.find((r) => r.path === '/payouts/paypal-batches/batch_1/resolve')?.body).toEqual({ action: 'link', payoutBatchId: 'PB123456' }),
    );

    expect(view.getByText(/Unclaimed: PayPal emailed the partner/)).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Cancel and get it back' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('PayPal returns the money to your balance'));
    await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.path === '/payouts/po_una/paypal-cancel')).toBe(true));
  });
});

describe('Settings: Pay with PayPal', () => {
  it('connects an app and never shows the secret again', async () => {
    const view = renderWithClient(<PaypalPayoutsCard />);
    fireEvent.click(await view.findByRole('button', { name: 'Connect sandbox app' }));
    fireEvent.change(view.getByLabelText('Client ID'), { target: { value: 'AbCdEfClientIdForSandbox0123456789' } });
    fireEvent.change(view.getByLabelText('Secret'), { target: { value: SECRET } });
    expect((view.getByLabelText('Secret') as HTMLInputElement).type).toBe('password');
    fireEvent.click(view.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST' && r.path === '/config/paypal')?.body).toEqual({
        environment: 'sandbox',
        clientId: 'AbCdEfClientIdForSandbox0123456789',
        clientSecret: SECRET,
      }),
    );
    await view.findByText(/Pay with PayPal sends from here/);
    expect(view.getByText('AbCdEf…6789')).toBeTruthy();
    expect(view.container.innerHTML).not.toContain(SECRET);
  });

  it('warns when PayPal hasn’t enabled Payouts on the app', async () => {
    connections = [{ ...CONNECTED, payoutsEnabled: false }];
    const view = renderWithClient(<PaypalPayoutsCard />);
    await view.findByText(/hasn’t given this app the Payouts permission/);
  });
});
