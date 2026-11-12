// @vitest-environment jsdom
/**
 * A partner with their own Network account. The Network refuses a brand
 * acting for a creator who signed in to it themselves (403
 * invalid_acting_context, reason creator_account), so the brand API answers
 * its /network/me… reads with `ownNetworkAccount: true` and its writes with
 * 403 network_own_account. The partner's Network pages then point at their
 * own Network portal instead of saying the profile "is being set up":
 *   - Network profile: no editor, a link to the profile there;
 *   - no "complete your profile" banner;
 *   - an offering: a link to apply from there instead of the form;
 *   - My partnership and My applications: where those are, not "none yet".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Principal } from '../api.js';
import { MyAffiliationsPage } from '../pages/partner/MyAffiliations.js';
import { MyProfilePage } from '../pages/partner/MyProfile.js';
import { MyRequestsPage } from '../pages/partner/MyRequests.js';
import { NetworkProfileBanner } from '../pages/partner/NetworkProfileBanner.js';
import { OfferingDetailPage } from '../pages/partner/OfferingDetail.js';

const BRAND = {
  programName: 'Acme',
  supportEmail: null,
  logoUrl: null,
  brandColor: null,
  programTermsUrl: null,
  whiteLabel: false,
  partnerNetworkVisible: true,
};

const CONSENT = {
  offered: true,
  status: 'granted',
  source: 'portal_setting',
  consentedAt: '2026-10-01T09:00:00.000Z',
  withdrawnAt: null,
  declinedAt: null,
};

const OFFERING = {
  id: 'off_1',
  title: 'Globex Creators',
  description: null,
  productUrl: 'https://globex.example',
  vendorId: 'vnd_globex',
  vendorName: 'Globex',
  terms: {},
  createdAt: '2026-10-01T00:00:00.000Z',
};

const INCOMPLETE = {
  profileComplete: false,
  profileMissing: [{ field: 'avatar', label: 'Profile photo' }],
};

const partner: Principal = {
  role: 'partner',
  partnerId: 'p1',
  partner: { id: 'p1', name: 'Ada', email: 'ada@example.com', stripeConnected: false },
};

interface Call {
  method: string;
  url: string;
}
let calls: Call[] = [];
/** What GET /network/me/profile answers. */
let profile: Record<string, unknown>;
let applyResponse: () => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  window.sessionStorage.clear();
  profile = { notFederated: true, ownNetworkAccount: true };
  applyResponse = () => json(403, { error: 'network_own_account' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (url.endsWith('/network/offerings/off_1/apply') && method === 'POST') return applyResponse();
    if (url.endsWith('/network/offerings/off_1')) return json(200, OFFERING);
    if (url.endsWith('/network/me/consent')) return json(200, CONSENT);
    if (url.endsWith('/network/me/profile')) return json(200, profile);
    if (url.endsWith('/network/me/affiliations')) return json(200, { affiliations: [], ownNetworkAccount: true });
    if (url.endsWith('/network/me/requests')) return json(200, { requests: [], ownNetworkAccount: true });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderAt(path: string, element: React.ReactElement, routePath = path) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['program-settings'], BRAND);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const PORTAL = 'https://app.openpartner.dev/creator';

describe('Network profile page', () => {
  it('points to their own Network account instead of "being set up" or an editor', async () => {
    const page = renderAt('/network/profile', <MyProfilePage />);
    await page.findByText('Your Network profile is managed in your own Network account.');
    const link = page.getByRole('link', { name: 'Open your Network portal ↗' });
    expect(link.getAttribute('href')).toBe(`${PORTAL}/profile`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(page.queryByText(/being set up/)).toBeNull();
    // No editor: nothing to save, no platforms to list.
    expect(page.queryByRole('button', { name: 'Save profile' })).toBeNull();
    expect(page.queryByText('Platforms')).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/network/me/platforms'))).toBe(false);
    // They can still leave the Network from here.
    await page.findByRole('button', { name: 'Leave the Network' });
  });

  it('a partner whose push is still queued keeps the "being set up" card', async () => {
    profile = { notFederated: true };
    const page = renderAt('/network/profile', <MyProfilePage />);
    await page.findByText(/Your Network profile is being set up/);
    expect(page.queryByText(/your own Network account/)).toBeNull();
  });
});

describe('complete-your-profile banner', () => {
  it('stays hidden: the profile is finished in their Network account', async () => {
    profile = { ownNetworkAccount: true, ...INCOMPLETE };
    const page = renderAt('/network/discover', <NetworkProfileBanner isMobile={false} />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/network/me/profile'))).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(page.container.textContent).toBe('');
  });

  it('still shows for a partner the brand acts for', async () => {
    profile = INCOMPLETE;
    const page = renderAt('/network/discover', <NetworkProfileBanner isMobile={false} />);
    await page.findByText(/Your profile isn’t complete/);
  });
});

describe('an offering', () => {
  function renderOffering() {
    return renderAt('/network/offerings/off_1', <OfferingDetailPage principal={partner} />, '/network/offerings/:id');
  }

  it('links to the offering in their Network portal instead of the application form', async () => {
    const page = renderOffering();
    await page.findByText(/Apply from your own Network account\./);
    const link = page.getByRole('link', { name: 'Open this program there ↗' });
    expect(link.getAttribute('href')).toBe(`${PORTAL}/offerings/off_1`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(page.queryByRole('button', { name: 'Submit application' })).toBeNull();
    expect(page.queryByText(/Message to the vendor/)).toBeNull();
  });

  it('a refused application shows the same link, not a raw error', async () => {
    // The profile read was answered before they signed in to the Network.
    profile = { profileComplete: true };
    const page = renderOffering();
    fireEvent.click(await page.findByRole('button', { name: 'Submit application' }));
    await page.findByText(/Apply from your own Network account\./);
    expect(page.container.textContent).not.toMatch(/network_own_account|network_call_failed/);
    expect(page.queryByRole('button', { name: 'Submit application' })).toBeNull();
    expect(page.getByRole('link', { name: 'Open this program there ↗' }).getAttribute('href')).toBe(
      `${PORTAL}/offerings/off_1`,
    );
  });
});

describe('My partnership and My applications', () => {
  it('My partnership says where their partnerships are, not that there are none', async () => {
    const page = renderAt('/network/affiliations', <MyAffiliationsPage />);
    await page.findByText('Your partnerships are in your own Network account.');
    expect(page.queryByText('No Network partnership yet')).toBeNull();
    expect(page.getByRole('link', { name: 'Open your Network portal ↗' }).getAttribute('href')).toBe(
      `${PORTAL}/affiliations`,
    );
  });

  it('My applications says where their applications are, not that there are none', async () => {
    const page = renderAt('/network/my-requests', <MyRequestsPage />);
    await page.findByText('Your applications are in your own Network account.');
    expect(page.queryByText('No applications yet')).toBeNull();
    expect(page.getByRole('link', { name: 'Open your Network portal ↗' }).getAttribute('href')).toBe(
      `${PORTAL}/requests`,
    );
  });
});
