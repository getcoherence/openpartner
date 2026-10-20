// @vitest-environment jsdom
/**
 * The admin Commissions and Payouts pages in words a brand admin can read:
 *   - a commission names its partner and the event it was earned on;
 *   - "Run payouts" reports each payout, who carried over and who is held,
 *     by name, not as JSON;
 *   - with no partner picked, the page lists every partner's recent
 *     payouts, each linking to that partner's history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { CommissionsPage } from '../pages/Commissions.js';
import { PayoutsPage } from '../pages/Payouts.js';
import { commissionSourceLabel, eventTypeLabel } from '../lib/commission-source.js';

let requests: Array<{ method: string; path: string; search: string }> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const NOW = new Date().toISOString();
const LAST_WEEK = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const payout = (over: Record<string, unknown>) => ({
  tenantId: 't_1', currency: 'USD', method: 'manual', status: 'pending', stripeTransferId: null,
  metadata: {}, createdAt: NOW, completedAt: null, ...over,
});

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, search: url.search });
    if (path === '/commissions') {
      return json(200, {
        commissions: [
          {
            id: 'c_trial', partnerId: 'p_maya', partnerName: 'Maya Chen', amount: '10.00', currency: 'USD', status: 'accrued',
            accruedAt: NOW, paidAt: null, campaignName: 'Kestrel Partners', source: 'attribution', eventType: 'trial_started', bonus: null,
          },
          {
            id: 'c_gone', partnerId: '01GONE00000000000000000000', partnerName: null, amount: '30.00', currency: 'USD', status: 'paid',
            accruedAt: LAST_WEEK, paidAt: NOW, campaignName: null, source: 'attribution', eventType: 'invoice_paid', bonus: null,
          },
        ],
        nextCursor: null,
      });
    }
    if (path === '/payouts/holds') return json(200, { holds: [] });
    if (path === '/payouts/runs') return json(200, { runs: [], nextCursor: null });
    if (path === '/payouts/run' && method === 'POST') {
      return json(200, {
        runId: '01RUN0000000000000000000AA',
        mode: 'flat',
        payouts: [
          { payoutId: 'po_1', partnerId: 'p_maya', partnerName: 'Maya Chen', amount: 60, currency: 'USD', method: 'manual', status: 'pending' },
          { payoutId: 'po_2', partnerId: 'p_ravi', partnerName: 'Ravi Shah', amount: 125, currency: 'USD', method: 'stripe_connect', status: 'paid' },
        ],
        skippedBelowThreshold: [{ partnerId: 'p_leo', partnerName: 'Leo Park', currency: 'USD', amount: 20 }],
        skippedUnfunded: [],
        heldForClawback: [],
        heldForCompliance: [
          { partnerId: 'p_ivy', partnerName: 'Ivy Lund', currency: 'USD', amount: 45, reason: 'screening_review' },
        ],
        transfers: { processed: 1, confirmed: [], failed: [], ambiguous: [], reconciled: [], canceled: [], skipped: 0 },
      });
    }
    if (path === '/payouts') {
      return json(200, {
        payouts: [
          payout({ id: 'po_1', partnerId: 'p_maya', partnerName: 'Maya Chen', amount: '60.00' }),
          payout({ id: 'po_0', partnerId: 'p_leo', partnerName: 'Leo Park', amount: '80.00', status: 'paid', createdAt: LAST_WEEK, completedAt: NOW }),
        ],
        nextCursor: null,
      });
    }
    if (path === '/partners/p_maya') return json(200, { id: 'p_maya', name: 'Maya Chen', email: 'maya@example.com' });
    if (path === '/partners/p_maya/payouts') {
      return json(200, { payouts: [payout({ id: 'po_1', partnerId: 'p_maya', amount: '60.00' })] });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => cleanup());

function renderAt(ui: ReactElement, path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/commissions" element={ui} />
          <Route path="/payouts" element={ui} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('admin Commissions: who and what for', () => {
  it("shows the partner's name and the event the commission was earned on", async () => {
    const page = renderAt(<CommissionsPage principal={{ role: 'admin' }} />, '/commissions');
    const trial = within((await page.findByText('Trial started')).closest('tr') as HTMLElement);
    expect(trial.getByText('Maya Chen')).toBeTruthy();
    expect(trial.getByText('Kestrel Partners')).toBeTruthy();
    // A partner whose record is gone falls back to the start of the id.
    const invoice = within(page.getByText('Invoice paid').closest('tr') as HTMLElement);
    expect(invoice.getByText('01GONE00')).toBeTruthy();
  });

  it('words event types, and keeps "Sale" when the type is unknown', () => {
    expect(eventTypeLabel('trial_started')).toBe('Trial started');
    expect(eventTypeLabel('subscription_created')).toBe('Subscription created');
    expect(eventTypeLabel('demo-booked')).toBe('Demo booked');
    expect(commissionSourceLabel({ source: 'attribution', eventType: 'invoice_paid' })).toBe('Invoice paid');
    expect(commissionSourceLabel({ source: 'attribution', eventType: null })).toBe('Sale');
    // A bonus keeps its own label even if a type slipped in.
    expect(commissionSourceLabel({ source: 'bonus', eventType: 'signup', bonus: { source: 'manual', note: null, bountyId: null } })).toBe('Bonus');
  });
});

describe('admin Payouts: run summary and history', () => {
  it("lists every partner's recent payouts, each linking to that partner's history", async () => {
    const page = renderAt(<PayoutsPage principal={{ role: 'admin' }} />, '/payouts');
    expect(page.queryByText('Pick a partner')).toBeNull();
    expect(await page.findByText('Recent payouts')).toBeTruthy();
    const maya = (await page.findByText('Maya Chen')).closest('a') as HTMLAnchorElement;
    expect(maya.getAttribute('href')).toBe('/payouts?partnerId=p_maya');
    const leo = within(page.getByText('Leo Park').closest('tr') as HTMLElement);
    expect(leo.getByText('$80.00')).toBeTruthy();
    expect(leo.getByText('paid')).toBeTruthy();
    expect(requests.find((r) => r.path === '/payouts')?.search).toBe('?limit=50');
  });

  it("opens a partner's history from the list, with a way back", async () => {
    const page = renderAt(<PayoutsPage principal={{ role: 'admin' }} />, '/payouts');
    fireEvent.click(await page.findByText('Maya Chen'));
    expect(await page.findByText('Payout history for Maya Chen.')).toBeTruthy();
    expect((page.getByText('All payouts').closest('a') as HTMLAnchorElement).getAttribute('href')).toBe('/payouts');
    expect(page.queryByText('Recent payouts')).toBeNull();
    expect(await page.findByText('$60.00')).toBeTruthy();
  });

  it('reports a run by name: payouts, carried over, and held', async () => {
    const page = renderAt(<PayoutsPage principal={{ role: 'admin' }} />, '/payouts');
    fireEvent.click(await page.findByRole('button', { name: 'Run payouts' }));

    expect(await page.findByText('Payout run finished: 2 payouts, $185.00')).toBeTruthy();
    expect(page.getByText(/You send the manual payout yourself/)).toBeTruthy();
    expect(page.container.querySelector('pre')).toBeNull();

    const s = within(page.getByRole('region', { name: 'Payout run' }));
    expect(s.getByText('Maya Chen')).toBeTruthy();
    expect(s.getByText('Manual')).toBeTruthy();
    expect(s.getByText('Ravi Shah')).toBeTruthy();
    expect(s.getByText('Stripe')).toBeTruthy();
    expect(s.getByText('Carried over')).toBeTruthy();
    expect(s.getByText('Leo Park')).toBeTruthy();
    expect(s.getByText('$20.00')).toBeTruthy();
    expect(s.getByText('On a compliance hold')).toBeTruthy();
    expect(s.getByText('Ivy Lund')).toBeTruthy();
    expect(s.getByText(/possible match/)).toBeTruthy();

    fireEvent.click(s.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(page.queryByText(/Payout run finished/)).toBeNull());
  });
});
