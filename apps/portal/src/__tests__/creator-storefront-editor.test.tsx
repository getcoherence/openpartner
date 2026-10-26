// @vitest-environment jsdom
/**
 * The storefront editor (the Network's docs/creator-storefront.md §6, §7.2):
 * packages grouped under the creator's channels, templates per platform,
 * channel stats marked synced or self-reported, the live preview beside
 * the editor, and the guided setup creating packages from templates. Plus
 * the brand's in-app view of a storefront (each package books a tracked
 * deal) and the app's old public route forwarding to the public site.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorPublicProfilePage } from '../pages/creator/CreatorPublicProfile.js';
import { NetworkCreatorStorefrontPage } from '../pages/admin/NetworkCreatorStorefront.js';
import { CreatorStorefrontPage } from '../pages/creator/CreatorStorefront.js';
import { CreatorStorefrontSetupPage } from '../pages/creator/CreatorStorefrontSetup.js';
import {
  groupByChannel,
  parsePackagePrice,
  templatesFor,
  type StorefrontChannel,
  type StorefrontPackage,
} from '../pages/creator/storefront-shared.js';

const YOUTUBE: StorefrontChannel = {
  id: 'cpf_yt',
  platform: 'youtube',
  handle: 'mayabuilds',
  profileUrl: 'https://www.youtube.com/@mayabuilds',
  followerCount: 48200,
  verified: true,
  description: null,
  cadence: null,
  followerCountSynced: true,
  viewsPerVideo: 12400,
  statsSyncedAt: '2026-10-20T00:00:00.000Z',
};
const SUBSTACK: StorefrontChannel = {
  id: 'cpf_ss',
  platform: 'substack',
  handle: 'mayabuilds',
  profileUrl: 'https://mayabuilds.substack.com',
  followerCount: 9100,
  verified: false,
  description: 'A weekly teardown of one developer tool.',
  cadence: 'Every Tuesday',
  followerCountSynced: false,
  viewsPerVideo: null,
  statsSyncedAt: null,
};

function pkg(id: string, platform: string | null, over: Partial<StorefrontPackage> = {}) {
  return { id, title: `Package ${id}`, description: null, platform, priceAmount: 500, priceIsFrom: false, currency: 'USD', published: true, position: 0, ...over };
}

let requests: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
let storefront: Record<string, unknown>;

beforeEach(() => {
  requests = [];
  storefront = {
    bookingsOpen: false,
    handle: 'mayabuilds',
    profileComplete: true,
    maxPackages: 12,
    packages: [],
    platforms: [YOUTUBE, SUBSTACK],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const path = url.pathname.replace('/api/creator-api', '');
    requests.push({ method, path, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/creators/me/storefront' && method === 'GET') return json(200, storefront);
    if (path === '/creators/me/platforms' && method === 'GET') return json(200, { platforms: [YOUTUBE, SUBSTACK] });
    if (path === '/creators/me' && method === 'GET') {
      return json(200, { id: 'crt_1', email: 'maya@example.test', name: 'Maya Chen', handle: 'mayabuilds', avatarUrl: null, pastBrands: [], profileComplete: true });
    }
    if (path === '/creators/me/packages' && method === 'POST') return json(201, { id: `pkg_${requests.length}`, ...body });
    const putPlatform = /^\/creators\/me\/platforms\/(\w+)$/.exec(path);
    if (putPlatform && method === 'PUT') {
      const platforms = storefront.platforms as StorefrontChannel[];
      if (!platforms.some((p) => p.platform === putPlatform[1])) {
        const added: StorefrontChannel = {
          ...SUBSTACK,
          id: `cpf_${putPlatform[1]}`,
          platform: putPlatform[1]!,
          handle: String(body?.handle),
          profileUrl: null,
          followerCount: (body?.followerCount as number | null) ?? null,
          description: null,
          cadence: null,
        };
        storefront = { ...storefront, platforms: [...platforms, added] };
      }
      return json(200, { ok: true });
    }
    if (path === '/creators/by-handle/mayabuilds') {
      return json(200, {
        id: 'crt_1',
        name: 'Maya Chen',
        handle: 'mayabuilds',
        avatarUrl: null,
        bio: null,
        categories: [],
        audienceLocations: [],
        audienceAgeRange: null,
        portfolioLinks: [],
        pastBrands: [],
        platforms: [YOUTUBE, SUBSTACK],
        bookingsOpen: true,
        packages: [pkg('a', 'youtube', { title: 'Dedicated video', priceAmount: 4500 }), pkg('b', null, { title: 'Bundle' })],
      });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => cleanup());

function renderAt(path: string, routePath: string, element: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('storefront helpers', () => {
  it('groups packages under their channel, empty channels next, then other platforms, then any', () => {
    const groups = groupByChannel(
      [pkg('1', 'substack'), pkg('2', null), pkg('3', 'tiktok'), pkg('4', 'substack')],
      [YOUTUBE, SUBSTACK],
    );
    expect(groups.map((g) => [g.key, g.packages.map((p) => p.id)])).toEqual([
      ['substack', ['1', '4']],
      ['youtube', []],
      ['tiktok', ['3']],
      ['any', ['2']],
    ]);
    expect(groups[2]!.channel).toBeNull();
  });

  it('parses prices up to the Network cap', () => {
    expect(parsePackagePrice('')).toEqual({ valid: true, amount: null });
    expect(parsePackagePrice(' 1,500 ')).toEqual({ valid: true, amount: 1500 });
    expect(parsePackagePrice('10000000')).toEqual({ valid: true, amount: 10_000_000 });
    expect(parsePackagePrice('10000001').valid).toBe(false);
    expect(parsePackagePrice('12.50').valid).toBe(false);
  });

  it('has templates for every platform and for bundles, never with prices', () => {
    for (const p of ['youtube', 'substack', 'linkedin', 'twitter', 'instagram', 'tiktok', 'podcast', 'twitch', 'website', null]) {
      const t = templatesFor(p);
      expect(t.length).toBeGreaterThan(1);
      for (const x of t) expect(Object.keys(x).sort()).toEqual(['description', 'title']);
    }
  });
});

describe('brand storefront', () => {
  const at = () =>
    renderAt('/admin/network/creators/mayabuilds', '/admin/network/creators/:handle', <NetworkCreatorStorefrontPage />);

  it('shows each channel with its stats and packages, and drops the separate Platforms card', async () => {
    at();
    await screen.findByText('Work with Maya');
    expect(screen.getByText('Synced from YouTube')).toBeTruthy();
    expect(screen.getByText('12.4K')).toBeTruthy();
    expect(screen.getByText('Self-reported')).toBeTruthy();
    expect(screen.getByText('Every Tuesday')).toBeTruthy();
    expect(screen.getByText('A weekly teardown of one developer tool.')).toBeTruthy();
    expect(screen.getByText('Across channels')).toBeTruthy();
    expect(screen.queryByText('Platforms')).toBeNull();
    expect(screen.getByRole('link', { name: /Public page/ }).getAttribute('href')).toBe('https://openpartner.dev/creators/mayabuilds');
  });

  it('books a package as a tracked deal, starting on that package', async () => {
    at();
    await screen.findByText('Dedicated video');
    expect(screen.queryByRole('button', { name: /Request/ })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Book →' })[0]!);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect((within(dialog).getByDisplayValue(/Dedicated video/) as HTMLSelectElement).value).toBe('a'));
  });
});

describe("the app's old public route", () => {
  it('forwards to the storefront on the public site', () => {
    renderAt('/creators/mayabuilds', '/creators/:handle', <CreatorPublicProfilePage />);
    expect(screen.getByRole('link', { name: /storefront/ }).getAttribute('href')).toBe('https://openpartner.dev/creators/mayabuilds');
    expect(requests).toEqual([]);
  });
});

describe('storefront editor', () => {
  it('adds a package from a template with the preview following the form', async () => {
    renderAt('/creator/storefront', '/creator/storefront', <CreatorStorefrontPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Dedicated video/ }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Dedicated video');
    expect((screen.getByLabelText('Platform') as HTMLSelectElement).value).toBe('youtube');

    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '4500' } });
    // The preview shows the unsaved package with its price.
    await waitFor(() => expect(screen.getAllByText('$4,500').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Add package' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.path === '/creators/me/packages')).toBe(true));
    const post = requests.find((r) => r.method === 'POST' && r.path === '/creators/me/packages')!;
    expect(post.body).toMatchObject({ title: 'Dedicated video', platform: 'youtube', priceAmount: 4500, currency: 'USD', published: true });
  });

  it('saves a channel pitch without touching the handle, URL or count', async () => {
    renderAt('/creator/storefront', '/creator/storefront', <CreatorStorefrontPage />);
    const buttons = await screen.findAllByRole('button', { name: 'Add pitch' });
    fireEvent.click(buttons[0]!);
    fireEvent.change(screen.getByLabelText('What your YouTube covers'), { target: { value: 'Dev tool reviews.' } });
    fireEvent.change(screen.getByLabelText('How often you publish'), { target: { value: 'Weekly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true));
    expect(requests.find((r) => r.method === 'PUT')).toMatchObject({
      path: '/creators/me/platforms/youtube',
      body: {
        handle: 'mayabuilds',
        followerCount: 48200,
        profileUrl: 'https://www.youtube.com/@mayabuilds',
        description: 'Dev tool reviews.',
        cadence: 'Weekly',
      },
    });
  });

  it('adds a channel not listed yet, then opens its pitch', async () => {
    renderAt('/creator/storefront', '/creator/storefront', <CreatorStorefrontPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Add a channel/ }));
    // Only platforms the creator hasn't listed are offered.
    const options = within(screen.getByLabelText('Channel')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).not.toContain('youtube');
    expect(options).not.toContain('substack');
    expect(options).toContain('tiktok');

    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'tiktok' } });
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: '@mayabuilds' } });
    fireEvent.change(screen.getByLabelText('Audience'), { target: { value: '15000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));

    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true));
    expect(requests.find((r) => r.method === 'PUT')).toMatchObject({
      path: '/creators/me/platforms/tiktok',
      body: { handle: '@mayabuilds', followerCount: 15000 },
    });
    // Straight on to the new channel's pitch.
    expect(await screen.findByLabelText('What your TikTok covers')).toBeTruthy();
  });

  it('hides Add a channel once every platform is listed', async () => {
    const all = ['tiktok', 'instagram', 'youtube', 'twitter', 'linkedin', 'substack', 'twitch', 'podcast', 'website'];
    storefront = { ...storefront, platforms: all.map((p) => ({ ...SUBSTACK, id: `cpf_${p}`, platform: p, description: null, cadence: null })) };
    renderAt('/creator/storefront', '/creator/storefront', <CreatorStorefrontPage />);
    await screen.findAllByRole('button', { name: 'Add pitch' });
    expect(screen.queryByRole('button', { name: /Add a channel/ })).toBeNull();
  });
});

describe('guided setup', () => {
  it('creates the ticked templates with their prices in one currency', async () => {
    storefront.packages = [pkg('existing', 'youtube', { title: 'Shoutout' })];
    renderAt('/creator/storefront/setup?step=packages', '/creator/storefront/setup', <CreatorStorefrontSetupPage />);

    // An existing package's template is already ticked and locked.
    const shoutout = (await screen.findByLabelText('Shoutout on YouTube')) as HTMLInputElement;
    expect(shoutout.checked).toBe(true);
    expect(shoutout.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Dedicated video on YouTube'));
    fireEvent.change(screen.getByLabelText('Dedicated video price'), { target: { value: '4500' } });
    fireEvent.click(screen.getByLabelText('Primary sponsor on Substack'));
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'EUR' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add 2 packages and continue' }));
    await waitFor(() => expect(requests.filter((r) => r.method === 'POST')).toHaveLength(2));
    const posts = requests.filter((r) => r.method === 'POST').map((r) => r.body);
    expect(posts).toEqual([
      expect.objectContaining({ title: 'Dedicated video', platform: 'youtube', priceAmount: 4500, currency: 'EUR' }),
      expect.objectContaining({ title: 'Primary sponsor', platform: 'substack', priceAmount: null, currency: 'EUR' }),
    ]);
    await screen.findByText('Brands you’ve worked with');
  });

  it('blocks a price over the cap', async () => {
    renderAt('/creator/storefront/setup?step=packages', '/creator/storefront/setup', <CreatorStorefrontSetupPage />);
    fireEvent.click(await screen.findByLabelText('Dedicated video on YouTube'));
    fireEvent.change(screen.getByLabelText('Dedicated video price'), { target: { value: '45004500' } });
    const add = screen.getByRole('button', { name: 'Add 1 package and continue' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(within(document.body).getByText(/up to 10,000,000/)).toBeTruthy();
  });
});
