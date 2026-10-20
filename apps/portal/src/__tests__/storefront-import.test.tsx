// @vitest-environment jsdom
/**
 * Storefront import from Passionfroot (the Network's
 * docs/creator-storefront.md §7.3): the guided setup's import step reads a
 * page, shows what it found against what the creator has, and applies the
 * ticked items; the ops console flags pages imported by another account and
 * can release the claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorStorefrontSetupPage } from '../pages/creator/CreatorStorefrontSetup.js';
import { CreatorsPage } from '../pages/platform/Creators.js';

const PLAN = {
  source: 'passionfroot',
  sourceKey: 'mira',
  sourceUrl: 'https://www.passionfroot.me/mira',
  displayName: 'Mira Okafor',
  bio: 'I write about tools for small teams.',
  avatarUrl: 'https://res.cloudinary.com/demo/mira.png',
  room: 2,
  unreadableSections: 1,
  pastBrands: ['Notion', 'Linear'],
  portfolioLinks: [],
  channels: [
    {
      key: 'ch:yt',
      platform: 'youtube',
      sourceLabel: 'Youtube',
      handle: 'miramakes',
      profileUrl: 'https://www.youtube.com/@MiraMakes',
      description: 'Tool reviews.',
      cadence: 'Weekly',
      followerCount: 12000,
      action: 'create',
      note: null,
      packages: [
        { key: 'pk:1', title: 'Integrated ad', description: null, platform: 'youtube', priceAmount: 1500, currency: 'USD', action: 'create', note: null },
        { key: 'pk:2', title: 'Dedicated video', description: null, platform: 'youtube', priceAmount: 4200, currency: 'USD', action: 'exists', note: 'You already have a package with this name.' },
        { key: 'pk:3', title: 'Short', description: null, platform: 'youtube', priceAmount: 300, currency: 'USD', action: 'create', note: null },
      ],
    },
    {
      key: 'ch:fb',
      platform: null,
      sourceLabel: 'Facebook',
      handle: null,
      profileUrl: null,
      description: null,
      cadence: null,
      followerCount: null,
      action: 'none',
      note: 'Facebook isn’t a channel type here yet, so its packages come in under “Across channels”.',
      packages: [
        { key: 'pk:4', title: 'Group post', description: null, platform: null, priceAmount: null, currency: 'USD', action: 'create', note: 'Price was hidden on Passionfroot, so it comes in as “on request”.' },
      ],
    },
  ],
};

let requests: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
let previewReply: { status: number; body: unknown } = { status: 200, body: { plan: PLAN } };

beforeEach(() => {
  requests = [];
  previewReply = { status: 200, body: { plan: PLAN } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const path = url.pathname.replace('/api/creator-api', '').replace(/^\/api/, '');
    requests.push({ method, path, body });
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/creators/me/storefront/import/preview') return json(previewReply.status, previewReply.body);
    if (path === '/creators/me/storefront/import/apply') {
      return json(200, { ok: true, channelsCreated: 1, channelsFilled: 0, packagesCreated: 2, packagesOverLimit: 0, bioSet: true, avatarSet: true, brandsAdded: 2, linksAdded: 0 });
    }
    if (path === '/creators/me/storefront') return json(200, { bookingsOpen: false, handle: 'mira', profileComplete: true, maxPackages: 12, packages: [], platforms: [] });
    if (path === '/creators/me/platforms') return json(200, { platforms: [] });
    if (path === '/creators/me') return json(200, { id: 'crt_1', email: 'mira@example.test', name: 'Mira Okafor', handle: 'mira', avatarUrl: null, pastBrands: [] });
    if (path === '/platform-admin/creators') {
      return json(200, {
        creators: [
          creatorRow('crt_copy', 'copycat@example.test', [{ role: 'refused', otherEmail: 'mira@example.test' }]),
          creatorRow('crt_mira', 'mira@example.test', [{ role: 'claimant', otherEmail: 'copycat@example.test' }]),
          creatorRow('crt_other', 'other@example.test', []),
        ],
      });
    }
    if (path.startsWith('/platform-admin/storefront-imports/') && method === 'DELETE') {
      return json(200, { ok: true, released: { source: 'passionfroot', sourceKey: 'mira', creatorId: 'crt_mira' } });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function creatorRow(id: string, email: string, conflicts: Array<{ role: 'refused' | 'claimant'; otherEmail: string }>) {
  return {
    id,
    email,
    name: email.split('@')[0],
    handle: null,
    status: 'active',
    avatarUrl: null,
    bio: null,
    categories: [],
    blockedAt: null,
    blockedReason: null,
    blockedByEmail: null,
    lastSignInAt: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    affiliationCount: 0,
    platformCount: 1,
    profileComplete: true,
    profileMissing: [],
    importConflicts: conflicts.map((c) => ({
      source: 'passionfroot',
      sourceKey: 'mira',
      claimId: 'sim_1',
      role: c.role,
      otherCreatorId: 'x',
      otherEmail: c.otherEmail,
      attempts: 2,
      lastAttemptAt: '2026-10-20T00:00:00.000Z',
    })),
  };
}

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

describe('setup: import from Passionfroot', () => {
  it('previews, ticks what’s new within the package room, and applies the choice', async () => {
    renderAt('/creator/storefront/setup?step=import', '/creator/storefront/setup', <CreatorStorefrontSetupPage />);
    fireEvent.change(await screen.findByLabelText('Your Passionfroot page'), { target: { value: 'passionfroot.me/mira' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find my storefront' }));

    await screen.findByText('Integrated ad');
    expect(requests.find((r) => r.path === '/creators/me/storefront/import/preview')?.body).toEqual({ url: 'passionfroot.me/mira' });
    expect(screen.getByText(/couldn’t read 1 section/)).toBeTruthy();
    expect(screen.getByText(/Facebook isn’t a channel type here yet/)).toBeTruthy();

    // New packages are ticked up to the 2 slots left; the existing one is locked.
    const box = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
    expect(box('Import Integrated ad').checked).toBe(true);
    expect(box('Import Short').checked).toBe(true);
    expect(box('Import Group post').checked).toBe(false);
    expect(box('Import Group post').disabled).toBe(true);
    expect(box('Import Dedicated video')).toMatchObject({ checked: true, disabled: true });

    // Swap one package, drop past work.
    fireEvent.click(box('Import Short'));
    fireEvent.click(box('Import Group post'));
    fireEvent.click(box('Import past collaborations'));
    fireEvent.click(screen.getByRole('button', { name: /Import \d+ items?/ }));

    await screen.findByText(/Imported 1 channel, 2 draft packages, your bio, your photo and 2 past brands/);
    expect(requests.find((r) => r.path === '/creators/me/storefront/import/apply')?.body).toEqual({
      url: 'passionfroot.me/mira',
      channels: ['ch:yt'],
      packages: ['pk:1', 'pk:4'],
      profile: true,
      pastWork: false,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Pitch each channel');
  });

  it('shows the Network’s reason when another account imported the page', async () => {
    previewReply = {
      status: 409,
      body: { error: 'import_claimed', detail: 'This Passionfroot page was already imported by another OpenPartner account.' },
    };
    renderAt('/creator/storefront/setup?step=import', '/creator/storefront/setup', <CreatorStorefrontSetupPage />);
    fireEvent.change(await screen.findByLabelText('Your Passionfroot page'), { target: { value: 'passionfroot.me/mira' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find my storefront' }));
    expect(await screen.findByText('This Passionfroot page was already imported by another OpenPartner account.')).toBeTruthy();
    expect(screen.queryByText(/import_claimed/)).toBeNull();
  });

  it('can be skipped', async () => {
    renderAt('/creator/storefront/setup?step=import', '/creator/storefront/setup', <CreatorStorefrontSetupPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip, I’m starting fresh' }));
    await screen.findByText('Pitch each channel');
    expect(requests.some((r) => r.path.includes('/import/'))).toBe(false);
  });
});

describe('ops console: import conflicts', () => {
  it('flags both accounts, filters them, and releases the claim', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAt('/platform/creators', '/platform/creators', <CreatorsPage operator={{ email: 'ops@example.test', role: 'admin' } as never} />);
    expect(await screen.findByText(/Tried to import passionfroot.me\/mira, already imported by mira@example.test/)).toBeTruthy();
    expect(screen.getByText(/Imported passionfroot.me\/mira; copycat@example.test tried to import it too/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Import conflicts (2)' }));
    expect(screen.queryByText('other@example.test')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Release claim' })[0]!);
    await waitFor(() => expect(requests.some((r) => r.method === 'DELETE' && r.path === '/platform-admin/storefront-imports/sim_1')).toBe(true));
    expect(await screen.findByText(/Released passionfroot.me\/mira/)).toBeTruthy();
  });

  it('read-only operators see the flag but no release button', async () => {
    renderAt('/platform/creators', '/platform/creators', <CreatorsPage operator={{ email: 'ops@example.test', role: 'support' } as never} />);
    await screen.findByText(/Tried to import passionfroot.me\/mira/);
    expect(screen.queryByRole('button', { name: 'Release claim' })).toBeNull();
  });
});
