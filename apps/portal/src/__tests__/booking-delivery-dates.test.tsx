// @vitest-environment jsdom
/**
 * Booking delivery dates in the portal (the Network's
 * docs/creator-storefront.md §9):
 *
 *   - The creator accepts a request at the brand's proposed dates, and
 *     can't accept without a go-live date.
 *   - Both cards show the dates, an overdue booking says so, and a
 *     proposal waits for the other side's Accept or Decline.
 *   - The draft: the creator shares one; the brand approves it or asks for
 *     changes, within the rounds left.
 *   - A brand can't pay for dates that have passed.
 *   - A booking from a Network before dates shows and sends none of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminNetworkThread } from '../pages/admin/NetworkMessages.js';
import { CreatorThreadPage } from '../pages/creator/CreatorMessages.js';
import { dateInDays, datePassed, formatDay, scheduleBody, scheduleDraftFrom, scheduleDraftProblem, type BookingSchedule } from '../pages/creator/booking-schedule.js';
import { packageTermsText } from '../pages/creator/storefront-shared.js';
import { onTimeText } from '../pages/creator/CaseStudies.js';

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

const GO_LIVE = dateInDays(14);
const DRAFT = dateInDays(7);

function schedule(over: Partial<BookingSchedule> = {}): BookingSchedule {
  return {
    goLiveBy: GO_LIVE,
    draftDueBy: DRAFT,
    revisionRounds: 2,
    revisionsRequested: 0,
    draftState: null,
    draftSharedAt: null,
    draftApprovedAt: null,
    proposal: null,
    overdue: null,
    datesPassed: false,
    goLive: null,
    draft: null,
    ...over,
  };
}

// ----- the creator's side -----

const REQUEST = {
  id: 'bkr_2',
  conversationId: 'cnv_2',
  proposedBy: 'vendor',
  packageId: 'cpk_1',
  package: { title: 'Sponsored post', platform: null, priceAmount: 500, priceIsFrom: false, currency: 'USD', turnaroundDays: 10, revisionRounds: 2 },
  contactName: 'Grace Hopper',
  company: 'New Brand Co',
  website: null,
  brief: 'A post about our app, please.',
  budgetNote: null,
  status: 'pending',
  creatorMessage: null,
  createdAt: '2026-10-25T10:00:00Z',
  tracked: false,
  amount: 500,
  currency: 'USD',
  amountMinor: 50000,
  deliverableUrls: [],
  deliveredAt: null,
  completedAt: null,
  paidAt: null,
  refundedMinor: 0,
  disputedAt: null,
  schedule: schedule({ revisionRounds: null }),
};

function creatorThread(booking: Record<string, unknown>, extra: unknown[] = []) {
  return {
    conversation: { id: 'cnv_2', brand: { id: 'vnd_1', name: 'New Brand Co', logoUrl: null }, contactName: 'Grace Hopper', blocked: false, brandActive: true },
    messages: [
      { id: 'cnm_2', author: 'vendor', authorName: 'Grace Hopper', kind: 'event', body: null, event: 'requested', bookingId: 'bkr_2', createdAt: '2026-10-25T10:00:01Z' },
      ...extra,
    ],
    hasMore: false,
    bookings: [booking],
  };
}

function creatorRoutes(booking: Record<string, unknown>, extra: unknown[] = []) {
  routes['GET /api/creator-api/creators/me/conversations/cnv_2'] = () => [200, creatorThread(booking, extra)];
  routes['GET /api/creator-api/creators/me/payments'] = () => [200, { connected: true, ready: true, cardPayments: 'active', country: 'US', currency: 'USD', checkedAt: null }];
}

describe('creator thread', () => {
  it("accepts at the brand's proposed dates and the package's rounds, and needs a go-live date", async () => {
    creatorRoutes(REQUEST);
    routes['POST /api/creator-api/creators/me/bookings/bkr_2/accept'] = () => [200, { booking: { ...REQUEST, status: 'awaiting_payment' } }];
    renderAt('/creator/messages/cnv_2', <Route path="/creator/messages/:id" element={<CreatorThreadPage />} />);

    const goLive = (await screen.findByLabelText('Goes live by')) as HTMLInputElement;
    expect(goLive.value).toBe(GO_LIVE);
    expect((screen.getByLabelText('Draft by') as HTMLInputElement).value).toBe(DRAFT);
    expect((screen.getByLabelText('Revision rounds') as HTMLSelectElement).value).toBe('2');

    const accept = await screen.findByRole('button', { name: 'Accept at $500' });
    await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(goLive, { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'Accept at $500' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(goLive, { target: { value: GO_LIVE } });

    fireEvent.click(screen.getByRole('button', { name: 'Accept at $500' }));
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/bookings/bkr_2/accept'))).toBe(true));
    expect(sent.find((s) => s.url.endsWith('/accept'))!.body).toEqual({
      amount: 500,
      currency: 'USD',
      goLiveBy: GO_LIVE,
      draftDueBy: DRAFT,
      revisionRounds: 2,
    });
  });

  it('shows a paid booking as overdue, shares the draft, and answers new dates from the brand', async () => {
    const paid = {
      ...REQUEST,
      status: 'paid',
      paidAt: '2026-10-26T10:00:00Z',
      schedule: schedule({
        overdue: 'draft',
        proposal: { goLiveBy: dateInDays(20), draftDueBy: dateInDays(12), by: 'vendor', at: '2026-10-28T10:00:00Z' },
      }),
    };
    creatorRoutes(paid, [
      { id: 'cnm_3', author: 'vendor', authorName: 'Grace Hopper', kind: 'event', body: `go live ${dateInDays(20)}, draft ${dateInDays(12)}`, event: 'schedule_proposed', bookingId: 'bkr_2', createdAt: '2026-10-28T10:00:00Z' },
    ]);
    routes['POST /api/creator-api/creators/me/bookings/bkr_2/draft'] = () => [200, { booking: paid }];
    routes['POST /api/creator-api/creators/me/bookings/bkr_2/schedule/accept'] = () => [200, { booking: paid }];
    renderAt('/creator/messages/cnv_2', <Route path="/creator/messages/:id" element={<CreatorThreadPage />} />);

    expect(await screen.findByText('Draft overdue')).toBeTruthy();
    expect(screen.getByText(formatDay(GO_LIVE))).toBeTruthy();
    expect(screen.getByText(`New Brand Co proposed new dates: go live by ${formatDay(dateInDays(20))}, draft by ${formatDay(dateInDays(12))}`, { exact: false })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'First cut: https://docs.example.test/1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share draft' }));
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/bookings/bkr_2/draft'))).toBe(true));
    expect(sent.find((s) => s.url.endsWith('/draft'))!.body).toEqual({ body: 'First cut: https://docs.example.test/1' });

    fireEvent.click(screen.getByRole('button', { name: 'Accept dates' }));
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && s.url.endsWith('/bookings/bkr_2/schedule/accept'))).toBe(true));
  });

  it('a booking from a Network before dates shows and sends none of it', async () => {
    const { schedule: _none, ...old } = REQUEST;
    creatorRoutes({ ...old, package: { title: 'Sponsored post', platform: null, priceAmount: 500, priceIsFrom: false, currency: 'USD' } });
    routes['POST /api/creator-api/creators/me/bookings/bkr_2/accept'] = () => [200, { booking: { ...old, status: 'awaiting_payment' } }];
    renderAt('/creator/messages/cnv_2', <Route path="/creator/messages/:id" element={<CreatorThreadPage />} />);
    const accept = await screen.findByRole('button', { name: 'Accept at $500' });
    expect(screen.queryByLabelText('Goes live by')).toBeNull();
    await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(accept);
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/accept'))).toBe(true));
    expect(sent.find((s) => s.url.endsWith('/accept'))!.body).toEqual({ amount: 500, currency: 'USD' });
  });
});

// ----- the brand's side -----

const BOOKING = {
  id: 'bkr_1',
  conversationId: 'cnv_1',
  proposedBy: 'vendor',
  status: 'paid',
  creator: { id: 'crt_ada', name: 'Ada Lovelace', handle: 'ada', avatarUrl: null },
  package: { title: 'YouTube integration', priceAmount: 2000, priceIsFrom: false, currency: 'USD' },
  offering: null,
  brief: 'A 60-second read in my weekly video.',
  amount: 2000,
  currency: 'USD',
  feeRateBps: 1000,
  amountMinor: 200000,
  feeMinor: 20000,
  totalMinor: 220000,
  creatorMessage: null,
  deliverableUrls: [],
  partnerId: null,
  createdAt: '2026-10-25T10:00:00Z',
  paidAt: '2026-10-26T10:00:00Z',
  deliveredAt: null,
  completedAt: null,
  refundedMinor: 0,
  disputedAt: null,
};

function brandRoutes(booking: Record<string, unknown>) {
  routes['GET /api/t/acme/admin/network/conversations/cnv_1'] = () => [
    200,
    {
      conversation: { id: 'cnv_1', creator: BOOKING.creator, blocked: false, canWrite: true, cannotWriteReason: null, canBook: true },
      messages: [{ id: 'cnm_2', author: 'vendor', authorName: 'Grace', kind: 'event', body: null, event: 'requested', bookingId: 'bkr_1', createdAt: '2026-10-25T10:00:00Z' }],
      hasMore: false,
      bookings: [booking],
    },
  ];
}

describe('brand thread', () => {
  it('approves a shared draft, or asks for changes within the rounds left', async () => {
    const shared = { ...BOOKING, schedule: schedule({ draftState: 'shared', draftSharedAt: '2026-10-30T10:00:00Z', revisionsRequested: 1 }) };
    brandRoutes(shared);
    routes['POST /api/t/acme/admin/network/bookings/bkr_1/draft/changes'] = () => [200, { booking: shared }];
    routes['POST /api/t/acme/admin/network/bookings/bkr_1/draft/approve'] = () => [200, { booking: shared }];
    renderAt('/t/acme/admin/network/messages/cnv_1', <Route path="/t/:slug/admin/network/messages/:id" element={<AdminNetworkThread />} />);

    expect(await screen.findByText('Draft shared for your review.')).toBeTruthy();
    expect(screen.getByText('1 round left')).toBeTruthy();
    expect(screen.getByText(/2 revision rounds \(1 used\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Ask for changes' }));
    fireEvent.change(screen.getByLabelText('Changes'), { target: { value: 'Shorter intro, please.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send changes' }));
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/bookings/bkr_1/draft/changes'))).toBe(true));
    expect(sent.find((s) => s.url.endsWith('/draft/changes'))!.body).toEqual({ body: 'Shorter intro, please.' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve draft' }));
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/bookings/bkr_1/draft/approve'))).toBe(true));
  });

  it('proposes new dates, and withdraws its own proposal', async () => {
    brandRoutes({ ...BOOKING, schedule: schedule() });
    routes['POST /api/t/acme/admin/network/bookings/bkr_1/schedule'] = () => [200, { booking: BOOKING }];
    renderAt('/t/acme/admin/network/messages/cnv_1', <Route path="/t/:slug/admin/network/messages/:id" element={<AdminNetworkThread />} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Change dates' }));
    const propose = screen.getByRole('button', { name: 'Propose dates' }) as HTMLButtonElement;
    // The same dates aren't a proposal.
    expect(propose.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('New go-live date'), { target: { value: dateInDays(21) } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose dates' }));
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && s.url.endsWith('/bookings/bkr_1/schedule'))).toBe(true));
    expect(sent.find((s) => s.url.endsWith('/schedule'))!.body).toEqual({ goLiveBy: dateInDays(21), draftDueBy: DRAFT });
    cleanup();

    brandRoutes({ ...BOOKING, schedule: schedule({ proposal: { goLiveBy: dateInDays(21), draftDueBy: DRAFT, by: 'vendor', at: '2026-10-28T10:00:00Z' } }) });
    routes['DELETE /api/t/acme/admin/network/bookings/bkr_1/schedule'] = () => [200, { booking: BOOKING }];
    renderAt('/t/acme/admin/network/messages/cnv_1', <Route path="/t/:slug/admin/network/messages/:id" element={<AdminNetworkThread />} />);
    expect(await screen.findByText(/You proposed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept dates' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(sent.some((s) => s.method === 'DELETE' && s.url.endsWith('/bookings/bkr_1/schedule'))).toBe(true));
  });

  it("can't pay for dates that have passed, and shows an overdue booking", async () => {
    brandRoutes({ ...BOOKING, status: 'awaiting_payment', paidAt: null, schedule: schedule({ goLiveBy: dateInDays(-3), draftDueBy: null, datesPassed: true }) });
    renderAt('/t/acme/admin/network/messages/cnv_1', <Route path="/t/:slug/admin/network/messages/:id" element={<AdminNetworkThread />} />);
    expect(await screen.findByText('Dates passed')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Pay $2,200' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    brandRoutes({ ...BOOKING, schedule: schedule({ overdue: 'go_live' }) });
    renderAt('/t/acme/admin/network/messages/cnv_1', <Route path="/t/:slug/admin/network/messages/:id" element={<AdminNetworkThread />} />);
    expect(await screen.findByText('Overdue')).toBeTruthy();
  });
});

describe('the pieces', () => {
  it('checks dates before they go to the Network', () => {
    const ok = scheduleDraftFrom({ goLiveBy: GO_LIVE, draftDueBy: DRAFT, revisionRounds: 1 });
    expect(scheduleDraftProblem(ok, { requireGoLive: true })).toBeNull();
    expect(scheduleBody(ok)).toEqual({ goLiveBy: GO_LIVE, draftDueBy: DRAFT, revisionRounds: 1 });
    expect(scheduleDraftProblem({ ...ok, goLiveBy: '' }, { requireGoLive: true })).toBe('Pick a go-live date.');
    expect(scheduleDraftProblem({ goLiveBy: '', draftDueBy: '', revisionRounds: '' }, { requireGoLive: false })).toBeNull();
    expect(scheduleDraftProblem({ ...ok, draftDueBy: GO_LIVE }, { requireGoLive: true })).toBe('The draft is due before go-live.');
    expect(scheduleDraftProblem({ ...ok, goLiveBy: dateInDays(-5), draftDueBy: '' }, { requireGoLive: true })).toBe('That go-live date has passed.');
    // A date ends at noon UTC the next day: the end of the day at UTC−12.
    expect(datePassed('2026-11-20', new Date('2026-11-21T11:59:59Z'))).toBe(false);
    expect(datePassed('2026-11-20', new Date('2026-11-21T12:00:00Z'))).toBe(true);
    // A package's turnaround fills the go-live date.
    expect(scheduleDraftFrom(null, { turnaroundDays: 10, revisionRounds: 0 })).toEqual({ goLiveBy: dateInDays(10), draftDueBy: '', revisionRounds: '0' });
  });

  it('says a package’s terms and a case study’s timing in a few words', () => {
    expect(packageTermsText({ turnaroundDays: 14, revisionRounds: 2 })).toBe('Live within 14 days · 2 revision rounds');
    expect(packageTermsText({ turnaroundDays: 1, revisionRounds: null })).toBe('Live within 1 day');
    expect(packageTermsText({})).toBeNull();
    expect(onTimeText({ onTime: true, daysLate: 0 })).toBe('Delivered on time');
    expect(onTimeText({ onTime: false, daysLate: 3 })).toBe('Delivered 3 days late');
    expect(onTimeText({})).toBeNull();
  });
});
