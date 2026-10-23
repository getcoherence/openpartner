// @vitest-environment jsdom
/**
 * The creator program page's Events and Customers tabs, fed by the
 * Network (GET /creators/me/partnerships/:id/events and /referrals):
 *   - an event names the brand's stage and the customer's referralId, never
 *     a user ID, even from a Network that still sends one;
 *   - the type filter is the brand's stages, in its order;
 *   - Customers is the brand's referral timeline: "Referral #n" with its
 *     stages, paged with the brand's cursor;
 *   - a brand whose instance predates referral timelines says so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorProgramDetailPage } from '../pages/creator/CreatorProgramDetail.js';
import type { Referral } from '../pages/Referrals.js';

const BASE = '/api/creator-api/creators/me/partnerships';

let requests: Array<{ path: string; search: string }> = [];
/** Per-test answers, keyed by path under /api/creator-api. */
let routes: Record<string, (search: URLSearchParams) => Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const STAGES = [
  { eventType: 'signup', label: 'Signed up' },
  { eventType: 'demo_booked', label: 'Demo booked' },
  { eventType: 'invoice_paid', label: 'Paid' },
];

function event(n: number, type: string, label: string | undefined, referralId: string | null) {
  return {
    attributionId: `att_${n}`,
    weight: 1,
    model: 'last_click_60d',
    eventId: `evt_${n}`,
    type,
    label,
    value: type === 'invoice_paid' ? 49 : null,
    currency: type === 'invoice_paid' ? 'USD' : null,
    ts: '2026-10-20T10:00:00.000Z',
    referralId,
    click: { id: `clk_${n}`, linkKey: 'ada', referer: null, landingUrl: null, ts: null },
  };
}

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

