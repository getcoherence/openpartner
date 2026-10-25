// @vitest-environment jsdom
/**
 * Creator review, both sides.
 *
 *   - Ops console (/platform → Creators): the review queue opens on
 *     "Pending review", approves (emailing the creator by default), rejects,
 *     holds an approved creator, and sends a message (the English-only note
 *     prefilled on request). Read-only operators see no actions.
 *   - Creator portal: unread messages from OpenPartner show until marked
 *     read; a complete profile waiting for (or refused) approval says so.
 *   - Applying: blocked up front while the profile awaits approval, and the
 *     Network's 403 creator_not_approved reads as that notice, not an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorsPage } from '../pages/platform/Creators.js';
import { CreatorShell } from '../pages/creator/CreatorShell.js';
import { CreatorOfferingDetailPage } from '../pages/creator/CreatorOfferingDetail.js';
import { notApprovedFrom } from '../lib/profile-incomplete.js';

type Req = { method: string; path: string; body: Record<string, unknown> | undefined };
let requests: Req[] = [];
let routes: Record<string, (r: Req) => { status: number; body: unknown }> = {};

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  window.sessionStorage.clear();
  requests = [];
  routes = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const path = url.pathname.replace('/api/creator-api', '').replace(/^\/api/, '');
    const req = { method, path, body };
    requests.push(req);
    const handler = routes[`${method} ${path}`];
    if (!handler) return json(404, { error: 'not_found' });
    const reply = handler(req);
    return json(reply.status, reply.body);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function wrap(path: string, routePath: string, element: React.ReactElement, qc?: QueryClient) {
  const client = qc ?? new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function creatorRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id}@example.test`,
    name: `Creator ${id}`,
    handle: id,
    status: 'active',
    avatarUrl: null,
    bio: null,
    categories: ['travel'],
    blockedAt: null,
    blockedReason: null,
    blockedByEmail: null,
    lastSignInAt: '2026-10-25T00:00:00.000Z',
    createdAt: '2026-10-25T00:00:00.000Z',
    affiliationCount: 0,
    platformCount: 1,
    profileComplete: true,
    profileMissing: [],
    reviewStatus: 'pending',
    reviewedAt: null,
    reviewReason: null,
    reviewedByEmail: null,
    profileUpdatedAt: '2026-10-25T00:00:00.000Z',
    platforms: [{ platform: 'instagram', handle: 'fyhgj', profileUrl: null, followerCount: 1200, verified: false }],
    messageCount: 0,
    unreadMessageCount: 0,
    lastMessageAt: null,
    ...over,
  };
}

const ADMIN = { email: 'ops@example.test', role: 'admin' } as never;

describe('ops console: creator review', () => {
  beforeEach(() => {
    routes['GET /platform-admin/creators'] = () => ({
      status: 200,
      body: {
        creators: [
          creatorRow('fyhgj', { name: 'نتنتم', bio: 'مهندس يحب السفر والتصوير' }),
          creatorRow('thin', { profileComplete: false, profileMissing: [{ field: 'bio', label: 'Write a bio' }], platforms: [] }),
          creatorRow('ada', { name: 'Ada', reviewStatus: 'approved', reviewedAt: '2026-10-20T00:00:00.000Z', reviewedByEmail: 'keith@example.test' }),
        ],
      },
    });
    routes['POST /platform-admin/creators/fyhgj/review'] = () => ({ status: 200, body: { ok: true, reviewStatus: 'approved', changed: true, notified: true } });
    routes['POST /platform-admin/creators/ada/review'] = () => ({ status: 200, body: { ok: true, reviewStatus: 'pending', changed: true, notified: false } });
    routes['POST /platform-admin/creators/fyhgj/messages'] = () => ({ status: 201, body: { ok: true, emailed: true, message: { id: 'cmsg_1' } } });
  });

  it('opens on the pending queue, complete profiles first, with the bio in full', async () => {
    wrap('/platform/creators', '/platform/creators', <CreatorsPage operator={ADMIN} />);
    expect(await screen.findByRole('button', { name: 'Pending review (2)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approved (1)' })).toBeTruthy();
    const names = screen.getAllByText(/^(نتنتم|Creator thin|Ada)$/).map((n) => n.textContent);
    expect(names).toEqual(['نتنتم', 'Creator thin']);
    const bio = screen.getByText('مهندس يحب السفر والتصوير');
    expect(bio.getAttribute('dir')).toBe('auto');
    // Their platforms, as text for the reviewer.
    expect(screen.getAllByText((_, el) => el?.tagName === 'SPAN' && el.textContent === 'instagram fyhgj · 1,200 followers')).toHaveLength(1);
  });

  it('approves and emails the creator by default', async () => {
    wrap('/platform/creators', '/platform/creators', <CreatorsPage operator={ADMIN} />);
    await screen.findByText('نتنتم');
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]!);
    await waitFor(() =>
      expect(requests.find((r) => r.path === '/platform-admin/creators/fyhgj/review')?.body).toEqual({
        status: 'approved',
        notifyCreator: true,
      }),
    );
    expect(await screen.findByText(/نتنتم approved — brands can find them now · creator emailed/)).toBeTruthy();
  });

  it('sends the English-only note as a message, emailed', async () => {
    wrap('/platform/creators', '/platform/creators', <CreatorsPage operator={ADMIN} />);
    await screen.findByText('نتنتم');
    fireEvent.click(screen.getAllByRole('button', { name: 'Message' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Use the English-only note' }));
    const box = screen.getByPlaceholderText('Write to the creator…') as HTMLTextAreaElement;
    expect(box.value).toContain('English-language platform');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(requests.some((r) => r.path === '/platform-admin/creators/fyhgj/messages')).toBe(true));
    const sent = requests.find((r) => r.path === '/platform-admin/creators/fyhgj/messages')!;
    expect(sent.body).toEqual({ body: box.value.trim(), email: true });
    expect(await screen.findByText('Message sent to نتنتم and emailed.')).toBeTruthy();
    // The form closes once it's sent.
    expect(screen.queryByPlaceholderText('Write to the creator…')).toBeNull();
  });

  it('rejects silently unless asked to email', async () => {
    wrap('/platform/creators', '/platform/creators', <CreatorsPage operator={ADMIN} />);
    await screen.findByText('نتنتم');
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]!);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Not English' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject creator' }));
    await waitFor(() =>
      expect(requests.find((r) => r.path === '/platform-admin/creators/fyhgj/review')?.body).toEqual({
        status: 'rejected',
        reason: 'Not English',
        notifyCreator: false,
      }),
    );
  });

  it('holds an approved creator for another review', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap('/platform/creators', '/platform/creators', <CreatorsPage operator={ADMIN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approved (1)' }));
    expect(screen.getByText(/Approved .* by keith@example.test/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hold for review' }));
    await waitFor(() =>
      expect(requests.find((r) => r.path === '/platform-admin/creators/ada/review')?.body).toEqual({
        status: 'pending',
        notifyCreator: false,
      }),
    );
    expect(await screen.findByText('Ada is back in the review queue — hidden until approved.')).toBeTruthy();
  });

  it('gives read-only operators no review or message actions', async () => {
    wrap('/platform/creators', '/platform/creators', <CreatorsPage operator={{ email: 'x@example.test', role: 'support' } as never} />);
    await screen.findByText('نتنتم');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
  });

  it('shows message history and edits since the last message', async () => {
    routes['GET /platform-admin/creators'] = () => ({
      status: 200,
      body: {
        creators: [
          creatorRow('fyhgj', {
            messageCount: 1,
            unreadMessageCount: 0,
            lastMessageAt: '2026-10-25T10:00:00.000Z',
            profileUpdatedAt: '2026-10-25T11:00:00.000Z',
          }),
        ],
      },
    });
    routes['GET /platform-admin/creators/fyhgj/messages'] = () => ({
      status: 200,
      body: {
        messages: [
          { id: 'cmsg_1', body: 'Please use English.', sentByEmail: 'ops@example.test', createdAt: '2026-10-25T10:00:00.000Z', emailedAt: '2026-10-25T10:00:00.000Z', readAt: '2026-10-25T10:30:00.000Z' },
        ],
      },
    });
    wrap('/platform/creators', '/platform/creators', <CreatorsPage operator={ADMIN} />);
    expect(await screen.findByText(/1 message sent/)).toBeTruthy();
    expect(screen.getByText('Profile edited since your last message')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show messages' }));
    expect(await screen.findByText('Please use English.')).toBeTruthy();
    expect(screen.getByText(/ops@example.test · emailed · read/)).toBeTruthy();
  });

  it('falls back to the old view on a Network without review', async () => {
    routes['GET /platform-admin/creators'] = () => ({
      status: 200,
      body: { creators: [{ ...creatorRow('old'), reviewStatus: undefined }] },
    });
    wrap('/platform/creators', '/platform/creators', <CreatorsPage operator={ADMIN} />);
    expect(await screen.findByRole('button', { name: 'All (1)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pending review/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

describe('creator portal: review and messages', () => {
  let me: Record<string, unknown>;
  let messages: Array<{ id: string; body: string; createdAt: string; readAt: string | null }>;

  beforeEach(() => {
    me = { id: 'crt_1', name: 'Ada', handle: 'ada', profileComplete: true, profileChecklist: [], reviewStatus: 'pending', unreadMessageCount: 0 };
    messages = [];
    routes['GET /creators/whoami'] = () => ({
      status: 200,
      body: { creator: { id: 'crt_1', name: 'Ada', email: 'ada@example.test', handle: 'ada', avatarUrl: null, bio: null } },
    });
    routes['GET /creators/me'] = () => ({ status: 200, body: me });
    routes['GET /creators/me/messages'] = () => ({ status: 200, body: { messages } });
    routes['GET /creators/me/location'] = () => ({ status: 200, body: { country: 'US' } });
  });

  const shell = (path = '/creator/requests') => wrap(path, '/creator/*', <CreatorShell />);

  it('says a complete profile is in review, and dismisses for the session', async () => {
    shell();
    const note = await screen.findByRole('region', { name: 'Profile review' });
    expect(note.textContent).toContain('Your profile is in review.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the review note for this session' }));
    expect(screen.queryByRole('region', { name: 'Profile review' })).toBeNull();
    expect(window.sessionStorage.getItem('op:creator-review-banner-dismissed')).toBe('1');
  });

  it('says so when the profile was not approved, and nothing once approved', async () => {
    me = { ...me, reviewStatus: 'rejected' };
    shell();
    expect((await screen.findByRole('region', { name: 'Profile review' })).textContent).toContain('wasn’t approved');
    cleanup();
    me = { ...me, reviewStatus: 'approved' };
    shell();
    await screen.findByRole('link', { name: /My applications/ });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('region', { name: 'Profile review' })).toBeNull();
  });

  it('shows an unread message until it is marked read', async () => {
    me = { ...me, reviewStatus: 'approved', unreadMessageCount: 1 };
    messages = [{ id: 'cmsg_1', body: 'Please write your bio in English.', createdAt: '2026-10-25T10:00:00.000Z', readAt: null }];
    routes['POST /creators/me/messages/cmsg_1/read'] = () => {
      messages = [{ ...messages[0]!, readAt: '2026-10-25T11:00:00.000Z' }];
      me = { ...me, unreadMessageCount: 0 };
      return { status: 200, body: { message: messages[0] } };
    };
    shell('/creator/profile');
    const banner = await screen.findByRole('region', { name: 'Message from OpenPartner' });
    expect(banner.textContent).toContain('Please write your bio in English.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark as read' })[0]!);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Message from OpenPartner' })).toBeNull());
    expect(requests.some((r) => r.method === 'POST' && r.path === '/creators/me/messages/cmsg_1/read')).toBe(true);
  });
});

describe('applying while the profile awaits approval', () => {
  const OFFERING = {
    id: 'off_1',
    title: 'Acme Partners',
    description: 'Acme makes design tools.',
    productUrl: 'https://acme.example',
    vendorId: 'vnd_1',
    vendorName: 'Acme',
    vendorLogoUrl: null,
    terms: { commissionDescription: '20% recurring' },
    coverImageUrl: null,
    video: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    myStatus: 'none',
  };

  function page(profile: Record<string, unknown>) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(['creator-offering', 'off_1'], OFFERING);
    qc.setQueryData(['creator-whoami'], { creator: { id: 'crt_1', handle: 'ada' } });
    qc.setQueryData(['creator-my-profile'], profile);
    return wrap('/creator/offerings/off_1', '/creator/offerings/:id', <CreatorOfferingDetailPage />, qc);
  }

  it('blocks up front from the creator’s own review state', () => {
    page({ profileComplete: true, profileChecklist: [], reviewStatus: 'pending' });
    expect(screen.getByText('Your profile hasn’t been approved yet')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Submit application' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reads the Network’s refusal as the notice, not an error', async () => {
    routes['POST /offerings/off_1/apply'] = () => ({ status: 403, body: { error: 'creator_not_approved' } });
    page({ profileComplete: true, profileChecklist: [] });
    expect(screen.queryByText('Your profile hasn’t been approved yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
    expect(await screen.findByText('Your profile hasn’t been approved yet')).toBeTruthy();
    expect(screen.queryByText(/creator_not_approved/)).toBeNull();
  });

  it('recognises the refusal through the brand’s partner proxy too', () => {
    expect(notApprovedFrom({ status: 403, detail: { error: 'creator_not_approved' } })).toBe(true);
    expect(
      notApprovedFrom({ status: 403, detail: { error: 'network_call_failed', detail: '{"error":"creator_not_approved"}' } }),
    ).toBe(true);
    expect(notApprovedFrom({ status: 403, detail: { error: 'country_not_supported' } })).toBe(false);
    expect(notApprovedFrom({ status: 409, detail: { error: 'creator_not_approved' } })).toBe(false);
  });
});
