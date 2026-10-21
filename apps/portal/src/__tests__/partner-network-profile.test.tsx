// @vitest-environment jsdom
/**
 * A brand partner can finish every Network completeness item from the
 * brand portal: the partner Network profile page renders the same editor
 * as the creator portal (checklist, categories, audience incl. size,
 * platforms, portfolio), wired to the brand's /network/me… proxies. The
 * creator page keeps using /api/creator-api. Both edit the cover image (the
 * storefront card's banner), once the Network reports the field.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MyProfilePage } from '../pages/partner/MyProfile.js';
import { CreatorMyProfilePage } from '../pages/creator/CreatorMyProfile.js';

const PROFILE = {
  id: 'crt_1',
  email: 'pat@example.com',
  name: 'Pat',
  handle: 'pat',
  avatarUrl: null,
  bio: 'I make weekly videos about design tools for indie founders.',
  profile: null,
  categories: [],
  audienceLocations: [],
  audienceAgeRange: null,
  audienceSize: null,
  portfolioLinks: [],
  pastBrands: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  profileComplete: false,
  profileMissing: [
    { field: 'avatar', label: 'Profile photo' },
    { field: 'categories', label: 'At least one category' },
    { field: 'platforms', label: 'At least one platform' },
  ],
  profileChecklist: [
    { field: 'handle', label: 'Handle', done: true },
    { field: 'avatar', label: 'Profile photo', done: false },
    { field: 'bio', label: 'Bio (40+ characters)', done: true },
    { field: 'categories', label: 'At least one category', done: false },
    { field: 'platforms', label: 'At least one platform', done: false },
  ],
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (url.endsWith('/platforms') && method === 'GET') return json(200, { platforms: [] });
    // Refetch after a save: the profile endpoints answer with the profile.
    if ((url.endsWith('/network/me/profile') || url.endsWith('/creators/me')) && method === 'GET') return json(200, PROFILE);
    if (url.endsWith('/uploads/cover')) return json(200, { coverImageUrl: 'https://cdn.example.com/new-cover.png' });
    return json(200, { ok: true });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderWith(ui: React.ReactElement, key: string, profile: Record<string, unknown> = PROFILE) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData([key], profile);
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('partner Network profile page', () => {
  it('renders the checklist, categories, audience and platforms editors', async () => {
    const page = renderWith(<MyProfilePage />, 'network-my-profile');
    expect(page.getByText('Your profile is hidden from brands')).toBeTruthy();
    expect(page.getByText('Categories')).toBeTruthy();
    expect(page.getByRole('button', { name: 'design' })).toBeTruthy();
    expect(page.getByLabelText('Audience size')).toBeTruthy();
    expect(page.getByText('Portfolio')).toBeTruthy();
    expect(page.getByText('Platforms')).toBeTruthy();
    await waitFor(() => expect(page.getByText('YouTube')).toBeTruthy());
    expect(page.getAllByRole('button', { name: 'Add' }).length).toBe(9);
    expect(calls.some((c) => c.method === 'GET' && c.url === '/api/network/me/platforms')).toBe(true);
  });

  it('saves categories + audience size and adds platforms through the brand proxies', async () => {
    const page = renderWith(<MyProfilePage />, 'network-my-profile');
    fireEvent.click(page.getByRole('button', { name: 'design' }));
    fireEvent.change(page.getByLabelText('Audience size'), { target: { value: '10k_50k' } });
    fireEvent.click(page.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/network/me/profile');
    expect(patch.body).toMatchObject({ categories: ['design'], audienceSize: '10k_50k', handle: 'pat' });

    await waitFor(() => expect(page.getByText('YouTube')).toBeTruthy());
    const youtube = page.getByText('YouTube').parentElement!;
    fireEvent.change(youtube.querySelector('input')!, { target: { value: 'pat' } });
    fireEvent.click(youtube.querySelector('button')!);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/network/me/platforms/youtube');
    expect(put.body).toEqual({ handle: 'pat', followerCount: null });
  });

  it('an opted-in partner whose push is still queued sees it being set up, not an editor', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(['network-my-profile'], { notFederated: true });
    const page = render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <MyProfilePage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(page.getByText(/Your Network profile is being set up/)).toBeTruthy();
    expect(page.queryByText('Platforms')).toBeNull();
  });
});

describe('creator profile page (same editor, creator endpoints)', () => {
  it('still saves to /api/creator-api and keeps its public-profile link', async () => {
    const page = renderWith(<CreatorMyProfilePage />, 'creator-my-profile');
    expect(page.getByRole('link', { name: /View public profile/ }).getAttribute('href')).toBe('https://openpartner.dev/creators/pat');
    fireEvent.click(page.getByRole('button', { name: 'tech' }));
    fireEvent.click(page.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.url).toBe('/api/creator-api/creators/me');
    expect(calls.some((c) => c.url === '/api/creator-api/creators/me/platforms')).toBe(true);
  });

  async function savedBody(page: ReturnType<typeof renderWith>): Promise<Record<string, unknown>> {
    fireEvent.click(page.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    return calls.find((c) => c.method === 'PATCH')!.body as Record<string, unknown>;
  }

  it('edits the cover image and saves its removal as null', async () => {
    const page = renderWith(<CreatorMyProfilePage />, 'creator-my-profile', {
      ...PROFILE,
      coverImageUrl: 'https://cdn.example.com/cover.png',
    });
    expect(page.getByText('Cover image (optional)')).toBeTruthy();
    fireEvent.click(page.getByRole('button', { name: 'Remove' }));
    expect(await savedBody(page)).toMatchObject({ coverImageUrl: null });
  });

  it('leaves the cover out on a Network that predates it', async () => {
    const page = renderWith(<CreatorMyProfilePage />, 'creator-my-profile');
    expect(page.queryByText('Cover image (optional)')).toBeNull();
    expect(await savedBody(page)).not.toHaveProperty('coverImageUrl');
  });

  it('the partner page uploads the cover through the brand proxy and saves it', async () => {
    const page = renderWith(<MyProfilePage />, 'network-my-profile', { ...PROFILE, coverImageUrl: null });
    expect(page.getByText('Cover image (optional)')).toBeTruthy();
    const cover = page.getByText('Cover image (optional)').parentElement!;
    const file = new File([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' });
    fireEvent.change(cover.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(cover.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/new-cover.png'));
    const upload = calls.find((c) => c.url.endsWith('/uploads/cover'))!;
    expect(upload).toMatchObject({ method: 'POST', url: '/api/network/me/uploads/cover' });
    const body = await savedBody(page);
    expect(calls.find((c) => c.method === 'PATCH')!.url).toBe('/api/network/me/profile');
    expect(body).toMatchObject({ coverImageUrl: 'https://cdn.example.com/new-cover.png' });
  });

  it('the partner page leaves the cover out on a Network that predates it', async () => {
    const page = renderWith(<MyProfilePage />, 'network-my-profile');
    expect(page.queryByText('Cover image (optional)')).toBeNull();
    expect(await savedBody(page)).not.toHaveProperty('coverImageUrl');
  });
});
