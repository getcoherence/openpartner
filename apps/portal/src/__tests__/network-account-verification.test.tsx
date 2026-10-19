// @vitest-environment jsdom
/**
 * Verified Network accounts in the portal:
 *
 *   - the profile editor offers Verify on unverified YouTube / website rows
 *     and a Verified badge once the Network says so;
 *   - the 3-step dialog (copy code, open channel, verify) runs through
 *     either proxy and explains the Network's refusals;
 *   - a follower-count edit sends the stored profileUrl back, so it can't
 *     silently unverify the account;
 *   - brands can filter the creator directory to verified accounts.
 *
 * The Network is a fetch stub; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, configure, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MyProfilePage } from '../pages/partner/MyProfile.js';
import { CreatorMyProfilePage } from '../pages/creator/CreatorMyProfile.js';
import { AdminNetworkCreators } from '../pages/admin/NetworkCreators.js';

// The first render of the full editor is slow when the whole suite runs in
// parallel; the 1s default makes the first test flaky.
configure({ asyncUtilTimeout: 5000 });

const PROFILE = {
  id: 'crt_1',
  email: 'pat@example.com',
  name: 'Pat',
  handle: 'pat',
  avatarUrl: 'https://cdn.example/pat.png',
  bio: 'I make weekly videos about design tools for indie founders.',
  profile: null,
  categories: ['design'],
  audienceLocations: [],
  audienceAgeRange: null,
  audienceSize: null,
  portfolioLinks: [],
  pastBrands: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  profileComplete: true,
};

const row = (platform: string, extra: Record<string, unknown> = {}) => ({
  id: `cpf_${platform}`,
  platform,
  handle: 'pat',
  profileUrl: null,
  followerCount: 1200,
  verified: false,
  verifiedAt: null,
  verificationMethod: null,
  ...extra,
});

const START = {
  platform: 'youtube',
  method: 'bio_code',
  code: '048213',
  expiresAt: '2026-10-19T12:00:00.000Z',
  instructions: {
    kind: 'youtube_description',
    editUrl: 'https://studio.youtube.com/',
    channelUrl: 'https://www.youtube.com/@pat',
    text: '048213',
  },
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[] = [];
let platforms: unknown[] = [];
/** Answers for successive POST .../verify calls. */
let checkAnswers: Array<{ status: number; body: unknown }> = [];
let startAnswer: { status: number; body: unknown } = { status: 200, body: START };
let directory: unknown[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  platforms = [];
  checkAnswers = [];
  startAnswer = { status: 200, body: START };
  directory = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (url.endsWith('/platforms') && method === 'GET') return json(200, { platforms });
    if (url.endsWith('/verify/start')) return json(startAnswer.status, startAnswer.body);
    if (url.endsWith('/verify')) {
      const next = checkAnswers.shift() ?? { status: 200, body: { ok: true } };
      return json(next.status, next.body);
    }
    if (url.includes('/admin/network/discover/creators')) return json(200, { creators: directory });
    if ((url.endsWith('/network/me/profile') || url.endsWith('/creators/me')) && method === 'GET') return json(200, PROFILE);
    return json(200, { ok: true });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

function renderWith(ui: React.ReactElement, key?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (key) qc.setQueryData([key], PROFILE);
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

async function platformRow(page: ReturnType<typeof render>, label: string) {
  await waitFor(() => expect(page.getByText(label)).toBeTruthy());
  return page.getByText(label).parentElement!;
}

describe('profile editor: verify buttons and badges', () => {
  it('offers Verify on unverified YouTube and website rows only', async () => {
    platforms = [row('youtube'), row('website', { handle: 'pat.dev' }), row('tiktok')];
    const page = renderWith(<CreatorMyProfilePage />, 'creator-my-profile');
    await waitFor(() => expect(page.getAllByRole('button', { name: 'Verify' })).toHaveLength(2));
    expect(within(await platformRow(page, 'TikTok')).queryByRole('button', { name: 'Verify' })).toBeNull();
  });

  it('shows a Verified badge instead of the button once verified', async () => {
    platforms = [row('youtube', { verified: true, verificationMethod: 'bio_code' })];
    const page = renderWith(<CreatorMyProfilePage />, 'creator-my-profile');
    const youtube = await platformRow(page, 'YouTube');
    await waitFor(() => expect(within(youtube).getByText('Verified')).toBeTruthy());
    expect(within(youtube).queryByRole('button', { name: 'Verify' })).toBeNull();
  });

  it('disables Verify while the row has unsaved edits', async () => {
    platforms = [row('youtube')];
    const page = renderWith(<CreatorMyProfilePage />, 'creator-my-profile');
    const youtube = await platformRow(page, 'YouTube');
    await waitFor(() => expect(within(youtube).getByRole('button', { name: 'Verify' })).toBeTruthy());
    fireEvent.change(youtube.querySelector('input')!, { target: { value: 'someone-else' } });
    expect((within(youtube).getByRole('button', { name: 'Verify' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a follower-count edit keeps the stored profile URL', async () => {
    platforms = [row('youtube', { handle: 'ucabc', profileUrl: 'https://www.youtube.com/channel/UCAbC', verified: true })];
    const page = renderWith(<MyProfilePage />, 'network-my-profile');
    const youtube = await platformRow(page, 'YouTube');
    await waitFor(() => expect((youtube.querySelectorAll('input')[1] as HTMLInputElement).value).toBe('1200'));
    fireEvent.change(youtube.querySelectorAll('input')[1]!, { target: { value: '5000' } });
    fireEvent.click(within(youtube).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      handle: 'ucabc',
      followerCount: 5000,
      profileUrl: 'https://www.youtube.com/channel/UCAbC',
    });
  });
});

describe('Verify YouTube account dialog', () => {
  it('walks copy code → open channel → verify through the creator proxy', async () => {
    platforms = [row('youtube')];
    checkAnswers = [
      { status: 409, body: { error: 'code_not_found', detail: 'Code 048213 isn’t in the channel description yet.' } },
      { status: 200, body: { ok: true, platform: row('youtube', { verified: true }) } },
    ];
    const page = renderWith(<CreatorMyProfilePage />, 'creator-my-profile');
    fireEvent.click(await waitFor(() => page.getByRole('button', { name: 'Verify' })));

    const dialog = await waitFor(() => page.getByRole('dialog', { name: 'Verify YouTube account' }));
    await waitFor(() => expect(within(dialog).getByText('048213')).toBeTruthy());
    expect(calls.find((c) => c.url.endsWith('/verify/start'))!).toMatchObject({
      method: 'POST',
      url: '/api/creator-api/creators/me/platforms/youtube/verify/start',
    });
    expect(within(dialog).getByText('Copy your code')).toBeTruthy();
    expect(within(dialog).getByText('Add it to your channel description')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: /Open YouTube Studio/ }).getAttribute('href')).toBe('https://studio.youtube.com/');
    expect(within(dialog).getByRole('link', { name: /View channel/ }).getAttribute('href')).toBe('https://www.youtube.com/@pat');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(within(dialog).getByText(/isn’t in the channel description yet/)).toBeTruthy());

    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(within(dialog).getByText(/Your YouTube account is verified/)).toBeTruthy());
    expect(calls.filter((c) => c.url === '/api/creator-api/creators/me/platforms/youtube/verify')).toHaveLength(2);
    // The platform list refreshes so the row picks up its badge.
    expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('/creators/me/platforms')).length).toBeGreaterThan(1);
  });

  it('unwraps the brand proxy’s errors into the Network’s reason', async () => {
    platforms = [row('youtube')];
    checkAnswers = [
      { status: 429, body: { error: 'network_call_failed', detail: JSON.stringify({ error: 'too_many_attempts', retryAfterSeconds: 1500 }) } },
    ];
    const page = renderWith(<MyProfilePage />, 'network-my-profile');
    fireEvent.click(await waitFor(() => page.getByRole('button', { name: 'Verify' })));
    const dialog = await waitFor(() => page.getByRole('dialog'));
    await waitFor(() => expect(within(dialog).getByText('048213')).toBeTruthy());
    expect(calls.some((c) => c.url === '/api/network/me/platforms/youtube/verify/start')).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(within(dialog).getByText('Too many checks for now. Try again in 25 minutes.')).toBeTruthy());
  });

  it('offers a new code when the old one expired', async () => {
    platforms = [row('youtube')];
    checkAnswers = [{ status: 409, body: { error: 'code_expired', detail: 'This code has expired.' } }];
    const page = renderWith(<CreatorMyProfilePage />, 'creator-my-profile');
    fireEvent.click(await waitFor(() => page.getByRole('button', { name: 'Verify' })));
    const dialog = await waitFor(() => page.getByRole('dialog'));
    await waitFor(() => expect(within(dialog).getByText('048213')).toBeTruthy());

    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify' }));
    startAnswer = { status: 200, body: { ...START, code: '771100', instructions: { ...START.instructions, text: '771100' } } };
    fireEvent.click(await waitFor(() => within(dialog).getByRole('button', { name: 'Get a new code' })));
    await waitFor(() => expect(within(dialog).getByText('771100')).toBeTruthy());
    expect(calls.filter((c) => c.url.endsWith('/verify/start'))).toHaveLength(2);
  });

  it('says so when YouTube verification is not configured', async () => {
    platforms = [row('youtube')];
    startAnswer = {
      status: 503,
      body: { error: 'verification_not_configured', detail: 'YouTube verification is not configured on this Network yet.' },
    };
    const page = renderWith(<CreatorMyProfilePage />, 'creator-my-profile');
    fireEvent.click(await waitFor(() => page.getByRole('button', { name: 'Verify' })));
    const dialog = await waitFor(() => page.getByRole('dialog'));
    await waitFor(() => expect(within(dialog).getByText('YouTube verification is not configured on this Network yet.')).toBeTruthy());
  });

  it('shows the DNS record for a website', async () => {
    platforms = [row('website', { handle: 'https://www.pat.dev' })];
    startAnswer = {
      status: 200,
      body: {
        platform: 'website',
        method: 'dns',
        code: '048213',
        expiresAt: START.expiresAt,
        instructions: { kind: 'dns_txt', host: 'pat.dev', type: 'TXT', value: 'openpartner-verify=048213' },
      },
    };
    const page = renderWith(<CreatorMyProfilePage />, 'creator-my-profile');
    fireEvent.click(await waitFor(() => page.getByRole('button', { name: 'Verify' })));
    const dialog = await waitFor(() => page.getByRole('dialog', { name: 'Verify website' }));
    await waitFor(() => expect(within(dialog).getByText('openpartner-verify=048213')).toBeTruthy());
    expect(within(dialog).getByText('pat.dev')).toBeTruthy();
  });

  it('docks to the bottom of the screen on mobile', async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    platforms = [row('youtube')];
    const page = renderWith(<CreatorMyProfilePage />, 'creator-my-profile');
    fireEvent.click(await waitFor(() => page.getByRole('button', { name: 'Verify' })));
    const dialog = await waitFor(() => page.getByRole('dialog'));
    expect(dialog.style.alignItems).toBe('flex-end');
    expect((dialog.firstElementChild as HTMLElement).style.width).toBe('100%');
  });
});

describe('brand creator directory', () => {
  it('filters to verified accounts and badges verified platforms', async () => {
    directory = [
      {
        id: 'crt_1',
        name: 'Pat',
        handle: 'pat',
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
        createdAt: '2026-10-01T00:00:00.000Z',
        platforms: [row('youtube', { verified: true }), row('tiktok')],
        totalReach: 2400,
      },
    ];
    const page = renderWith(<AdminNetworkCreators />);
    await waitFor(() => expect(page.getByText('@pat')).toBeTruthy());
    expect(page.getAllByRole('img', { name: 'Verified' })).toHaveLength(1);

    fireEvent.click(page.getByLabelText(/Verified accounts only/));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/admin/network/discover/creators?') && c.url.includes('verified=true'))).toBe(true),
    );
  });
});
