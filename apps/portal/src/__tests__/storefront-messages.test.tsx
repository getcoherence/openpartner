// @vitest-environment jsdom
/**
 * Storefront conversations and paid bookings in the portal (the Network's
 * docs/creator-storefront.md §8):
 *
 *   - /booking/confirm: a public requester continues as a brand: a new
 *     address names its brand there; a signed-in brand admin sends it as
 *     that brand; an address with an account signs in first.
 *   - The brand's claim page shows the request and sends it only on a click.
 *   - The brand's thread: a creator's offer shows the price, the booking
 *     fee and the total, and Pay opens Checkout for it; a payment still
 *     processing replaces Pay, and the return banner follows the booking.
 *   - The creator's thread: accepting needs a Stripe account that can take
 *     payments, and sends the creator's price.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookingConfirmPage } from '../pages/creator/BookingConfirm.js';
import { AdminNetworkClaim, AdminNetworkThread } from '../pages/admin/NetworkMessages.js';
import { CreatorThreadPage } from '../pages/creator/CreatorMessages.js';
import { CreatorBookingsPage } from '../pages/creator/CreatorBookings.js';

const TOKEN = `opbk_${'a'.repeat(48)}`;

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

const PREVIEW = {
  creator: { id: 'crt_ada', name: 'Ada Lovelace', handle: 'ada', avatarUrl: null },
  packageTitle: 'Deep dive',
  contactName: 'Grace Hopper',
  company: 'New Brand Co',
  brief: 'A deep-dive post about our app, please.',
  email: 'grace@newbrand.test',
  accountExists: false,
  suggested: { displayName: 'New Brand Co', slug: 'new-brand-co' },
};

describe('/booking/confirm', () => {
  it('creates a brand for a new address and sends the request', async () => {
    routes['POST /api/booking-claims/preview'] = () => [200, PREVIEW];
    routes['GET /api/session/home'] = () => [200, { home: null }];
    routes['POST /api/booking-claims/signup'] = () => [201, { tenant: { slug: 'new-brand-co' }, conversationId: 'cnv_1' }];
    renderAt(`/booking/confirm?token=${TOKEN}`, <Route path="/booking/confirm" element={<BookingConfirmPage />} />);

    expect(await screen.findByText('Send your request to Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('grace@newbrand.test')).toBeTruthy();
    expect((screen.getByDisplayValue('New Brand Co') as HTMLInputElement).value).toBe('New Brand Co');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'US' } });
    fireEvent.click(screen.getByRole('button', { name: /create brand and send to ada/i }));

    await waitFor(() => expect(sent.some((s) => s.url === '/api/booking-claims/signup')).toBe(true));
    expect(sent.find((s) => s.url === '/api/booking-claims/signup')!.body).toEqual({
      token: TOKEN,
      displayName: 'New Brand Co',
      slug: 'new-brand-co',
      adminName: 'Grace Hopper',
      country: 'US',
    });
  });

  it('sends it as the signed-in brand, or asks an existing account to sign in', async () => {
    routes['POST /api/booking-claims/preview'] = () => [200, PREVIEW];
    routes['GET /api/session/home'] = () => [200, { home: '/t/acme/', kind: 'admin', tenantSlug: 'acme' }];
    renderAt(
      `/booking/confirm?token=${TOKEN}`,
      <>
        <Route path="/booking/confirm" element={<BookingConfirmPage />} />
        <Route path="/t/:slug/admin/network/claim" element={<div>claim page</div>} />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Send it as your brand' }));
    expect(await screen.findByText('claim page')).toBeTruthy();
    expect(window.location.pathname).toBe('/t/acme/admin/network/claim');
    expect(new URLSearchParams(window.location.search).get('token')).toBe(TOKEN);
    cleanup();

    routes['POST /api/booking-claims/preview'] = () => [200, { ...PREVIEW, accountExists: true }];
    routes['GET /api/session/home'] = () => [200, { home: null }];
    renderAt(
      `/booking/confirm?token=${TOKEN}`,
      <>
        <Route path="/booking/confirm" element={<BookingConfirmPage />} />
        <Route path="/signin" element={<div>sign in page</div>} />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to send it' }));
    expect(await screen.findByText('sign in page')).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get('next')).toBe(`/admin/network/claim?token=${TOKEN}`);
  });

  it('says so when the link has expired', async () => {
    routes['POST /api/booking-claims/preview'] = () => [410, { error: 'expired' }];
    routes['GET /api/session/home'] = () => [200, { home: null }];
    renderAt(`/booking/confirm?token=${TOKEN}`, <Route path="/booking/confirm" element={<BookingConfirmPage />} />);
    expect(await screen.findByText(/This link has expired/)).toBeTruthy();
  });
});

describe('brand claim page', () => {
  it('shows the request and sends it as the brand only on a click', async () => {
    routes['POST /api/booking-claims/preview'] = () => [200, PREVIEW];
    routes['POST /api/t/acme/admin/network/bookings/claim'] = () => [201, { conversationId: 'cnv_9' }];
    renderAt(
      `/t/acme/admin/network/claim?token=${TOKEN}`,
      <>
        <Route path="/t/:slug/admin/network/claim" element={<AdminNetworkClaim />} />
        <Route path="/t/:slug/admin/network/messages/:id" element={<div>thread page</div>} />
      </>,
    );
    expect(await screen.findByText('A deep-dive post about our app, please.')).toBeTruthy();
    expect(screen.getByText('To Ada Lovelace')).toBeTruthy();
    expect(sent.some((s) => s.url.endsWith('/bookings/claim'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Send as your brand' }));
    expect(await screen.findByText('thread page')).toBeTruthy();
    expect(window.location.pathname).toBe('/t/acme/admin/network/messages/cnv_9');
    expect(sent.find((s) => s.url.endsWith('/bookings/claim'))!.body).toEqual({ token: TOKEN });
  });

  it('explains a brand in review that already talks to another creator', async () => {
    routes['POST /api/booking-claims/preview'] = () => [200, PREVIEW];
    routes['POST /api/t/acme/admin/network/bookings/claim'] = () => [403, { error: 'vendor_pending_review' }];
    renderAt(`/t/acme/admin/network/claim?token=${TOKEN}`, <Route path="/t/:slug/admin/network/claim" element={<AdminNetworkClaim />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send as your brand' }));
    expect(await screen.findByText(/it can talk to one creator only/)).toBeTruthy();
  });
});

const OFFER = {
  id: 'bkr_1',
  conversationId: 'cnv_1',
  proposedBy: 'creator',
  status: 'awaiting_payment',
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
  paidAt: null,
  deliveredAt: null,
  completedAt: null,
  refundedMinor: 0,
  disputedAt: null,
};

describe('brand thread', () => {
  it('shows what the brand pays for an offer, and Pay opens Checkout', async () => {
    routes['GET /api/t/acme/admin/network/conversations/cnv_1'] = () => [
      200,
      {
        conversation: { id: 'cnv_1', creator: OFFER.creator, blocked: false, canWrite: true, cannotWriteReason: null, canBook: true },
        messages: [
          { id: 'cnm_1', author: 'vendor', authorName: 'Grace', kind: 'text', body: 'What would a video cost?', event: null, bookingId: null, createdAt: '2026-10-25T09:00:00Z' },
          { id: 'cnm_2', author: 'creator', authorName: null, kind: 'event', body: null, event: 'offered', bookingId: 'bkr_1', createdAt: '2026-10-25T10:00:00Z' },
        ],
        hasMore: false,
        bookings: [OFFER],
      },
    ];
    routes['POST /api/t/acme/admin/network/bookings/bkr_1/checkout'] = () => [200, { url: 'https://checkout.stripe.test/cs_1' }];
    renderAt('/t/acme/admin/network/messages/cnv_1', <Route path="/t/:slug/admin/network/messages/:id" element={<AdminNetworkThread />} />);

    expect(await screen.findByText('What would a video cost?')).toBeTruthy();
    expect(screen.getByText('Ada Lovelace sent an offer', { exact: false })).toBeTruthy();
    expect(screen.getByText(/\$2,000 to Ada Lovelace and the \$200 OpenPartner booking fee/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pay $2,200' }));
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/bookings/bkr_1/checkout'))).toBe(true));
    expect(sent.find((s) => s.url.endsWith('/checkout'))!.body).toEqual({ returnPath: '/admin/network/messages/cnv_1' });
  });

  it('says a payment is processing instead of offering Pay, and the return banner follows the booking', async () => {
    let booking: Record<string, unknown> = { ...OFFER, paymentProcessing: true };
    routes['GET /api/t/acme/admin/network/conversations/cnv_1'] = () => [
      200,
      {
        conversation: { id: 'cnv_1', creator: OFFER.creator, blocked: false, canWrite: true, cannotWriteReason: null, canBook: true },
        messages: [{ id: 'cnm_2', author: 'creator', authorName: null, kind: 'event', body: null, event: 'offered', bookingId: 'bkr_1', createdAt: '2026-10-25T10:00:00Z' }],
        hasMore: false,
        bookings: [booking],
      },
    ];
    routes['POST /api/t/acme/admin/network/bookings/bkr_1/sync'] = () => [200, { booking }];
    renderAt(
      '/t/acme/admin/network/messages/cnv_1?booking=bkr_1&checkout=success',
      <Route path="/t/:slug/admin/network/messages/:id" element={<AdminNetworkThread />} />,
    );
    expect(await screen.findByText(/Your payment is processing/)).toBeTruthy();
    expect(screen.getByText(/^Payment processing\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Pay/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline offer' })).toBeNull();
    expect(screen.queryByText(/Payment received/)).toBeNull();
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/bookings/bkr_1/sync'))).toBe(true));
    cleanup();

    booking = { ...OFFER, status: 'paid', paidAt: '2026-10-25T11:00:00Z' };
    renderAt(
      '/t/acme/admin/network/messages/cnv_1?booking=bkr_1&checkout=success',
      <Route path="/t/:slug/admin/network/messages/:id" element={<AdminNetworkThread />} />,
    );
    expect(await screen.findByText(/Payment received\. Ada Lovelace has been told/)).toBeTruthy();
    cleanup();

    // Refunded before the brand got back: no "can start now".
    booking = { ...OFFER, status: 'refunded', paidAt: '2026-10-25T11:00:00Z', refundedMinor: 220000 };
    renderAt(
      '/t/acme/admin/network/messages/cnv_1?booking=bkr_1&checkout=success',
      <Route path="/t/:slug/admin/network/messages/:id" element={<AdminNetworkThread />} />,
    );
    expect(await screen.findByText('Ada Lovelace has refunded this booking.')).toBeTruthy();
    expect(screen.queryByText(/Payment received/)).toBeNull();
  });

  it('explains why it cannot write when the creator blocked the brand', async () => {
    routes['GET /api/t/acme/admin/network/conversations/cnv_1'] = () => [
      200,
      {
        conversation: { id: 'cnv_1', creator: OFFER.creator, blocked: true, canWrite: false, cannotWriteReason: 'conversation_blocked', canBook: false },
        messages: [],
        hasMore: false,
        bookings: [],
      },
    ];
    renderAt('/t/acme/admin/network/messages/cnv_1', <Route path="/t/:slug/admin/network/messages/:id" element={<AdminNetworkThread />} />);
    expect(await screen.findByText('This creator isn’t taking messages from you.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request a booking' })).toBeNull();
  });
});

const REQUEST = {
  id: 'bkr_2',
  conversationId: 'cnv_2',
  proposedBy: 'vendor',
  packageId: 'cpk_1',
  package: { title: 'Deep dive', platform: null, priceAmount: 900, priceIsFrom: true, currency: 'USD' },
  contactName: 'Grace Hopper',
  company: 'New Brand Co',
  website: null,
  brief: 'A deep-dive post about our app, please.',
  budgetNote: null,
  status: 'pending',
  creatorMessage: null,
  createdAt: '2026-10-25T10:00:00Z',
  tracked: false,
  amount: null,
  currency: null,
  amountMinor: null,
  deliverableUrls: [],
  deliveredAt: null,
  completedAt: null,
  paidAt: null,
  refundedMinor: 0,
  disputedAt: null,
};

function creatorThread(booking: Record<string, unknown> = REQUEST, extra: unknown[] = []) {
  return {
    conversation: { id: 'cnv_2', brand: { id: 'vnd_1', name: 'New Brand Co', logoUrl: null }, contactName: 'Grace Hopper', blocked: false, brandActive: true },
    messages: [
      { id: 'cnm_1', author: 'vendor', authorName: 'Grace Hopper', kind: 'text', body: REQUEST.brief, event: null, bookingId: null, createdAt: '2026-10-25T10:00:00Z' },
      { id: 'cnm_2', author: 'vendor', authorName: 'Grace Hopper', kind: 'event', body: null, event: 'requested', bookingId: 'bkr_2', createdAt: '2026-10-25T10:00:01Z' },
      ...extra,
    ],
    hasMore: false,
    bookings: [booking],
  };
}

describe('creator thread', () => {
  it('accepts a request only with Stripe ready, at the creator price', async () => {
    let ready = false;
    routes['GET /api/creator-api/creators/me/conversations/cnv_2'] = () => [200, creatorThread()];
    routes['GET /api/creator-api/creators/me/payments'] = () => [
      200,
      { connected: ready, ready, cardPayments: ready ? 'active' : null, country: 'US', currency: 'USD', checkedAt: null },
    ];
    routes['POST /api/creator-api/creators/me/bookings/bkr_2/accept'] = () => [200, { booking: { ...REQUEST, status: 'awaiting_payment' } }];
    renderAt('/creator/messages/cnv_2', <Route path="/creator/messages/:id" element={<CreatorThreadPage />} />);

    expect(await screen.findByText(/Connect Stripe to accept bookings/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    ready = true;
    renderAt('/creator/messages/cnv_2', <Route path="/creator/messages/:id" element={<CreatorThreadPage />} />);
    const price = await screen.findByLabelText('Your price');
    await waitFor(() => expect(screen.queryByText(/Connect Stripe to accept bookings/)).toBeNull());
    fireEvent.change(price, { target: { value: '1200' } });
    const accept = await screen.findByRole('button', { name: 'Accept at $1,200' });
    await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(accept);
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/bookings/bkr_2/accept'))).toBe(true));
    expect(sent.find((s) => s.url.endsWith('/accept'))!.body).toEqual({ amount: 1200, currency: 'USD' });
  });

  it('the Bookings list opens a booking in Messages, and an older request with no brand can be declined', async () => {
    routes['GET /api/creator-api/creators/me/bookings'] = () => [
      200,
      {
        bookings: [
          { ...REQUEST, id: 'bkr_2', conversationId: 'cnv_2', package: { ...REQUEST.package, title: 'Repost with comment' } },
          { ...REQUEST, id: 'bkr_old', conversationId: null, package: null, contactName: 'Old Requester', company: null },
        ],
      },
    ];
    routes['POST /api/creator-api/creators/me/bookings/bkr_old/decline'] = () => [200, { booking: { ...REQUEST, id: 'bkr_old', status: 'declined' } }];
    const confirm = window.confirm;
    window.confirm = () => true;
    try {
      renderAt(
        '/creator/bookings',
        <>
          <Route path="/creator/bookings" element={<CreatorBookingsPage />} />
          <Route path="/creator/messages/:id" element={<div>thread page</div>} />
        </>,
      );
      expect(await screen.findByText('Repost with comment')).toBeTruthy();
      expect(screen.getByText(/with no brand account behind it/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
      await waitFor(() => expect(sent.some((s) => s.url.endsWith('/bookings/bkr_old/decline'))).toBe(true));
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      expect(await screen.findByText('thread page')).toBeTruthy();
      expect(window.location.pathname).toBe('/creator/messages/cnv_2');
    } finally {
      window.confirm = confirm;
    }
  });

  it('says before accepting that a tracked request shares their name and email, and when a brand tracks one', async () => {
    routes['GET /api/creator-api/creators/me/payments'] = () => [200, { connected: true, ready: true, cardPayments: 'active', country: 'US', currency: 'USD', checkedAt: null }];
    routes['GET /api/creator-api/creators/me/conversations/cnv_2'] = () => [200, creatorThread({ ...REQUEST, tracksOnAccept: true })];
    renderAt('/creator/messages/cnv_2', <Route path="/creator/messages/:id" element={<CreatorThreadPage />} />);
    expect(await screen.findByText(/This request is tracked: accepting makes you New Brand Co’s partner/)).toBeTruthy();
    expect(screen.getByText(/gives New Brand Co your name and email for its partner records/)).toBeTruthy();
    cleanup();

    routes['GET /api/creator-api/creators/me/conversations/cnv_2'] = () => [
      200,
      creatorThread({ ...REQUEST, status: 'awaiting_payment', amount: 1200, currency: 'USD', amountMinor: 120000, tracked: true }, [
        { id: 'cnm_3', author: 'vendor', authorName: null, kind: 'event', body: 'Acme Pro', event: 'tracked', bookingId: 'bkr_2', createdAt: '2026-10-25T11:00:00Z' },
      ]),
    ];
    renderAt('/creator/messages/cnv_2', <Route path="/creator/messages/:id" element={<CreatorThreadPage />} />);
    expect(await screen.findByText(/tracks this booking on Acme Pro: you’re its partner there, and it has your name and email/)).toBeTruthy();
  });
});
