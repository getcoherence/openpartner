// @vitest-environment jsdom
/**
 * The creator index in the portal (openpartner-network
 * docs/creator-index.md §4.4, §5.3): Discover creators shows OpenPartner's
 * creators, then external creators under the same filters, with the badge
 * and an invite that needs a real message;
 * brands on other plans see what the plan unlocks; creators who already do
 * partnerships are marked and can be shown alone; the claim page shows who
 * is waiting and what we hold, and sends an existing account to sign in, or
 * with no brand waiting, lands them in their account; the ops console picks
 * where to search and whether to keep only creators who take partnerships,
 * and previews and sends the outreach email in batches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IndexedCreatorPage, IndexedCreatorsSection } from '../pages/admin/NetworkIndexedCreators.js';
import { AdminNetworkCreators } from '../pages/admin/NetworkCreators.js';
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

describe('external creators', () => {
  it('lists creators with the badge and invites with a real message', async () => {
    respond = (url, method) =>
      method === 'POST'
        ? { status: 201, body: { invite: { id: 'cinv_1', status: 'held' } } }
        : { status: 200, body: { creators: [JO], nextCursor: null, total: 1 } };
    wrap(<IndexedCreatorsSection />);
    expect(await screen.findByText('Jo Rivera')).toBeTruthy();
    expect(screen.getByText('External creator')).toBeTruthy();
    expect(screen.getByText('1 external creator')).toBeTruthy();
    expect(calls[0]!.url).toBe('/api/admin/network/indexed-creators?');

    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
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
    expect(await screen.findByText('See external creators too')).toBeTruthy();
    expect(screen.getByText('See plans')).toBeTruthy();
  });

  it('shows OpenPartner’s creators first and external ones after, under the same filters, and hides external ones for members-only filters', async () => {
    const MEMBER = {
      id: 'crt_1',
      name: 'Member Mo',
      handle: 'mo',
      avatarUrl: null,
      bio: 'Writes about sales',
      categories: ['marketing'],
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
    };
    respond = (url) =>
      url.includes('/indexed-creators')
        ? { status: 200, body: { creators: [JO], nextCursor: null, total: 1 } }
        : { status: 200, body: { creators: [MEMBER] } };
    wrap(<AdminNetworkCreators />);
    expect(await screen.findByText('Member Mo')).toBeTruthy();
    expect(await screen.findByText('Jo Rivera')).toBeTruthy();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['On OpenPartner', 'External creators']);
    // There are no tabs any more.
    expect(screen.queryByText('Not on OpenPartner yet')).toBeNull();

    // A shared filter reaches both lists; sales is a topic only external creators have.
    fireEvent.click(screen.getByRole('button', { name: 'sales' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/indexed-creators?categories=sales'))).toBe(true));

    // Members-only data (revenue) leaves external creators out, with a word why.
    fireEvent.change(screen.getByPlaceholderText('e.g. 500'), { target: { value: '500' } });
    expect(await screen.findByText(/External creators have no sales, audience-location or verification data yet/)).toBeTruthy();

    // Only external creators.
    fireEvent.click(screen.getByRole('button', { name: 'External creators' }));
    expect(screen.queryByText('Member Mo')).toBeNull();
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
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    // Every card opens the creator's page.
    expect(screen.getAllByText('View details')).toHaveLength(2);
    expect(screen.getByText('Nope').getAttribute('href')).toBe('/admin/network/indexed-creators/b');
  });

  describe('a creator’s page', () => {
    const PROFILE = {
      ...JO,
      openToPartnerships: true,
      partnershipSignals: [{ kind: 'storefront', count: 4 }],
      platforms: [
        {
          ...JO.platforms[0],
          avgComments: 12,
          avgReposts: null,
          topPostUrls: ['https://www.linkedin.com/feed/update/1', 'https://www.linkedin.com/feed/update/2'],
        },
      ],
      summary: 'Writes weekly about outbound sales for SDR teams.',
      productsMentioned: [{ name: 'Clay', count: 3 }],
      blocker: null,
    };

    function profilePage() {
      return wrap(
        <Routes>
          <Route path="/admin/network/indexed-creators/:id" element={<IndexedCreatorPage />} />
        </Routes>,
        '/admin/network/indexed-creators/ixc_jo',
      );
    }

    it('shows what they publish, each channel’s numbers and top posts, and invites from there', async () => {
      respond = (url, method) =>
        method === 'POST' ? { status: 201, body: { invite: { id: 'cinv_1', status: 'held' } } } : { status: 200, body: { creator: PROFILE } };
      profilePage();
      expect(await screen.findByText('Writes weekly about outbound sales for SDR teams.')).toBeTruthy();
      expect(calls[0]!.url).toBe('/api/admin/network/indexed-creators/ixc_jo');
      expect(screen.getByText('Sells sponsorships (4 past collaborations)')).toBeTruthy();
      expect(screen.getByText(/12,000 followers · 8 posts in the last 30 days · 100 reactions a post · 12 comments a post/)).toBeTruthy();
      expect(screen.getByText('2').getAttribute('href')).toBe('https://www.linkedin.com/feed/update/2');
      expect(screen.getByText('Clay (3 posts)')).toBeTruthy();
      expect(screen.getByText('← Discover creators').getAttribute('href')).toBe('/admin/network/creators?show=external');
      fireEvent.click(screen.getByText('Invite to collaborate'));
      fireEvent.change(screen.getByPlaceholderText(/Who you are/), { target: { value: 'Hi Jo, we would love to sponsor a post on outbound.' } });
      fireEvent.click(screen.getByText('Send invite'));
      await waitFor(() => expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ indexedCreatorId: 'ixc_jo' }));
    });

    it('says why a creator can’t be invited', async () => {
      respond = () => ({ status: 200, body: { creator: { ...PROFILE, invitable: false, blocker: 'unreachable' } } });
      profilePage();
      expect(await screen.findByText(/haven.t published a business email address we can use/)).toBeTruthy();
      expect(screen.queryByText('Invite to collaborate')).toBeNull();
    });

    it('says when a creator is no longer listed, and what the plan unlocks on other plans', async () => {
      respond = () => ({ status: 404, body: { error: 'not_found' } });
      profilePage();
      expect(await screen.findByText('This creator is no longer listed')).toBeTruthy();
      cleanup();
      respond = () => ({ status: 402, body: { error: 'plan_required' } });
      profilePage();
      expect(await screen.findByText('See external creators too')).toBeTruthy();
    });
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

  it('shows reach by platform, where each email came from, and switches the paid lookups', async () => {
    respond = (url, method) => {
      if (url.endsWith('/creator-index/settings') && method === 'PUT') return { status: 200, body: { settings: calls[calls.length - 1]!.body, visibilityChanged: 0 } };
      if (url.endsWith('/creator-index/settings')) {
        return { status: 200, body: { settings: SETTINGS, defaults: SETTINGS, classifierModels: ['gpt-6-luna'], updatedAt: null, updatedByEmail: null, configured: {} } };
      }
      if (url.endsWith('/creator-index/stats')) {
        return {
          status: 200,
          body: {
            creators: { byStatus: {}, listed: 16, shownToBrands: 2, hiddenFromBrands: 14, hiddenByRegion: 7, withEmail: 3, withoutEmail: 13 },
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
      const base = { status: 'active', headline: null, country: 'US', region: 'US-TX', brandVisible: true, emailsSent: 0 };
      return {
        status: 200,
        body: {
          creators: [
            {
              ...base,
              id: 'a',
              name: 'Jo Rivera',
              totalReach: 48_200,
              contact: { masked: 'h••••@jorivera.co', foundOn: 'via:creator-data', verified: true },
              platforms: [
                { platform: 'linkedin', handle: 'jo', profileUrl: 'https://www.linkedin.com/in/jo', followerCount: 41_000 },
                { platform: 'youtube', handle: '@jo', profileUrl: 'https://www.youtube.com/@jo', followerCount: 7_200 },
              ],
            },
            { ...base, id: 'b', name: 'Sam Lee', totalReach: 5_000, contact: null, platforms: [] },
          ],
        },
      };
    };
    wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
    expect(await screen.findByText('LinkedIn 41,000')).toBeTruthy();
    expect(screen.getByText('YouTube 7,200')).toBeTruthy();
    expect(screen.getByText('via creator-data lookup')).toBeTruthy();
    expect(screen.getByText('none yet · hidden from brands')).toBeTruthy();
    expect(screen.getByText('3 with an email · 13 without (hidden)')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Creator contact-data lookup/));
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ contactEnrichment: { creatorData: false, ownDomain: true } }));
  });

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

  it('starts runs in the background, shows each run and why a platform was set aside, and sets how many profiles are read at once', async () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    respond = (url, method) => {
      if (url.endsWith('/creator-index/settings') && method === 'PUT') return { status: 200, body: { settings: calls[calls.length - 1]!.body, visibilityChanged: 0 } };
      if (url.endsWith('/creator-index/settings')) {
        return { status: 200, body: { settings: { ...SETTINGS, readConcurrency: 8 }, defaults: SETTINGS, classifierModels: ['gpt-6-luna'], updatedAt: null, updatedByEmail: null, configured: {} } };
      }
      if (url.endsWith('/creator-index/run/discover')) return { status: 200, body: { started: true } };
      if (url.endsWith('/creator-index/run/read')) return { status: 409, body: { error: 'already_running' } };
      if (url.endsWith('/creator-index/stats')) {
        return {
          status: 200,
          body: {
            creators: { byStatus: {}, listed: 3, shownToBrands: 3, hiddenFromBrands: 0 },
            byCountry: [],
            candidates: { queued: 41 },
            rejections: {},
            invites: {},
            emailsSent30d: 0,
            suppressions: {},
            spend: { thisMonthUsd: 0.12, budgetUsd: 10 },
            runs: {
              discover: { startedAt: minutesAgo(9), finishedAt: minutesAgo(8), result: { ran: true, searches: 2, found: 43, queued: 41, recent: 0 } },
              read: { startedAt: minutesAgo(1), finishedAt: null, result: null },
              refresh: {
                startedAt: minutesAgo(30),
                finishedAt: minutesAgo(29),
                result: { ran: true, refreshed: 4, deleted: 0, deferred: 1, gone: 0, errors: 0, skipped: { youtube: 'youtube_quota' } },
              },
            },
          },
        };
      }
      return { status: 200, body: { creators: [] } };
    };
    wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
    expect(await screen.findByText(/2 searches · 43 found · 41 queued/)).toBeTruthy();
    expect(screen.getByText(/running since/)).toBeTruthy();
    expect(screen.getByText(/YouTube set aside: the YouTube API quota is used up/)).toBeTruthy();

    fireEvent.click(screen.getByText('Discover now'));
    expect(await screen.findByText(/Started\. It runs on the Network in the background/)).toBeTruthy();
    fireEvent.click(screen.getByText('Read queue now'));
    expect(await screen.findByText(/That job is already running/)).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue('8'), { target: { value: '12' } });
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ readConcurrency: 12 }));
  });

  it('keeps new lines, commas and spaces as they’re typed in the list boxes, and saves the lists', async () => {
    respond = (url, method) => {
      if (url.endsWith('/creator-index/settings') && method === 'PUT') return { status: 200, body: { settings: calls[calls.length - 1]!.body, visibilityChanged: 0 } };
      if (url.endsWith('/creator-index/settings')) {
        return { status: 200, body: { settings: SETTINGS, defaults: SETTINGS, classifierModels: ['gpt-6-luna'], updatedAt: null, updatedByEmail: null, configured: {} } };
      }
      if (url.endsWith('/creator-index/stats')) return { status: 404, body: { error: 'not_found' } };
      return { status: 200, body: { creators: [] } };
    };
    wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
    const seeds = (await screen.findByDisplayValue('B2B sales newsletters')) as HTMLTextAreaElement;
    // Each keystroke, as the browser sends it.
    for (const v of ['B2B sales newsletters\n', 'B2B sales newsletters\nRevOps ', 'B2B sales newsletters\nRevOps creators']) {
      fireEvent.change(seeds, { target: { value: v } });
      expect(seeds.value).toBe(v);
    }
    const countries = screen.getByDisplayValue('DE') as HTMLTextAreaElement;
    for (const v of ['DE,', 'DE, ', 'DE, fr']) {
      fireEvent.change(countries, { target: { value: v } });
      expect(countries.value).toBe(v);
    }
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
      seedQueries: ['B2B sales newsletters', 'RevOps creators'],
      excludedCountries: ['DE', 'FR'],
    });
    // Saved: the boxes show the lists as stored.
    await waitFor(() => expect(screen.getByDisplayValue('DE, FR')).toBeTruthy());

    // Discard puts back what's stored.
    fireEvent.change(screen.getByDisplayValue('DE, FR'), { target: { value: 'DE, FR, IT' } });
    fireEvent.click(screen.getByText('Discard changes'));
    expect(screen.getByDisplayValue('DE')).toBeTruthy();
  });

  describe('the outreach email', () => {
    const STATS = {
      creators: { byStatus: {}, listed: 3, shownToBrands: 2, hiddenFromBrands: 1 },
      byCountry: [],
      candidates: {},
      rejections: {},
      invites: {},
      emailsSent30d: 0,
      outreachSent: 4,
      suppressions: {},
      spend: { thisMonthUsd: 0, budgetUsd: 10 },
      runs: { outreach: { startedAt: new Date(Date.now() - 120_000).toISOString(), finishedAt: new Date(Date.now() - 60_000).toISOString(), result: { sent: 3, skipped: 1, failed: 0 } } },
    };
    const PREVIEW = {
      dryRun: true,
      enabled: false,
      mailerConfigured: true,
      sender: 'keith@openpartner.test',
      due: 2,
      candidates: 2,
      excluded: { invite_waiting: 1, country_not_cleared: 2, published_address_only: 1 },
      countriesNotCleared: { JP: 1, BR: 1 },
      targets: [
        {
          id: 'ixc_1',
          name: 'Jo Rivera',
          country: 'US',
          region: 'US-CA',
          shownToBrands: false,
          totalReach: 40000,
          address: 'p••••••@jo.co',
          addressFoundOn: 'https://jo.co/contact',
          opening: 'I came across your sponsorship page (jo.co/sponsor) while looking for creators who already work with brands.',
        },
        { id: 'ixc_2', name: 'Sam Lee', country: 'IN', region: null, shownToBrands: true, totalReach: 9000, address: 's••••@sam.in', addressFoundOn: 'via:creator-data', opening: 'I came across your LinkedIn profile (linkedin.com/in/sam) while looking for creators who already work with brands.', skip: 'member' },
      ],
    };

    function respondWith(opts: { outreachEnabled: boolean; mailer: { configured: boolean; from: string | null } }) {
      respond = (url, method) => {
        if (url.endsWith('/creator-index/settings')) {
          return {
            status: 200,
            body: { settings: { ...SETTINGS, outreachEnabled: opts.outreachEnabled }, defaults: SETTINGS, classifierModels: ['gpt-6-luna'], updatedAt: null, updatedByEmail: null, configured: {}, outreachMailer: opts.mailer },
          };
        }
        if (url.endsWith('/creator-index/stats')) return { status: 200, body: STATS };
        if (url.endsWith('/creator-index/outreach/run') && method === 'POST') {
          const body = calls[calls.length - 1]!.body as { dryRun: boolean };
          return body.dryRun ? { status: 200, body: { ...PREVIEW, enabled: opts.outreachEnabled } } : { status: 202, body: { started: true } };
        }
        return { status: 200, body: { creators: [] } };
      };
    }

    it('previews a batch: who, how it opens, who’s skipped and why the rest are left out', async () => {
      respondWith({ outreachEnabled: false, mailer: { configured: true, from: 'keith@openpartner.test' } });
      wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
      expect(await screen.findByText(/Sends from keith@openpartner\.test/)).toBeTruthy();
      expect(screen.getByText('outreach email off')).toBeTruthy();
      expect(screen.getByText('4 outreach emails sent')).toBeTruthy();
      expect(screen.getByText(/3 sent · 1 skipped/)).toBeTruthy();

      fireEvent.change(screen.getByDisplayValue('50'), { target: { value: '20' } });
      fireEvent.click(screen.getByText('Preview batch'));
      expect(await screen.findByText('Jo Rivera')).toBeTruthy();
      expect(calls.find((c) => c.url.endsWith('/outreach/run'))?.body).toEqual({ dryRun: true, limit: 20 });
      expect(screen.getByText(/I came across your sponsorship page \(jo\.co\/sponsor\)/)).toBeTruthy();
      expect(screen.getByText('US (US-CA) · hidden')).toBeTruthy();
      expect(screen.getByText('already on OpenPartner: skipped')).toBeTruthy();
      expect(screen.getByText('via creator-data lookup')).toBeTruthy();
      expect(screen.getByText(/a brand is waiting \(they get the brands’ email\) 1/)).toBeTruthy();
      expect(screen.getByText(/not cleared: JP 1, BR 1/)).toBeTruthy();
      // Off in Settings: nothing to send yet.
      expect((screen.getByText('Send this batch').closest('button') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/Switch .Outreach email on. in Settings to send/)).toBeTruthy();
    });

    it('sends a previewed batch after a confirm, and says so', async () => {
      respondWith({ outreachEnabled: true, mailer: { configured: true, from: 'keith@openpartner.test' } });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
      fireEvent.click(await screen.findByText('Preview batch'));
      await screen.findByText('Jo Rivera');
      fireEvent.click(screen.getByText('Send this batch'));
      expect(await screen.findByText(/Started\. The Network sends it a few seconds apart/)).toBeTruthy();
      expect(confirm).toHaveBeenCalledWith('Send the outreach email to 2 creators? Each gets it only once.');
      expect(calls.filter((c) => c.url.endsWith('/outreach/run')).map((c) => c.body)).toEqual([
        { dryRun: true, limit: 50 },
        { dryRun: false, limit: 50 },
      ]);
      confirm.mockRestore();
    });

    it('says when there’s no mailbox to send from, and support can preview but not send', async () => {
      respondWith({ outreachEnabled: true, mailer: { configured: false, from: null } });
      wrap(<CreatorIndexPage operator={{ id: 'pa_2', email: 'support@test', role: 'support' } as never} />);
      expect(await screen.findByText(/The Network has no outreach mailbox set up, so nothing can be sent/)).toBeTruthy();
      expect(screen.getByText('Preview batch')).toBeTruthy();
      expect(screen.queryByText('Send this batch')).toBeNull();
    });
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
        <Route path="/creator" element={<div>creator home</div>} />
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
    expect(screen.getByText(/got partnerships@jo\.co from https:\/\/jo\.co\/contact/)).toBeTruthy();
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

  it('with no brand waiting, offers the claim alone, says whether brands see them, and lands them in their account', async () => {
    respond = (url) =>
      url.endsWith('/claim/preview')
        ? {
            status: 200,
            body: {
              ...PREVIEW,
              invites: [],
              creator: { ...PREVIEW.creator, shownToBrands: false, partnershipSignals: [{ kind: 'sponsor_page', count: null, evidence: 'https://jo.co/sponsor' }] },
            },
          }
        : { status: 200, body: { ok: true, creatorId: 'crt_1', created: true, conversationIds: [] } };
    page();
    expect(await screen.findByText('Claim your OpenPartner profile')).toBeTruthy();
    expect(screen.getByText(/It isn.t shown to brands until you claim it/)).toBeTruthy();
    expect(screen.getByText(/Brands don.t see this listing\. It notes that you take partnerships, from/)).toBeTruthy();
    expect(screen.queryByText(/want to work with you/)).toBeNull();
    fireEvent.click(screen.getByText('Claim my profile'));
    expect(await screen.findByText('creator home')).toBeTruthy();
  });

  it('explains an expired link', async () => {
    respond = () => ({ status: 404, body: { error: 'invalid_or_expired' } });
    page();
    expect(await screen.findByText(/This link has expired or isn.t valid/)).toBeTruthy();
  });
});
