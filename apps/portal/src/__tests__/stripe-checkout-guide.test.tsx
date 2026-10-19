// @vitest-environment jsdom
/**
 * Once a brand has connected Stripe, the Integrations card asks how its
 * customers pay and shows only that path: nothing for a Payment Link as
 * the destination or for promo codes, the /op.js tag for Stripe links and
 * embeds on the brand's site, the tag plus one server line for a Checkout
 * Session the brand's app creates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api.js';
import { AdminIntegrations } from '../pages/admin/Integrations.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  api: vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({});
});

function renderConnected(rewards = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['stripe-app'], {
    available: true,
    modes: ['live'],
    connection: {
      stripeAccountId: 'acct_1Brand',
      livemode: true,
      connectedAt: '2026-10-19T00:24:17.000Z',
      lastEventAt: null,
      needsReconnect: false,
      refreshError: null,
      permissionsOutdated: false,
      rewards,
    },
  });
  qc.setQueryData(['integration-keys'], { apiKeys: [] });
  qc.setQueryData(['conversion-postback'], { token: null });
  qc.setQueryData(['program-settings'], {
    programName: 'Acme Partners',
    supportEmail: null,
    logoUrl: null,
    brandColor: null,
    programTermsUrl: null,
    whiteLabel: false,
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AdminIntegrations />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const choose = (label: RegExp) => fireEvent.click(screen.getByRole('radio', { name: label }));
const text = () => document.body.textContent ?? '';
const scriptTag = `<script src="${window.location.origin}/op.js" data-api-url="${window.location.origin}/api"></script>`;

describe('the Stripe checkout guide', () => {
  it('asks how customers pay before showing any steps', () => {
    renderConnected();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(text()).not.toContain('/op.js');
  });

  it('a Payment Link destination needs only the {click_id} URL', () => {
    renderConnected();
    choose(/straight to a stripe payment link/i);
    expect(text()).toContain('https://buy.stripe.com/your-link?client_reference_id={click_id}');
    expect(text()).not.toContain('/op.js');
  });

  it('links and embeds on the site get the one script tag, pointing at this tenant', () => {
    renderConnected();
    choose(/pricing table or a buy button/i);
    expect(text()).toContain(scriptTag);
    expect(text()).toContain('data-stripe-hosts');
  });

  it('an app-created Checkout Session gets the tag and one server line reading op_ref', () => {
    renderConnected();
    choose(/my app creates the stripe checkout session/i);
    expect(text()).toContain(scriptTag);
    expect(text()).toContain('client_reference_id: req.cookies.op_ref');
  });

  it('promo codes say what they need, depending on the connection’s permissions', () => {
    renderConnected(true);
    choose(/partner’s promo code/i);
    expect(text()).toMatch(/Nothing to install, as long as the program offers a customer discount/);
    cleanup();

    renderConnected(false);
    choose(/partner’s promo code/i);
    expect(text()).toMatch(/Reconnect\s+Stripe and accept them/);
  });
});
