// @vitest-environment jsdom
/**
 * Warnings for conversion setups that lose referrals without an error
 * (Oct 17 e2e):
 *   - the campaign form checks the destination the way the API does: a
 *     macro the router won't fill in ({{click_id}}) is refused, and a Stripe
 *     Payment Link without client_reference_id={click_id} gets a warning
 *     with a one-click fix
 *   - Admin → Integrations lists event types that matched no commission
 *     rule (a typo'd stage name pays nothing and the sender hears 200)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminPrograms } from '../pages/AdminPrograms.js';
import { AdminIntegrations } from '../pages/admin/Integrations.js';

const BRAND = {
  programName: 'Acme Partners',
  supportEmail: null,
  logoUrl: null,
  brandColor: null,
  programTermsUrl: null,
  whiteLabel: false,
};

function client(seed: Array<[unknown[], unknown]>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['program-settings'], BRAND);
  for (const [key, data] of seed) qc.setQueryData(key, data);
  return qc;
}

function renderWith(qc: QueryClient, page: React.ReactElement) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={qc}>{page}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const text = () => document.body.textContent ?? '';

beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'unexpected_fetch' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
});

afterEach(cleanup);

describe('campaign destination', () => {
  function openCreate() {
    renderWith(
      client([
        [['campaigns'], { programs: [], customerRewardDelivery: 'brand' }],
        [['network-membership'], { enabled: false }],
      ]),
      <AdminPrograms />,
    );
    fireEvent.click(screen.getByRole('button', { name: /new campaign/i }));
    return screen.getByPlaceholderText('https://yourbrand.com/landing-page') as HTMLInputElement;
  }

  it('refuses double braces, as the API does', () => {
    const input = openCreate();
    fireEvent.change(input, { target: { value: 'https://buy.stripe.com/abc?client_reference_id={{click_id}}' } });
    expect(text()).toMatch(/Use single braces: \{click_id\}/);
  });

  it('warns about a Stripe Payment Link without the macro, and adds it on click', () => {
    const input = openCreate();
    fireEvent.change(input, { target: { value: 'https://buy.stripe.com/abc' } });
    expect(text()).toMatch(/Stripe reads the referral only from client_reference_id/);
    fireEvent.click(screen.getByRole('button', { name: 'Add it' }));
    expect(input.value).toBe('https://buy.stripe.com/abc?client_reference_id={click_id}');
    expect(text()).not.toMatch(/Stripe reads the referral only/);
  });

  it('says nothing extra for an ordinary landing page', () => {
    const input = openCreate();
    fireEvent.change(input, { target: { value: 'https://acme.example/landing' } });
    expect(text()).toMatch(/Where partner share-links for this campaign land/);
  });
});

describe('Admin → Integrations: event types that matched no rule', () => {
  function renderIntegrations(eventTypes: unknown[]) {
    renderWith(
      client([
        [['unmatched-event-types'], { since: '2026-09-17T00:00:00Z', eventTypes }],
        [['integration-keys'], { apiKeys: [] }],
        [['conversion-postback'], { token: null }],
      ]),
      <AdminIntegrations />,
    );
  }

  it('lists each type, how often, and on which programs', () => {
    renderIntegrations([
      { type: 'funded', events: 3, lastSeenAt: '2026-10-17T09:00:00Z', programs: [{ id: 'p1', name: 'Lender A' }] },
    ]);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/An event type matched no commission rule/);
    expect(alert.textContent).toMatch(/funded/);
    expect(alert.textContent).toMatch(/3 conversions/);
    expect(alert.textContent).toMatch(/Lender A/);
  });

  it('shows nothing when every type matched a rule', () => {
    renderIntegrations([]);
    expect(screen.queryByRole('alert')).toBeNull();
    // The Stripe guide is linked from the click id card either way.
    expect(screen.getByRole('link', { name: /Stripe Payment Links on OpenPartner Cloud/ }).getAttribute('href')).toMatch(
      /headless-referral\.md#stripe-payment-links-on-openpartner-cloud$/,
    );
  });
});
