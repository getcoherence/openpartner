// @vitest-environment jsdom
/**
 * /creator/profile is three tabs, so Save profile is the last thing on the
 * Profile tab: Password and Account (data download + deletion) have tabs of
 * their own. Unsaved profile edits ask before an in-app link, Back, a reload
 * or a closed tab leaves them behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { BrowserRouter, createMemoryRouter, Route, RouterProvider, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorMyProfilePage } from '../pages/creator/CreatorMyProfile.js';
import { LEAVE_PROMPT, UnsavedChangesGuard } from '../lib/useUnsavedChanges.js';

const PROFILE = {
  id: 'crt_1',
  email: 'pat@example.com',
  name: 'Pat',
  handle: 'pat',
  avatarUrl: null,
  bio: 'I make weekly videos about design tools for indie founders.',
  profile: null,
  categories: ['design'],
  audienceLocations: [],
  audienceAgeRange: null,
  portfolioLinks: [],
  pastBrands: [],
  createdAt: '2026-10-01T00:00:00.000Z',
};

let profile: Record<string, unknown>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  profile = PROFILE;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/creators/me/platforms')) return json(200, { platforms: [] });
    if (url.endsWith('/creators/me/password')) return json(200, { hasPassword: true });
    if (url.endsWith('/creators/me/messages')) return json(200, { messages: [] });
    if (url.endsWith('/creators/me') && method === 'PATCH') {
      profile = { ...profile, ...(JSON.parse(String(init!.body)) as Record<string, unknown>) };
      return json(200, profile);
    }
    if (url.endsWith('/creators/me')) return json(200, profile);
    return json(200, { ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['creator-my-profile'], profile);
  return render(
    <BrowserRouter>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/creator/profile/*" element={<CreatorMyProfilePage />} />
        </Routes>
      </QueryClientProvider>
    </BrowserRouter>,
  );
}

/** Under a data router with the guard, as App renders it, coming from /creator/discover. */
function renderInDataRouter() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['creator-my-profile'], profile);
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <UnsavedChangesGuard />
            <Routes>
              <Route path="/creator/profile/*" element={<CreatorMyProfilePage />} />
              <Route path="*" element={<p>Elsewhere</p>} />
            </Routes>
          </>
        ),
      },
    ],
    { initialEntries: ['/creator/discover', '/creator/profile'], initialIndex: 1 },
  );
  const page = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, page };
}

