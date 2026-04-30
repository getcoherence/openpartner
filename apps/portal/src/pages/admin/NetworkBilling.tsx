import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../api.js';
import { TenantLink } from '../../tenant-link.js';
import { Button, Card, ErrorBanner, Page } from '../../ui.js';

interface NetworkBilling {
  billingRequired: boolean;
  bundledWithMainPlan: boolean;
  subscriptionStatus: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  networkPriceConfigured: boolean;
  networkUsagePriceConfigured: boolean;
  billingEnabled: boolean;
}

export function AdminNetworkBilling() {
  return (
    <Page
      title="Network billing"
      subtitle="$29/mo + 3% on Network-originated payouts. Self-hosted vendors only — hosted plans bundle Network access."
    >
      <BillingPanel />
    </Page>
  );
}

function BillingPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['network-billing'],
    queryFn: () => api<NetworkBilling>('/admin/network/billing'),
    retry: false,
  });

  if (isLoading) return <Card><p>Loading…</p></Card>;
  if (error) {
    const msg = error instanceof ApiError && error.message.includes('network_not_configured')
      ? 'Connect to the Network first.'
      : `Couldn't load billing: ${error instanceof Error ? error.message : String(error)}`;
    return (
      <>
        <ErrorBanner error={msg} />
        <Card>
          <p>
            Set up your Network connection under <TenantLink to="/admin/network">Network → Connection</TenantLink>{' '}
            before subscribing.
          </p>
        </Card>
      </>
    );
  }
  if (!data) return null;

  if (data.bundledWithMainPlan) {
    return <BundledPanel />;
  }
  return (
    <>
      <StatusCard data={data} />
      {data.subscriptionStatus === 'active' || data.subscriptionStatus === 'trialing' ? (
        <ManagePanel />
      ) : (
        <SubscribePanel data={data} />
      )}
    </>
  );
}

function BundledPanel() {
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Bundled with your main plan ✓</h3>
      <p>
        You're on a hosted plan (Flex or Revshare) on app.openpartner.dev. Network access is included
        — no separate Network billing. The 3% on Network-originated payouts is folded into your main-plan
        invoice.
      </p>
      <p style={{ color: '#6b7280', fontSize: 13 }}>
        Switching to self-hosted later? Re-connect to the Network from your new instance and you'll get
        the standalone billing flow ($29/mo + 3% metered).
      </p>
    </Card>
  );
}

function StatusCard({ data }: { data: NetworkBilling }) {
  const status = data.subscriptionStatus ?? 'not_subscribed';
  const color =
    status === 'active' || status === 'trialing' ? '#1a6b1a' :
    status === 'past_due' || status === 'unpaid' ? '#8b6f00' :
    status === 'canceled' ? '#8a1a1a' :
    '#6b7280';
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Subscription</h3>
      <p>
        Status: <strong style={{ color }}>{status}</strong>
        {data.stripeSubscriptionId && (
          <> · Stripe ID: <code style={{ fontSize: 12 }}>{data.stripeSubscriptionId}</code></>
        )}
      </p>
      {data.currentPeriodEnd && (
        <p style={{ color: '#6b7280', fontSize: 13 }}>
          Current period ends: {new Date(data.currentPeriodEnd).toLocaleDateString()}
        </p>
      )}
      <p style={{ color: '#6b7280', fontSize: 13 }}>
        $29/mo flat + 3% metered on Network-originated payouts. The metered portion is reported daily by
        your instance — only payouts where the partner came from the marketplace count.
      </p>
    </Card>
  );
}

function SubscribePanel({ data }: { data: NetworkBilling }) {
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api<{ url: string }>('/admin/network/billing/checkout', {
      method: 'POST',
      body: {
        successUrl: window.location.origin + '/admin/network/billing?subscribed=1',
        cancelUrl: window.location.href,
      },
    }),
    onSuccess: ({ url }) => { window.location.href = url; },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  });
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Subscribe to Network access</h3>
      {!data.billingEnabled && (
        <ErrorBanner error="Stripe isn't configured on the Network deploy. Operator needs to set STRIPE_SECRET_KEY." />
      )}
      {data.billingEnabled && !data.networkPriceConfigured && (
        <ErrorBanner error="The Network deploy doesn't have a price configured. Operator needs to set STRIPE_NETWORK_PRICE_ID." />
      )}
      {data.billingEnabled && data.networkPriceConfigured && !data.networkUsagePriceConfigured && (
        <ErrorBanner error="The Network deploy is missing the metered price. Operator needs to set STRIPE_NETWORK_USAGE_PRICE_ID." />
      )}
      {error && <ErrorBanner error={error} />}
      <p>
        Click below to open Stripe Checkout. You'll subscribe to a single Stripe Subscription with two
        items: the $29/mo flat fee and the 3% metered usage. We'll redirect you back here when payment
        completes.
      </p>
      <Button
        onClick={() => m.mutate()}
        disabled={
          m.isPending ||
          !data.billingEnabled ||
          !data.networkPriceConfigured ||
          !data.networkUsagePriceConfigured
        }
      >
        {m.isPending ? 'Opening Stripe…' : 'Subscribe via Stripe'}
      </Button>
    </Card>
  );
}

function ManagePanel() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api<{ url: string }>('/admin/network/billing/portal', {
      method: 'POST',
      body: { returnUrl: window.location.href },
    }),
    onSuccess: ({ url }) => { window.location.href = url; },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  });
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Manage subscription</h3>
      {error && <ErrorBanner error={error} />}
      <p>
        Update your card, see invoices, or cancel via Stripe's hosted Customer Portal.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => m.mutate()} disabled={m.isPending}>
          {m.isPending ? 'Opening Stripe…' : 'Open Stripe portal'}
        </Button>
        <Button variant="secondary" onClick={() => qc.invalidateQueries({ queryKey: ['network-billing'] })}>
          Refresh
        </Button>
      </div>
    </Card>
  );
}
