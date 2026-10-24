// @vitest-environment jsdom
/**
 * Admin → Tracking health shows where clicks and conversions go missing:
 * the funnel with landing rate (or "Not measured" before any landing has
 * been reported), a browser that stitches far below the rest highlighted,
 * conversions that credited nobody by why, and the input OpenPartner
 * dropped, with what to fix.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AdminTrackingHealth,
  type StripeReconciliationReport,
  type TrackingHealthReport,
} from '../pages/admin/TrackingHealth.js';

let report: TrackingHealthReport;
let stripe: StripeReconciliationReport;
let requested: string[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function baseReport(): TrackingHealthReport {
  return {
    window: { days: 30, since: '2026-09-24T00:00:00.000Z', programId: null },
    funnel: { clicks: 200, landed: 120, stitched: 80, converted: 30, flagged: 4, bots: 9 },
    landingReported: true,
    byBrowser: [
      { browser: 'Chrome', device: 'desktop', clicks: 120, landed: 80, stitched: 64, converted: 20 },
      { browser: 'Mobile Safari', device: 'mobile', clicks: 80, landed: 40, stitched: 16, converted: 10 },
    ],
    unattributed: {
      events: 7,
      byReason: [
        { reason: 'no_click', events: 5, value: [{ currency: 'USD', amount: 500 }] },
        { reason: 'outside_window', events: 2, value: [] },
      ],
    },
    coupons: { overrodeLink: 3 },
    stripe: { recovered: 1 },
    issues: [
      { kind: 'stripe_foreign_reference', count: 12, days: 3, sampleRef: 'order-1234', lastSeenAt: '2026-10-23T10:00:00.000Z' },
    ],
    signals: {
      lastClickAt: '2026-10-23T10:00:00.000Z',
      lastLandingAt: '2026-10-23T09:00:00.000Z',
      lastStitchAt: null,
      lastStripeEventAt: '2026-10-22T10:00:00.000Z',
      lastPostbackAt: null,
    },
  };
}

function stripeReport(): StripeReconciliationReport {
  return {
    available: true,
    window: { days: 30, since: '2026-09-24T00:00:00.000Z' },
    computedAt: new Date().toISOString(),
    livemode: true,
    truncated: false,
    counts: { payments: 9, credited: 3, recorded: 1, missed: 2, unreferred: 3 },
    totals: [{ currency: 'USD', stripe: 900, recorded: 400, credited: 300, missed: 150, unreferred: 350 }],
    missed: [
      {
        kind: 'invoice',
        id: 'in_missed1',
        created: '2026-10-22T10:00:00.000Z',
        amount: 100,
        currency: 'USD',
        signals: ['linked_customer', 'partner_code'],
        dashboardUrl: 'https://dashboard.stripe.com/invoices/in_missed1',
      },
      {
        kind: 'checkout',
        id: 'cs_missed2',
        created: '2026-10-21T10:00:00.000Z',
        amount: 50,
        currency: 'USD',
        signals: ['partner_click'],
        dashboardUrl: null,
      },
    ],
  };
}

beforeEach(() => {
  report = baseReport();
  stripe = stripeReport();
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    requested.push(url.pathname + url.search);
    if (url.pathname === '/api/programs') return json(200, { programs: [{ id: 'p1', name: 'Main' }] });
    if (url.pathname === '/api/admin/tracking-health') return json(200, report);
    if (url.pathname === '/api/admin/tracking-health/stripe') return json(200, stripe);
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderPage(path = '/admin/tracking-health') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <AdminTrackingHealth />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Admin → Tracking health', () => {
  it('shows the funnel, the lagging browser, unattributed reasons and dropped input', async () => {
    renderPage();
    expect(await screen.findByText('60%')).toBeTruthy(); // landed 120 / 200
    expect(screen.getByText('40%')).toBeTruthy(); // stitched 80 / 200
    expect(screen.getByText(/4 flagged as fraud/)).toBeTruthy();
    expect(screen.getByText(/40% of clicks never reached a page running the script/)).toBeTruthy();

    // Safari stitches 20% against 40% overall: highlighted.
    const safari = screen.getByText('20%');
    expect(safari.getAttribute('title')).toMatch(/under the account-wide stitch rate/);

    expect(screen.getByText('No partner click on record')).toBeTruthy();
    expect(screen.getByText('Click outside the window')).toBeTruthy();
    expect(screen.getByText('Stripe checkout carried your own reference')).toBeTruthy();
    expect(screen.getByText('order-1234')).toBeTruthy();
    expect(screen.getByText('12 over 3 days')).toBeTruthy();
    expect(requested).toContain('/api/admin/tracking-health?days=30');
  });

  it('says landing is not measured until a landing has ever been reported', async () => {
    report = { ...baseReport(), landingReported: false };
    renderPage();
    expect(await screen.findByText('Not measured')).toBeTruthy();
    expect(screen.queryByText(/never reached a page running the script/)).toBeNull();
  });

  it('passes the window and program from the URL to the API', async () => {
    renderPage('/admin/tracking-health?days=90&program=p1');
    await screen.findByText('No partner click on record');
    expect(requested).toContain('/api/admin/tracking-health?days=90&programId=p1');
    expect(screen.getByText(/Account-wide/)).toBeTruthy();
  });

  it('puts Stripe revenue next to recorded and credited, and lists the missed payments', async () => {
    renderPage();
    expect(await screen.findByText('Stripe revenue')).toBeTruthy();
    expect(await screen.findByText(/2 payments carry a partner signal, but OpenPartner recorded nothing/)).toBeTruthy();
    const link = screen.getByText('in_missed1').closest('a')!;
    expect(link.getAttribute('href')).toBe('https://dashboard.stripe.com/invoices/in_missed1');
    expect(screen.getByText("customer came from a partner click; partner's promotion code")).toBeTruthy();
    expect(screen.getByText('cs_missed2').closest('a')).toBeNull();
    expect(requested).toContain('/api/admin/tracking-health/stripe?days=30');
  });

  it('says how to connect Stripe when there is none to read', async () => {
    stripe = { available: false, reason: 'not_connected' };
    renderPage();
    expect(await screen.findByText(/to see\s+your Stripe revenue next to what OpenPartner recorded/)).toBeTruthy();
    expect(screen.queryByText('Read again')).toBeNull();
  });

  it('shows empty states when nothing is wrong', async () => {
    report = { ...baseReport(), unattributed: { events: 0, byReason: [] }, issues: [] };
    renderPage();
    expect(await screen.findByText('Every conversion in this window credited a partner.')).toBeTruthy();
    expect(screen.getByText('Nothing dropped in this window.')).toBeTruthy();
  });
});
