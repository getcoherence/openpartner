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
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
let posted: Array<{ path: string; body: unknown }> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  requested = [];
  posted = [];
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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    requested.push(url.pathname);
    if (init?.method === 'POST') posted.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
    const body = routes[url.pathname];
    return body === undefined ? json(404, { error: 'not_found' }) : json(200, body);
  }) as typeof fetch;
});
afterEach(cleanup);

let qc: QueryClient;

/** The app shell loads /config/program before rendering anything, so the
 *  settings are already cached when these components mount. Pass 'failed'
 *  to leave them uncached, with the endpoint erroring. */
function renderWith(ui: React.ReactElement, connectPayoutsAvailable: boolean | undefined | 'failed') {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (connectPayoutsAvailable !== 'failed') {
    qc.setQueryData(['program-settings'], { ...BRAND, connectPayoutsAvailable });
  }
  qc.setQueryData(['network-consent'], { offered: false, status: null });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

/** Wait until the dashboard's payout-profile fetch has actually settled. */
const payoutProfileSettled = () =>
  waitFor(() => expect(qc.getQueryState(['payout-profile', 'p1'])?.status).toBe('success'));

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

  it('leaves it out when the settings fetch fails, rather than offering Connect to every partner', async () => {
    const page = renderWith(<Sidebar principal={PARTNER} />, 'failed');
    await waitFor(() => expect(qc.getQueryState(['program-settings'])?.status).toBe('error'));
    expect(page.queryByText('Stripe Connect')).toBeNull();
  });
});

