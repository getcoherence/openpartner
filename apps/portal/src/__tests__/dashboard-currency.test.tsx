// @vitest-environment jsdom
/**
 * Dashboards in a non-USD program. An INR brand's admin overview read
 * "Attributed revenue $183,828,000.00" and its partners saw "$18,277.00":
 * every total was formatted as dollars, and rupees and dollars were added
 * together. Totals now come per currency and render in their own symbols,
 * and an empty total shows a zero in the brand's default currency.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Dashboard } from '../pages/Dashboard.js';
import { money, moneyByCurrency, statusAmounts } from '../ui.js';

let routes: Record<string, unknown> = {};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  routes = { '/api/config/program': { programName: 'Acme', defaultCurrency: 'INR', whiteLabel: false } };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const body = routes[url.pathname];
    return body === undefined ? json(404, { error: 'not_found' }) : json(200, body);
  }) as typeof fetch;
});
afterEach(cleanup);

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('moneyByCurrency', () => {
  it('never adds currencies, leads with the default, and zeroes in it', () => {
    expect(moneyByCurrency({ USD: 85_000, INR: 1_023_377 }, 'INR')).toBe(`${money(1_023_377, 'INR')} + ${money(85_000, 'USD')}`);
    expect(moneyByCurrency({}, 'INR')).toBe(money(0, 'INR'));
    expect(moneyByCurrency(undefined, 'EUR')).toBe(money(0, 'EUR'));
    expect(money(0, 'INR')).toContain('₹');
  });

  it('statusAmounts sums statuses within a currency only', () => {
    const by = { INR: { paid: 10, approved: 5 }, USD: { accrued: 2 } };
    expect(statusAmounts(by, 'paid', 'approved')).toEqual({ INR: 15 });
    expect(statusAmounts(by, 'accrued')).toEqual({ USD: 2 });
  });
});

describe('admin overview', () => {
  it('shows each currency in its own symbol instead of one dollar total', async () => {
    routes['/api/admin/overview'] = {
      since: '2026-09-17T00:00:00.000Z',
      sort: 'revenue',
      nextCursor: null,
      totals: {
        partners: 1,
        clicks: 12,
        currency: 'INR',
        attributedRevenue: 1_023_377,
        attributedRevenueByCurrency: { INR: 1_023_377, USD: 85_000 },
        attributedEvents: 3,
        commissionAccrued: 102_337.7,
        commissionApproved: 0,
        commissionPaid: 0,
        commissionByCurrency: { INR: { accrued: 102_337.7 }, USD: { accrued: 8_500 } },
      },
      partners: [
        {
          id: 'p1',
          name: 'Riya',
          email: 'riya@example.com',
          stripeConnected: false,
          clicks: 12,
          revenue: 1_023_377,
          revenueByCurrency: { INR: 1_023_377, USD: 85_000 },
          events: 3,
          commission: { accrued: 102_337.7 },
          commissionByCurrency: { INR: { accrued: 102_337.7 }, USD: { accrued: 8_500 } },
        },
      ],
    };
    const page = renderWithClient(<Dashboard principal={{ role: 'admin' }} />);
    const revenue = `${money(1_023_377, 'INR')} + ${money(85_000, 'USD')}`;
    expect((await page.findAllByText(revenue)).length).toBe(2); // the total and the partner card
    expect(page.getByText(`${money(102_337.7, 'INR')} + ${money(8_500, 'USD')}`)).toBeTruthy();
    expect(page.getByText(`${money(0, 'INR')} approved, ${money(0, 'INR')} paid`)).toBeTruthy();
    expect(page.queryByText('$1,108,377.00')).toBeNull();
  });
});

describe('partner dashboard', () => {
  it('formats in the program currency, including an empty total', async () => {
    routes['/api/partners/p1/dashboard'] = {
      partnerId: 'p1',
      since: '2026-09-17T00:00:00.000Z',
      currency: 'INR',
      clicks: 4,
      attributedEvents: 1,
      attributedRevenue: 18_277,
      attributedRevenueByCurrency: { INR: 18_277 },
      commissionByStatus: { accrued: 1_827.7 },
      commissionByCurrency: { INR: { accrued: 1_827.7 } },
    };
    const page = renderWithClient(<Dashboard principal={{ role: 'partner', partnerId: 'p1', partner: { id: 'p1', name: 'Riya', email: 'r@x', stripeConnected: false } }} />);
    expect(await page.findByText(money(18_277, 'INR'))).toBeTruthy();
    // Nothing paid yet: a zero in rupees, not "$0.00".
    expect(page.getByText(money(0, 'INR'))).toBeTruthy();
    expect(page.getByText(money(1_827.7, 'INR'))).toBeTruthy();
    expect(page.queryByText('$18,277.00')).toBeNull();
    expect(page.queryByText('$0.00')).toBeNull();
  });

  it('still renders an API that predates the per-currency fields', async () => {
    routes['/api/config/program'] = { programName: 'Acme', whiteLabel: false };
    routes['/api/partners/p1/dashboard'] = {
      partnerId: 'p1',
      since: '2026-09-17T00:00:00.000Z',
      clicks: 1,
      attributedEvents: 1,
      attributedRevenue: 50,
      commissionByStatus: { paid: 5 },
    };
    const page = renderWithClient(<Dashboard principal={{ role: 'partner', partnerId: 'p1', partner: { id: 'p1', name: 'Riya', email: 'r@x', stripeConnected: false } }} />);
    expect(await page.findByText('$50.00')).toBeTruthy();
    expect(page.getAllByText('$5.00').length).toBeGreaterThan(0);
  });
});
