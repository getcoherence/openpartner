// @vitest-environment jsdom
/**
 * Partners opt in to the OpenPartner Network themselves:
 *   - an optional, UNCHECKED checkbox on the join page (only when the brand
 *     offers the Network),
 *   - a one-time prompt in the portal (Join / No thanks),
 *   - a persistent setting on the Network profile page (join / leave).
 * Every surface says plainly what's shared and that it's optional. The
 * partner Network nav only appears when the brand offers the Network or
 * the partner is opted in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '../App.js';
import { PartnerJoinPage } from '../pages/PartnerJoin.js';
import { MyProfilePage } from '../pages/partner/MyProfile.js';
import { NetworkConsentPrompt, type NetworkConsentState } from '../pages/partner/NetworkConsent.js';
import type { Principal } from '../api.js';

const BRAND = {
  programName: 'Acme',
  supportEmail: null,
  logoUrl: null,
  brandColor: null,
  programTermsUrl: null,
  whiteLabel: false,
  partnerNetworkVisible: true,
};

const UNDECIDED: NetworkConsentState = {
  offered: true,
  status: null,
  source: null,
  consentedAt: null,
  withdrawnAt: null,
  declinedAt: null,
};
const GRANTED: NetworkConsentState = {
  ...UNDECIDED,
  status: 'granted',
  source: 'join_page',
  consentedAt: '2026-10-01T09:00:00.000Z',
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[] = [];
let consentAfterPost: NetworkConsentState = GRANTED;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  consentAfterPost = GRANTED;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (url.endsWith('/network/me/consent') && method === 'POST') return json(200, consentAfterPost);
    if (url.endsWith('/network/me/profile')) return json(200, { notFederated: true, consentRequired: true });
    if (url.endsWith('/partner-signup')) return json(201, { ok: true, status: 'active', partnerId: 'p1' });
    return json(401, { error: 'no_platform_session' });
  }) as typeof fetch;
});
afterEach(cleanup);

function client(consent?: NetworkConsentState): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['program-settings'], BRAND);
  qc.setQueryData(['public-branding', null], { ...BRAND, tenantSlug: 'acme' });
  if (consent) qc.setQueryData(['network-consent'], consent);
  return qc;
}

function renderIn(ui: React.ReactElement, qc: QueryClient) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const consentPosts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/network/me/consent'));

describe('first-login prompt', () => {
  it('explains what is shared and that it is optional', () => {
    const page = renderIn(<NetworkConsentPrompt isMobile={false} />, client(UNDECIDED));
    const text = page.getByRole('region', { name: 'Join the OpenPartner Network' }).textContent ?? '';
    expect(text).toContain('Join the OpenPartner Network?');
    expect(text).toMatch(/shares your name, email address and partner profile/);
    expect(text).toMatch(/Joining is optional/);
  });

  it('Join the Network grants via the prompt', async () => {
    const page = renderIn(<NetworkConsentPrompt isMobile={false} />, client(UNDECIDED));
    fireEvent.click(page.getByRole('button', { name: 'Join the Network' }));
    await waitFor(() => expect(consentPosts()).toHaveLength(1));
    expect(consentPosts()[0]!.body).toEqual({ decision: 'grant', via: 'prompt' });
  });

  it('No thanks declines via the prompt', async () => {
    const page = renderIn(<NetworkConsentPrompt isMobile={false} />, client(UNDECIDED));
    fireEvent.click(page.getByRole('button', { name: 'No thanks' }));
    await waitFor(() => expect(consentPosts()).toHaveLength(1));
    expect(consentPosts()[0]!.body).toEqual({ decision: 'decline', via: 'prompt' });
  });

  it('"Decide later" hides it without recording anything', () => {
    const page = renderIn(<NetworkConsentPrompt isMobile={false} />, client(UNDECIDED));
    fireEvent.click(page.getByRole('button', { name: 'Decide later' }));
    expect(page.queryByText('Join the OpenPartner Network?')).toBeNull();
    expect(consentPosts()).toHaveLength(0);
  });
});

describe('Network profile page setting', () => {
  it('not on the Network: explains sharing, offers Join, shows no editor', async () => {
    const page = renderIn(<MyProfilePage />, client({ ...UNDECIDED, status: 'declined', declinedAt: '2026-10-02T00:00:00.000Z' }));
    await waitFor(() => expect(page.getByText(/You.re not on the Network/)).toBeTruthy());
    fireEvent.click(page.getByRole('button', { name: 'Join the Network' }));
    await waitFor(() => expect(consentPosts()).toHaveLength(1));
    expect(consentPosts()[0]!.body).toEqual({ decision: 'grant', via: 'setting' });
    expect(page.queryByText('Platforms')).toBeNull();
  });

  it('on the Network: says how they joined, and leaving asks for confirmation first', async () => {
    consentAfterPost = { ...GRANTED, status: 'withdrawn', withdrawnAt: '2026-10-16T00:00:00.000Z' };
    const page = renderIn(<MyProfilePage />, client(GRANTED));
    expect(page.getByText(/You.re on the Network/)).toBeTruthy();
    expect(page.getByText(/You joined when you applied/)).toBeTruthy();

    fireEvent.click(page.getByRole('button', { name: 'Leave the Network' }));
    expect(consentPosts()).toHaveLength(0);
    expect(page.getByText(/stop sharing your details with the Network/)).toBeTruthy();
    fireEvent.click(page.getAllByRole('button', { name: 'Leave the Network' })[0]!);
    await waitFor(() => expect(consentPosts()).toHaveLength(1));
    expect(consentPosts()[0]!.body).toEqual({ decision: 'withdraw', via: 'setting' });
    await waitFor(() => expect(page.getByText(/You.re not on the Network/)).toBeTruthy());
  });

  it('a grandfathered partner is told they were added before partners were asked', () => {
    const page = renderIn(<MyProfilePage />, client({ ...GRANTED, source: 'grandfathered' }));
    expect(page.getByText(/automatically, before partners were asked/)).toBeTruthy();
    expect(page.getByRole('button', { name: 'Leave the Network' })).toBeTruthy();
  });

  it('brand not offering the Network and partner not on it: says nothing is shared', () => {
    const page = renderIn(<MyProfilePage />, client({ ...UNDECIDED, offered: false }));
    expect(page.getByText(/doesn.t offer the OpenPartner Network to its partners/)).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Join the Network' })).toBeNull();
  });
});

describe('partner sidebar Network section', () => {
  const partner: Principal = {
    role: 'partner',
    partnerId: 'p1',
    partner: { id: 'p1', name: 'Pat Partner', email: 'pat@example.com', stripeConnected: false },
  };

  it('hidden when the brand does not offer it and the partner is not on it', () => {
    const page = renderIn(<Sidebar principal={partner} />, client({ ...UNDECIDED, offered: false }));
    // The section is collapsed by default, so match its heading text.
    expect(page.container.textContent).not.toMatch(/network/i);
  });

  it('shown when offered, and kept for an opted-in partner after the brand stops offering it', () => {
    const offered = renderIn(<Sidebar principal={partner} />, client(UNDECIDED));
    expect(offered.container.textContent).toMatch(/network/i);
    cleanup();
    const optedIn = renderIn(<Sidebar principal={partner} />, client({ ...GRANTED, offered: false }));
    expect(optedIn.container.textContent).toMatch(/network/i);
  });
});

describe('join page opt-in', () => {
  const PITCH = 'Weekly tutorials for indie founders; I would demo the product in a launch video.';

  function fill(page: ReturnType<typeof render>) {
    fireEvent.change(page.getByPlaceholderText('Your name'), { target: { value: 'Ada' } });
    fireEvent.change(page.getByPlaceholderText('you@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.change(page.getByLabelText('Website or main channel'), { target: { value: 'https://ada.example' } });
    fireEvent.change(page.getByLabelText('Social profile 1'), { target: { value: 'https://youtube.com/@ada' } });
    fireEvent.change(page.getByLabelText('Audience size'), { target: { value: '10k_50k' } });
    fireEvent.change(page.getByLabelText('How would you promote Acme?'), { target: { value: PITCH } });
  }

  function joinClient(networkOffered: boolean): QueryClient {
    const qc = client();
    qc.setQueryData(['partner-signup-status', null], { open: true, reviewRequired: false, networkOffered });
    return qc;
  }

  it('no checkbox when the brand does not offer the Network', () => {
    const page = renderIn(<PartnerJoinPage />, joinClient(false));
    expect(page.queryByText(/Also join the OpenPartner Network/)).toBeNull();
  });

  it('starts unchecked; an untouched box sends no opt-in', async () => {
    const page = renderIn(<PartnerJoinPage />, joinClient(true));
    const box = page.getByRole('checkbox', { name: /Also join the OpenPartner Network/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(page.getByText(/shares your name, email address, website, social profiles and audience size/)).toBeTruthy();
    expect(page.getByText(/Your pitch stays with Acme/)).toBeTruthy();
    fill(page);
    fireEvent.click(page.getByRole('button', { name: 'Apply to join' }));
    await waitFor(() => expect(page.getByText('Check your inbox')).toBeTruthy());
    const signup = calls.find((c) => c.url.endsWith('/partner-signup'))!;
    expect(signup.body).not.toHaveProperty('networkOptIn');
  });

  it('ticked: sends networkOptIn: true', async () => {
    const page = renderIn(<PartnerJoinPage />, joinClient(true));
    fill(page);
    fireEvent.click(page.getByRole('checkbox', { name: /Also join the OpenPartner Network/ }));
    fireEvent.click(page.getByRole('button', { name: 'Apply to join' }));
    await waitFor(() => expect(page.getByText('Check your inbox')).toBeTruthy());
    const signup = calls.find((c) => c.url.endsWith('/partner-signup'))!;
    expect(signup.body).toMatchObject({ networkOptIn: true });
  });
});
