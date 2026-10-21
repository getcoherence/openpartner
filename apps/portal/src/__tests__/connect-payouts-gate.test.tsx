// @vitest-environment jsdom
/**
 * Stripe Connect is only offered to partners whose brand can pay through
 * it. A hosted brand without payout funding, or any brand on the manual
 * rail, pays partners directly to the details on Payout details; a
 * Connect account there is never paid (runPayouts refuses the transfer).
 * So `connectPayoutsAvailable: false` on /config/program hides the
 * sidebar entry and the dashboard's "Connect Stripe" prompts, and the
 * /connect page, still reachable by URL, points to Payout details.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '../App.js';
import { ConnectPage } from '../pages/Connect.js';
import { Dashboard } from '../pages/Dashboard.js';
import type { Principal } from '../api.js';

const BRAND = {
  programName: 'Acme',
  supportEmail: null,
  logoUrl: null,
  brandColor: null,
  programTermsUrl: null,
  whiteLabel: false,
  partnerNetworkVisible: true,
  defaultCurrency: 'USD',
};

const PARTNER: Principal = {
  role: 'partner',
  partnerId: 'p1',
  partner: { id: 'p1', name: 'Pat Partner', email: 'pat@example.com', stripeConnected: false },
};

let routes: Record<string, unknown> = {};
let requested: string[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  requested = [];
  routes = {
    '/api/partners/p1/dashboard': {
      partnerId: 'p1',
      since: '2026-09-20T00:00:00.000Z',
      currency: 'USD',
      clicks: 3,
      attributedEvents: 1,
      attributedRevenue: 100,
      commissionByStatus: { approved: 10 },
      commissionByCurrency: { USD: { approved: 10 } },
    },
    '/api/partners/p1/funnel': {
      stages: { clicks: 3, identities: 1, signups: 1, paid: 1 },
      rates: { stitchRate: 0.33, signupRate: 1, paidRate: 1, overall: 0.33 },
      revenue: 100,
    },
    '/api/partners/p1/links': { links: [{ id: 'l1' }] },
    '/api/partners/p1/connect/status': { connected: false },
    '/api/partners/p1/payout-profile': { profile: null, paidVia: 'manual' },
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    requested.push(url.pathname);
    const body = routes[url.pathname];
    return body === undefined ? json(404, { error: 'not_found' }) : json(200, body);
  }) as typeof fetch;
});
afterEach(cleanup);

/** The app shell loads /config/program before rendering anything, so the
 *  settings are already cached when these components mount. */
function renderWith(ui: React.ReactElement, connectPayoutsAvailable: boolean | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['program-settings'], { ...BRAND, connectPayoutsAvailable });
  qc.setQueryData(['network-consent'], { offered: false, status: null });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const connectStatusCalls = () => requested.filter((p) => p.endsWith('/connect/status'));

describe('partner sidebar', () => {
  it('lists Stripe Connect when the brand pays through it', () => {
    const page = renderWith(<Sidebar principal={PARTNER} />, true);
    expect(page.getByText('Stripe Connect')).toBeTruthy();
    expect(page.getByText('Payout details')).toBeTruthy();
  });

  it('leaves it out when the brand pays partners directly', () => {
    const page = renderWith(<Sidebar principal={PARTNER} />, false);
    expect(page.queryByText('Stripe Connect')).toBeNull();
    expect(page.getByText('Payout details')).toBeTruthy();
  });

  it('keeps it for an API that predates the field', () => {
    const page = renderWith(<Sidebar principal={PARTNER} />, undefined);
    expect(page.getByText('Stripe Connect')).toBeTruthy();
  });
});

describe('/connect page', () => {
  it('offers Stripe onboarding when the brand pays through Connect', async () => {
    const page = renderWith(<ConnectPage principal={PARTNER} />, true);
    expect(await page.findByRole('button', { name: 'Connect Stripe' })).toBeTruthy();
    expect(connectStatusCalls()).toHaveLength(1);
  });

  it('reached by URL when the brand pays directly: points to Payout details instead', () => {
    const page = renderWith(<ConnectPage principal={PARTNER} />, false);
    expect(page.getByText('Acme doesn’t pay through Stripe Connect')).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Connect Stripe' })).toBeNull();
    expect(page.getByRole('link', { name: /Go to Payout details/ }).getAttribute('href')).toBe('/payout-details');
    expect(connectStatusCalls()).toHaveLength(0);
  });
});

describe('partner dashboard getting-started', () => {
  it('asks the partner to connect Stripe when the brand pays through it', async () => {
    const page = renderWith(<Dashboard principal={PARTNER} />, true);
    expect(await page.findByText('Connect Stripe to get paid')).toBeTruthy();
    expect(page.getByRole('link', { name: 'Connect Stripe' }).getAttribute('href')).toBe('/connect');
    expect(page.queryByText('Add your payout details')).toBeNull();
  });

  it('asks for payout details instead when the brand pays directly', async () => {
    const page = renderWith(<Dashboard principal={PARTNER} />, false);
    expect(await page.findByText('Add your payout details')).toBeTruthy();
    expect(page.getByRole('link', { name: 'Add details' }).getAttribute('href')).toBe('/payout-details');
    expect(page.container.textContent).not.toMatch(/Connect Stripe|Stripe onboarding/);
    expect(connectStatusCalls()).toHaveLength(0);
  });

  it('drops the card once the link and payout details are both in place', async () => {
    routes['/api/partners/p1/payout-profile'] = {
      profile: { method: 'paypal', summary: 'PayPal · p•••@example.com' },
      paidVia: 'manual',
    };
    const page = renderWith(<Dashboard principal={PARTNER} />, false);
    expect(await page.findByText('Attributed events')).toBeTruthy();
    await waitFor(() => expect(requested).toContain('/api/partners/p1/payout-profile'));
    // Let the profile response settle before asserting the card stays away.
    await new Promise((r) => setTimeout(r, 20));
    expect(page.queryByText('Getting started')).toBeNull();
    expect(page.container.textContent).not.toMatch(/Connect Stripe/);
  });
});
