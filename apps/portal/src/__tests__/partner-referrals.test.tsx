// @vitest-environment jsdom
/**
 * The Referrals page (GET /partners/:id/referrals) and the brand's
 * Referral stages setting:
 *   - a partner sees each referral as "Referral #n" (or the brand's label),
 *     with the brand's stages in order: reached with a date, not yet, or
 *     reversed; never a user ID;
 *   - "Load more" pages with the cursor;
 *   - an admin gets the same view for one partner, plus each user ID;
 *   - Settings → Referral stages saves the stages in the order shown and
 *     turns customer labels on by itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { AdminPartnerReferrals, ReferralsPage, type Referral, type ReferralPage } from '../pages/Referrals.js';
import { ReferralStagesSection } from '../pages/admin/ReferralStagesSection.js';

let requests: Array<{ method: string; path: string; search: string; body: unknown }> = [];
let settings = {
  stages: [
    { eventType: 'demo_booked', label: 'Demo booked' },
    { eventType: 'deal_won', label: 'Deal won' },
  ],
  showCustomerLabels: false,
  defaultStages: [{ eventType: 'signup', label: 'Signed up' }],
  recentEventTypes: ['deal_won', 'lead_created', 'invoice_paid'],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const STAGES = [
  { eventType: 'demo_booked', label: 'Demo booked' },
  { eventType: 'deal_won', label: 'Deal won' },
  { eventType: 'invoice_paid', label: 'Paid' },
];

function referral(over: Partial<Referral>): Referral {
  return {
    referralId: 'ref_aaaaaaaaaaaa',
    number: 1,
    label: 'Referral #1',
    customerLabel: null,
    referredAt: '2026-09-01T10:00:00.000Z',
    stages: [],
    latestStage: null,
    commission: 0,
    commissionByCurrency: {},
    ...over,
  };
}

const FIRST_PAGE: ReferralPage = {
  partnerId: 'p_ada',
  stages: STAGES,
  currency: 'INR',
  total: 3,
  nextCursor: 'cursor_2',
  referrals: [
    referral({
      referralId: 'ref_acme0000000',
      number: 3,
      label: 'Acme Trading Co',
      customerLabel: 'Acme Trading Co',
      userId: 'u-acme-123',
      stages: [
        { eventType: 'demo_booked', label: 'Demo booked', firstAt: '2026-09-03T10:00:00.000Z', lastAt: '2026-09-03T10:00:00.000Z', count: 1, reversed: false },
        { eventType: 'deal_won', label: 'Deal won', firstAt: '2026-09-10T10:00:00.000Z', lastAt: '2026-09-10T10:00:00.000Z', count: 1, reversed: true },
        { eventType: 'invoice_paid', label: 'Paid', firstAt: '2026-09-12T10:00:00.000Z', lastAt: '2026-10-12T10:00:00.000Z', count: 2, reversed: false },
      ],
      latestStage: { eventType: 'invoice_paid', label: 'Paid', at: '2026-09-12T10:00:00.000Z' },
      commission: 1500,
      commissionByCurrency: { INR: 1500 },
    }),
    referral({
      referralId: 'ref_lead000000a',
      number: 2,
      label: 'Referral #2',
      userId: 'u-lead-456',
      stages: [
        { eventType: 'demo_booked', label: 'Demo booked', firstAt: '2026-09-20T10:00:00.000Z', lastAt: '2026-09-20T10:00:00.000Z', count: 1, reversed: false },
      ],
      latestStage: { eventType: 'demo_booked', label: 'Demo booked', at: '2026-09-20T10:00:00.000Z' },
    }),
  ],
};

const SECOND_PAGE: ReferralPage = {
  ...FIRST_PAGE,
  nextCursor: null,
  referrals: [referral({ referralId: 'ref_first00000a', number: 1, label: 'Referral #1', userId: 'u-first-789' })],
};

/** What a partner gets: the same rows with no userId. */
function asPartner(page: ReferralPage): ReferralPage {
  return { ...page, referrals: page.referrals.map(({ userId: _userId, ...r }) => r) };
}

