/**
 * The creator's own Stripe account, which storefront bookings are paid into
 * (the Network's docs/creator-storefront.md §8.2). Brands pay upfront
 * through Stripe Checkout as a charge on this account: the creator is the
 * seller, Stripe pays them out on their own schedule and bills them its
 * processing fees, and OpenPartner's booking fee is added on top for the
 * brand. A storefront takes bookings only while the account can take card
 * payments.
 *
 * Connecting opens Stripe's hosted onboarding; Stripe sends the creator back
 * to /creator/storefront?stripe=return, which re-reads the account.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, ExternalLink } from 'lucide-react';
import { Button, Card, ErrorBanner } from '../../ui.js';
import { theme } from '../../theme.js';
import { ApiError, creatorApi } from './creator-api.js';

export interface PaymentsView {
  connected: boolean;
  ready: boolean;
  cardPayments: 'active' | 'pending' | 'restricted' | 'unsupported' | null;
  country: string | null;
  currency: string | null;
  checkedAt: string | null;
  configured?: boolean;
}

export const PAYMENTS_KEY = ['creator-payments'];

/** The Network's error code on a creator-api error. */
export function creatorErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const d = err.detail as { error?: unknown } | null;
  return typeof d?.error === 'string' ? d.error : null;
}

export function usePayments() {
  const [params] = useSearchParams();
  // Back from Stripe's onboarding: read the account fresh.
  const returning = params.get('stripe') === 'return';
  return useQuery({
    queryKey: [...PAYMENTS_KEY, returning],
    queryFn: () => creatorApi<PaymentsView>(`/creators/me/payments${returning ? '?refresh=1' : ''}`),
    retry: false,
    // Stripe can take a minute to verify; poll while it's pending.
    refetchInterval: (q) => (q.state.data?.connected && !q.state.data.ready ? 30_000 : false),
  });
}

export function PaymentsCard({ returnPath = '/creator/storefront' }: { returnPath?: string }) {
  const qc = useQueryClient();
  const payments = usePayments();
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    if (!params.get('stripe') || payments.isLoading) return;
    // The storefront's bookings switch depends on this too.
    void qc.invalidateQueries({ queryKey: ['creator-storefront'] });
    const next = new URLSearchParams(params);
    next.delete('stripe');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payments.isLoading]);

  const connect = useMutation({
    mutationFn: () => {
      const back = `${window.location.origin}${returnPath}${returnPath.includes('?') ? '&' : '?'}`;
      return creatorApi<{ url: string }>('/creators/me/payments/onboarding', {
        method: 'POST',
        body: { returnUrl: `${back}stripe=return`, refreshUrl: `${back}stripe=refresh` },
      });
    },
    onSuccess: (r) => window.location.assign(r.url),
  });
  const p = payments.data;
  const code = creatorErrorCode(connect.error);

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <CreditCard size={20} style={{ color: p?.ready ? theme.success : theme.textMuted, flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>Payments</div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4, lineHeight: 1.5 }}>
            {!p ? (
              'Loading…'
            ) : p.ready ? (
              <>
                Brands pay you upfront, straight into your own Stripe account{p.country ? ` (${p.country})` : ''}. Stripe pays you out on your
                schedule and charges its processing fees; OpenPartner&rsquo;s booking fee is added on top for the brand, so you keep your price.
              </>
            ) : p.connected ? (
              <>Stripe is still checking your account, or needs a few more details. Bookings open once it can take card payments.</>
            ) : (
              <>
                Bookings are paid upfront into your own Stripe account, so you need one to take bookings. Stripe sets it up in a few
                minutes, and you can add it to a Stripe login you already have. You keep your price: OpenPartner&rsquo;s booking fee is
                added on top for the brand.
              </>
            )}
          </div>
          <ErrorBanner
            error={
              code === 'payments_not_configured'
                ? 'Payments aren’t available on this server yet.'
                : code === 'stripe_error'
                  ? 'Stripe couldn’t start the setup. Try again in a moment.'
                  : connect.error ?? payments.error
            }
          />
        </div>
        {p && !p.ready && (
          <Button onClick={() => connect.mutate()} disabled={connect.isPending || connect.isSuccess}>
            {connect.isPending || connect.isSuccess ? 'Opening Stripe…' : p.connected ? 'Finish Stripe setup' : 'Connect Stripe'}
          </Button>
        )}
        {p?.ready && (
          <a
            href="https://dashboard.stripe.com/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 13, color: theme.accentText, display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'center' }}
          >
            Stripe Dashboard <ExternalLink size={12} />
          </a>
        )}
      </div>
    </Card>
  );
}
