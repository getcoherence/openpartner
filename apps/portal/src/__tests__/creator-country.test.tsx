// @vitest-environment jsdom
/**
 * Where creators are based (the Network's country access). Creator signup
 * asks for a country, with the Ukraine occupied-regions confirmation;
 * creators from before that are asked once in the shell; refusals from the
 * Network show the same neutral message as for brands; and a brand
 * approving a creator the Network no longer serves is told so plainly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorSignupPage } from '../pages/creator/CreatorSignup.js';
import { CreatorSigninPage } from '../pages/creator/CreatorSignin.js';
import { CreatorMagicLandingPage } from '../pages/creator/CreatorMagicLanding.js';
import { CreatorShell } from '../pages/creator/CreatorShell.js';
import { AdminNetworkRequests } from '../pages/admin/NetworkRequests.js';

const NOT_SERVED = "Sorry — OpenPartner isn't available in your country.";

interface Sent {
  method: string;
  url: string;
  body: unknown;
}
let sent: Sent[] = [];
/** Per-test answers, keyed by "METHOD /path" (path after /api). */
let routes: Record<string, () => Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  sent = [];
  routes = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const path = url.replace(/^\/api/, '').replace(/\?.*$/, '');
    const handler = routes[`${method} ${path}`];
    return handler ? handler() : json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderAt(path: string, element: React.ReactNode, routePath = '*') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe('creator signup', () => {
  function fill(page: ReturnType<typeof render>) {
    fireEvent.change(page.getByPlaceholderText('Ada Lovelace'), { target: { value: 'Ada' } });
    fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: 'ada@example.com' } });
  }

  it('requires a country, asks Ukrainians to confirm, and sends both', async () => {
    routes['POST /creator-api/creators/signup'] = () => json(200, { ok: true });
    const page = renderAt('/creator/signup', <CreatorSignupPage />);
    fill(page);
    const submit = page.getByRole('button', { name: 'Become a creator' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(page.getByRole('combobox'), { target: { value: 'UA' } });
    expect(submit.disabled).toBe(true);
    fireEvent.click(page.getByRole('checkbox', { name: /occupied areas/ }));
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => expect(page.getByText('Check your inbox')).toBeTruthy());
    expect(sent.find((s) => s.method === 'POST')!.body).toEqual({
      email: 'ada@example.com',
      name: 'Ada',
      country: 'UA',
      outsideOccupiedRegions: true,
    });
  });

  it('sends only the country elsewhere', async () => {
    routes['POST /creator-api/creators/signup'] = () => json(200, { ok: true });
    const page = renderAt('/creator/signup', <CreatorSignupPage />);
    fill(page);
    fireEvent.change(page.getByRole('combobox'), { target: { value: 'DE' } });
    fireEvent.click(page.getByRole('button', { name: 'Become a creator' }));
    await waitFor(() => expect(page.getByText('Check your inbox')).toBeTruthy());
    expect(sent.find((s) => s.method === 'POST')!.body).toEqual({ email: 'ada@example.com', name: 'Ada', country: 'DE' });
  });

  it('says plainly when the country is not served', async () => {
    routes['POST /creator-api/creators/signup'] = () => json(403, { error: 'country_not_supported' });
    const page = renderAt('/creator/signup', <CreatorSignupPage />);
    fill(page);
    fireEvent.change(page.getByRole('combobox'), { target: { value: 'DE' } });
    fireEvent.click(page.getByRole('button', { name: 'Become a creator' }));
    await waitFor(() => expect(page.getByText(NOT_SERVED)).toBeTruthy());
  });

  it('asks for the confirmation when the Network wants it', async () => {
    routes['POST /creator-api/creators/signup'] = () => json(400, { error: 'occupied_region_confirmation_required' });
    const page = renderAt('/creator/signup', <CreatorSignupPage />);
    fill(page);
    fireEvent.change(page.getByRole('combobox'), { target: { value: 'UA' } });
    fireEvent.click(page.getByRole('checkbox', { name: /occupied areas/ }));
    fireEvent.click(page.getByRole('button', { name: 'Become a creator' }));
    await waitFor(() =>
      expect(page.getByText('Please confirm you are not based in the occupied regions of Ukraine.')).toBeTruthy(),
    );
  });
});

