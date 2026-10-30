// @vitest-environment jsdom
/**
 * The creator index in the portal (openpartner-network
 * docs/creator-index.md §4.4, §5.3): the "Not on OpenPartner yet" tab shows
 * listed creators with the badge and an invite that needs a real message;
 * brands on other plans see what the plan unlocks; the claim page shows
 * who is waiting and what we hold, and sends an existing account to sign in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IndexedCreatorsSection } from '../pages/admin/NetworkIndexedCreators.js';
import { CreatorIndexClaimPage } from '../pages/creator/CreatorIndexClaim.js';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}
let calls: Recorded[] = [];
let respond: (url: string, method: string) => { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const { status, body } = respond(url, method);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(ui: React.ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const JO = {
  kind: 'indexed',
  id: 'ixc_jo',
  name: 'Jo Rivera',
  avatarUrl: null,
  headline: 'I write about outbound sales',
  country: 'US',
  categories: ['sales'],
  topics: ['outbound', 'cold email'],
  platforms: [{ platform: 'linkedin', handle: 'jorivera', profileUrl: 'https://www.linkedin.com/in/jorivera', followerCount: 12000, postsLast30d: 8, avgReactions: 100 }],
  totalReach: 12000,
  invitable: true,
  invite: null,
  refreshedAt: null,
};

describe('Not on OpenPartner yet', () => {
  it('lists creators with the badge and invites with a real message', async () => {
    respond = (url, method) =>
      method === 'POST'
        ? { status: 201, body: { invite: { id: 'cinv_1', status: 'held' } } }
        : { status: 200, body: { creators: [JO], nextCursor: null, total: 1 } };
    wrap(<IndexedCreatorsSection />);
    expect(await screen.findByText('Jo Rivera')).toBeTruthy();
    expect(screen.getByText('Not on OpenPartner yet')).toBeTruthy();
    expect(screen.getByText('1 creator not on OpenPartner yet')).toBeTruthy();
    expect(calls[0]!.url).toBe('/api/admin/network/indexed-creators?');

    fireEvent.click(screen.getByText('Invite to collaborate'));
    const send = screen.getByText('Send invite') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/Who you are/), { target: { value: 'Hi Jo, we would love to sponsor a post on outbound.' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(await screen.findByText(/Invited\. We.ll tell you when they join\./)).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/admin/network/creator-invites');
    expect(post.body).toEqual({ indexedCreatorId: 'ixc_jo', message: 'Hi Jo, we would love to sponsor a post on outbound.' });
  });

  it('says what the plan unlocks instead of an error on other plans', async () => {
    respond = () => ({ status: 402, body: { error: 'plan_required', detail: 'Creators not on OpenPartner yet come with the Flex and Enterprise plans.' } });
    wrap(<IndexedCreatorsSection />);
    expect(await screen.findByText(/Search creators who aren.t on OpenPartner yet/)).toBeTruthy();
    expect(screen.getByText('See plans')).toBeTruthy();
  });

  it('shows an invite already sent, and a creator who can’t be invited', async () => {
    respond = () => ({
      status: 200,
      body: {
        creators: [
          { ...JO, id: 'a', name: 'Sent One', invitable: false, invite: { id: 'i', status: 'sent', createdAt: '2026-10-30T00:00:00Z' } },
          { ...JO, id: 'b', name: 'Nope', invitable: false },
        ],
        nextCursor: null,
        total: 2,
      },
    });
    wrap(<IndexedCreatorsSection />);
    expect(await screen.findByText('Invited. We emailed them.')).toBeTruthy();
    expect(screen.getByText(/Can.t be invited yet/)).toBeTruthy();
    expect(screen.queryByText('Invite to collaborate')).toBeNull();
  });
});

describe('claim page', () => {
  const PREVIEW = {
    creator: {
      name: 'Jo Rivera',
      headline: 'Outbound',
      avatarUrl: null,
      email: 'partnerships@jo.co',
      emailFoundOn: 'https://jo.co/contact',
      firstSeenAt: '2026-10-01T00:00:00Z',
      platforms: [{ platform: 'linkedin', handle: 'jorivera', profileUrl: 'https://www.linkedin.com/in/jorivera', followerCount: 12000 }],
    },
    invites: [
      { brand: 'Acme', logoUrl: null, preview: 'We would love to sponsor you.' },
      { brand: 'Globex', logoUrl: null, preview: 'Hello from Globex.' },
    ],
    expiresAt: '2026-11-30T00:00:00Z',
  };

  function page() {
    return wrap(
      <Routes>
        <Route path="/creator/claim" element={<CreatorIndexClaimPage />} />
        <Route path="/creator/messages/:id" element={<div>thread page</div>} />
      </Routes>,
      '/creator/claim?token=tok_123',
    );
  }

  it('shows who is waiting and what we hold, and claims on a click', async () => {
    respond = (url) =>
      url.endsWith('/claim/preview')
        ? { status: 200, body: PREVIEW }
        : { status: 200, body: { ok: true, creatorId: 'crt_1', created: true, conversationIds: ['cnv_1', 'cnv_2'] } };
    page();
    expect(await screen.findByText('2 brands want to work with you')).toBeTruthy();
    expect(screen.getByText(/found partnerships@jo\.co on https:\/\/jo\.co\/contact/)).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual(['/api/creator-api/creator-index/claim/preview']);
    fireEvent.click(screen.getByText('Claim my profile and read'));
    expect(await screen.findByText('thread page')).toBeTruthy();
    expect(calls[1]).toMatchObject({ url: '/api/creator-api/creator-index/claim', method: 'POST', body: { token: 'tok_123' } });
  });

  it('sends an existing account to sign in', async () => {
    respond = (url) =>
      url.endsWith('/claim/preview')
        ? { status: 200, body: PREVIEW }
        : { status: 409, body: { error: 'sign_in_required', email: 'partnerships@jo.co' } };
    page();
    fireEvent.click(await screen.findByText('Claim my profile and read'));
    await waitFor(() => expect(screen.getByText(/You already have an OpenPartner account at partnerships@jo\.co/)).toBeTruthy());
    expect(screen.getByText('Sign in')).toBeTruthy();
  });

  it('explains an expired link', async () => {
    respond = () => ({ status: 404, body: { error: 'invalid_or_expired' } });
    page();
    expect(await screen.findByText(/This link has expired or isn.t valid/)).toBeTruthy();
  });
});
