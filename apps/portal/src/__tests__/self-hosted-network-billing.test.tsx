// @vitest-environment jsdom
/**
 * Ops → Fees → Self-hosted Network subscription: shows the Network's
 * setting and counts, sets a date as midnight UTC with the grace days, and
 * says what the save did (openpartner-network selfhost-billing.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SelfHostedNetworkBillingCard } from '../pages/platform/SelfHostedNetworkBilling.js';

let state: Record<string, unknown>;
let puts: unknown[];

beforeEach(() => {
  state = {
    settings: { requiredFrom: null, graceDays: 14 },
    maxGraceDays: 90,
    vendors: { listed: 2, paying: 0, held: 0 },
  };
  puts = [];
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/platform-admin/fees/self-hosted-network');
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      state = { ...state, settings: body };
      return new Response(JSON.stringify({ ...state, sweep: { noticed: 2, held: 0, released: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCard(canWrite = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SelfHostedNetworkBillingCard canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

describe('Self-hosted Network subscription card', () => {
  it('shows the gate off with the counts', async () => {
    renderCard();
    expect(await screen.findByText('Not required')).toBeTruthy();
    expect(screen.getByText(/2 approved brands · 0 paying · 0 on hold/)).toBeTruthy();
  });

  it('sets a date as midnight UTC with the grace days and reports the emails', async () => {
    renderCard();
    fireEvent.change(await screen.findByLabelText('Required from'), { target: { value: '2027-01-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set date' }));
    await waitFor(() => expect(puts).toEqual([{ requiredFrom: '2027-01-15T00:00:00.000Z', graceDays: 14 }]));
    expect(await screen.findByText('Saved · 2 brands emailed.')).toBeTruthy();
    expect(await screen.findByText(/Required from Jan 15, 2027/)).toBeTruthy();
  });

  it('turns it off, and hides the controls from read-only operators', async () => {
    state = { ...state, settings: { requiredFrom: '2027-01-15T00:00:00.000Z', graceDays: 14 } };
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(puts).toEqual([{ requiredFrom: null, graceDays: 14 }]));
    cleanup();
    state = { ...state, settings: { requiredFrom: '2027-01-15T00:00:00.000Z', graceDays: 14 } };
    renderCard(false);
    expect(await screen.findByText(/Required from/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
