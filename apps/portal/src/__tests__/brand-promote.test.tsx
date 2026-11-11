// @vitest-environment jsdom
/**
 * Promote: a brand joining other brands' programs, entirely inside its own
 * admin portal (docs/network-protocol.md).
 *
 *   - The creator portal's pages run in two places. Under /creator they
 *     call the creator proxy and link within /creator, exactly as before;
 *     under a brand's Promote area they call that brand's API and link
 *     within the area.
 *   - Admin → Network → Promote sets the brand's promoter profile up with
 *     one of the brand's admins' addresses.
 *   - Once set up, the Promote area serves the promoter's pages.
 *   - A view-only seat gets no setup form.
 *   - Requests marks an applicant that is a brand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Principal } from '../api.js';
import { ViewOnlyProvider } from '../lib/viewOnly.js';
import { AdminNetworkPromote } from '../pages/admin/NetworkPromote.js';
import { AdminNetworkRequests } from '../pages/admin/NetworkRequests.js';
import { creatorApi, creatorPath, inPromoteArea, promoteAreaPrefix } from '../pages/creator/creator-api.js';

const PROFILE = {
  creatorId: 'crt_brand',
  email: 'partnerships@acme.test',
  name: 'Acme',
  handle: 'acme',
  avatarUrl: null,
  profileComplete: true,
  profileMissing: [],
  active: true,
};

const SETUP = {
  profile: null,
  contacts: [
    { email: 'owner@acme.test', name: 'Owen Owner' },
    { email: 'partnerships@acme.test', name: 'Partnerships' },
  ],
  suggestedWebsite: 'https://www.acme.test',
};

interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
let sent: Sent[] = [];
/** What GET /admin/network/brand-profile answers. */
let state: Record<string, unknown>;
let putAnswer: () => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  sent = [];
  state = SETUP;
  putAnswer = () => {
    state = { profile: PROFILE, contacts: [], suggestedWebsite: null };
    return json(200, { profile: PROFILE });
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    sent.push({ method, path, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    if (path.endsWith('/admin/network/brand-profile') && method === 'GET') return json(200, state);
    if (path.endsWith('/admin/network/brand-profile') && method === 'PUT') return putAnswer();
    if (path.endsWith('/admin/network/requests')) {
      return json(200, {
        requests: [
          { id: 'req_1', status: 'pending', message: null, preferredSlug: null, createdAt: '2026-11-10T00:00:00.000Z', creatorId: 'crt_brand', creatorEmail: 'partnerships@acme.test', creatorName: 'Acme', creatorHandle: 'acme', creatorBio: null, creatorKind: 'brand', offeringId: 'off_1', offeringTitle: 'Pro' },
          { id: 'req_2', status: 'pending', message: null, preferredSlug: null, createdAt: '2026-11-10T00:00:00.000Z', creatorId: 'crt_ada', creatorEmail: 'ada@example.test', creatorName: 'Ada', creatorHandle: 'ada', creatorBio: null, creatorKind: 'person', offeringId: 'off_1', offeringTitle: 'Pro' },
        ],
      });
    }
    // The promoter's own applications, through either transport.
    if (path.endsWith('/creators/me/requests')) {
      return json(200, {
        requests: [
          { id: 'req_9', status: 'pending', message: null, preferredSlug: null, decisionNote: null, createdAt: '2026-11-10T00:00:00.000Z', decidedAt: null, offeringId: 'off_7', offeringTitle: 'Shopwise partners', vendorId: 'vnd_2', vendorName: 'Shopwise' },
        ],
      });
    }
    return json(200, { ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const ADMIN = { role: 'admin', admin: { role: 'admin' } } as unknown as Principal;
const VIEWER = { role: 'admin', admin: { role: 'viewer' } } as unknown as Principal;

/** The Promote route as App mounts it, at `at` (also the browser's address,
 *  which is what the pages read their place from). */
function renderPromote(at = '/t/acme/admin/network/promote', principal: Principal = ADMIN) {
  window.history.replaceState(null, '', at);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[at]}>
      <QueryClientProvider client={qc}>
        <ViewOnlyProvider principal={principal}>
          <Routes>
            <Route path="/t/:slug/admin/network/promote/*" element={<AdminNetworkPromote />} />
          </Routes>
        </ViewOnlyProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('the creator pages know where they are', () => {
  const at = (path: string) => window.history.replaceState(null, '', path);

  it('is the creator portal everywhere but a Promote area', async () => {
    for (const path of [
      '/creator/discover',
      '/creator/profile/password',
      '/creators/ada',
      '/signin',
      '/',
      '/t/acme/login',
      '/t/acme/admin/network/requests',
      '/t/acme/admin/network/creators/ada',
      '/t/acme/admin/network/promoters',
      '/t/acme/network/discover',
      '/admin/network/bookings',
    ]) {
      at(path);
      expect(promoteAreaPrefix(), path).toBeNull();
      expect(inPromoteArea(), path).toBe(false);
      expect(creatorPath('/offerings/off_1'), path).toBe('/creator/offerings/off_1');
      sent = [];
      await creatorApi('/creators/me');
      expect(sent[0]!.path, path).toBe('/api/creator-api/creators/me');
    }
  });

  it("is the brand's own area and API inside one", async () => {
    at('/t/acme/admin/network/promote/discover');
    expect(promoteAreaPrefix()).toBe('/t/acme');
    expect(creatorPath('/offerings/off_1')).toBe('/t/acme/admin/network/promote/offerings/off_1');
    await creatorApi('/offerings/off_1/apply', { method: 'POST', body: { message: 'hi' } });
    expect(sent.at(-1)).toEqual({ method: 'POST', path: '/api/t/acme/admin/network/promoter-api/offerings/off_1/apply', body: { message: 'hi' } });

    // A single-tenant install has no /t/<slug>.
    at('/admin/network/promote');
    expect(promoteAreaPrefix()).toBe('');
    expect(creatorPath('/links')).toBe('/admin/network/promote/links');
    await creatorApi('/creators/me');
    expect(sent.at(-1)!.path).toBe('/api/admin/network/promoter-api/creators/me');
  });
});

describe('Promote: setting the profile up', () => {
  it("offers the brand's admins' addresses and a website, and creates the profile", async () => {
    const page = renderPromote();
    const email = (await page.findByLabelText('Contact email')) as HTMLSelectElement;
    expect([...email.options].map((o) => o.value)).toEqual(['owner@acme.test', 'partnerships@acme.test']);
    expect(email.value).toBe('owner@acme.test');
    expect((page.getByLabelText('Website') as HTMLInputElement).value).toBe('https://www.acme.test');

    fireEvent.change(email, { target: { value: 'partnerships@acme.test' } });
    fireEvent.click(page.getByRole('button', { name: 'Start promoting' }));

    await waitFor(() => expect(sent.some((s) => s.method === 'PUT')).toBe(true));
    expect(sent.find((s) => s.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/api/t/acme/admin/network/brand-profile',
      body: { email: 'partnerships@acme.test', websiteUrl: 'https://www.acme.test' },
    });
    // The form gives way to the promoter's pages, in place.
    await waitFor(() => expect(page.queryByLabelText('Contact email')).toBeNull());
  });

  it('leaves the website out when the field is empty', async () => {
    const page = renderPromote();
    fireEvent.change(await page.findByLabelText('Website'), { target: { value: '  ' } });
    fireEvent.click(page.getByRole('button', { name: 'Start promoting' }));
    await waitFor(() => expect(sent.some((s) => s.method === 'PUT')).toBe(true));
    expect(sent.find((s) => s.method === 'PUT')!.body).toEqual({ email: 'owner@acme.test' });
  });

  it('says in plain words why an address was refused', async () => {
    putAnswer = () => json(409, { error: 'email_taken' });
    const page = renderPromote();
    fireEvent.click(await page.findByRole('button', { name: 'Start promoting' }));
    expect(await page.findByText('That address already has a creator account. Pick another admin.')).toBeTruthy();
    // Still the form: nothing was created.
    expect(page.getByLabelText('Contact email')).toBeTruthy();
  });

  it('shows a view-only seat no form', async () => {
    state = { profile: null, contacts: [], suggestedWebsite: null };
    const page = renderPromote('/t/acme/admin/network/promote', VIEWER);
    expect(await page.findByText('Not set up yet.')).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Start promoting' })).toBeNull();
  });
});

describe('Promote: the promoter pages, inside the brand admin', () => {
  it("serves the promoter's applications from the brand's own API, with links that stay in the area", async () => {
    state = { profile: PROFILE, contacts: [], suggestedWebsite: null };
    const page = renderPromote('/t/acme/admin/network/promote/requests');

    const program = (await page.findByRole('link', { name: 'Shopwise partners' })) as HTMLAnchorElement;
    expect(program.getAttribute('href')).toBe('/t/acme/admin/network/promote/offerings/off_7');
    expect(sent.some((s) => s.path === '/api/t/acme/admin/network/promoter-api/creators/me/requests')).toBe(true);
    // Nothing here went to the creator portal's proxy.
    expect(sent.some((s) => s.path.startsWith('/api/creator-api'))).toBe(false);
  });

  it('holds the pages back while the profile is on hold', async () => {
    state = { profile: { ...PROFILE, active: false }, contacts: [], suggestedWebsite: null };
    const page = renderPromote('/t/acme/admin/network/promote/requests');
    expect(await page.findByText('On hold. Contact support.')).toBeTruthy();
    expect(sent.some((s) => s.path.includes('/promoter-api/'))).toBe(false);
  });
});

describe('Requests: an applicant that is a brand', () => {
  it('carries the Brand badge; a person does not', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <AdminNetworkRequests />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const acme = (await page.findByText('@acme')).closest('h3')!;
    expect(acme.textContent).toContain('Brand');
    const ada = page.getByText('@ada').closest('h3')!;
    expect(ada.textContent).not.toContain('Brand');
  });
});
