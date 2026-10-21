// @vitest-environment jsdom
/**
 * The partner dashboard's payout step follows the brand's payout rail.
 *
 * Partners of a brand on the manual rail are paid by the brand itself, from
 * the payout details they give (bank transfer, PayPal or Wise batch files),
 * yet the Getting started card told them to connect Stripe. It now asks for
 * payout details there, and keeps Stripe for every other rail.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Dashboard } from '../pages/Dashboard.js';

let routes: Record<string, unknown> = {};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const DASHBOARD = {
  partnerId: 'p1',
  since: '2026-09-20T00:00:00.000Z',
  currency: 'USD',
  clicks: 124,
  attributedEvents: 3,
  attributedRevenue: 240,
  attributedRevenueByCurrency: { USD: 240 },
  commissionByStatus: { approved: 48 },
  commissionByCurrency: { USD: { approved: 48 } },
};

const PAYPAL = { details: { method: 'paypal', email: 'riya@pay.test' } };

beforeEach(() => {
  routes = {
    '/api/config/program': { programName: 'Kestrel Analytics', defaultCurrency: 'USD', whiteLabel: false },
    '/api/partners/p1/dashboard': DASHBOARD,
    '/api/partners/p1/links': { links: [] },
    '/api/partners/p1/connect/status': { connected: false },
    '/api/partners/p1/payout-profile': { profile: null, paidVia: 'manual', rail: 'manual' },
    '/api/partners/p1/funnel': {
      stages: { clicks: 124, identities: 9, signups: 6, paid: 2 },
      rates: { stitchRate: 9 / 124, signupRate: 6 / 9, paidRate: 2 / 6, overall: 2 / 124 },
      revenue: 240,
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const body = routes[url.pathname];
    return body === undefined ? json(404, { error: 'not_found' }) : json(200, body);
  }) as typeof fetch;
});
afterEach(cleanup);

function renderPartner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Dashboard principal={{ role: 'partner', partnerId: 'p1', partner: { id: 'p1', name: 'Riya Shah', email: 'r@x', stripeConnected: false } }} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('partner dashboard payout step', () => {
  it('asks a manual-rail partner for payout details, not Stripe', async () => {
    const page = renderPartner();
    expect(await page.findByText('Add your payout details')).toBeTruthy();
    expect(page.getByText(/Tell Kestrel Analytics where to send your commissions/)).toBeTruthy();
    expect(page.getByRole('link', { name: 'Add details' }).getAttribute('href')).toBe('/payout-details');
    expect(page.queryByText('Connect Stripe to get paid')).toBeNull();
    expect(page.queryByText(/Connect Stripe/)).toBeNull();
  });

  it('keeps the Stripe step on the other rails', async () => {
    routes['/api/partners/p1/payout-profile'] = { profile: null, paidVia: 'manual', rail: 'auto' };
    const page = renderPartner();
    expect(await page.findByText('Connect Stripe to get paid')).toBeTruthy();
    expect(page.queryByText('Add your payout details')).toBeNull();
  });

  it('falls back to Stripe when the payout profile is unavailable', async () => {
    delete routes['/api/partners/p1/payout-profile'];
    const page = renderPartner();
    expect(await page.findByText('Connect Stripe to get paid')).toBeTruthy();
  });

  it('keeps asking until the details are in, with money owed and a link made', async () => {
    routes['/api/partners/p1/links'] = { links: [{ id: 'l1' }] };
    const page = renderPartner();
    expect(await page.findByText('Add your payout details')).toBeTruthy();
    expect(page.queryByText(/Connect Stripe/)).toBeNull();
  });

  it('drops the card, and never mentions Stripe, once a manual-rail partner has a link and payout details', async () => {
    routes['/api/partners/p1/links'] = { links: [{ id: 'l1' }] };
    routes['/api/partners/p1/payout-profile'] = { profile: PAYPAL, paidVia: 'manual', rail: 'manual' };
    const page = renderPartner();
    expect(await page.findByText('Funnel')).toBeTruthy();
    expect(page.queryByText('Getting started')).toBeNull();
    expect(page.queryByText(/Stripe/)).toBeNull();
  });
});

describe('partner funnel', () => {
  it('reads as one cohort of this month’s clicks', async () => {
    const page = renderPartner();
    expect(await page.findByText('Your clicks in the last 30 days, and what those visitors went on to do.')).toBeTruthy();
    for (const label of ['Identified', 'Signed up']) expect(page.getByText(label)).toBeTruthy();
    expect(page.getByText('67%')).toBeTruthy(); // 6 of 9 identified signed up
    expect(page.getByText('33%')).toBeTruthy(); // 2 of 6 paid
  });
});
