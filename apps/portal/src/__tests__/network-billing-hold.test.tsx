// @vitest-environment jsdom
/**
 * Network → Billing on a self-hosted brand: the Network's billing gate
 * (openpartner-network selfhost-billing.ts) shows as a hold banner, or as
 * the coming deadline while unpaid, and not at all once paying.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminNetworkBilling } from '../pages/admin/NetworkBilling.js';

const BASE = {
  billingRequired: true,
  bundledWithMainPlan: false,
  subscriptionStatus: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  currentPeriodEnd: null,
  networkPriceConfigured: true,
  networkUsagePriceConfigured: true,
  billingEnabled: true,
};

function renderWith(billing: Record<string, unknown>) {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify({ ...BASE, ...billing }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/admin/network/billing']}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="*" element={<AdminNetworkBilling />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Network billing gate on the billing page', () => {
  it('says the listing is on hold', async () => {
    renderWith({ requiredFrom: '2026-12-01T00:00:00.000Z', billingHold: true });
    expect(await screen.findByText(/off the marketplace and you can't approve new creators until you subscribe/)).toBeTruthy();
  });

  it('shows the coming deadline while unpaid', async () => {
    renderWith({ requiredFrom: '2027-01-15T00:00:00.000Z', billingHold: false });
    expect(await screen.findByText(/Subscription required from January 15, 2027/)).toBeTruthy();
  });

  it('shows nothing once paying, or from a Network without the gate', async () => {
    renderWith({ requiredFrom: '2027-01-15T00:00:00.000Z', billingHold: false, subscriptionStatus: 'active' });
    expect(await screen.findByText('Subscription')).toBeTruthy();
    expect(screen.queryByText(/Subscription required from/)).toBeNull();
    cleanup();
    renderWith({});
    expect(await screen.findByText('Subscription')).toBeTruthy();
    expect(screen.queryByText(/Subscription required from|off the marketplace/)).toBeNull();
  });
});
