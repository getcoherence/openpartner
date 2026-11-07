// @vitest-environment jsdom
/**
 * Book on Discover creators: the Network says on each row whether the
 * creator's storefront takes bookings (bookingsOpen). Book is hidden where
 * it doesn't, and shown as before where an older Network leaves the field
 * out, so the portal can ship after the Network or before it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminNetworkCreators } from '../pages/admin/NetworkCreators.js';

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
  invitations: [],
};

let row: Record<string, unknown> = MEMBER;

beforeEach(() => {
  row = MEMBER;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/indexed-creators')
      ? { creators: [], nextCursor: null, total: 0 }
      : url.includes('/admin/network/offerings')
        ? { offerings: [{ id: 'off_pro', title: 'Acme Pro', published: true }] }
        : { creators: [row] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
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

const button = (name: string) => screen.queryByRole('button', { name });

describe('Book on Discover creators', () => {
  it('is hidden for a creator not taking bookings, leaving Invite', async () => {
    row = { ...MEMBER, bookingsOpen: false };
    wrap();
    await screen.findByText('Member Mo');
    await waitFor(() => expect(button('Invite')).not.toBeNull());
    expect(button('Book')).toBeNull();
  });

  it('shows for a creator taking bookings', async () => {
    row = { ...MEMBER, bookingsOpen: true };
    wrap();
    await screen.findByText('Member Mo');
    expect(button('Book')).not.toBeNull();
  });

  it('shows when an older Network leaves bookingsOpen out', async () => {
    wrap();
    await screen.findByText('Member Mo');
    expect(button('Book')).not.toBeNull();
  });
});
