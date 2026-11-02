// @vitest-environment jsdom
/**
 * Booking reports in the portal (the Network's docs/campaign-reports.md):
 *
 *   - Approving a delivered booking asks what the creator may share, and a
 *     delivered booking links to its report.
 *   - The brand's report: results kept apart from YouTube's numbers, spend
 *     per result, the sharing choice, and a share link shown once.
 *   - The creator's report: their own numbers for a post we can't read, and
 *     no share link unless the brand allows it.
 *   - The public page takes the token from the fragment, sends it in a body
 *     and takes it out of the address bar.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminNetworkThread } from '../pages/admin/NetworkMessages.js';
import { AdminNetworkBookingReport } from '../pages/admin/NetworkBookingReport.js';
import { CreatorBookingReportPage } from '../pages/creator/CreatorBookingReport.js';
import { PublicReportPage } from '../pages/PublicReport.js';

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}
let sent: Sent[];
let routes: Record<string, (body: Record<string, unknown> | null) => [number, unknown]>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  sent = [];
  routes = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ method, url, body });
    const handler = routes[`${method} ${url.split('?')[0]}`];
    if (handler) {
      const [status, payload] = handler(body);
      return json(status, payload);
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

function renderAt(path: string, routeTree: React.ReactNode) {
  window.history.pushState({}, '', path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>{routeTree}</Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const CREATOR = { id: 'crt_ada', name: 'Ada Lovelace', handle: 'ada', avatarUrl: null };

const DELIVERED = {
  id: 'bkr_1',
  conversationId: 'cnv_1',
  proposedBy: 'vendor',
  status: 'delivered',
  creator: CREATOR,
  package: { title: 'Sponsored LinkedIn post', priceAmount: 500, priceIsFrom: false, currency: 'USD' },
  offering: { id: 'off_1', title: 'Acme Pro' },
  brief: 'A post about drafting faster with Acme.',
  amount: 500,
  currency: 'USD',
  feeRateBps: 1000,
  amountMinor: 50000,
  feeMinor: 5000,
  totalMinor: 55000,
  creatorMessage: null,
  deliverableUrls: [],
  partnerId: 'pp_ada',
  createdAt: '2026-10-25T10:00:00Z',
  paidAt: '2026-10-26T10:00:00Z',
  deliveredAt: '2026-10-28T10:00:00Z',
  completedAt: null,
  refundedMinor: 0,
  disputedAt: null,
  hasReport: true,
};

const REPORT = {
  bookingId: 'bkr_1',
  title: 'Sponsored LinkedIn post',
  platform: 'linkedin',
  currency: 'USD',
  status: 'completed',
  deliveredAt: '2026-10-28T10:00:00Z',
  completedAt: '2026-10-30T10:00:00Z',
  refunded: false,
  brand: { name: 'Acme', logoUrl: null },
  creator: { name: 'Ada Lovelace', handle: 'ada', avatarUrl: null, storefrontUrl: 'https://portal.test/creators/ada' },
  posts: [
    {
      url: 'https://youtu.be/abc',
      platform: 'youtube',
      label: 'YouTube',
      account: 'verified',
      reachable: true,
      publishedAt: '2026-10-28T09:00:00Z',
      publishedBeforeAccept: false,
      link: 'booking',
      youtube: { views: 12400, likes: 310, comments: null },
      reported: null,
    },
    {
      url: 'https://www.linkedin.com/posts/ada_acme-1',
      platform: 'other',
      label: 'linkedin',
      account: 'unsupported',
      reachable: null,
      publishedAt: null,
      publishedBeforeAccept: null,
      link: 'unknown',
      youtube: null,
      reported: { views: 15000, likes: 320, comments: 41, shares: null, reportedAt: '2026-10-29T10:00:00Z' },
    },
  ],
  results: {
    scope: 'link',
    checkedAt: '2026-10-31T10:00:00Z',
    clicks: 40,
    bySource: [{ host: 'youtube.com', clicks: 30 }],
    leads: 5,
    sales: 2,
    refundedSales: 0,
    revenueByCurrency: { USD: 300 },
    refundedByCurrency: { USD: 50 },
    netRevenueByCurrency: { USD: 250 },
    daily: [],
    error: null,
  },
  window: { clickSince: '2026-10-25T10:00:00Z', clickUntil: '2027-01-26T10:00:00Z', conversionUntil: '2027-02-25T10:00:00Z', closed: false, asOf: '2026-10-31T10:00:00Z' },
  spend: { currency: 'USD', paid: 550, refunded: 0, net: 550, costPerClick: 13.75, costPerLead: 110, costPerSale: 275, returnOnSpend: 0.45 },
  sharing: { creatorShare: null, effective: 'none', brandDefault: 'none' },
  linkState: 'ready',
  trackedUrls: ['https://app.openpartner.test/r/acme/bk-abc'],
};

describe('approving a delivered booking', () => {
  function thread(booking: Record<string, unknown>) {
    routes['GET /api/t/acme/admin/network/conversations/cnv_1'] = () => [
      200,
      {
        conversation: { id: 'cnv_1', creator: CREATOR, blocked: false, canWrite: true, cannotWriteReason: null, canBook: true },
        // The card hangs off the booking's first event.
        messages: [{ id: 'cnm_1', author: 'vendor', authorName: 'Grace', kind: 'event', body: null, event: 'requested', bookingId: 'bkr_1', createdAt: '2026-10-25T10:00:00Z' }],
        hasMore: false,
        bookings: [booking],
      },
    ];
    routes['POST /api/t/acme/admin/network/bookings/bkr_1/approve'] = () => [200, { booking: { ...booking, status: 'completed' } }];
    renderAt('/t/acme/admin/network/messages/cnv_1', <Route path="/t/:slug/admin/network/messages/:id" element={<AdminNetworkThread />} />);
  }

  it('asks what the creator may share, and sends the choice', async () => {
    thread(DELIVERED);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'counts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and complete' }));
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/bookings/bkr_1/approve'))).toBe(true));
    expect(sent.find((s) => s.url.endsWith('/approve'))!.body).toEqual({ creatorShare: 'counts' });
  });

  it("keeps the brand's default unless one is picked, and links to the report", async () => {
    thread(DELIVERED);
    const report = await screen.findByRole('link', { name: 'Report' });
    expect(report.getAttribute('href')).toBe('/t/acme/admin/network/bookings/bkr_1/report');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve and complete' }));
    await waitFor(() => expect(sent.find((s) => s.url.endsWith('/approve'))?.body).toEqual({}));
  });
});

describe("the brand's report", () => {
  function open() {
    routes['GET /api/t/acme/admin/network/bookings/bkr_1/report'] = () => [200, { report: REPORT }];
    routes['GET /api/t/acme/admin/network/bookings/bkr_1/report/shares'] = () => [200, { shares: [] }];
    routes['POST /api/t/acme/admin/network/bookings/bkr_1/report/shares'] = () => [201, { share: { id: 'brs_1' }, url: 'https://portal.test/reports#oprp_abc' }];
    routes['PATCH /api/t/acme/admin/network/bookings/bkr_1/report-sharing'] = () => [200, { creatorShare: 'revenue', effective: 'revenue' }];
    renderAt('/t/acme/admin/network/bookings/bkr_1/report', <Route path="/t/:slug/admin/network/bookings/:id/report" element={<AdminNetworkBookingReport />} />);
  }

  it('keeps OpenPartner results apart from YouTube, labels reported numbers, and shows spend per result', async () => {
    open();
    expect(await screen.findByText('Tracked by OpenPartner', { exact: false })).toBeTruthy();
    expect(screen.getByText('· not YouTube data', { exact: false })).toBeTruthy();
    expect(screen.getByText('$250.00')).toBeTruthy();
    expect(screen.getByText('$50.00 refunded')).toBeTruthy();
    expect(screen.getByText('12,400 views')).toBeTruthy();
    expect(screen.getByText('Comments hidden')).toBeTruthy();
    expect(screen.getByText(/Reported by the creator/)).toBeTruthy();
    expect(screen.getByText('15,000 impressions')).toBeTruthy();
    expect(screen.getByText('$13.75')).toBeTruthy();
    expect(screen.getByText('0.45×')).toBeTruthy();
  });

  it("says when the booking is on the creator's storefront", async () => {
    routes['GET /api/t/acme/admin/network/bookings/bkr_1/report'] = () => [
      200,
      { report: { ...REPORT, sharing: { creatorShare: 'posts', effective: 'posts', brandDefault: 'none', onCreatorStorefront: true } } },
    ];
    routes['GET /api/t/acme/admin/network/bookings/bkr_1/report/shares'] = () => [200, { shares: [] }];
    renderAt('/t/acme/admin/network/bookings/bkr_1/report', <Route path="/t/:slug/admin/network/bookings/:id/report" element={<AdminNetworkBookingReport />} />);
    expect(await screen.findByText('On their storefront as verified work')).toBeTruthy();
  });

  it('changes what the creator may share, and shows a new link once', async () => {
    open();
    const select = await screen.findByDisplayValue('Your default (No)');
    fireEvent.change(select, { target: { value: 'revenue' } });
    await waitFor(() => expect(sent.find((s) => s.method === 'PATCH')?.body).toEqual({ creatorShare: 'revenue' }));

    fireEvent.click(screen.getByLabelText('Spend'));
    fireEvent.click(screen.getByRole('button', { name: 'Make share link' }));
    expect(await screen.findByText('https://portal.test/reports#oprp_abc')).toBeTruthy();
    expect(sent.find((s) => s.method === 'POST' && s.url.endsWith('/report/shares'))!.body).toEqual({
      includeResults: true,
      includeCost: true,
      includeReported: true,
    });
  });
});

describe('Instagram and TikTok numbers', () => {
  const TIKTOK_POST = {
    url: 'https://www.tiktok.com/@ada/video/743',
    platform: 'tiktok',
    label: 'tiktok',
    account: 'verified',
    reachable: true,
    publishedAt: '2026-10-28T09:00:00Z',
    publishedBeforeAccept: false,
    link: 'unknown',
    youtube: null,
    social: { platform: 'tiktok', views: 91000, likes: 4100, comments: 120, shares: 340 },
    reported: null,
  };

  it("shows the brand what the creator's verified account says", async () => {
    routes['GET /api/t/acme/admin/network/bookings/bkr_1/report'] = () => [200, { report: { ...REPORT, posts: [TIKTOK_POST] } }];
    routes['GET /api/t/acme/admin/network/bookings/bkr_1/report/shares'] = () => [200, { shares: [] }];
    renderAt('/t/acme/admin/network/bookings/bkr_1/report', <Route path="/t/:slug/admin/network/bookings/:id/report" element={<AdminNetworkBookingReport />} />);
    expect(await screen.findByText('TikTok')).toBeTruthy();
    expect(screen.getByText('91,000 views')).toBeTruthy();
    expect(screen.getByText('4,100 likes')).toBeTruthy();
    expect(screen.getByText('340 shares')).toBeTruthy();
    expect(screen.getByText('✓ Verified account')).toBeTruthy();
    // Not YouTube's numbers, so no YouTube note.
    expect(screen.queryByText('· not YouTube data', { exact: false })).toBeNull();
  });

  it("lets the creator add numbers only where the platform gave none", async () => {
    const creatorReport = { ...REPORT, spend: null, posts: [TIKTOK_POST, REPORT.posts[1]] };
    routes['GET /api/creator-api/creators/me/bookings/bkr_1/report'] = () => [200, { report: creatorReport }];
    routes['GET /api/creator-api/creators/me/bookings/bkr_1/report/shares'] = () => [200, { shares: [], allowed: false }];
    renderAt('/creator/bookings/bkr_1/report', <Route path="/creator/bookings/:id/report" element={<CreatorBookingReportPage />} />);
    expect(await screen.findByText('91,000 views')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /your numbers/ })).toHaveLength(1);
  });
});

describe("the creator's report", () => {
  it('saves their own numbers for a post we cannot read, and has no link to make unless allowed', async () => {
    const creatorReport = { ...REPORT, spend: null, price: { amount: 500, currency: 'USD' } };
    routes['GET /api/creator-api/creators/me/bookings/bkr_1/report'] = () => [200, { report: creatorReport }];
    routes['GET /api/creator-api/creators/me/bookings/bkr_1/report/shares'] = () => [200, { shares: [], allowed: false }];
    routes['PUT /api/creator-api/creators/me/bookings/bkr_1/reported-stats'] = () => [200, { report: creatorReport }];
    renderAt('/creator/bookings/bkr_1/report', <Route path="/creator/bookings/:id/report" element={<CreatorBookingReportPage />} />);

    expect(await screen.findByText('The brand hasn’t allowed sharing for this booking.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make share link' })).toBeNull();
    // Only the LinkedIn post takes numbers: YouTube's are verified.
    const edit = screen.getAllByRole('button', { name: /your numbers/ });
    expect(edit).toHaveLength(1);
    fireEvent.click(edit[0]!);
    fireEvent.change(screen.getByLabelText('Impressions'), { target: { value: '16000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent.some((s) => s.method === 'PUT')).toBe(true));
    expect(sent.find((s) => s.method === 'PUT')!.body).toEqual({
      url: 'https://www.linkedin.com/posts/ada_acme-1',
      views: 16000,
      likes: 320,
      comments: 41,
      shares: null,
    });
  });
});

describe('a shared report', () => {
  it('posts the token from the fragment, takes it out of the address bar, and shows the report', async () => {
    const shared = {
      ...REPORT,
      bookingId: undefined,
      spend: null,
      sharing: undefined,
      trackedUrls: undefined,
      results: { ...REPORT.results, netRevenueByCurrency: { EUR: 89, USD: 250 } },
    };
    routes['POST /api/creator-api/reports/view'] = () => [200, { report: shared }];
    renderAt('/reports#oprp_secret_token', <Route path="/reports" element={<PublicReportPage />} />);

    expect(await screen.findByText('Measured by', { exact: false })).toBeTruthy();
    expect(sent.find((s) => s.url === '/api/creator-api/reports/view')!.body).toEqual({ token: 'oprp_secret_token' });
    expect(window.location.hash).toBe('');
    expect(sent.every((s) => !s.url.includes('oprp_'))).toBe(true);
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    expect(screen.getByText('Work with Ada Lovelace')).toBeTruthy();
    // No spend on a shared page: the booking's currency still leads.
    expect(screen.getByText('$250.00 + €89.00')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sponsored LinkedIn post' })).toBeTruthy();
  });

  it('shows the next link opened in the same tab, and takes its token out too', async () => {
    routes['POST /api/creator-api/reports/view'] = (body) => [200, { report: { ...REPORT, title: body?.token === 'oprp_second' ? 'Second booking' : 'First booking' } }];
    renderAt('/reports#oprp_first', <Route path="/reports" element={<PublicReportPage />} />);
    expect(await screen.findByRole('heading', { name: 'First booking' })).toBeTruthy();

    // Same page, new fragment: no reload.
    window.location.hash = 'oprp_second';
    expect(await screen.findByRole('heading', { name: 'Second booking' })).toBeTruthy();
    expect(window.location.hash).toBe('');
  });

  it('says a revoked or unknown link is not found', async () => {
    routes['POST /api/creator-api/reports/view'] = () => [404, { error: 'report_not_found' }];
    renderAt('/reports#oprp_gone', <Route path="/reports" element={<PublicReportPage />} />);
    expect(await screen.findByText('Report not found')).toBeTruthy();
  });
});
