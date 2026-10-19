// @vitest-environment jsdom
/**
 * Customer-reward copy follows the deployment.
 *
 * Only a single-tenant self-host mints the reward in the brand's Stripe
 * (API: customerRewardDelivery(), sent with GET /programs). Everywhere
 * else the editor used to promise "discount applies automatically" for a
 * code that never existed at the brand's checkout. Render the real
 * Programs page per delivery value and pin which promise it makes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminPrograms } from '../pages/AdminPrograms.js';

type Delivery = 'stripe' | 'unconfigured' | 'brand';

const PROGRAM = {
  id: 'prog_1',
  name: 'Default',
  commissionRule: [{ trigger: 'every', type: 'percent', value: 20, recurring: true }],
  attributionWindowDays: 60,
  attributionModel: 'last_click',
  destinationUrl: 'https://acme.example/landing',
  deepLinkAllowedDomains: null,
  holdbackDays: 0,
  startsAt: null,
  endsAt: null,
  customerReward: { type: 'percent_off', value: 20, duration: 'repeating', durationInMonths: 3 },
  shareOnNetwork: false,
  partnersMayCustomizeCode: false,
  marketplaceDescription: null,
  networkOfferingId: null,
  categories: [],
  createdAt: '2026-10-01T00:00:00.000Z',
};

function renderPrograms(delivery: Delivery | undefined) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // Seed every cache the page reads so no fetch happens. An absent
  // delivery = an API that predates the field.
  qc.setQueryData(['campaigns'], {
    programs: [PROGRAM],
    ...(delivery ? { customerRewardDelivery: delivery } : {}),
  });
  qc.setQueryData(['network-membership'], { enabled: false });
  qc.setQueryData(['program-settings'], {
    programName: 'Acme Partners',
    supportEmail: null,
    logoUrl: null,
    brandColor: null,
    programTermsUrl: null,
    whiteLabel: false,
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AdminPrograms />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function openCreate() {
  fireEvent.click(screen.getByRole('button', { name: /new campaign/i }));
}

function pickFreeMonths() {
  const toggle = screen.getByLabelText(/offer customer-side discount/i) as HTMLInputElement;
  if (!toggle.checked) fireEvent.click(toggle);
  fireEvent.change(screen.getByDisplayValue('% off'), { target: { value: 'free_months' } });
}

const text = () => document.body.textContent ?? '';

beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'unexpected_fetch' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
});

afterEach(() => {
  cleanup();
});

describe('customer reward copy per deployment', () => {
  it('self-host with Stripe: promises auto-provisioning', () => {
    renderPrograms('stripe');
    openCreate();
    expect(text()).toMatch(/discount applies automatically/);
    expect(text()).toMatch(/A deactivated code stops working at checkout/);
    pickFreeMonths();
    expect(text()).toMatch(/Delivered as a 100% Stripe coupon/);
  });

  it('hosted: tells the brand to create the code in its own Stripe', () => {
    renderPrograms('brand');
    openCreate();
    expect(text()).not.toMatch(/applies automatically/);
    expect(text()).toMatch(/in your own Stripe, create a promotion code with\s+the same string/);
    expect(text()).toMatch(/POST \/coupons\/redeem/);
    expect(text()).toMatch(/checkout isn’t updated for you/);
    expect(text()).toMatch(/keeps discounting until you do/);
    expect(text()).not.toMatch(/stops working at checkout/);
    pickFreeMonths();
    expect(text()).not.toMatch(/Delivered as a 100% Stripe coupon/);
    expect(text()).toMatch(/In Stripe, that’s a 100% coupon repeating/);
  });

  it('hosted: the edit form carries the same copy', () => {
    renderPrograms('brand');
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(text()).toMatch(/Edit campaign — Default/);
    expect(text()).not.toMatch(/applies automatically/);
    expect(text()).toMatch(/create a promotion code/);
  });

  it('self-host without a Stripe key: points at STRIPE_SECRET_KEY', () => {
    renderPrograms('unconfigured');
    openCreate();
    expect(text()).not.toMatch(/applies automatically/);
    expect(text()).toMatch(/STRIPE_SECRET_KEY/);
    expect(text()).toMatch(/checkout isn’t updated for you/);
  });

  it('unknown delivery (older API, still loading): promises nothing either way', () => {
    renderPrograms(undefined);
    openCreate();
    expect(text()).not.toMatch(/applies automatically/);
    expect(text()).not.toMatch(/create a promotion code/);
    expect(text()).not.toMatch(/stops working at checkout/);
    expect(text()).not.toMatch(/keeps discounting/);
    pickFreeMonths();
    expect(text()).not.toMatch(/Delivered as a 100% Stripe coupon/);
  });
});