let viewer: 'partner' | 'admin' = 'partner';
/** Set to hold POST /config/referrals until the test releases it. */
let holdSave: Promise<void> | null = null;

beforeEach(() => {
  requests = [];
  viewer = 'partner';
  holdSave = null;
  settings = {
    stages: [
      { eventType: 'demo_booked', label: 'Demo booked' },
      { eventType: 'deal_won', label: 'Deal won' },
    ],
    showCustomerLabels: false,
    defaultStages: [{ eventType: 'signup', label: 'Signed up' }],
    recentEventTypes: ['deal_won', 'lead_created', 'invoice_paid'],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, search: url.search, body });
    if (path === '/partners/p_ada/referrals') {
      const page = url.searchParams.get('cursor') === 'cursor_2' ? SECOND_PAGE : FIRST_PAGE;
      return json(200, viewer === 'admin' ? page : asPartner(page));
    }
    if (path === '/partners/p_ada') return json(200, { id: 'p_ada', name: 'Ada Lovelace', revokedAt: '2026-10-01T00:00:00.000Z' });
    if (path === '/config/referrals' && method === 'GET') return json(200, settings);
    if (path === '/config/referrals' && method === 'POST') {
      if (holdSave) await holdSave;
      settings = { ...settings, ...(body as object) };
      return json(200, settings);
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => cleanup());

function renderAt(ui: ReactElement, path: string, routePath = path) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path={routePath} element={ui} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const partnerPrincipal = { role: 'partner' as const, partnerId: 'p_ada' };

describe('partner Referrals page', () => {
  it("shows each referral's stages in the brand's order, and never a user ID", async () => {
    const page = renderAt(<ReferralsPage principal={partnerPrincipal} />, '/referrals');
    const acme = await page.findByRole('article', { name: 'Acme Trading Co' });
    expect(page.getByText('3 referrals')).toBeTruthy();

    // The brand's three stages, each in its state.
    const steps = within(acme).getAllByRole('listitem');
    expect(steps.map((li) => li.getAttribute('data-state'))).toEqual(['reached', 'reversed', 'reached']);
    expect(steps[0]!.getAttribute('aria-label')).toBe('Demo booked: Sep 3, 2026');
    expect(steps[1]!.getAttribute('aria-label')).toBe('Deal won: Sep 10, 2026, reversed');
    expect(within(steps[1]!).getByText('reversed')).toBeTruthy();
    expect(within(steps[2]!).getByText('×2')).toBeTruthy();
    expect(within(acme).getByText('₹1,500.00')).toBeTruthy();
    expect(within(acme).getByText(/Referral #3 · Paid/)).toBeTruthy();

    // A referral that's only booked a demo: the later stages read "Not yet".
    const lead = within(page.getByRole('article', { name: 'Referral #2' }));
    expect(lead.getAllByRole('listitem').map((li) => li.getAttribute('data-state'))).toEqual(['reached', 'pending', 'pending']);
    expect(lead.getAllByText('Not yet')).toHaveLength(2);
    expect(lead.getByText('₹0.00')).toBeTruthy();

    expect(page.container.textContent).not.toMatch(/u-acme|u-lead|User ID/);
    expect(requests.find((r) => r.path === '/partners/p_ada/referrals')?.search).toBe('?limit=50');
  });

  it('loads the next page with the cursor', async () => {
    const page = renderAt(<ReferralsPage principal={partnerPrincipal} />, '/referrals');
    fireEvent.click(await page.findByRole('button', { name: 'Load 50 more' }));
    expect(await page.findByText('Referral #1')).toBeTruthy();
    expect(page.getByText('Acme Trading Co')).toBeTruthy();
    expect(requests.filter((r) => r.path === '/partners/p_ada/referrals').map((r) => r.search)).toEqual([
      '?limit=50',
      '?limit=50&cursor=cursor_2',
    ]);
    expect(page.queryByRole('button', { name: 'Load 50 more' })).toBeNull();
  });

  it('says so when there are no referrals yet', async () => {
    globalThis.fetch = (async () => json(200, { ...FIRST_PAGE, referrals: [], total: 0, nextCursor: null })) as typeof fetch;
    const page = renderAt(<ReferralsPage principal={partnerPrincipal} />, '/referrals');
    expect(await page.findByText('No referrals yet')).toBeTruthy();
  });
});

describe('admin view of a partner’s referrals', () => {
  it('shows what the partner sees, plus each user ID, and says the partner is revoked', async () => {
    viewer = 'admin';
    const page = renderAt(<AdminPartnerReferrals />, '/admin/partners/p_ada/referrals', '/admin/partners/:id/referrals');
    expect(await page.findByText('Referrals · Ada Lovelace')).toBeTruthy();
    expect(await page.findByText('u-acme-123')).toBeTruthy();
    expect(page.getByText('u-lead-456')).toBeTruthy();
    expect(page.getByText(/This partner is revoked/)).toBeTruthy();
    expect(page.getByRole('link', { name: 'Settings → Referral stages' })).toBeTruthy();
  });
});

describe('Settings → Referral stages', () => {
  it('adds, orders and saves the stages partners see', async () => {
    const page = renderAt(<ReferralStagesSection />, '/admin/settings');
    expect(await page.findByDisplayValue('Demo booked')).toBeTruthy();
    // Suggestions leave out what's already a stage.
    expect(page.getByText('Recently recorded: lead_created, invoice_paid')).toBeTruthy();

    fireEvent.change(page.getByPlaceholderText('demo_booked'), { target: { value: 'invoice_paid' } });
    fireEvent.change(page.getByPlaceholderText('Invoice paid'), { target: { value: 'Paid' } });
    fireEvent.click(page.getByRole('button', { name: 'Add stage' }));
    fireEvent.click(page.getByRole('button', { name: 'Move Paid up' }));
    fireEvent.change(page.getByLabelText('Label for demo_booked'), { target: { value: 'Demo' } });

    // A correction can't be a stage.
    fireEvent.change(page.getByPlaceholderText('demo_booked'), { target: { value: 'refund' } });
    expect(page.getByText(/can’t be stages/)).toBeTruthy();
    expect((page.getByRole('button', { name: 'Add stage' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(page.getByRole('button', { name: 'Save stages' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      stages: [
        { eventType: 'demo_booked', label: 'Demo' },
        { eventType: 'invoice_paid', label: 'Paid' },
        { eventType: 'deal_won', label: 'Deal won' },
      ],
    });
    expect(await page.findByText('Saved.')).toBeTruthy();
  });

  it('keeps an edit made while a save is in flight', async () => {
    let release!: () => void;
    holdSave = new Promise<void>((resolve) => (release = resolve));
    const page = renderAt(<ReferralStagesSection />, '/admin/settings');
    fireEvent.change(await page.findByLabelText('Label for deal_won'), { target: { value: 'Won' } });
    fireEvent.click(page.getByRole('button', { name: 'Save stages' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
    // Renamed again before the save comes back.
    fireEvent.change(page.getByLabelText('Label for deal_won'), { target: { value: 'Closed' } });
    release();
    expect(await page.findByText('Saved.')).toBeTruthy();
    expect((page.getByLabelText('Label for deal_won') as HTMLInputElement).value).toBe('Closed');
    // Still unsaved, so Save stays available.
    expect(((await page.findByRole('button', { name: 'Save stages' })) as HTMLButtonElement).disabled).toBe(false);
  });

  it('turns customer labels on by itself, off by default', async () => {
    const page = renderAt(<ReferralStagesSection />, '/admin/settings');
    const toggle = (await page.findByRole('checkbox')) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ showCustomerLabels: true }));
    await waitFor(() => expect((page.getByRole('checkbox') as HTMLInputElement).checked).toBe(true));
  });
});
