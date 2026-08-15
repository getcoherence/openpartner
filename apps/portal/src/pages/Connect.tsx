import { useMutation, useQuery } from '@tanstack/react-query';
import { CreditCard, CheckCircle2, XCircle } from 'lucide-react';
import { api, type Principal } from '../api.js';
import { theme } from '../theme.js';
import { useBrand } from '../lib/useBrand.js';
import { Button, Card, EmptyState, ErrorBanner, Page } from '../ui.js';

interface ConnectStatus {
  connected: boolean;
  accountId?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
}

export function ConnectPage({ principal }: { principal: Principal }) {
  const partnerId = principal.role === 'partner' ? principal.partnerId : null;
  const { programName } = useBrand();

  const status = useQuery({
    queryKey: ['connect-status', partnerId],
    queryFn: () => api<ConnectStatus>(`/partners/${partnerId}/connect/status`),
    retry: false,
    enabled: !!partnerId,
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

  if (!partnerId) {
    return (
      <Page title="Stripe Connect">
        <EmptyState title="Partners only" hint="Stripe Connect onboarding is a partner-side flow." icon={<CreditCard size={28} strokeWidth={1.25} />} />
      </Page>
    );
  }

  const s = status.data;

  return (
    <Page
      title="Stripe Connect"
      subtitle="Receive payouts straight into your own Stripe account."
    >
      <ErrorBanner error={status.error ?? start.error} />
      {status.isLoading ? (
        <Card>Loading…</Card>
      ) : !s?.connected ? (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>Connect an account</div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 16, maxWidth: 560 }}>
            You'll be redirected to Stripe's hosted onboarding. Once you've finished,
            {' '}{programName} will transfer approved commissions directly to your balance.
          </div>
          <Button onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? 'Preparing…' : 'Connect Stripe'}
          </Button>
        </Card>
      ) : (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <CreditCard size={18} color={theme.accent} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Connected</div>
              <code style={{ fontSize: 12, color: theme.textMuted }}>{s.accountId}</code>
            </div>
          </div>
          <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <ChecklistItem label="Details submitted" ok={!!s.detailsSubmitted} />
            <ChecklistItem label="Charges enabled" ok={!!s.chargesEnabled} />
            <ChecklistItem label="Payouts enabled" ok={!!s.payoutsEnabled} />
          </div>
          {!s.payoutsEnabled && (
            <div style={{ marginTop: 16 }}>
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

function ChecklistItem({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div
      style={{
        background: theme.bg,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
      }}
    >
      {ok ? <CheckCircle2 size={14} color={theme.success} /> : <XCircle size={14} color={theme.textDim} />}
      <span style={{ color: ok ? theme.text : theme.textMuted }}>{label}</span>
    </div>
  );
}
