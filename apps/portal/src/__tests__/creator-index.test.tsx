// @vitest-environment jsdom
/**
 * The creator index in the portal (openpartner-network
 * docs/creator-index.md §4.4, §5.3): the "Not on OpenPartner yet" tab shows
 * listed creators with the badge and an invite that needs a real message;
 * brands on other plans see what the plan unlocks; creators who already do
 * partnerships are marked and can be shown alone; the claim page shows who
 * is waiting and what we hold, and sends an existing account to sign in; the
 * ops console picks where to search and whether to keep only creators who
 * take partnerships.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IndexedCreatorsSection } from '../pages/admin/NetworkIndexedCreators.js';
import { CreatorIndexClaimPage } from '../pages/creator/CreatorIndexClaim.js';
import { CreatorIndexPage } from '../pages/platform/CreatorIndex.js';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}
let calls: Recorded[] = [];
let respond: (url: string, method: string) => { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const { status, body } = respond(url, method);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(ui: React.ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const JO = {
  kind: 'indexed',
  id: 'ixc_jo',
  name: 'Jo Rivera',
  avatarUrl: null,
  headline: 'I write about outbound sales',
  country: 'US',
  categories: ['sales'],
  topics: ['outbound', 'cold email'],
  platforms: [{ platform: 'linkedin', handle: 'jorivera', profileUrl: 'https://www.linkedin.com/in/jorivera', followerCount: 12000, postsLast30d: 8, avgReactions: 100 }],
  totalReach: 12000,
  invitable: true,
  invite: null,
  refreshedAt: null,
};

describe('Not on OpenPartner yet', () => {
  it('lists creators with the badge and invites with a real message', async () => {
    respond = (url, method) =>
      method === 'POST'
        ? { status: 201, body: { invite: { id: 'cinv_1', status: 'held' } } }
        : { status: 200, body: { creators: [JO], nextCursor: null, total: 1 } };
    wrap(<IndexedCreatorsSection />);
    expect(await screen.findByText('Jo Rivera')).toBeTruthy();
    expect(screen.getByText('Not on OpenPartner yet')).toBeTruthy();
    expect(screen.getByText('1 creator not on OpenPartner yet')).toBeTruthy();
    expect(calls[0]!.url).toBe('/api/admin/network/indexed-creators?');

    fireEvent.click(screen.getByText('Invite to collaborate'));
    const send = screen.getByText('Send invite') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/Who you are/), { target: { value: 'Hi Jo, we would love to sponsor a post on outbound.' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(await screen.findByText(/Invited\. We.ll tell you when they join\./)).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/admin/network/creator-invites');
    expect(post.body).toEqual({ indexedCreatorId: 'ixc_jo', message: 'Hi Jo, we would love to sponsor a post on outbound.' });
  });

  it('says what the plan unlocks instead of an error on other plans', async () => {
    respond = () => ({ status: 402, body: { error: 'plan_required', detail: 'Creators not on OpenPartner yet come with the Flex and Enterprise plans.' } });
    wrap(<IndexedCreatorsSection />);
    expect(await screen.findByText(/Search creators who aren.t on OpenPartner yet/)).toBeTruthy();
    expect(screen.getByText('See plans')).toBeTruthy();
  });

  it('shows an invite already sent, and a creator who can’t be invited', async () => {
    respond = () => ({
      status: 200,
      body: {
        creators: [
          { ...JO, id: 'a', name: 'Sent One', invitable: false, invite: { id: 'i', status: 'sent', createdAt: '2026-10-30T00:00:00Z' } },
          { ...JO, id: 'b', name: 'Nope', invitable: false },
        ],
        nextCursor: null,
        total: 2,
      },
    });
    wrap(<IndexedCreatorsSection />);
    expect(await screen.findByText('Invited. We emailed them.')).toBeTruthy();
    expect(screen.getByText(/Can.t be invited yet/)).toBeTruthy();
    expect(screen.queryByText('Invite to collaborate')).toBeNull();
  });

  it('marks creators who already do partnerships, says why, and can show only them', async () => {
    const open = {
      ...JO,
      openToPartnerships: true,
      partnershipSignals: [
        { kind: 'storefront', count: 3 },
        { kind: 'sponsored_posts', count: 1 },
      ],
    };
    respond = () => ({ status: 200, body: { creators: [open, { ...JO, id: 'b', name: 'Quiet One' }], nextCursor: null, total: 2 } });
    wrap(<IndexedCreatorsSection />);
    expect(await screen.findByText('Sells sponsorships (3 past collaborations) · 1 sponsored post lately')).toBeTruthy();
    expect(screen.getAllByText('Open to partnerships')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Only creators who already do brand partnerships'));
    await waitFor(() => expect(calls[calls.length - 1]!.url).toBe('/api/admin/network/indexed-creators?openToPartnerships=1'));
  });
});

describe('ops console: creator index settings', () => {
  const SETTINGS = {
    enabled: true,
    invitesEnabled: false,
    monthlyBudgetUsd: 10,
    minFollowers: 3000,
    minPostsPer30d: 4,
    refreshDays: 30,
    excludedCountries: ['DE'],
    hiddenRegions: ['US-CA'],
    seedQueries: ['B2B sales newsletters'],
    classifierModel: 'gpt-6-luna',
  };

  it('chooses where queries are searched and whether only partnership-ready creators are kept, and shows ops the evidence', async () => {
    respond = (url, method) => {
      if (url.endsWith('/creator-index/settings') && method === 'PUT') return { status: 200, body: { settings: calls[calls.length - 1]!.body, visibilityChanged: 0 } };
      if (url.endsWith('/creator-index/settings')) {
        // A Network that predates the discovery settings: the page shows their defaults.
        return { status: 200, body: { settings: SETTINGS, defaults: SETTINGS, classifierModels: ['gpt-6-luna'], updatedAt: null, updatedByEmail: null, configured: {} } };
      }
      if (url.endsWith('/creator-index/stats')) {
        return {
          status: 200,
          body: {
            creators: { byStatus: {}, listed: 4, shownToBrands: 4, hiddenFromBrands: 0, openToPartnerships: 3 },
            byCountry: [],
            candidates: {},
            rejections: {},
            invites: {},
            emailsSent30d: 0,
            suppressions: {},
            spend: { thisMonthUsd: 0, budgetUsd: 10 },
          },
        };
      }
      return {
        status: 200,
        body: {
          creators: [
            {
              id: 'ixc_1',
              status: 'active',
              name: 'Jo Rivera',
              headline: null,
              country: 'US',
              region: 'US-TX',
              brandVisible: true,
              totalReach: 12000,
              contact: null,
              emailsSent: 0,
              platforms: [],
              partnershipSignals: [{ kind: 'storefront', count: 0, evidence: 'https://www.example-storefront.test/jo' }],
            },
          ],
        },
      };
    };
    wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
    expect(await screen.findByText('3 open to partnerships')).toBeTruthy();
    expect((screen.getByLabelText('Sponsorship storefronts') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Anyone who posts about the topic') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Anyone who posts about the topic'));
    fireEvent.click(screen.getByLabelText(/Only index creators who already take partnerships/));
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
      discoverySources: { storefronts: true, sponsorPages: true, people: true },
      requirePartnershipSignal: false,
    });
    // Ops see where a signal was read; brands never do.
    expect(await screen.findByText('example-storefront.test/jo')).toBeTruthy();
  });
});

describe('claim page', () => {
  const PREVIEW = {
    creator: {
      name: 'Jo Rivera',
      headline: 'Outbound',
      avatarUrl: null,
      email: 'partnerships@jo.co',
      emailFoundOn: 'https://jo.co/contact',
      firstSeenAt: '2026-10-01T00:00:00Z',
      platforms: [{ platform: 'linkedin', handle: 'jorivera', profileUrl: 'https://www.linkedin.com/in/jorivera', followerCount: 12000 }],
    },
    invites: [
      { brand: 'Acme', logoUrl: null, preview: 'We would love to sponsor you.' },
      { brand: 'Globex', logoUrl: null, preview: 'Hello from Globex.' },
    ],
    expiresAt: '2026-11-30T00:00:00Z',
  };

  function page() {
    return wrap(
      <Routes>
        <Route path="/creator/claim" element={<CreatorIndexClaimPage />} />
        <Route path="/creator/messages/:id" element={<div>thread page</div>} />
      </Routes>,
      '/creator/claim?token=tok_123',
    );
  }

  it('shows who is waiting and what we hold, and claims on a click', async () => {
    respond = (url) =>
      url.endsWith('/claim/preview')
        ? { status: 200, body: PREVIEW }
        : { status: 200, body: { ok: true, creatorId: 'crt_1', created: true, conversationIds: ['cnv_1', 'cnv_2'] } };
    page();
    expect(await screen.findByText('2 brands want to work with you')).toBeTruthy();
    expect(screen.getByText(/found partnerships@jo\.co on https:\/\/jo\.co\/contact/)).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual(['/api/creator-api/creator-index/claim/preview']);
    fireEvent.click(screen.getByText('Claim my profile and read'));
    expect(await screen.findByText('thread page')).toBeTruthy();
    expect(calls[1]).toMatchObject({ url: '/api/creator-api/creator-index/claim', method: 'POST', body: { token: 'tok_123' } });
  });

  it('sends an existing account to sign in', async () => {
    respond = (url) =>
      url.endsWith('/claim/preview')
        ? { status: 200, body: PREVIEW }
        : { status: 409, body: { error: 'sign_in_required', email: 'partnerships@jo.co' } };
    page();
    fireEvent.click(await screen.findByText('Claim my profile and read'));
    await waitFor(() => expect(screen.getByText(/You already have an OpenPartner account at partnerships@jo\.co/)).toBeTruthy());
    expect(screen.getByText('Sign in')).toBeTruthy();
  });

  it('tells the creator why brands see them as open to partnerships, and where we read it', async () => {
    respond = () => ({
      status: 200,
      body: {
        ...PREVIEW,
        creator: {
          ...PREVIEW.creator,
          partnershipSignals: [
            { kind: 'sponsor_page', count: null, evidence: 'https://jo.co/sponsor' },
            { kind: 'sponsored_posts', count: 2, evidence: 'https://www.linkedin.com/in/jorivera' },
          ],
        },
      },
    });
    page();
    expect(await screen.findByText(/We show brands that you take partnerships, from/)).toBeTruthy();
    expect(screen.getByText(/your sponsor page/)).toBeTruthy();
    expect(screen.getByText(/2 recent posts marked as sponsored/)).toBeTruthy();
    expect(screen.getByText('jo.co/sponsor').getAttribute('href')).toBe('https://jo.co/sponsor');
  });

  it('explains an expired link', async () => {
    respond = () => ({ status: 404, body: { error: 'invalid_or_expired' } });
    page();
    expect(await screen.findByText(/This link has expired or isn.t valid/)).toBeTruthy();
  });
});
