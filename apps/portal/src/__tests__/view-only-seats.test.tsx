// @vitest-environment jsdom
/**
 * View-only seats (docs/view-only-seats.md) in the portal:
 *
 *   - the sidebar says "View only" and leaves out Export / import;
 *   - Admins shows each seat's role, invites with one, and switches it;
 *     a viewer sees the list without the controls;
 *   - a page of edits hides its actions and disables its controls;
 *   - a booking report reads, without refresh, sharing or share links;
 *   - an edit the API refuses says why.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '../App.js';
import { api, READ_ONLY_MESSAGE, type Principal } from '../api.js';
import { AdminAdmins } from '../pages/admin/Admins.js';
import { AdminNetworkBookingReport } from '../pages/admin/NetworkBookingReport.js';
import { ViewOnlyProvider } from '../lib/viewOnly.js';
import { Button, Input, Page } from '../ui.js';

const VIEWER: Principal = { role: 'admin', source: 'session', admin: { id: 'adm_v', name: 'Vic Viewer', email: 'vic@example.com', role: 'viewer' } };
const ADMIN: Principal = { role: 'admin', source: 'session', admin: { id: 'adm_a', name: 'Ada Admin', email: 'ada@example.com', role: 'admin' } };

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

afterEach(() => cleanup());

function renderAs(principal: Principal, ui: React.ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['program-settings'], { programName: 'Acme Partners', supportEmail: null, logoUrl: null, whiteLabel: false });
  qc.setQueryData(['public-branding', null], { programName: 'Acme Partners', whiteLabel: false, tenantSlug: 'acme' });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <ViewOnlyProvider principal={principal}>{ui}</ViewOnlyProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the sidebar', () => {
  // The Admin section starts collapsed; open it.
  beforeEach(() => window.localStorage.setItem('op:nav-collapsed:admin-admin', '0'));
  afterEach(() => window.localStorage.clear());

  it('says View only and leaves out Export / import', () => {
    renderAs(VIEWER, <Sidebar principal={VIEWER} />);
    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.queryByText('Export / import')).toBeNull();
    expect(screen.getByText('Partners')).toBeTruthy();
  });

  it('is unchanged for a full admin', () => {
    renderAs(ADMIN, <Sidebar principal={ADMIN} />);
    expect(screen.queryByText('View only')).toBeNull();
    expect(screen.getByText('Export / import')).toBeTruthy();
  });
});

const SEATS = [
  { id: 'adm_a', email: 'ada@example.com', name: 'Ada Admin', role: 'admin', activatedAt: '2026-10-01T00:00:00Z', revokedAt: null, lastSignInAt: null, createdAt: '2026-10-01T00:00:00Z' },
  { id: 'adm_b', email: 'bo@example.com', name: 'Bo Admin', role: 'admin', activatedAt: '2026-10-02T00:00:00Z', revokedAt: null, lastSignInAt: null, createdAt: '2026-10-02T00:00:00Z' },
  { id: 'adm_v', email: 'vic@example.com', name: 'Vic Viewer', role: 'viewer', activatedAt: '2026-10-03T00:00:00Z', revokedAt: null, lastSignInAt: null, createdAt: '2026-10-03T00:00:00Z' },
];

describe('Admins', () => {
  beforeEach(() => {
    routes['GET /api/admins'] = () => [200, { admins: SEATS }];
  });

  it('shows roles, and invites with one', async () => {
    routes['GET /api/auth/whoami'] = () => [200, ADMIN];
    routes['POST /api/admins'] = (body) => [201, { ...SEATS[0], id: 'adm_new', ...body }];
    renderAs(ADMIN, <AdminAdmins />);
    await screen.findByText('Vic Viewer');
    expect(screen.getByText('Role')).toBeTruthy();
    expect(screen.getAllByText('View only').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('Invite admin'));
    fireEvent.change(screen.getByPlaceholderText('Taylor Admin'), { target: { value: 'Ivy' } });
    fireEvent.change(screen.getByPlaceholderText('taylor@example.com'), { target: { value: 'ivy@example.com' } });
    fireEvent.change(screen.getByDisplayValue('Admin'), { target: { value: 'viewer' } });
    fireEvent.click(screen.getByText('Send invite'));
    await waitFor(() => expect(sent.find((s) => s.method === 'POST')?.body).toEqual({ name: 'Ivy', email: 'ivy@example.com', role: 'viewer' }));
  });

  it("switches another seat's role, never your own, and says why one is refused", async () => {
    routes['GET /api/auth/whoami'] = () => [200, ADMIN];
    routes['PATCH /api/admins/adm_b'] = () => [409, { error: 'cannot_demote_last_active_admin' }];
    routes['PATCH /api/admins/adm_v'] = () => [200, { ...SEATS[2], role: 'admin' }];
    renderAs(ADMIN, <AdminAdmins />);
    await screen.findByText('Make admin');
    // Ada (signed in) gets no role switch; Bo and Vic do.
    await waitFor(() => expect(screen.getAllByText('Make view only')).toHaveLength(1));

    fireEvent.click(screen.getByText('Make admin'));
    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH' && s.url.endsWith('/admins/adm_v') && s.body?.role === 'admin')).toBe(true));

    fireEvent.click(screen.getByText('Make view only'));
    await screen.findByText('Someone has to stay a full admin.');
  });

  it('shows a viewer the seats without the controls', async () => {
    routes['GET /api/auth/whoami'] = () => [200, VIEWER];
    renderAs(VIEWER, <AdminAdmins />);
    await screen.findByText('Bo Admin');
    expect(screen.queryByText('Invite admin')).toBeNull();
    expect(screen.queryByText('Revoke')).toBeNull();
    expect(screen.queryByText('Make view only')).toBeNull();
    expect(screen.queryByText('Actions')).toBeNull();
  });
});

describe('a page of edits', () => {
  const page = (
    <Page edits title="Webhooks" actions={<Button>New endpoint</Button>}>
      <Input aria-label="URL" />
      <Button>Save</Button>
    </Page>
  );

  it('hides its actions and disables its controls on a view-only seat', () => {
    renderAs(VIEWER, page);
    expect(screen.queryByText('New endpoint')).toBeNull();
    expect((screen.getByLabelText('URL') as HTMLInputElement).matches(':disabled')).toBe(true);
    expect((screen.getByText('Save').closest('button') as HTMLButtonElement).matches(':disabled')).toBe(true);
  });

  it('is untouched for a full admin', () => {
    renderAs(ADMIN, page);
    expect(screen.getByText('New endpoint')).toBeTruthy();
    expect((screen.getByLabelText('URL') as HTMLInputElement).matches(':disabled')).toBe(false);
  });
});

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

describe('a booking report', () => {
  beforeEach(() => {
    routes['GET /api/admin/network/bookings/bkr_1/report'] = () => [200, { report: REPORT }];
    routes['GET /api/admin/network/bookings/bkr_1/report/shares'] = () => [200, { shares: [] }];
  });
  const at = (principal: Principal) =>
    renderAs(
      principal,
      <Routes>
        <Route path="/admin/network/bookings/:id/report" element={<AdminNetworkBookingReport />} />
      </Routes>,
      '/admin/network/bookings/bkr_1/report',
    );

  it('reads for a viewer, without refresh, sharing or share links', async () => {
    at(VIEWER);
    await screen.findByText('Print / Save as PDF');
    expect(screen.queryByText('Refresh')).toBeNull();
    expect(screen.queryByText('Share')).toBeNull();
    expect(screen.queryByText(/may share/)).toBeNull();
    expect(sent.some((s) => s.url.includes('/report/shares'))).toBe(false);
  });

  it('keeps the controls for a full admin', async () => {
    at(ADMIN);
    await screen.findByText('Refresh');
    expect(screen.getByText('Share')).toBeTruthy();
  });
});

describe('a refused edit', () => {
  it('says the seat is view only', async () => {
    routes['POST /api/partners'] = () => [403, { error: 'read_only' }];
    await expect(api('/partners', { method: 'POST', body: {} })).rejects.toThrow(READ_ONLY_MESSAGE);
  });
});