beforeEach(() => {
  requests = [];
  routes = {
    '/creators/me/partnerships': () =>
      json(200, {
        partnerships: [
          {
            id: 'pt_ada',
            vendorId: 'ven_1',
            offeringId: 'off_1',
            creatorSlug: 'notewise',
            publicShareUrl: 'https://notewise.test/r/ada',
            status: 'active',
            createdAt: '2026-09-01T00:00:00.000Z',
            vendorName: 'Notewise',
            offeringTitle: 'Notewise Pro',
            shareUrl: 'https://notewise.test/r/ada',
            customDomain: null,
            coupons: [],
          },
        ],
      }),
    '/creators/me/partnerships/pt_ada/brand-info': () =>
      json(200, {
        brand: { displayName: null, logoUrl: null, brandColor: null, programTermsUrl: null, supportEmail: null },
        assets: [],
      }),
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://portal.test');
    requests.push({ path: url.pathname, search: url.search });
    const handler = routes[url.pathname.replace(/^\/api\/creator-api/, '')];
    return handler ? handler(url.searchParams) : json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderTab(tab: 'events' | 'customers') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/creator/programs/pt_ada/${tab}`]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/creator/programs/:partnershipId/*" element={<CreatorProgramDetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('creator Events tab', () => {
  it("names each event's stage and referral, never a user ID", async () => {
    routes['/creators/me/partnerships/pt_ada/events'] = (q) => {
      const type = q.get('type');
      const events = [
        event(1, 'invoice_paid', 'Paid', 'ref_111111111111'),
        event(2, 'demo_booked', 'Demo booked', 'ref_222222222222'),
      ].filter((e) => !type || e.type === type);
      // A user ID the Network should never send: the page mustn't show it either.
      return json(200, { stages: STAGES, events: events.map((e) => ({ ...e, userId: 'usr_secret_1' })), limit: 100, offset: 0, nextOffset: null });
    };
    const page = renderTab('events');
    await waitFor(() => expect(page.getByText('referral ref_111111111111')).toBeTruthy());
    expect(page.getByText('referral ref_222222222222')).toBeTruthy();
    expect(page.queryByText(/usr_/)).toBeNull();
    expect(page.container.textContent).not.toContain('usr_');

    // The filter chips are the brand's stages, in its order, labelled its way.
    const chips = page.getAllByRole('button').map((b) => b.textContent);
    expect(chips).toEqual(expect.arrayContaining(['All', 'Signed up', 'Demo booked', 'Paid']));
    expect(chips.indexOf('Signed up')).toBeLessThan(chips.indexOf('Demo booked'));
    expect(chips.indexOf('Demo booked')).toBeLessThan(chips.indexOf('Paid'));

    fireEvent.click(page.getByRole('button', { name: 'Demo booked' }));
    await waitFor(() => expect(page.queryByText('referral ref_111111111111')).toBeNull());
    expect(requests.at(-1)!.search).toContain('type=demo_booked');
  });

  it('loads more with the Network cursor', async () => {
    routes['/creators/me/partnerships/pt_ada/events'] = (q) =>
      q.get('cursor') === 'c2'
        ? json(200, { stages: STAGES, events: [event(2, 'signup', 'Signed up', 'ref_222222222222')], limit: 100, nextCursor: null })
        : json(200, { stages: STAGES, events: [event(1, 'invoice_paid', 'Paid', 'ref_111111111111')], limit: 100, nextCursor: 'c2' });
    const page = renderTab('events');
    await page.findByText('referral ref_111111111111');
    fireEvent.click(page.getByRole('button', { name: 'Load 100 more' }));
    await page.findByText('referral ref_222222222222');
    expect(page.getByText('referral ref_111111111111')).toBeTruthy();
    expect(page.queryByRole('button', { name: /Load 100 more/ })).toBeNull();
    const eventCalls = requests.filter((r) => r.path === `${BASE}/pt_ada/events`);
    expect(eventCalls.map((r) => new URLSearchParams(r.search).get('cursor'))).toEqual([null, 'c2']);
  });

  it('shows an event without a customer id when the brand has none to give', async () => {
    routes['/creators/me/partnerships/pt_ada/events'] = () =>
      json(200, { stages: STAGES, events: [event(1, 'signup', 'Signed up', null)], limit: 100, offset: 0, nextOffset: null });
    const page = renderTab('events');
    await waitFor(() => expect(page.getAllByText('Signed up').length).toBeGreaterThan(1));
    expect(page.queryByText(/^referral /)).toBeNull();
  });

  it('a Network from before stage filtering: type words, still no user ID', async () => {
    routes['/creators/me/partnerships/pt_ada/events'] = () =>
      json(200, {
        events: [{ ...event(1, 'trial_started', undefined, undefined as unknown as null), userId: 'usr_secret_1' }],
        limit: 100,
        offset: 0,
      });
    const page = renderTab('events');
    await waitFor(() => expect(page.getAllByText('Trial started').length).toBeGreaterThan(0));
    expect(page.container.textContent).not.toContain('usr_');
  });
});

describe('creator Customers tab', () => {
  it("is the brand's referral timeline, paged with its cursor", async () => {
    routes['/creators/me/partnerships/pt_ada/referrals'] = (q) =>
      q.get('cursor') === 'enc_next'
        ? json(200, {
            available: true,
            stages: STAGES,
            currency: 'USD',
            referrals: [referral({ referralId: 'ref_111111111111', number: 1, label: 'Referral #1' })],
            total: 2,
            nextCursor: null,
          })
        : json(200, {
            available: true,
            stages: STAGES,
            currency: 'USD',
            referrals: [
              referral({
                referralId: 'ref_222222222222',
                number: 2,
                label: 'Referral #2',
                stages: [
                  { eventType: 'signup', label: 'Signed up', firstAt: '2026-09-02T10:00:00.000Z', lastAt: '2026-09-02T10:00:00.000Z', count: 1, reversed: false },
                ],
                latestStage: { eventType: 'signup', label: 'Signed up', at: '2026-09-02T10:00:00.000Z' },
                commission: 25,
                commissionByCurrency: { USD: 25 },
              }),
            ],
            total: 2,
            // A real page holds 50; this one says there's more anyway.
            nextCursor: 'enc_next',
          });
    const page = renderTab('customers');
    const card = await page.findByRole('article', { name: 'Referral #2' });
    expect(within(card).getByText('$25.00')).toBeTruthy();
    // The id the Events tab names this customer by.
    expect(within(card).getByText('referral ref_222222222222')).toBeTruthy();
    expect(within(card).getByRole('list', { name: 'Stages' }).querySelectorAll('li[data-state="reached"]')).toHaveLength(1);
    expect(page.getByText('2 referrals')).toBeTruthy();

    fireEvent.click(page.getByRole('button', { name: /Load 50 more/ }));
    await page.findByRole('article', { name: 'Referral #1' });
    const referralCalls = requests.filter((r) => r.path === `${BASE}/pt_ada/referrals`);
    expect(referralCalls.map((r) => new URLSearchParams(r.search).get('cursor'))).toEqual([null, 'enc_next']);
    // The old per-customer relay is never called.
    expect(requests.some((r) => r.path.endsWith('/customers'))).toBe(false);
  });

  it('says when the brand has no referral timeline yet', async () => {
    routes['/creators/me/partnerships/pt_ada/referrals'] = () =>
      json(200, { available: false, stages: [], currency: null, referrals: [], total: 0, nextCursor: null });
    const page = renderTab('customers');
    await page.findByText("Referral details aren't available yet");
    expect(page.queryByText('No referrals yet')).toBeNull();
  });

  it('a Network from before referral relays reads as not available yet, not an error', async () => {
    // No route registered: the fetch mock answers 404 not_found, as an old Network would.
    const page = renderTab('customers');
    await page.findByText("Referral details aren't available yet");
    expect(page.queryByText(/not_found|404/)).toBeNull();
  });

  it('with no referrals yet, says how they appear', async () => {
    routes['/creators/me/partnerships/pt_ada/referrals'] = () =>
      json(200, { available: true, stages: STAGES, currency: 'USD', referrals: [], total: 0, nextCursor: null });
    const page = renderTab('customers');
    await page.findByText('No referrals yet');
  });
});
