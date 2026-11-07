// @vitest-environment jsdom
/**
 * Admin → Billing for a brand on a card plan that hasn't subscribed. The
 * trial runs from signup and Checkout always asks for a payment method, so
 * the notice follows the trial's own dates on both plans: days left and
 * what activating costs while it runs, "Trial expired" once it's over, and
 * never a promise that no card is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminBilling } from '../pages/admin/Billing.js';

const DAY = 24 * 60 * 60 * 1000;
let status: Record<string, unknown>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const collection = {
  method: 'charge_automatically',
  source: 'default',
  daysUntilDue: 30,
  country: 'US',
  gstin: null,
  gstinRequired: false,
};

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/branding') return json(200, { tenantSlug: 'default' });
    if (url.pathname === '/api/billing/status') return json(200, status);
    if (url.pathname === '/api/billing/invoices') return json(200, { invoices: [] });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter initialEntries={['/admin/billing']}>
      <QueryClientProvider client={qc}>
        <AdminBilling />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Billing trial notice', () => {
  it('revshare during the trial: days left, a payment method, nothing charged now', async () => {
    // The revshare status carries no hasUsedTrial or trialExpiredWithoutSubscription.
    status = {
      mode: 'revshare',
      plan: 'revshare',
      subscribed: false,
      status: null,
      trialEndsAt: new Date(Date.now() + 7 * DAY - 60_000).toISOString(),
      inTrial: true,
      collection,
    };
    renderPage();
    expect(await screen.findByRole('button', { name: 'Activate plan' })).toBeTruthy();
    expect(screen.getByText('7 days')).toBeTruthy();
    expect(screen.getByText(/Stripe asks for a payment method/)).toBeTruthy();
    expect(screen.getByText(/Nothing is charged now/)).toBeTruthy();
    expect(screen.queryByText(/no card required/i)).toBeNull();
    expect(screen.queryByText(/hasn't started/)).toBeNull();
    expect(screen.queryByText('Trial expired.')).toBeNull();
  });

  it('flex during the trial: no expired banner, though the API flags one', async () => {
    // The flat status sets trialExpiredWithoutSubscription for any unsubscribed
    // brand that has a trial, ended or not.
    status = {
      mode: 'flat',
      plan: 'flex',
      subscribed: false,
      trialEndsAt: new Date(Date.now() + 2 * DAY - 60_000).toISOString(),
      inTrial: true,
      hasUsedTrial: true,
      trialExpiredWithoutSubscription: true,
      collection,
    };
    renderPage();
    expect(await screen.findByRole('button', { name: 'Activate plan' })).toBeTruthy();
    expect(screen.getByText('2 days')).toBeTruthy();
    expect(screen.getByText(/Your first month is charged when you activate/)).toBeTruthy();
    expect(screen.queryByText('Trial expired.')).toBeNull();
  });

  it('after the trial: expired, on either plan', async () => {
    status = {
      mode: 'revshare',
      plan: 'revshare',
      subscribed: false,
      status: null,
      trialEndsAt: new Date(Date.now() - DAY).toISOString(),
      inTrial: false,
      collection,
    };
    renderPage();
    expect(await screen.findByRole('button', { name: 'Subscribe' })).toBeTruthy();
    expect(screen.getByText('Trial expired.')).toBeTruthy();
    expect(screen.queryByText(/days? left/)).toBeNull();
  });
});
