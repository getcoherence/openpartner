// @vitest-environment jsdom
/**
 * The ops console's Rates page (the Network's docs/rate-suggestions.md §8):
 * the calculator's spend against its caps, the CPM table edited row by row,
 * a new format added under a platform's existing basis, problems blocking
 * Save, and support operators reading only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RatesPage, type RatesSettings, type RatesState } from '../pages/platform/Rates.js';

const SETTINGS: RatesSettings = {
  minAudience: 1000,
  taper: { followers: [{ above: 100_000, weight: 0.5 }] },
  niches: { b2b: { low: 1.5, high: 2.5 }, entertainment: { low: 0.6, high: 0.8 } },
  platforms: {
    youtube: { basis: 'views', formats: { integration: { label: 'Integrated sponsorship', low: 15, high: 30 } } },
    podcast: { basis: 'listeners', niches: { b2b: { low: 1.2, high: 1.4 } }, formats: { midroll: { label: 'Mid-roll read', low: 22, high: 30 } } },
  },
  calculator: { dailyBudgetUsd: 1, monthlyBudgetUsd: 10, lookupsPerIpPerDay: 20, youtubeLookupsPerDay: 300 },
};

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    const state: RatesState = {
      settings: method === 'PUT' ? (body as { settings: RatesSettings }).settings : SETTINGS,
      defaults: SETTINGS,
      updatedAt: null,
      updatedByEmail: null,
      spend: { todayUsd: 0.25, monthUsd: 3.5, youtubeToday: 12 },
    };
    return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage(role: 'admin' | 'support' = 'admin') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <RatesPage operator={{ email: 'ops@example.test', role }} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ops Rates page', () => {
  it('shows spend against the caps', async () => {
    renderPage();
    expect((await screen.findByTestId('rates-spend')).textContent).toBe('Today $0.25 of $1 · This month $3.50 of $10 · YouTube 12 of 300 today');
  });

  it('saves edited rows and a new format, keeping what the page does not edit', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('youtube integration high'), { target: { value: '35' } });

    // A new format on an existing platform takes that platform's basis.
    fireEvent.change(screen.getByLabelText('New platform'), { target: { value: 'youtube' } });
    expect((screen.getByLabelText('New basis') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('New format'), { target: { value: 'dedicated' } });
    fireEvent.change(screen.getByLabelText('New label'), { target: { value: 'Dedicated video' } });
    fireEvent.change(screen.getByLabelText('New low'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('New high'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByLabelText('youtube dedicated label')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toContain('/platform-admin/rates');
    const saved = (put.body as { settings: RatesSettings }).settings;
    expect(saved.platforms.youtube).toEqual({
      basis: 'views',
      formats: {
        integration: { label: 'Integrated sponsorship', low: 15, high: 35 },
        dedicated: { label: 'Dedicated video', low: 30, high: 90 },
      },
    });
    // The podcast row's own niche multipliers and the taper ride along.
    expect(saved.platforms.podcast!.niches).toEqual({ b2b: { low: 1.2, high: 1.4 } });
    expect(saved.taper).toEqual(SETTINGS.taper);
  });

  it('blocks Save while a row or limit is wrong', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('youtube integration low'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Daily budget'), { target: { value: 'lots' } });
    expect((screen.getByRole('alert') as HTMLElement).textContent).toBe(
      'youtube integration: high is below low; Daily budget must be between 0 and 1000.',
    );
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses an inverted niche range instead of letting the Network fall back to its default', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('B2B low'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('B2B high'), { target: { value: '1' } });
    expect((screen.getByRole('alert') as HTMLElement).textContent).toBe('B2B high is below low.');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a format', async () => {
    renderPage();
    await screen.findByLabelText('podcast midroll label');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(Object.keys((calls.find((c) => c.method === 'PUT')!.body as { settings: RatesSettings }).settings.platforms)).toEqual(['youtube']);
  });

  it('is read-only for support operators', async () => {
    renderPage('support');
    expect(((await screen.findByLabelText('youtube integration high')) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByLabelText('New platform')).toBeNull();
  });
});
