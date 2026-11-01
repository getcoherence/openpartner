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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IndexedCreatorPage } from '../pages/admin/NetworkIndexedCreators.js';
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
  // Folded cards are remembered.
  window.localStorage.clear();
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

describe('external creators', () => {
  /** Discover creators' answers: external creators, and OpenPartner's own. */
  const discover =
    (external: { status: number; body: unknown }, members: unknown[] = []) =>
    (url: string, method: string) =>
      method === 'POST'
        ? { status: 201, body: { invite: { id: 'cinv_1', status: 'held' } } }
        : url.includes('/indexed-creators')
          ? external
          : { status: 200, body: { creators: members } };
  const externalPage = (creators: unknown[]) => ({ status: 200, body: { creators, nextCursor: null, total: creators.length } });

  it('lists creators with the badge and invites with a real message', async () => {
    respond = discover(externalPage([JO]));
    wrap(<AdminNetworkCreators />);
    expect(await screen.findByText('Jo Rivera')).toBeTruthy();
    // The badge says what it means on hover.
    expect(screen.getByText('External creator').getAttribute('title')).toMatch(/^Not on OpenPartner yet/);
    expect(calls.some((c) => c.url === '/api/admin/network/indexed-creators?')).toBe(true);

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
    respond = discover({ status: 402, body: { error: 'plan_required', detail: 'Creators not on OpenPartner yet come with the Flex and Enterprise plans.' } }, [MEMBER]);
    wrap(<AdminNetworkCreators />);
    expect(await screen.findByText('See external creators too')).toBeTruthy();
    expect(screen.getByText('Member Mo')).toBeTruthy();
    expect(screen.getByText('See plans')).toBeTruthy();
  });

  it('shows OpenPartner’s creators first and external ones after, under the same filters, and leaves external ones out of members-only filters', async () => {
    respond = (url) =>
      url.includes('/indexed-creators')
        ? { status: 200, body: { creators: [JO], nextCursor: null, total: 1 } }
        : { status: 200, body: { creators: [MEMBER] } };
    wrap(<AdminNetworkCreators />);
    expect(await screen.findByText('Member Mo')).toBeTruthy();
    expect(await screen.findByText('Jo Rivera')).toBeTruthy();
    // One list, no sections: OpenPartner's creators first, external ones
    // after, told apart by the badge.
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
    const rows = screen.getAllByTestId('creator-row');
    expect(rows.map((r) => r.textContent!.includes('External creator'))).toEqual([false, true]);
    expect(rows[0]!.parentElement).toBe(rows[1]!.parentElement);
    // Rows never grow wider than the list (a long headline cut off their right-hand side).
    expect(rows[0]!.parentElement!.style.gridTemplateColumns).toBe('minmax(0, 1fr)');
    // No count line over the list.
    expect(screen.queryByText(/on OpenPartner ·/)).toBeNull();

    // The filters are one bar; each opens below its chip. A shared filter
    // reaches both lists; sales is a topic only external creators have.
    expect(screen.queryByRole('button', { name: 'sales' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Categories/ }));
    fireEvent.click(screen.getByRole('button', { name: 'sales' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/indexed-creators?categories=sales'))).toBe(true));
    // The chip says what's set.
    expect(screen.getByRole('button', { name: /^Categories.*1/ })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'sales' })).toBeNull();

    // Only creators who already take partnerships: external ones.
    fireEvent.click(screen.getByRole('button', { name: 'Open to partnerships' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/indexed-creators?categories=sales&openToPartnerships=1'))).toBe(true));

    // Followers is a range: a common one, or any two numbers. Both lists get it.
    fireEvent.click(screen.getByRole('button', { name: /^Followers/ }));
    fireEvent.click(screen.getByRole('button', { name: '1K–10K' }));
    expect(screen.getByRole('button', { name: /^Followers.*1K–10K/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('At most'), { target: { value: '5000' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('/discover/creators?') && c.url.includes('minFollowers=1000&maxFollowers=5000'))).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/indexed-creators?') && c.url.includes('minFollowers=1000&maxFollowers=5000'))).toBe(true));
    expect(screen.getByRole('button', { name: /^Followers.*1K–5K/ })).toBeTruthy();

    // There's no sales filter: the Network withholds those numbers.
    expect(screen.queryByRole('button', { name: /^Sales/ })).toBeNull();

    // Audience is countries by name, picked from a list. External creators
    // have no audience data, so they're left out, without a word.
    fireEvent.click(screen.getByRole('button', { name: /^Audience/ }));
    fireEvent.change(screen.getByLabelText('Search countries'), { target: { value: 'united k' } });
    expect(screen.queryByLabelText('France')).toBeNull();
    fireEvent.click(screen.getByLabelText('United Kingdom'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/discover/creators?') && c.url.includes('locations=GB'))).toBe(true));
    expect(screen.getByRole('button', { name: /^Audience.*GB/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Jo Rivera')).toBeNull());
    expect(screen.queryByText(/hidden by these filters/)).toBeNull();

    // Reset all clears the lot.
    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }));
    expect(await screen.findByText('Jo Rivera')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open to partnerships' }).getAttribute('aria-pressed')).toBe('false');

    // Only external creators.
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'external' } });
    expect(screen.queryByText('Member Mo')).toBeNull();
  });

  it('shows each channel as its logo with followers, linking to the profile', async () => {
    respond = (url) =>
      url.includes('/indexed-creators')
        ? { status: 200, body: { creators: [{ ...JO, platforms: [...JO.platforms, { ...JO.platforms[0], platform: 'youtube', profileUrl: 'https://www.youtube.com/@jo', followerCount: 4_500_000 }] }], nextCursor: null, total: 1 } }
        : { status: 200, body: { creators: [MEMBER] } };
    wrap(<AdminNetworkCreators />);
    const linkedin = await screen.findByRole('link', { name: 'LinkedIn, 12,000 followers' });
    expect(linkedin.getAttribute('href')).toBe('https://www.linkedin.com/in/jorivera');
    expect(linkedin.textContent).toBe('12K');
    expect(linkedin.querySelector('img')!.getAttribute('src')).toBe('/linkedin-in-bug.png');
    const youtube = screen.getByRole('link', { name: 'YouTube, 4,500,000 followers' });
    expect(youtube.textContent).toBe('4.5M');
    expect(youtube.querySelector('svg path')!.getAttribute('fill')).toBe('#FF0000');
  });

  it('shows each channel’s engagement rate beside its followers, the full figures on hover, and filters and sorts on it', async () => {
    const rated = { ...JO, engagementRate: 2.41, platforms: [{ ...JO.platforms[0], engagementRate: 2.41, engagementPosts: 10 }] };
    const member = {
      ...MEMBER,
      platforms: [
        { id: 'cpf_1', platform: 'youtube', handle: 'mo', profileUrl: 'https://www.youtube.com/@mo', followerCount: 48_200, verified: true, engagementRate: 1.8667, engagementPosts: 6 },
        { id: 'cpf_2', platform: 'tiktok', handle: 'mo', profileUrl: null, followerCount: 900, verified: false, engagementRate: null, engagementPosts: null },
      ],
      totalReach: 49_100,
    };
    respond = (url) =>
      url.includes('/indexed-creators')
        ? { status: 200, body: { creators: [rated], nextCursor: null, total: 1 } }
        : { status: 200, body: { creators: [member] } };
    wrap(<AdminNetworkCreators />);
    const linkedin = await screen.findByRole('link', { name: 'LinkedIn, 12,000 followers, 2.41% engagement over 10 posts' });
    expect(linkedin.textContent).toBe('12K· 2.4%');
    const youtube = screen.getByRole('link', { name: 'YouTube, 48,200 followers, 1.87% engagement over 6 videos, verified' });
    expect(youtube.textContent).toContain('48.2K· 1.9%');
    // No rate, nothing beside the count.
    expect(screen.getByTitle('TikTok, 900 followers').textContent).toBe('900');

    // The best channel's rate, for both lists.
    fireEvent.click(screen.getByRole('button', { name: /^Engagement/ }));
    fireEvent.click(screen.getByRole('button', { name: '2%+' }));
    expect(screen.getByRole('button', { name: /^Engagement.*2%\+/ })).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/discover/creators?') && c.url.includes('minEngagement=2'))).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/admin/network/indexed-creators?minEngagement=2')).toBe(true));
    fireEvent.change(screen.getByLabelText('Minimum engagement %'), { target: { value: '3.5' } });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/admin/network/indexed-creators?minEngagement=3.5')).toBe(true));
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.change(screen.getByDisplayValue('Total followers'), { target: { value: 'engagement' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('/discover/creators?') && c.url.includes('sort=engagement'))).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/admin/network/indexed-creators?minEngagement=3.5&sort=engagement')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }));
    expect(screen.getByRole('button', { name: /^Engagement$/ })).toBeTruthy();
  });

  it('off a wide screen, opens the creator picked over the list, and closes back to it', async () => {
    respond = (url) => {
      if (url.includes('/indexed-creators/ixc_jo')) {
        return {
          status: 200,
          body: {
            creator: {
              ...JO,
              platforms: [{ ...JO.platforms[0], avgComments: null, avgReposts: null, topPostUrls: [] }],
              summary: 'Writes weekly about outbound sales for SDR teams.',
              productsMentioned: [],
              blocker: null,
            },
          },
        };
      }
      if (url.includes('/indexed-creators')) return externalPage([JO]);
      return { status: 200, body: { creators: [] } };
    };
    function Where() {
      return <div data-testid="where">{useLocation().search}</div>;
    }
    wrap(
      <>
        <AdminNetworkCreators />
        <Where />
      </>,
    );
    expect(screen.queryByRole('complementary', { name: 'Selected creator' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Jo Rivera' }));
    const sheet = await screen.findByRole('dialog', { name: 'Selected creator' });
    expect(await within(sheet).findByText('Writes weekly about outbound sales for SDR teams.')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('?external=ixc_jo');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Selected creator' })).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('');
    // The list is where it was.
    fireEvent.click(screen.getByRole('button', { name: 'Jo Rivera' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Selected creator' })).toBeNull();
    expect(screen.getByText('Jo Rivera')).toBeTruthy();
  });

  it('on a wide screen, shows the creator picked beside the list, and keeps who in the URL', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(min-width: 1200px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    respond = (url) => {
      if (url.includes('/indexed-creators/ixc_jo')) {
        return {
          status: 200,
          body: {
            creator: {
              ...JO,
              platforms: [{ ...JO.platforms[0], avgComments: null, avgReposts: null, topPostUrls: [] }],
              summary: 'Writes weekly about outbound sales for SDR teams.',
              productsMentioned: [],
              blocker: null,
            },
          },
        };
      }
      if (url.includes('/indexed-creators')) return { status: 200, body: { creators: [JO], nextCursor: null, total: 1 } };
      if (url.includes('/creators/by-handle/mo')) {
        return {
          status: 200,
          body: { ...MEMBER, bio: 'Writes about sales', portfolioLinks: [], bookingsOpen: false, packages: [] },
        };
      }
      return { status: 200, body: { creators: [MEMBER] } };
    };
    function Where() {
      return <div data-testid="where">{useLocation().search}</div>;
    }
    wrap(
      <>
        <AdminNetworkCreators />
        <Where />
      </>,
    );
    await screen.findByText('Jo Rivera');
    const panel = screen.getByRole('complementary', { name: 'Selected creator' });
    expect(within(panel).getByText('Pick a creator')).toBeTruthy();
    // The page stays put: the list and the creator each scroll on their own.
    expect(screen.getByTestId('creator-list-scroll').style.overflowY).toBe('auto');
    expect(panel.style.overflowY).toBe('auto');
    expect(panel.parentElement!.style.height).toMatch(/^\d+px$/);

    fireEvent.click(screen.getByRole('button', { name: 'Jo Rivera' }));
    expect(await within(panel).findByText('Writes weekly about outbound sales for SDR teams.')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Open full page →' }).getAttribute('href')).toBe('/admin/network/indexed-creators/ixc_jo');
    expect(screen.getByRole('button', { name: 'Jo Rivera' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('where').textContent).toBe('?external=ixc_jo');
    // The list stays.
    expect(screen.getByText('Member Mo')).toBeTruthy();

    // A click anywhere on a row picks it; its buttons keep their own job.
    const memberRow = screen.getAllByTestId('creator-row')[0]!;
    fireEvent.click(memberRow);
    expect(await within(panel).findByText(/Not taking bookings right now/)).toBeTruthy();
    // One surface: the profile's parts are sections of it, not cards.
    expect(within(panel).getByRole('heading', { name: 'Member Mo' }).closest('section')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('?creator=mo');
    fireEvent.click(within(memberRow).getByRole('button', { name: 'Book' }));
    expect(screen.getByTestId('where').textContent).toBe('?creator=mo');
  });

  it('shows an invite already sent, and a creator who can’t be invited', async () => {
    respond = discover(
      externalPage([
        { ...JO, id: 'a', name: 'Sent One', invitable: false, invite: { id: 'i', status: 'sent', createdAt: '2026-10-30T00:00:00Z' } },
        { ...JO, id: 'b', name: 'Nope', invitable: false },
      ]),
    );
    wrap(<AdminNetworkCreators />);
    expect(await screen.findByText('Invited. We emailed them.')).toBeTruthy();
    expect(screen.getByText(/Can.t be invited yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();

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

    it('shows each channel’s engagement rate with its numbers', async () => {
      respond = () => ({
        status: 200,
        body: { creator: { ...PROFILE, platforms: [{ ...PROFILE.platforms[0], engagementRate: 0.9625, engagementPosts: 8 }] } },
      });
      profilePage();
      const numbers = await screen.findByText(/12,000 followers · 1% engagement · 8 posts in the last 30 days/);
      expect(numbers.getAttribute('title')).toBe('0.96% engagement over 8 posts');
      expect(screen.getByRole('link', { name: 'LinkedIn, 12,000 followers, 0.96% engagement over 8 posts' }).textContent).toBe('12K· 1%');
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
    respond = discover(externalPage([open, { ...JO, id: 'b', name: 'Quiet One' }]));
    wrap(<AdminNetworkCreators />);
    expect(await screen.findByText('Sells sponsorships (3 past collaborations) · 1 sponsored post lately')).toBeTruthy();
    // The badge on one row; the filter chip is the other.
    expect(screen.getAllByText('Open to partnerships')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Open to partnerships' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/admin/network/indexed-creators?openToPartnerships=1')).toBe(true));
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
    // Each channel's logo, named for screen readers, with its count.
    expect(await screen.findByTitle('LinkedIn 41,000')).toBeTruthy();
    expect(screen.getByTitle('YouTube 7,200').textContent).toBe('7,200');
    expect(screen.getByRole('img', { name: 'YouTube' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'LinkedIn' }).getAttribute('href')).toBe('https://www.linkedin.com/in/jo');
    expect(screen.getByText('via creator-data lookup')).toBeTruthy();
    expect(screen.getByText('none yet · hidden from brands')).toBeTruthy();
    expect(screen.getByText('3 with an email · 13 without (hidden)')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Creator contact-data lookup/));
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ contactEnrichment: { creatorData: false, ownDomain: true } }));
  });

  it('sets the members’ budget beside the index’s, and shows what members’ reads spent', async () => {
    respond = (url, method) => {
      if (url.endsWith('/creator-index/settings') && method === 'PUT') return { status: 200, body: { settings: calls[calls.length - 1]!.body, visibilityChanged: 0 } };
      if (url.endsWith('/creator-index/settings')) {
        const settings = { ...SETTINGS, memberStatsBudgetUsd: 10 };
        return { status: 200, body: { settings, defaults: settings, classifierModels: ['gpt-6-luna'], updatedAt: null, updatedByEmail: null, configured: {} } };
      }
      if (url.endsWith('/creator-index/stats')) {
        return {
          status: 200,
          body: {
            creators: { byStatus: {}, listed: 0, shownToBrands: 0, hiddenFromBrands: 0 },
            byCountry: [],
            candidates: {},
            rejections: {},
            invites: {},
            emailsSent30d: 0,
            suppressions: {},
            spend: { thisMonthUsd: 2, budgetUsd: 10 },
            memberSpend: { thisMonthUsd: 1.25, budgetUsd: 10 },
          },
        };
      }
      return { status: 200, body: { creators: [] } };
    };
    wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
    expect(await screen.findByText('Members: $1.25 of $10')).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Members' budget (USD)"), { target: { value: '25' } });
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ monthlyBudgetUsd: 10, memberStatsBudgetUsd: 25 }));
  });

  it('shows an address in full on request, and adds one ops found published, saying why one was refused', async () => {
    let refuse = true;
    respond = (url, method) => {
      if (url.endsWith('/creator-index/settings')) {
        return { status: 200, body: { settings: SETTINGS, defaults: SETTINGS, classifierModels: ['gpt-6-luna'], updatedAt: null, updatedByEmail: null, configured: {} } };
      }
      if (url.endsWith('/creator-index/stats')) {
        return {
          status: 200,
          body: {
            creators: { byStatus: {}, listed: 2, shownToBrands: 1, hiddenFromBrands: 1, hiddenByRegion: 0, withEmail: 1, withoutEmail: 1 },
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
      if (url.endsWith('/creators/a/contact')) return { status: 200, body: { contact: { address: 'hello@jorivera.co', foundOn: 'via:creator-data', verified: true } } };
      if (url.endsWith('/creators/b/contact') && method === 'PUT') {
        if (refuse) {
          refuse = false;
          return { status: 422, body: { error: 'not_on_page' } };
        }
        return { status: 200, body: { creator: {} } };
      }
      const base = { status: 'active', headline: null, country: 'US', region: 'US-TX', brandVisible: true, emailsSent: 0, totalReach: 5_000, platforms: [] };
      return {
        status: 200,
        body: {
          creators: [
            { ...base, id: 'a', name: 'Jo Rivera', contact: { masked: 'h••••@jorivera.co', foundOn: 'via:creator-data', verified: true } },
            { ...base, id: 'b', name: 'Sam Lee', contact: null },
          ],
        },
      };
    };
    wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
    expect(await screen.findByText('h••••@jorivera.co')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('hello@jorivera.co')).toBeTruthy();
    expect(calls.some((c) => c.method === 'GET' && c.url === '/api/platform-admin/creator-index/creators/a/contact')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.getByText('h••••@jorivera.co')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add address' }));
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'hello@jorivera.co' } });
    fireEvent.change(screen.getByLabelText('Page it’s published on'), { target: { value: 'https://jorivera.substack.com/about' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That address isn’t on that page. Give the page that shows it.')).toBeTruthy();
    const listReads = calls.filter((c) => c.url.includes('/creator-index/creators?') || c.url.endsWith('/creator-index/creators')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Email address')).toBeNull());
    const put = calls.filter((c) => c.method === 'PUT' && c.url === '/api/platform-admin/creator-index/creators/b/contact');
    expect(put.at(-1)!.body).toEqual({ email: 'hello@jorivera.co', sourceUrl: 'https://jorivera.substack.com/about' });
    // The list is read again, to show the new address masked.
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/creator-index/creators?') || c.url.endsWith('/creator-index/creators')).length).toBeGreaterThan(listReads));

    // Support operators see the list, not the controls.
    cleanup();
    wrap(<CreatorIndexPage operator={{ id: 'pa_2', email: 'support@test', role: 'support' } as never} />);
    expect(await screen.findByText('h••••@jorivera.co')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add address' })).toBeNull();
  });

  it('sets a state ops found for a US creator, marks the hidden ones, and says why one was refused', async () => {
    let refuse = true;
    respond = (url, method) => {
      if (url.endsWith('/creator-index/settings')) {
        return { status: 200, body: { settings: SETTINGS, defaults: SETTINGS, classifierModels: ['gpt-6-luna'], updatedAt: null, updatedByEmail: null, configured: {} } };
      }
      if (url.endsWith('/creator-index/stats')) {
        return {
          status: 200,
          body: {
            creators: { byStatus: {}, listed: 3, shownToBrands: 1, hiddenFromBrands: 2, hiddenByRegion: 0, withEmail: 0, withoutEmail: 3 },
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
      if (url.endsWith('/creators/b/location') && method === 'PUT') {
        if (refuse) {
          refuse = false;
          return { status: 409, body: { error: 'state_from_profile' } };
        }
        return { status: 200, body: { creator: {} } };
      }
      const base = { status: 'active', headline: null, country: 'US', brandVisible: true, emailsSent: 0, totalReach: 5_000, platforms: [], contact: null };
      return {
        status: 200,
        body: {
          creators: [
            { ...base, id: 'a', name: 'Jo Rivera', region: 'US-TX', location: { text: 'https://jorivera.co/about', from: 'ops' } },
            { ...base, id: 'b', name: 'Sam Lee', region: null, brandVisible: false, location: { text: 'United States', from: 'linkedin' } },
            { ...base, id: 'c', name: 'Ana Ruiz', country: 'GB', region: null, location: { text: 'London', from: 'linkedin' } },
          ],
        },
      };
    };
    wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
    expect(await screen.findByText('jorivera.co/about')).toBeTruthy();
    expect(screen.getByText(/Set by ops:/)).toBeTruthy();
    // Only for US creators.
    expect(screen.getAllByRole('button', { name: 'Change state' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Set state' }));
    expect(screen.getByRole('option', { name: 'California (hidden from brands)' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'US-TX' } });
    fireEvent.change(screen.getByLabelText('Page that shows it'), { target: { value: 'https://samlee.substack.com/about' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Their profile gives a state. You can only move them to a hidden one, which hides them from brands.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('State')).toBeNull());
    const put = calls.filter((c) => c.method === 'PUT' && c.url === '/api/platform-admin/creator-index/creators/b/location');
    expect(put.at(-1)!.body).toEqual({ region: 'US-TX', sourceUrl: 'https://samlee.substack.com/about' });

    // Support operators see where, not the control.
    cleanup();
    wrap(<CreatorIndexPage operator={{ id: 'pa_2', email: 'support@test', role: 'support' } as never} />);
    expect(await screen.findByText('jorivera.co/about')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set state' })).toBeNull();
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
    expect(await screen.findByText(/2 searches · 43 found · 41 new/)).toBeTruthy();
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

  it('folds Settings and Runs away, remembers it, and lists only who has no address or no state', async () => {
    respond = (url) => {
      if (url.endsWith('/creator-index/settings')) {
        return { status: 200, body: { settings: SETTINGS, defaults: SETTINGS, classifierModels: ['gpt-6-luna'], updatedAt: null, updatedByEmail: null, configured: {} } };
      }
      if (url.endsWith('/creator-index/stats')) {
        return {
          status: 200,
          body: {
            creators: { byStatus: {}, listed: 3, shownToBrands: 1, hiddenFromBrands: 2 },
            byCountry: [],
            candidates: {},
            rejections: {},
            invites: {},
            emailsSent30d: 0,
            suppressions: {},
            spend: { thisMonthUsd: 0, budgetUsd: 10 },
            runs: { discover: { startedAt: new Date().toISOString(), finishedAt: null, result: null } },
          },
        };
      }
      return { status: 200, body: { creators: [], total: 0 } };
    };
    wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
    const settings = await screen.findByRole('button', { name: 'Settings' });
    expect(settings.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByLabelText('Indexing on'));
    fireEvent.click(settings);
    expect(settings.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Indexing on')).toBeNull();
    // What they'd miss while it's folded.
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
    expect(screen.queryByRole('button', { name: 'Discover now' })).toBeNull();
    expect(screen.getByText('Discover running…')).toBeTruthy();

    // Still folded next time.
    cleanup();
    wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
    expect((await screen.findByRole('button', { name: 'Settings' })).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Runs' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
    expect(screen.getByRole('button', { name: 'Discover now' })).toBeTruthy();

    const listed = () => calls.filter((c) => c.url.startsWith('/api/platform-admin/creator-index/creators')).map((c) => c.url);
    fireEvent.click(screen.getByRole('button', { name: 'No state' }));
    expect(screen.getByRole('button', { name: 'No state' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(listed()).toContain('/api/platform-admin/creator-index/creators?missing=state'));
    expect(screen.getByText(/US creators with no state: hidden from brands until one is set/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'No address' }));
    await waitFor(() => expect(listed()).toContain('/api/platform-admin/creator-index/creators?missing=address%2Cstate'));
    expect(await screen.findByText('0 match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'No state' }));
    await waitFor(() => expect(listed()).toContain('/api/platform-admin/creator-index/creators?missing=address'));
  });

  it('counts the creators listed lately, marks the new ones, and says how Discover went further', async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const discover = (result: Record<string, unknown>) => ({ startedAt: hoursAgo(1), finishedAt: hoursAgo(1), result });
    let run = discover({ ran: true, searches: 6, deeper: 1, related: ['RevOps newsletters', 'cold email outreach'], found: 120, queued: 37, recent: 2 });
    respond = (url) => {
      if (url.endsWith('/creator-index/settings')) {
        return { status: 200, body: { settings: SETTINGS, defaults: SETTINGS, classifierModels: ['gpt-6-luna'], updatedAt: null, updatedByEmail: null, configured: {} } };
      }
      if (url.endsWith('/creator-index/stats')) {
        return {
          status: 200,
          body: {
            creators: { byStatus: {}, listed: 52, listedLast24h: 37, listedLast7d: 40, shownToBrands: 30, hiddenFromBrands: 22 },
            byCountry: [],
            candidates: {},
            rejections: {},
            invites: {},
            emailsSent30d: 0,
            suppressions: {},
            spend: { thisMonthUsd: 1.2, budgetUsd: 10 },
            runs: { discover: run },
          },
        };
      }
      const base = { status: 'active', headline: null, country: 'US', region: 'US-TX', brandVisible: true, emailsSent: 0, totalReach: 1_000, contact: null, platforms: [] };
      return {
        status: 200,
        body: {
          creators: [
            { ...base, id: 'a', name: 'Jo Rivera', listedAt: hoursAgo(2), country: 'KR', region: null, location: { text: 'Seoul, South Korea', from: 'linkedin' } },
            { ...base, id: 'b', name: 'Sam Lee', listedAt: hoursAgo(72) },
          ],
          total: 52,
        },
      };
    };
    const { unmount } = wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
    expect(await screen.findByText('+37 in the last 24 hours · +40 this week')).toBeTruthy();
    expect(await screen.findByText('52 in all, newest 2 shown')).toBeTruthy();
    expect(screen.getByText('37 new in the last 24 hours')).toBeTruthy();
    expect(screen.getAllByText(/^new · listed/)).toHaveLength(1);
    // Where each country was read from.
    expect(screen.getByText('LinkedIn: “Seoul, South Korea”')).toBeTruthy();
    expect(screen.getByText(/6 searches · 1 of them deeper · 120 found · 37 new · 2 seed searches made this month/)).toBeTruthy();
    expect(screen.getByText('Related queries searched: RevOps newsletters · cold email outreach')).toBeTruthy();
    unmount();

    // A Discover with nothing left to search says so.
    run = discover({ ran: true, searches: 0, deeper: 0, related: [], found: 0, queued: 0, recent: 2 });
    wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
    expect(await screen.findByText(/Nothing left to search on these topics this month/)).toBeTruthy();
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

    function respondWith(opts: { outreachEnabled: boolean; mailer: { configured: boolean; from: string | null }; inviteMailer?: { configured: boolean; from: string | null } }) {
      respond = (url, method) => {
        if (url.endsWith('/creator-index/settings')) {
          return {
            status: 200,
            body: { settings: { ...SETTINGS, outreachEnabled: opts.outreachEnabled }, defaults: SETTINGS, classifierModels: ['gpt-6-luna'], updatedAt: null, updatedByEmail: null, configured: {}, outreachMailer: opts.mailer, inviteMailer: opts.inviteMailer },
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
      respondWith({ outreachEnabled: false, mailer: { configured: true, from: 'keith@openpartner.test' }, inviteMailer: { configured: true, from: 'creators@openpartner.test' } });
      wrap(<CreatorIndexPage operator={{ id: 'pa_1', email: 'ops@test', role: 'admin' } as never} />);
      expect(await screen.findByText(/Sends from keith@openpartner\.test/)).toBeTruthy();
      // Brands' invites go from a mailbox of their own.
      expect(screen.getByText('Brands’ invites send from creators@openpartner.test.')).toBeTruthy();
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
      expect(screen.getByText(/no invite mailbox set up, so brands’ invites aren’t emailed\. They never go from the outreach mailbox/)).toBeTruthy();
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
