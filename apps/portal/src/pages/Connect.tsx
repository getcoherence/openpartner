import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type Principal } from '../api.js';
import { Button, Card, ErrorBanner, Page } from '../ui.js';

interface ConnectStatus {
  connected: boolean;
  accountId?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
}

export function ConnectPage({ principal }: { principal: Principal }) {
  if (principal.role !== 'partner' || !principal.partnerId) {
    return (
      <Page title="Stripe Connect">
        <Card>Only partners can connect Stripe accounts from the portal.</Card>
      </Page>
    );
  }

  const partnerId = principal.partnerId;
  const status = useQuery({
    queryKey: ['connect-status', partnerId],
    queryFn: () => api<ConnectStatus>(`/partners/${partnerId}/connect/status`),
    retry: false,
  });

  const start = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/partners/${partnerId}/connect/start`, {
        method: 'POST',
        body: {
          returnUrl: `${window.location.origin}/connect?done=1`,
          refreshUrl: `${window.location.origin}/connect`,
        },
      }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const s = status.data;

  return (
    <Page title="Stripe Connect">
      <ErrorBanner error={status.error ?? start.error} />
      {status.isLoading ? (
        <Card>Loading…</Card>
      ) : !s?.connected ? (
        <Card>
          <div style={{ marginBottom: 12 }}>
            Connect a Stripe account to receive payouts. You'll be redirected to Stripe to complete onboarding.
          </div>
          <Button onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? 'Preparing…' : 'Connect Stripe'}
          </Button>
        </Card>
      ) : (
        <Card>
          <div style={{ marginBottom: 12 }}>
            <strong>Account:</strong> <code>{s.accountId}</code>
          </div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>Details submitted: {s.detailsSubmitted ? 'yes' : 'no'}</li>
            <li>Charges enabled: {s.chargesEnabled ? 'yes' : 'no'}</li>
            <li>Payouts enabled: {s.payoutsEnabled ? 'yes' : 'no'}</li>
          </ul>
          {!s.payoutsEnabled && (
            <div style={{ marginTop: 12 }}>
              <Button onClick={() => start.mutate()} disabled={start.isPending}>
                Finish onboarding
              </Button>
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}