describe('/connect page', () => {
  it('offers Stripe onboarding when the brand pays through Connect', async () => {
    const page = renderWith(<ConnectPage principal={PARTNER} />, true);
    expect(await page.findByRole('button', { name: 'Connect Stripe' })).toBeTruthy();
    expect(connectStatusCalls()).toHaveLength(1);
  });

  it('keeps the Standard onboarding copy and asks for no country', async () => {
    const page = renderWith(<ConnectPage principal={PARTNER} />, true);
    await page.findByRole('button', { name: 'Connect Stripe' });
    expect(page.getByText('Receive payouts straight into your own Stripe account.')).toBeTruthy();
    expect(page.queryByLabelText(/Country/)).toBeNull();
    expect(page.queryByText(/activity description is already filled in/)).toBeNull();
  });

  it.each([true, false])('shows Custom onboarding copy and matches description prefill=%s', async (prefilled) => {
    routes['/api/partners/p1/connect/status'] = {
      connected: false, accountMode: 'custom_payouts', activityDescriptionPrefilled: prefilled,
    };
    const page = renderWith(<ConnectPage principal={PARTNER} />, true);
    await page.findByRole('button', { name: 'Set up payouts' });
    expect(page.queryByRole('button', { name: 'Connect Stripe' })).toBeNull();
    expect(!!page.queryByText(/activity description is already filled in/)).toBe(prefilled);
  });

  it('asks a Custom partner for their country before starting onboarding', async () => {
    routes['/api/partners/p1/connect/status'] = { connected: false, accountMode: 'custom_payouts' };
    const page = renderWith(<ConnectPage principal={PARTNER} />, true);
    const button = await page.findByRole('button', { name: 'Set up payouts' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(page.getByLabelText("Country you're based in"), { target: { value: 'GB' } });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe('/api/partners/p1/connect/start');
    expect(posted[0]!.body).toMatchObject({ country: 'GB' });
  });

  it('explains a country Stripe refuses instead of showing the raw error', async () => {
    routes['/api/partners/p1/connect/status'] = { connected: false, accountMode: 'custom_payouts' };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? json(400, { error: 'stripe_account_rejected', detail: 'Cross-border payouts are not supported.' })
        : realFetch(input, init)) as typeof fetch;
    const page = renderWith(<ConnectPage principal={PARTNER} />, true);
    fireEvent.change(await page.findByLabelText("Country you're based in"), { target: { value: 'IN' } });
    fireEvent.click(page.getByRole('button', { name: 'Set up payouts' }));
    expect(await page.findByText(/Stripe can't set up payouts for the country you chose/)).toBeTruthy();
    expect(page.queryByText(/Cross-border payouts are not supported/)).toBeNull();
  });

  it('lets a payout-ready Custom partner update their payout details', async () => {
    routes['/api/partners/p1/connect/status'] = {
      connected: true, accountId: 'acct_partner', accountType: 'custom', detailsSubmitted: true,
      transfersEnabled: true, payoutsEnabled: true,
    };
    const page = renderWith(<ConnectPage principal={PARTNER} />, true);
    fireEvent.click(await page.findByRole('button', { name: 'Update payout details' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe('/api/partners/p1/connect/update');
    expect(page.queryByRole('button', { name: 'Finish onboarding' })).toBeNull();
  });

  it('reached by URL when the brand pays directly: points to Payout details instead', () => {
    const page = renderWith(<ConnectPage principal={PARTNER} />, false);
    expect(page.getByText('Acme doesn’t pay through Stripe Connect')).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Connect Stripe' })).toBeNull();
    expect(page.getByRole('link', { name: /Go to Payout details/ }).getAttribute('href')).toBe('/payout-details');
    expect(connectStatusCalls()).toHaveLength(0);
  });

  it.each([
    { transfersEnabled: false, payoutsEnabled: false },
    { transfersEnabled: false, payoutsEnabled: true },
    { transfersEnabled: true, payoutsEnabled: false },
  ])('keeps onboarding available while payout readiness is incomplete: $transfersEnabled/$payoutsEnabled', async (readiness) => {
    routes['/api/partners/p1/connect/status'] = {
      connected: true, accountId: 'acct_partner', detailsSubmitted: true,
      chargesEnabled: false, ...readiness,
    };
    const page = renderWith(<ConnectPage principal={PARTNER} />, true);
    expect(await page.findByRole('button', { name: 'Finish onboarding' })).toBeTruthy();
  });

  it.each([true, false])('does not require onboarding for a payout-ready account with chargesEnabled=%s', async (chargesEnabled) => {
    routes['/api/partners/p1/connect/status'] = {
      connected: true, accountId: 'acct_partner', accountType: 'standard', detailsSubmitted: true,
      chargesEnabled, transfersEnabled: true, payoutsEnabled: true,
    };
    const page = renderWith(<ConnectPage principal={PARTNER} />, true);
    await page.findByText('acct_partner');
    expect(page.queryByRole('button', { name: 'Finish onboarding' })).toBeNull();
    // Standard partners manage their details in their own Stripe dashboard.
    expect(page.queryByRole('button', { name: 'Update payout details' })).toBeNull();
    expect(page.queryByText('Charges enabled')).toBeNull();
    expect(page.getByText('Transfers enabled')).toBeTruthy();
  });

  it('asks a payout-ready Custom partner to finish onboarding when Stripe needs more details', async () => {
    routes['/api/partners/p1/connect/status'] = {
      connected: true, accountId: 'acct_partner', accountType: 'custom', detailsSubmitted: true,
      transfersEnabled: true, payoutsEnabled: true,
      requirementsDue: true, requirementsDueBy: '2026-12-01T12:00:00.000Z',
    };
    const page = renderWith(<ConnectPage principal={PARTNER} />, true);
    expect(await page.findByRole('button', { name: 'Finish onboarding' })).toBeTruthy();
    expect(page.getByText('Stripe needs more details by Dec 1, 2026.')).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Update payout details' })).toBeNull();
  });

  it('leaves a Standard partner with due details to Stripe', async () => {
    routes['/api/partners/p1/connect/status'] = {
      connected: true, accountId: 'acct_partner', accountType: 'standard', detailsSubmitted: true,
      transfersEnabled: true, payoutsEnabled: true, requirementsDue: true, requirementsDueBy: null,
    };
    const page = renderWith(<ConnectPage principal={PARTNER} />, true);
    await page.findByText('acct_partner');
    expect(page.queryByRole('button', { name: 'Finish onboarding' })).toBeNull();
    expect(page.queryByText(/Stripe needs more details/)).toBeNull();
  });
});

describe('partner dashboard getting-started', () => {
  it.each([
    { transfersEnabled: false, payoutsEnabled: true },
    { transfersEnabled: true, payoutsEnabled: false },
    { transfersEnabled: true, payoutsEnabled: true },
  ])('matches Connect payout readiness: $transfersEnabled/$payoutsEnabled', async (readiness) => {
    routes['/api/partners/p1/connect/status'] = { connected: true, ...readiness };
    const page = renderWith(<Dashboard principal={PARTNER} />, true);
    await page.findByText('Attributed events');
    await payoutProfileSettled();
    await waitFor(() => expect(qc.getQueryState(['connect-status', 'p1'])?.status).toBe('success'));
    if (readiness.transfersEnabled && readiness.payoutsEnabled) {
      await waitFor(() => expect(page.queryByText('Getting started')).toBeNull());
      expect(page.queryByText('Finish Stripe onboarding to receive payouts')).toBeNull();
    } else {
      expect(await page.findByText('Getting started')).toBeTruthy();
      expect(page.getByRole('link', { name: 'Connect Stripe' }).getAttribute('href')).toBe('/connect');
    }
  });

  it.each([
    { accountType: 'custom', requirementsDueBy: '2026-12-01T12:00:00.000Z', body: 'Add them by Dec 1, 2026 to keep getting paid.' },
    { accountType: 'custom', requirementsDueBy: null, body: 'Add them to keep getting paid.' },
    { accountType: 'standard', requirementsDueBy: null, body: null },
  ])('nudges a payout-ready $accountType partner when Stripe needs more details', async ({ accountType, requirementsDueBy, body }) => {
    routes['/api/partners/p1/connect/status'] = {
      connected: true, accountType, transfersEnabled: true, payoutsEnabled: true, requirementsDue: true, requirementsDueBy,
    };
    const page = renderWith(<Dashboard principal={PARTNER} />, true);
    await page.findByText('Attributed events');
    await waitFor(() => expect(qc.getQueryState(['connect-status', 'p1'])?.status).toBe('success'));
    if (body) {
      expect(await page.findByText('Stripe needs more details')).toBeTruthy();
      expect(page.getByText(body)).toBeTruthy();
      expect(page.getByRole('link', { name: 'Finish onboarding' }).getAttribute('href')).toBe('/connect');
    } else {
      await payoutProfileSettled();
      expect(page.queryByText('Stripe needs more details')).toBeNull();
    }
  });

  it('asks a Custom partner to set up payouts, matching the Connect page', async () => {
    routes['/api/partners/p1/connect/status'] = { connected: false, accountMode: 'custom_payouts' };
    const page = renderWith(<Dashboard principal={PARTNER} />, true);
    expect(await page.findByText('Set up payouts to get paid')).toBeTruthy();
    expect(page.getByRole('link', { name: 'Set up payouts' }).getAttribute('href')).toBe('/connect');
    expect(page.container.textContent).not.toMatch(/Connect Stripe/);
  });

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
      profile: { method: 'paypal', details: { email: 'pat@example.com' }, summary: 'PayPal · p•••@example.com' },
      paidVia: 'manual',
    };
    const page = renderWith(<Dashboard principal={PARTNER} />, false);
    expect(await page.findByText('Attributed events')).toBeTruthy();
    await payoutProfileSettled();
    expect(page.queryByText('Getting started')).toBeNull();
    expect(page.container.textContent).not.toMatch(/Connect Stripe/);
  });

  it('keeps asking when saved details can no longer be read', async () => {
    routes['/api/partners/p1/payout-profile'] = {
      profile: { method: 'paypal', details: null, summary: null },
      paidVia: 'manual',
    };
    const page = renderWith(<Dashboard principal={PARTNER} />, false);
    await payoutProfileSettled();
    expect(await page.findByText('Add your payout details')).toBeTruthy();
    expect(page.getByRole('link', { name: 'Add details' })).toBeTruthy();
  });
});
