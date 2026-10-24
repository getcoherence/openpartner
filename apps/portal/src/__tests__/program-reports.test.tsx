// @vitest-environment jsdom
/**
 * Per-program reporting in the portal. A brand running one program per
 * geography picks a program on the dashboard home (kept in the URL as
 * ?program=, so the view can be bookmarked and shared), and compares every
 * program side by side on the Programs page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api.js';
import { Dashboard } from '../pages/Dashboard.js';
import { AdminPrograms } from '../pages/AdminPrograms.js';
import { money } from '../ui.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  api: vi.fn(),
}));

const DAY = 24 * 60 * 60 * 1000;

function program(id: string, name: string) {
  return {
    id,
    name,
    commissionRule: [{ trigger: 'every', type: 'percent', value: 10 }],
    attributionWindowDays: 60,
    attributionModel: 'last_click',
    destinationUrl: 'https://acme.example/landing',
    deepLinkAllowedDomains: null,
    holdbackDays: 0,
    startsAt: null,
    endsAt: null,
    customerReward: null,
    shareOnNetwork: false,
    marketplaceDescription: null,
    networkOfferingId: null,
    categories: [],
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

const PROGRAMS = [program('prog_in', 'India'), program('prog_us', 'United States')];

function overview(programId: string | null) {
  return {
    since: '2026-09-22T00:00:00.000Z',
    programId,
    sort: 'revenue',
    nextCursor: null,
    totals: {
      partners: 1,
      clicks: 5,
      currency: 'INR',
      attributedRevenue: 1000,
      attributedRevenueByCurrency: { INR: 1000 },
      attributedEvents: 1,
      commissionAccrued: 100,
      commissionApproved: 0,
      commissionPaid: 0,
      commissionByCurrency: { INR: { accrued: 100 } },
    },
    partners: [],
  };
}

const STATS = {
  since: '2026-09-22T00:00:00.000Z',
  until: '2026-10-22T00:00:00.000Z',
  currency: 'INR',
  programs: [
    {
      programId: 'prog_in',
      name: 'India',
      partners: 12,
      clicks: 3400,
      attributedEvents: 21,
      attributedRevenueByCurrency: { INR: 123_000, USD: 50 },
      commissionByCurrency: { INR: { accrued: 12_300, paid: 500 }, USD: { approved: 5 } },
    },
    {
      programId: 'prog_us',
      name: 'United States',
      partners: 0,
      clicks: 0,
      attributedEvents: 0,
      attributedRevenueByCurrency: {},
      commissionByCurrency: {},
    },
  ],
};

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/programs') return { programs: PROGRAMS, customerRewardDelivery: 'brand' };
    if (path.startsWith('/admin/overview')) return overview(new URLSearchParams(path.split('?')[1]).get('programId'));
    if (path.startsWith('/programs/stats')) return STATS;
    if (path === '/config/program') return { programName: 'Acme', defaultCurrency: 'INR', whiteLabel: false };
    throw new Error(`not mocked: ${path}`);
  });
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
}

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname + search}</output>;
}

function renderDashboard(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client()}>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <Dashboard principal={{ role: 'admin' }} />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const calls = (prefix: string) =>
  vi.mocked(api).mock.calls.map((c) => c[0] as string).filter((p) => p.startsWith(prefix));
const lastOverviewQuery = () => new URLSearchParams(calls('/admin/overview').at(-1)!.split('?')[1]);
const programSelect = async () => (await screen.findByRole('combobox', { name: 'Program' })) as HTMLSelectElement;
const location = () => screen.getByTestId('location').textContent;

describe('dashboard program selector', () => {
  it('filters to the program named in the URL', async () => {
    renderDashboard('/?program=prog_in');
    const select = await programSelect();
    await waitFor(() => expect(select.value).toBe('prog_in'));
    expect(lastOverviewQuery().get('programId')).toBe('prog_in');
    expect(screen.getByText(/^India: its partners/)).toBeTruthy();
  });

  it('keeps the choice in the URL and refetches for it', async () => {
    renderDashboard('/');
    const select = await programSelect();
    await waitFor(() => expect(calls('/admin/overview').length).toBeGreaterThan(0));
    expect(lastOverviewQuery().has('programId')).toBe(false);

    fireEvent.change(select, { target: { value: 'prog_us' } });
    await waitFor(() => expect(location()).toBe('/?program=prog_us'));
    await waitFor(() => expect(lastOverviewQuery().get('programId')).toBe('prog_us'));
    expect(select.value).toBe('prog_us');

    expect(screen.getByText(/^United States: its partners/)).toBeTruthy();

    // Back to every program: the unfiltered page (cached from the first load).
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(location()).toBe('/'));
    expect(await screen.findByText('Overview of every partner driving attributed revenue.')).toBeTruthy();
    expect(select.value).toBe('');
  });

  it("shows every program for an id that isn't one of the brand's", async () => {
    renderDashboard('/?program=prog_elsewhere');
    const select = await programSelect();
    await waitFor(() => expect(lastOverviewQuery().has('programId')).toBe(false));
    expect(select.value).toBe('');
    expect(screen.getByText('Overview of every partner driving attributed revenue.')).toBeTruthy();
  });
});

describe('Programs page performance', () => {
  function renderPrograms() {
    const qc = client();
    qc.setQueryData(['campaigns'], { programs: PROGRAMS, customerRewardDelivery: 'brand' });
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <AdminPrograms />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('compares programs per currency and links each to its dashboard', async () => {
    renderPrograms();
    expect(await screen.findByText(`${money(123_000, 'INR')} + ${money(50, 'USD')}`)).toBeTruthy();
    expect(screen.getByText(money(12_300, 'INR'))).toBeTruthy(); // accrued
    expect(screen.getByText(money(5, 'USD'))).toBeTruthy(); // approved, in its own currency
    expect(screen.getByText(money(500, 'INR'))).toBeTruthy(); // paid
    expect(screen.getByText('3,400')).toBeTruthy();
    // An idle program shows zeros in the brand's currency.
    expect(screen.getAllByText(money(0, 'INR')).length).toBe(4);
    expect(screen.getByRole('link', { name: 'India' }).getAttribute('href')).toBe('/?program=prog_in');
  });

  it('refetches for the chosen window', async () => {
    renderPrograms();
    await screen.findByRole('link', { name: 'India' });
    const sinceOf = (path: string) => new Date(new URLSearchParams(path.split('?')[1]).get('since')!).getTime();
    expect(Math.abs(Date.now() - 30 * DAY - sinceOf(calls('/programs/stats').at(-1)!))).toBeLessThan(60_000);

    fireEvent.change(screen.getByRole('combobox', { name: 'Performance window' }), { target: { value: '7' } });
    await waitFor(() => expect(calls('/programs/stats').length).toBe(2));
    expect(Math.abs(Date.now() - 7 * DAY - sinceOf(calls('/programs/stats').at(-1)!))).toBeLessThan(60_000);
  });
});
