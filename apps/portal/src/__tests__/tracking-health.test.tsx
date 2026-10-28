// @vitest-environment jsdom
/**
 * Admin → Tracking health shows where clicks and conversions go missing:
 * the funnel with landing rate (or "Not measured" before any landing has
 * been reported), a browser that stitches far below the rest highlighted,
 * conversions that credited nobody by why, and the input OpenPartner
 * dropped, with what to fix. Stripe revenue splits missed sales from
 * signals that couldn't have credited, and partner codes whose customers
 * almost never clicked the partner's link are highlighted. Setup checks
 * come first, per program then account-wide, each failing one with what to
 * change, beside the checkbox that emails failing checks and new flags.
 * Flags (a browser or partner changed against its own past) follow, in
 * plain words.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AdminTrackingHealth,
  type SetupChecksReport,
  type StripeReconciliationReport,
  type TrackingFlagsReport,
  type TrackingHealthReport,
} from '../pages/admin/TrackingHealth.js';

let report: TrackingHealthReport;
let stripe: StripeReconciliationReport;
let flags: TrackingFlagsReport;
let setup: SetupChecksReport;
let alerts: { email: boolean };
let saved: unknown[] = [];
let requested: string[] = [];

function flagsReport(list: TrackingFlagsReport['flags'] = []): TrackingFlagsReport {
  const w = { baselineSince: '2026-09-20T00:00:00.000Z', recentSince: '2026-10-18T00:00:00.000Z', until: '2026-10-25T00:00:00.000Z' };
  return { computedAt: '2026-10-26T00:00:00.000Z', windows: { linkage: w, sales: w }, flags: list };
}

function setupReport(checks: SetupChecksReport['checks'] = []): SetupChecksReport {
  return { computedAt: new Date().toISOString(), checks };
}

const SPRING = { id: 'p1', name: 'Spring' };

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
    codes: [
      { partnerId: 'pa1', partnerName: 'Deal Hunters', customers: 10, codeOnly: 9 },
      { partnerId: 'pa2', partnerName: 'The Podcast', customers: 4, codeOnly: 1 },
    ],
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
    counts: { payments: 11, credited: 3, recorded: 1, missed: 2, notCreditable: 2, unreferred: 3 },
    notCreditableReasons: { outside_window: 1, inactive_code: 0, excluded: 1 },
    totals: [{ currency: 'USD', stripe: 1000, recorded: 400, credited: 300, missed: 150, notCreditable: 100, unreferred: 350 }],
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
  flags = flagsReport();
  setup = setupReport();
  alerts = { email: true };
  saved = [];
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    requested.push(url.pathname + url.search);
    if (url.pathname === '/api/programs') return json(200, { programs: [{ id: 'p1', name: 'Main' }] });
    if (url.pathname === '/api/admin/tracking-health') return json(200, report);
    if (url.pathname === '/api/admin/tracking-health/stripe') return json(200, stripe);
    if (url.pathname === '/api/admin/tracking-health/flags') return json(200, flags);
    if (url.pathname === '/api/admin/tracking-health/setup') return json(200, setup);
    if (url.pathname === '/api/config/tracking-alerts') {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { email: boolean };
        saved.push(body);
        alerts = { email: body.email };
      }
      return json(200, alerts);
    }
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
    expect(await screen.findByText(/2 payments would have credited a partner, but OpenPartner recorded nothing/)).toBeTruthy();
    expect(screen.getByText('Missed sales')).toBeTruthy();
    expect(screen.getByText('Not creditable')).toBeTruthy();
    expect(
      screen.getByText(/\(1 outside the window, 1 with only flagged clicks or revoked partners\), 3 with no partner signal/),
    ).toBeTruthy();
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

  it("highlights a code whose customers almost never clicked the partner's link", async () => {
    renderPage();
    expect(await screen.findByText('Partner codes')).toBeTruthy();
    const dealHunters = screen.getByText('90%');
    expect(dealHunters.getAttribute('title')).toMatch(/came through the code alone/);
    // 1 of 4: not highlighted.
    expect(screen.getByText('25%').getAttribute('title')).toBeNull();
  });

  it('shows empty states when nothing is wrong', async () => {
    report = { ...baseReport(), unattributed: { events: 0, byReason: [] }, issues: [], codes: [] };
    renderPage();
    expect(await screen.findByText('Every conversion in this window credited a partner.')).toBeTruthy();
    expect(screen.getByText('Nothing dropped in this window.')).toBeTruthy();
    expect(screen.queryByText('Partner codes')).toBeNull();
    expect(await screen.findByText(/Nothing unusual\. Each browser/)).toBeTruthy();
  });

  it('puts flags first, each in plain words with what usually causes it', async () => {
    flags = flagsReport([
      {
        kind: 'linkage_drop',
        subject: 'Mobile Safari|mobile|landed',
        browser: 'Mobile Safari',
        device: 'mobile',
        metric: 'landed',
        recent: { clicks: 150, hits: 30, rate: 0.2 },
        baseline: { clicks: 310, hits: 240, rate: 0.7742 },
      },
      {
        kind: 'fast_sales',
        subject: 'pa1',
        partnerId: 'pa1',
        partnerName: 'Deal Hunters',
        reason: 'mostly_instant',
        recent: { sales: 6, medianSeconds: 20, fast: 5, fastShare: 0.8333 },
        baseline: null,
      },
      {
        kind: 'fast_sales',
        subject: 'pa3',
        partnerId: 'pa3',
        partnerName: 'Shifted',
        reason: 'collapsed',
        recent: { sales: 6, medianSeconds: 120, fast: 0, fastShare: 0 },
        baseline: { sales: 12, medianSeconds: 1800, fast: 0, fastShare: 0 },
      },
    ]);
    renderPage();
    expect(
      await screen.findByText(
        'Mobile Safari (mobile): 20% of clicks reached a page running the script within a day, down from 77%',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/a new cookie banner or consent setup/)).toBeTruthy();
    expect(screen.getByText('Deal Hunters: 5 of 6 sales in the last two weeks came within a minute of the click')).toBeTruthy();
    expect(
      screen.getByText('Shifted: half of their sales now come within 2 minutes of the click, against 30 minutes before'),
    ).toBeTruthy();
    expect(screen.getByText(/6 in the last two weeks against 12 in the three months before/)).toBeTruthy();
    expect(screen.queryByText(/Nothing unusual/)).toBeNull();
    expect(requested).toContain('/api/admin/tracking-health/flags');
  });

  it('turns the alert email off from the setup checks heading', async () => {
    renderPage();
    const label = 'Email admins about failing checks and new flags';
    const box = (await screen.findByLabelText(label)) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(saved).toEqual([{ email: false }]));
    await waitFor(() => expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false));
  });

  it('shows each setup check per program, then the whole account, with what to change for the failing ones', async () => {
    setup = setupReport([
      {
        id: 'partners',
        title: 'Partners can share it',
        subject: 'p1',
        program: SPRING,
        status: 'pass',
        summary: '6 partners can share it (6 partners with a link).',
        fix: null,
      },
      {
        id: 'destination',
        title: 'Destination keeps the click',
        subject: 'p1',
        program: SPRING,
        status: 'fail',
        summary: 'The click is lost on the way: brand.example redirects to https://www.brand.example/ without ?cref=.',
        fix: 'Make the redirect keep the query string.',
      },
      {
        id: 'linking',
        title: 'Clicks are linked to customers',
        subject: 'account',
        program: null,
        status: 'waiting',
        summary: 'Waiting for partner clicks to reach a page running the script.',
        fix: null,
      },
      {
        id: 'codes',
        title: 'Partner codes have their discount',
        subject: 'account',
        program: null,
        status: 'unknown',
        summary: '6 partner codes promise customers a discount, and OpenPartner has no Stripe connection that can create it.',
        fix: 'Connect Stripe under Integrations.',
      },
    ]);
    renderPage();
    expect(await screen.findByText('1 of 4 checks is failing.')).toBeTruthy();
    expect(screen.getByText('1 failing, 1 can’t check, 1 waiting, 1 passing. Each failing check says what to change.')).toBeTruthy();
    expect(screen.getByText('Spring')).toBeTruthy();
    expect(screen.getByText('Whole account')).toBeTruthy();
    expect(screen.getByText('Destination keeps the click')).toBeTruthy();
    expect(screen.getByText('Make the redirect keep the query string.')).toBeTruthy();
    expect(screen.getByText('Connect Stripe under Integrations.')).toBeTruthy();
    expect(screen.getByText('can’t check')).toBeTruthy();
    expect(requested).toContain('/api/admin/tracking-health/setup');

    setup = setupReport(setup.checks.map((c) => ({ ...c, status: 'pass' as const })));
    fireEvent.click(screen.getByText('Check again'));
    expect(await screen.findByText('Every check passes.')).toBeTruthy();
    expect(requested).toContain('/api/admin/tracking-health/setup?refresh=1');
    // A passing check's advice isn't shown.
    expect(screen.queryByText('Make the redirect keep the query string.')).toBeNull();
  });

  it("shows Stripe's answer under a refused partner code", async () => {
    report = {
      ...baseReport(),
      issues: [
        {
          kind: 'reward_code_refused',
          count: 24,
          days: 1,
          sampleRef: 'ALPHA15',
          detail: 'Invalid string: …; must be at most 40 characters',
          lastSeenAt: '2026-10-28T10:00:00.000Z',
        },
      ],
    };
    renderPage();
    expect(await screen.findByText("Stripe refused a partner code's discount")).toBeTruthy();
    expect(screen.getByText('ALPHA15')).toBeTruthy();
    expect(screen.getByText('Invalid string: …; must be at most 40 characters')).toBeTruthy();
  });
});