function unloadPrevented(): boolean {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

describe('creator profile tabs', () => {
  it('ends the Profile tab with Save profile; password and deletion have their own tabs', async () => {
    const page = renderAt('/creator/profile');
    await waitFor(() => expect(page.getAllByRole('button').at(-1)!.textContent).toBe('Save profile'));
    expect(page.queryByText('Danger zone')).toBeNull();
    expect(page.queryByRole('button', { name: 'Change password' })).toBeNull();

    fireEvent.click(page.getByRole('link', { name: 'Password' }));
    expect(await page.findByRole('button', { name: 'Change password' })).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Save profile' })).toBeNull();
    expect(window.location.pathname).toBe('/creator/profile/password');

    fireEvent.click(page.getByRole('link', { name: 'Account' }));
    expect(page.getByText('Danger zone')).toBeTruthy();
    expect(page.getByRole('button', { name: 'Delete my account' })).toBeTruthy();
    expect(page.getByRole('link', { name: 'Download my data' })).toBeTruthy();
  });

  it('opens a tab from its own URL, and sends an unknown one to the profile', async () => {
    const account = renderAt('/creator/profile/account');
    expect(account.getByText('Danger zone')).toBeTruthy();
    cleanup();
    const unknown = renderAt('/creator/profile/nope');
    await waitFor(() => expect(window.location.pathname).toBe('/creator/profile'));
    expect(unknown.getByRole('button', { name: 'Save profile' })).toBeTruthy();
  });

  it('asks before a link leaves unsaved edits, and keeps them on cancel', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const page = renderAt('/creator/profile');
    fireEvent.change(page.getByDisplayValue('Pat'), { target: { value: 'Pat Lee' } });

    fireEvent.click(page.getByRole('link', { name: 'Password' }));
    expect(confirm).toHaveBeenCalledWith(LEAVE_PROMPT);
    expect(window.location.pathname).toBe('/creator/profile');
    expect(page.getByDisplayValue('Pat Lee')).toBeTruthy();

    confirm.mockReturnValue(true);
    fireEvent.click(page.getByRole('link', { name: 'Password' }));
    expect(window.location.pathname).toBe('/creator/profile/password');
  });

  it('asks the browser to confirm a reload while edits are unsaved', () => {
    const page = renderAt('/creator/profile');
    expect(unloadPrevented()).toBe(false);
    fireEvent.change(page.getByDisplayValue('Pat'), { target: { value: 'Pat Lee' } });
    expect(unloadPrevented()).toBe(true);
    fireEvent.change(page.getByDisplayValue('Pat Lee'), { target: { value: 'Pat' } });
    expect(unloadPrevented()).toBe(false);
  });

  it('counts a platform typed in but not added yet', async () => {
    const page = renderAt('/creator/profile');
    const picker = await page.findByLabelText('Platform to add');
    fireEvent.change(picker.parentElement!.querySelector('input')!, { target: { value: 'pat' } });
    expect(unloadPrevented()).toBe(true);
  });

  it('lets go without asking once the edits are saved', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const page = renderAt('/creator/profile');
    fireEvent.change(page.getByDisplayValue('Pat'), { target: { value: 'Pat Lee' } });
    expect(page.getByRole('button', { name: 'Save profile' })).toBeTruthy();
    fireEvent.click(page.getByRole('button', { name: 'Save profile' }));
    await page.findByRole('button', { name: 'Saved' });
    expect(unloadPrevented()).toBe(false);

    fireEvent.click(page.getByRole('link', { name: 'Account' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/creator/profile/account');
  });

  it('a new edit after saving reads Save profile again', async () => {
    const page = renderAt('/creator/profile');
    fireEvent.change(page.getByDisplayValue('Pat'), { target: { value: 'Pat Lee' } });
    fireEvent.click(page.getByRole('button', { name: 'Save profile' }));
    await page.findByRole('button', { name: 'Saved' });
    fireEvent.change(page.getByDisplayValue('Pat Lee'), { target: { value: 'Pat L.' } });
    expect(page.getByRole('button', { name: 'Save profile' })).toBeTruthy();
  });
});

describe('creator profile under the data router', () => {
  it('asks before Back leaves unsaved edits, and keeps them on cancel', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { router, page } = renderInDataRouter();
    fireEvent.change(page.getByDisplayValue('Pat'), { target: { value: 'Pat Lee' } });

    await act(() => router.navigate(-1));
    expect(confirm).toHaveBeenCalledWith(LEAVE_PROMPT);
    expect(router.state.location.pathname).toBe('/creator/profile');
    expect(page.getByDisplayValue('Pat Lee')).toBeTruthy();

    confirm.mockReturnValue(true);
    await act(() => router.navigate(-1));
    await waitFor(() => expect(router.state.location.pathname).toBe('/creator/discover'));
    expect(page.getByText('Elsewhere')).toBeTruthy();
  });

  it('goes Back without asking when nothing is unsaved', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { router } = renderInDataRouter();
    await act(() => router.navigate(-1));
    await waitFor(() => expect(router.state.location.pathname).toBe('/creator/discover'));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks once for an in-app link', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { router, page } = renderInDataRouter();
    fireEvent.change(page.getByDisplayValue('Pat'), { target: { value: 'Pat Lee' } });

    await act(async () => {
      fireEvent.click(page.getByRole('link', { name: 'Password' }));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/creator/profile');

    confirm.mockReturnValue(true);
    await act(async () => {
      fireEvent.click(page.getByRole('link', { name: 'Password' }));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/creator/profile/password'));
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
