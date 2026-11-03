// @vitest-environment jsdom
/**
 * Admin → Integrations → PayPal (docs/paypal-payments.md): Pay with
 * PayPal's app can record the payments it takes, a checkout on another app
 * connects that app (its secret never kept after the call), and once an app
 * records payments the card shows the checkout code that passes the click
 * in custom_id, and what's missing (no webhook, no Transaction Search).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api.js';
import { PaypalPaymentsCard, type PaypalPaymentApp } from '../pages/admin/PaypalPaymentsCard.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  api: vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({});
});

function app(o: Partial<PaypalPaymentApp> = {}): PaypalPaymentApp {
  return {
    id: '01JPAYOUTSAPP0000000000000',
    environment: 'live',
    purpose: 'payouts',
    clientIdPreview: 'AbCdEf…6789',
    tracking: false,
    trackingSince: null,
    webhook: { registered: true, error: null },
    lastEventAt: null,
    transactionSearch: null,
    lastError: null,
    lastErrorAt: null,
    ...o,
  };
}

function renderCard(apps: PaypalPaymentApp[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['paypal-payment-apps'], { apps });
  render(
    <QueryClientProvider client={qc}>
      <PaypalPaymentsCard />
    </QueryClientProvider>,
  );
}

const text = () => document.body.textContent ?? '';

describe('the PayPal payments card', () => {
  it('turns recording on for Pay with PayPal’s app', async () => {
    renderCard([app()]);
    expect(text()).not.toContain('Checkout code');
    fireEvent.click(screen.getByRole('button', { name: 'Record its payments' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/config/paypal/live/payments', { method: 'POST', body: { tracking: true } }));
  });

  it('shows the checkout code and what the app is missing once it records payments', () => {
    renderCard([app({ tracking: true, webhook: { registered: false, error: null }, transactionSearch: 'unavailable', lastEventAt: null })]);
    expect(text()).toContain('Recording payments');
    expect(text()).toContain('No payments yet');
    expect(text()).toContain('payments are read from PayPal every hour');
    expect(text()).toContain('Turn on Transaction Search');
    fireEvent.click(screen.getByText('Checkout code'));
    expect(text()).toContain('custom_id: openpartner.getReferral() ?? undefined');
    expect(text()).toContain("plan_id: 'P-YOUR-PLAN'");
    // Orders are created and captured on the brand's server: PayPal refused
    // a page-side capture of a PayPal-account payment in our sandbox check.
    expect(text()).toContain("post('/api/orders', { referral: openpartner.getReferral() })");
    expect(text()).toContain('/v2/checkout/orders/${encodeURIComponent(req.params.id)}/capture');
    expect(text()).not.toContain('actions.order.capture');
    expect(text()).not.toContain('actions.order.create');
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeTruthy();
  });

  it('connects a checkout app and forgets the secret, whatever PayPal answered', async () => {
    renderCard([app(), app({ id: '01JCHECKOUTAPP000000000000', environment: 'sandbox', purpose: 'checkout', tracking: true })]);
    // Sandbox has its checkout app already: only live is offered.
    fireEvent.click(screen.getByRole('button', { name: /Connect your checkout/ }));
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    vi.mocked(api).mockRejectedValueOnce(new Error('PayPal refused this client id and secret for this environment'));
    const [clientId, secret] = [
      screen.getByLabelText('Client ID') as HTMLInputElement,
      screen.getByLabelText('Secret') as HTMLInputElement,
    ];
    fireEvent.change(clientId, { target: { value: 'ChEcKoutAppClient0123456789' } });
    fireEvent.change(secret, { target: { value: 'CheckoutSecretNeverSeen0123456789abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect live app' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/config/paypal-payments', {
        method: 'POST',
        body: { environment: 'live', clientId: 'ChEcKoutAppClient0123456789', clientSecret: 'CheckoutSecretNeverSeen0123456789abc' },
      }),
    );
    await waitFor(() => expect(secret.value).toBe(''));
    expect(text()).toContain('PayPal refused');
  });

  it('points at Pay with PayPal when no payouts app is connected, and disconnects a checkout app', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderCard([app({ purpose: 'checkout', tracking: true })]);
    expect(text()).toContain('Settings → Pay with PayPal');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/config/paypal-payments/live', { method: 'DELETE' }));
  });
});
