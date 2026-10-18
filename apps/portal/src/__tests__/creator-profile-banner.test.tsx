// @vitest-environment jsdom
/**
 * App-wide "complete your profile" banner in the creator portal shell, and
 * the apply-page gate it pairs with. An incomplete profile is invisible to
 * brands and the Network refuses its applications, so every creator page
 * (except the profile page, which has the full checklist) says so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorShell } from '../pages/creator/CreatorShell.js';
import { missingFromProfile, profileIncompleteFrom } from '../lib/profile-incomplete.js';

const CHECKLIST_INCOMPLETE = [
  { field: 'handle', label: 'Handle', done: true },
  { field: 'avatar', label: 'Profile photo', done: false },
  { field: 'bio', label: 'Bio', done: true },
  { field: 'categories', label: 'Categories', done: false },
  { field: 'platforms', label: 'A social platform', done: true },
];

function profile(complete: boolean) {
  return {
    id: 'crt_1',
    email: 'ada@example.com',
    name: 'Ada',
    handle: 'ada',
    avatarUrl: null,
    bio: 'x'.repeat(50),
    profile: null,
    categories: [],
    audienceLocations: [],
    audienceAgeRange: null,
    audienceSize: null,
    portfolioLinks: [],
    pastBrands: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    profileComplete: complete,
    profileMissing: complete ? [] : CHECKLIST_INCOMPLETE.filter((i) => !i.done).map(({ field, label }) => ({ field, label })),
    profileChecklist: complete ? CHECKLIST_INCOMPLETE.map((i) => ({ ...i, done: true })) : CHECKLIST_INCOMPLETE,
  };
}

let me: ReturnType<typeof profile>;
let meCalls = 0;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  window.sessionStorage.clear();
  me = profile(false);
  meCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/creator-api/creators/whoami')) {
      return json(200, { creator: { id: 'crt_1', name: 'Ada', email: 'ada@example.com', handle: 'ada', avatarUrl: null, bio: null } });
    }
    if (url.endsWith('/creator-api/creators/me')) {
      meCalls += 1;
      return json(200, me);
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderShell(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/creator/*" element={<CreatorShell />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('creator shell profile banner', () => {
  it('shows progress and the missing items while the profile is incomplete', async () => {
    const page = renderShell('/creator/requests');
    const banner = await page.findByRole('region', { name: 'Complete your profile' });
    expect(banner.textContent).toContain('Your profile is 3 of 5 complete.');
    expect(banner.textContent).toContain("Brands can’t find you, and you can’t apply to programs, until it’s finished.");
    expect(banner.textContent).toContain('Still missing: Profile photo, Categories.');
    const cta = page.getByRole('link', { name: 'Complete profile' });
    expect(cta.getAttribute('href')).toBe('/creator/profile');
  });

  it('is hidden once the profile is complete', async () => {
    me = profile(true);
    const page = renderShell('/creator/requests');
    await page.findByRole('link', { name: /My applications/ });
    // Let the /creators/me query settle before asserting absence.
    await waitFor(() => expect(meCalls).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(page.queryByRole('region', { name: 'Complete your profile' })).toBeNull();
  });

  it('is hidden on the profile page itself', async () => {
    const page = renderShell('/creator/profile');
    // The profile page's own checklist renders from the same query.
    await page.findByText('Your profile is hidden from brands');
    expect(page.queryByRole('region', { name: 'Complete your profile' })).toBeNull();
  });

  it('dismisses for the session only', async () => {
    const page = renderShell('/creator/requests');
    await page.findByRole('region', { name: 'Complete your profile' });
    fireEvent.click(page.getByRole('button', { name: 'Dismiss for this session' }));
    expect(page.queryByRole('region', { name: 'Complete your profile' })).toBeNull();
    expect(window.sessionStorage.getItem('op:creator-profile-banner-dismissed')).toBe('1');
    expect(window.localStorage.getItem('op:creator-profile-banner-dismissed')).toBeNull();
  });
});

describe('apply gate helpers', () => {
  it('reads profile_incomplete from both proxy shapes', () => {
    const missing = [{ field: 'bio', label: 'Bio' }];
    // Creator proxy: the Network body passes through.
    expect(profileIncompleteFrom({ status: 409, detail: { error: 'profile_incomplete', missing } })).toEqual(missing);
    // Brand partner proxy: wrapped as text.
    expect(
      profileIncompleteFrom({
        status: 409,
        detail: { error: 'network_call_failed', detail: JSON.stringify({ error: 'profile_incomplete', missing }) },
      }),
    ).toEqual(missing);
    // Truncated upstream body: still recognised, without labels.
    expect(
      profileIncompleteFrom({ status: 409, detail: { error: 'network_call_failed', detail: '{"error":"profile_incomplete","missing":[{"fi' } }),
    ).toEqual([]);
    expect(profileIncompleteFrom({ status: 409, detail: { error: 'request_already_exists' } })).toBeNull();
    expect(profileIncompleteFrom({ status: 400, detail: { error: 'profile_incomplete' } })).toBeNull();
    expect(profileIncompleteFrom(new Error('boom'))).toBeNull();
  });

  it('derives the up-front block from the checklist, never from an older Network', () => {
    expect(missingFromProfile(profile(false))).toEqual([
      { field: 'avatar', label: 'Profile photo' },
      { field: 'categories', label: 'Categories' },
    ]);
    expect(missingFromProfile(profile(true))).toBeNull();
    expect(missingFromProfile({})).toBeNull();
    expect(missingFromProfile(undefined)).toBeNull();
  });
});
