// @vitest-environment jsdom
/**
 * Inviting an OpenPartner creator, or approving one, needs an active plan
 * (the API answers 402 plan_required). Discover creators shows Invite
 * disabled, with a link to Billing, when Billing says the brand has no
 * subscription; Enterprise, self-host and a subscribed brand invite as
 * before. The 402 itself still reads plainly, in the invite dialog and on
 * Requests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminNetworkCreators } from '../pages/admin/NetworkCreators.js';
import { AdminNetworkRequests } from '../pages/admin/NetworkRequests.js';

const MEMBER = {
  id: 'crt_1',
  name: 'Member Mo',
  handle: 'mo',
  avatarUrl: null,
  bio: null,
  categories: [],
  audienceLocations: [],
  audienceAgeRange: null,
  pastBrands: [],
  clicks90d: 0,
  conversions90d: 0,
  revenue90d: '0',
  commission90d: '0',
  topCategories: [],
  lastAggregatedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  platforms: [],
  totalReach: 0,
  invitations: [],
};

const REQUEST = {
  id: 'req_1',
  status: 'pending',
  message: null,
  preferredSlug: null,
  createdAt: '2026-11-01T00:00:00Z',
  creatorId: 'crt_1',
  creatorEmail: 'mo@example.com',
  creatorName: 'Member Mo',
  creatorHandle: 'mo',
  creatorBio: null,
  offeringId: 'off_pro',
  offeringTitle: 'Acme Pro',
};

/** The trial gate's 402 (apps/api middleware/trial-gate.ts). */
const PLAN_REQUIRED = {
  status: 402,
  body: { error: 'plan_required', detail: 'Pick a plan (RevShare or Flex) at /admin/billing to start onboarding partners.', plan: 'flex', trialEndsAt: null },
};

/** GET /billing/status; null answers 500. */
let billing: unknown;
let gated: { status: number; body: unknown };
let posts: string[] = [];

beforeEach(() => {
  billing = { mode: 'flat', plan: 'flex', subscribed: true, status: 'active' };
  gated = PLAN_REQUIRED;
  posts = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let res: { status: number; body: unknown };
    if (method === 'POST') {
      posts.push(url);
      res = gated;
    } else if (url.includes('/billing/status')) {
      res = billing === null ? { status: 500, body: { error: 'stripe_unavailable' } } : { status: 200, body: billing };
    } else if (url.includes('/indexed-creators')) {
      res = { status: 200, body: { creators: [], nextCursor: null, total: 0 } };
    } else if (url.includes('/admin/network/offerings')) {
      res = { status: 200, body: { offerings: [{ id: 'off_pro', title: 'Acme Pro', published: true }] } };
    } else if (url.includes('/admin/network/requests')) {
      res = { status: 200, body: { requests: [REQUEST] } };
    } else {
      res = { status: 200, body: { creators: [MEMBER] } };
    }
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

let qc: QueryClient;

function renderAt(path: string, element: React.ReactNode) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/t/acme${path}`]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="*" element={element} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** Billing's answer is in (or failed): nothing on the page shows it when
 *  the brand may invite. */
const billingSettled = () =>
  waitFor(() => expect(['success', 'error']).toContain(qc.getQueryState(['billing-status'])?.status));

const inviteButton = () => screen.getByRole('button', { name: 'Invite' }) as HTMLButtonElement;
const planLink = () => screen.queryByRole('link', { name: 'Activate your plan to invite' });

describe('Discover creators → Invite', () => {
  it('is disabled, with a link to Billing, when the brand has no plan', async () => {
    billing = { mode: 'flat', plan: 'flex', subscribed: false, inTrial: true, trialEndsAt: '2026-11-20T00:00:00Z' };
    renderAt('/admin/network/creators', <AdminNetworkCreators />);
    await screen.findByText('Member Mo');
    const link = await screen.findByRole('link', { name: 'Activate your plan to invite' });
    expect(link.getAttribute('href')).toBe('/t/acme/admin/billing');
    expect(inviteButton().disabled).toBe(true);
    fireEvent.click(inviteButton());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts).toEqual([]);
  });

  it('is disabled for a RevShare brand that never checked out', async () => {
    billing = { mode: 'revshare', plan: 'revshare', subscribed: false, status: null };
    renderAt('/admin/network/creators', <AdminNetworkCreators />);
    await screen.findByText('Member Mo');
    await waitFor(() => expect(inviteButton().disabled).toBe(true));
  });

  it.each([
    ['a subscribed brand', { mode: 'flat', plan: 'flex', subscribed: true, status: 'active' }],
    ['Enterprise', { mode: 'flat', plan: 'enterprise', enterprise: true, fee: null }],
    ['self-host', { mode: 'selfhost', plan: null, billed: false }],
  ])('stays open for %s', async (_name, status) => {
    billing = status;
    renderAt('/admin/network/creators', <AdminNetworkCreators />);
    await screen.findByText('Member Mo');
    await billingSettled();
    expect(planLink()).toBeNull();
    expect(inviteButton().disabled).toBe(false);
    fireEvent.click(inviteButton());
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('stays open when Billing can’t be read, and leaves the check to the API', async () => {
    billing = null;
    renderAt('/admin/network/creators', <AdminNetworkCreators />);
    await screen.findByText('Member Mo');
    await billingSettled();
    expect(qc.getQueryState(['billing-status'])?.status).toBe('error');
    expect(planLink()).toBeNull();
    expect(inviteButton().disabled).toBe(false);
  });

  it('says so plainly when the API answers plan_required', async () => {
    renderAt('/admin/network/creators', <AdminNetworkCreators />);
    await screen.findByText('Member Mo');
    fireEvent.click(inviteButton());
    const send = await screen.findByRole('button', { name: 'Send invitation' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    expect(await screen.findByText('Activate your plan on Billing to invite creators.')).toBeTruthy();
    expect(screen.queryByText(/Pick a plan/)).toBeNull();
    expect(posts).toEqual(['/api/admin/network/offerings/off_pro/invite-creator']);
  });
});

describe('Requests → Approve', () => {
  it('links to Billing instead of the raw detail when approving needs a plan', async () => {
    renderAt('/admin/network/requests', <AdminNetworkRequests />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve + provision' }));
    const link = await screen.findByRole('link', { name: 'Activate your plan to approve' });
    expect(link.getAttribute('href')).toBe('/t/acme/admin/billing');
    expect(screen.queryByText(/Pick a plan/)).toBeNull();
  });

  it('still shows other approve errors as before', async () => {
    gated = { status: 409, body: { error: 'network_call_failed', detail: '{"error":"partner_revoked"}' } };
    renderAt('/admin/network/requests', <AdminNetworkRequests />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve + provision' }));
    expect(await screen.findByText(/You revoked this creator as a partner/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Activate your plan to approve' })).toBeNull();
  });
});
