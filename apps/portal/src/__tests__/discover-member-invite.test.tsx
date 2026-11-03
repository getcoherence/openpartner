// @vitest-environment jsdom
/**
 * Inviting an OpenPartner creator from Discover creators: the Network
 * returns the brand's invitations on each row, so a creator invited to every
 * published offering shows Invited (disabled), the dialog marks the offerings
 * they're already invited to, and sending updates the row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminNetworkCreators } from '../pages/admin/NetworkCreators.js';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}
let calls: Recorded[] = [];
let invitations: Array<{ offeringId: string; status: string }> = [];
let offerings: Array<{ id: string; title: string; published: boolean }> = [];
let inviteResponse: { status: number; body: unknown } = { status: 201, body: { ok: true, expiresAt: '2026-12-03T00:00:00Z' } };

const MEMBER = {
  id: 'crt_1',
  name: 'Member Mo',
  handle: 'mo',
  avatarUrl: null,
  bio: 'Writes about sales',
  categories: ['marketing'],
  audienceLocations: [],
  audienceAgeRange: null,
  pastBrands: [],
  clicks90d: 0,
  conversions90d: 0,
  revenue90d: '0',
  commission90d: '0',
  topCategories: [],
  lastAggregatedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  platforms: [],
  totalReach: 0,
};

beforeEach(() => {
  calls = [];
  invitations = [];
  offerings = [{ id: 'off_pro', title: 'Acme Pro', published: true }];
  inviteResponse = { status: 201, body: { ok: true, expiresAt: '2026-12-03T00:00:00Z' } };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    let res: { status: number; body: unknown };
    if (method === 'POST' && url.includes('/invite-creator')) {
      res = inviteResponse;
      if (res.status === 201) invitations.push({ offeringId: url.split('/offerings/')[1]!.split('/')[0]!, status: 'pending' });
    } else if (url.includes('/indexed-creators')) {
      res = { status: 200, body: { creators: [], nextCursor: null, total: 0 } };
    } else if (url.includes('/admin/network/offerings')) {
      res = { status: 200, body: { offerings } };
    } else {
      res = { status: 200, body: { creators: [{ ...MEMBER, invitations: [...invitations] }] } };
    }
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AdminNetworkCreators />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const button = (name: string) => screen.queryByRole('button', { name }) as HTMLButtonElement | null;

describe('inviting an OpenPartner creator', () => {
  it('shows Invited, disabled, once they hold an invitation to every published offering', async () => {
    invitations = [{ offeringId: 'off_pro', status: 'pending' }];
    wrap();
    await screen.findByText('Member Mo');
    await waitFor(() => expect(button('Invited')?.disabled).toBe(true));
    expect(button('Invite')).toBeNull();
  });

  it('can invite again once the invitation expired or was used', async () => {
    invitations = [{ offeringId: 'off_pro', status: 'expired' }];
    wrap();
    await screen.findByText('Member Mo');
    await waitFor(() => expect(calls.some((c) => c.url.includes('/admin/network/offerings'))).toBe(true));
    expect(button('Invite')?.disabled).toBe(false);
    expect(button('Invited')).toBeNull();
  });

  it('turns the row to Invited after sending', async () => {
    wrap();
    await screen.findByText('Member Mo');
    fireEvent.click(button('Invite')!);
    // The only offering is picked for them.
    const send = await screen.findByRole('button', { name: 'Send invitation' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    expect(await screen.findByText(/Invitation sent/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.url).toBe('/api/admin/network/offerings/off_pro/invite-creator');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(button('Invited')?.disabled).toBe(true));
  });

  it('marks the offerings they’re already invited to and picks the one left', async () => {
    offerings = [
      { id: 'off_pro', title: 'Acme Pro', published: true },
      { id: 'off_team', title: 'Acme Team', published: true },
    ];
    invitations = [{ offeringId: 'off_pro', status: 'pending' }];
    wrap();
    await screen.findByText('Member Mo');
    fireEvent.click(button('Invite')!);
    const invited = (await screen.findByRole('option', { name: 'Acme Pro (invited)' })) as HTMLOptionElement;
    expect(invited.disabled).toBe(true);
    await waitFor(() => expect(invited.closest('select')!.value).toBe('off_team'));
  });

  it('says so when the Network refuses a repeat', async () => {
    inviteResponse = {
      status: 409,
      body: { error: 'network_call_failed', detail: JSON.stringify({ error: 'already_invited' }) },
    };
    wrap();
    await screen.findByText('Member Mo');
    fireEvent.click(button('Invite')!);
    const send = await screen.findByRole('button', { name: 'Send invitation' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    // Another tab sent one meanwhile: the refreshed row shows it.
    invitations = [{ offeringId: 'off_pro', status: 'pending' }];
    fireEvent.click(send);
    expect(await screen.findByText('You already invited them to this offering.')).toBeTruthy();
    await waitFor(() => expect(button('Invited')?.disabled).toBe(true));
    expect((screen.getByRole('option', { name: 'Acme Pro (invited)' }) as HTMLOptionElement).closest('select')!.value).toBe('');
  });
});