describe('creator sign-in refused by country', () => {
  it('shows the neutral message on the sign-in page', async () => {
    routes['POST /creator-api/creators/signin'] = () => json(403, { error: 'country_not_supported' });
    const page = renderAt('/creator/login', <CreatorSigninPage />);
    fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: 'ada@example.com' } });
    // The page opens on the password form; the emailed link is one click away.
    fireEvent.click(page.getByRole('button', { name: 'Email me a sign-in link instead' }));
    fireEvent.click(page.getByRole('button', { name: 'Email me a sign-in link' }));
    await waitFor(() => expect(page.getByText(NOT_SERVED)).toBeTruthy());
  });

  it("shows it on the magic-link landing, without suggesting a new link", async () => {
    routes['POST /creator-api/creators/verify'] = () => json(403, { error: 'country_not_supported' });
    const page = renderAt('/creator/auth/magic?token=abcdefghij', <CreatorMagicLandingPage />);
    await waitFor(() => expect(page.getByText(NOT_SERVED)).toBeTruthy());
    expect(page.queryByText(/Ask for a new link/)).toBeNull();
  });

  it('still suggests a new link for an expired one', async () => {
    routes['POST /creator-api/creators/verify'] = () => json(400, { error: 'invalid_or_expired' });
    const page = renderAt('/creator/auth/magic?token=abcdefghij', <CreatorMagicLandingPage />);
    await waitFor(() => expect(page.getByText(/Ask for a new link/)).toBeTruthy());
  });
});

describe('creator location prompt', () => {
  let location: { required: boolean; country: string | null; outsideOccupiedRegions: boolean | null } | null;

  beforeEach(() => {
    routes['GET /creator-api/creators/whoami'] = () =>
      json(200, { creator: { id: 'crt_1', name: 'Ada', email: 'ada@example.com', handle: 'ada', avatarUrl: null, bio: null } });
    location = { required: true, country: null, outsideOccupiedRegions: null };
    routes['GET /creator-api/creators/me/location'] = () =>
      location ? json(200, location) : json(404, { error: 'not_found' });
  });

  function renderShell() {
    return renderAt('/creator/discover', <CreatorShell />, '/creator/*');
  }

  it('asks a creator who never said where they are based, saves it, and goes away', async () => {
    routes['PUT /creator-api/creators/me/location'] = () => {
      location = { required: true, country: 'DE', outsideOccupiedRegions: null };
      return json(200, { ok: true, country: 'DE' });
    };
    const page = renderShell();
    const prompt = await page.findByRole('region', { name: 'Where are you based?' });
    fireEvent.change(prompt.querySelector('select')!, { target: { value: 'DE' } });
    fireEvent.click(page.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(page.queryByRole('region', { name: 'Where are you based?' })).toBeNull());
    expect(sent.find((s) => s.method === 'PUT')!.body).toEqual({ country: 'DE' });
  });

  it('shows the neutral message when the answer is not served', async () => {
    routes['PUT /creator-api/creators/me/location'] = () => json(403, { error: 'country_not_supported' });
    const page = renderShell();
    const prompt = await page.findByRole('region', { name: 'Where are you based?' });
    fireEvent.change(prompt.querySelector('select')!, { target: { value: 'DE' } });
    fireEvent.click(page.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(page.getByText(NOT_SERVED)).toBeTruthy());
  });

  it("doesn't ask a creator who already answered", async () => {
    location = { required: true, country: 'DE', outsideOccupiedRegions: null };
    const page = renderShell();
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/creators/me/location'))).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(page.queryByRole('region', { name: 'Where are you based?' })).toBeNull();
  });

  it("doesn't ask when the Network has no location endpoint yet", async () => {
    location = null;
    const page = renderShell();
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/creators/me/location'))).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(page.queryByRole('region', { name: 'Where are you based?' })).toBeNull();
  });
});

describe('brand approving a creator the Network no longer serves', () => {
  it('says the creator is not available, without a reason', async () => {
    routes['GET /admin/network/requests'] = () =>
      json(200, {
        requests: [
          {
            id: 'req_1',
            status: 'pending',
            message: null,
            preferredSlug: null,
            createdAt: new Date().toISOString(),
            creatorId: 'crt_1',
            creatorEmail: 'ada@example.com',
            creatorName: 'Ada',
            creatorHandle: 'ada',
            creatorBio: null,
            offeringId: 'off_1',
            offeringTitle: 'Acme',
          },
        ],
      });
    // How the brand API relays the Network's 409.
    routes['POST /admin/network/requests/req_1/approve'] = () =>
      json(409, { error: 'network_call_failed', detail: '{"error":"creator_not_available"}' });
    const page = renderAt('/admin/network/requests', <AdminNetworkRequests />);
    fireEvent.click(await page.findByRole('button', { name: 'Approve + provision' }));
    await waitFor(() => expect(page.getByText(/isn't available for partnerships on the Network/)).toBeTruthy());
    expect(page.queryByText(/creator_not_available/)).toBeNull();
    expect(page.queryByText(/countr/i)).toBeNull();
  });
});
