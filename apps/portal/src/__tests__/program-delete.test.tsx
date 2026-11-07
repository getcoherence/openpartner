// @vitest-environment jsdom
/**
 * Admin → Programs offers Delete only on a program nothing uses yet
 * (`deletable` from GET /programs), such as a duplicate made by mistake.
 * It asks on the row first (not window.confirm), and a refusal from the API
 * shows on that row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, api, type Principal } from '../api.js';
import { ViewOnlyProvider } from '../lib/viewOnly.js';
import { AdminPrograms } from '../pages/AdminPrograms.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  api: vi.fn(),
}));

const PROGRAM = {
  commissionRule: [{ trigger: 'every', type: 'percent', value: 20 }],
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
const USED = { ...PROGRAM, id: 'prog_used', name: 'Partners', deletable: false };
const DUPLICATE = { ...PROGRAM, id: 'prog_dup', name: 'Partners (copy)', deletable: true };

const ADMIN: Principal = { role: 'admin', source: 'session', admin: { id: 'adm_1', name: 'Ada', email: 'ada@example.com', role: 'admin' } };
const VIEWER: Principal = { role: 'admin', source: 'session', admin: { id: 'adm_v', name: 'Vic', email: 'vic@example.com', role: 'viewer' } };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({});
});

function renderPrograms(principal: Principal = ADMIN) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['campaigns'], { programs: [USED, DUPLICATE], customerRewardDelivery: 'brand' });
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ViewOnlyProvider principal={principal}>
          <AdminPrograms />
        </ViewOnlyProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const deleteCalls = () =>
  vi.mocked(api).mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'DELETE');

describe('Delete on Admin → Programs', () => {
  it('is offered only on the unused program', () => {
    renderPrograms();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'End now' })).toHaveLength(2);
  });

  it('asks on the row, then deletes', async () => {
    renderPrograms();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete for good?')).toBeTruthy();
    expect(deleteCalls()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(deleteCalls()).toEqual([['/programs/prog_dup', { method: 'DELETE' }]]));
  });

  // A scripted or agent-driven browser dismisses window.confirm, which then
  // returns false: Delete must not depend on it.
  it('works where the browser dismisses dialogs', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPrograms();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does nothing when the admin cancels', () => {
    renderPrograms();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleteCalls()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('shows why the API refused, on the row', async () => {
    vi.mocked(api).mockImplementation(async (_path, opts) => {
      if ((opts as { method?: string } | undefined)?.method === 'DELETE') {
        throw new ApiError(409, "program_in_use: This program has links, so it can't be deleted. End it instead.");
      }
      return {};
    });
    renderPrograms();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/End it instead/);
  });

  it('is hidden from a view-only seat', () => {
    renderPrograms(VIEWER);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

const patchCalls = () =>
  vi.mocked(api).mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH');

describe('End now on Admin → Programs', () => {
  it('asks on the row, then ends that program', async () => {
    renderPrograms();
    fireEvent.click(screen.getAllByRole('button', { name: 'End now' })[0]!);
    expect(screen.getByText('End now?')).toBeTruthy();
    expect(patchCalls()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, end' }));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(patchCalls()[0]![0]).toBe('/programs/prog_used');
  });
});
