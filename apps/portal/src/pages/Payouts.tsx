import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Principal } from '../api.js';
import { Button, Card, ErrorBanner, Page, Table, formatDate, money } from '../ui.js';
import { StatusPill } from './Commissions.js';

interface Payout {
  id: string;
  partnerId: string;
  amount: string;
  currency: string;
  method: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  stripeTransferId: string | null;
}

export function PayoutsPage({ principal }: { principal: Principal }) {
  const qc = useQueryClient();
  const queryPartnerId = new URLSearchParams(window.location.search).get('partnerId');
  const partnerId = principal.partnerId ?? queryPartnerId;

  const { data, error, isLoading } = useQuery({
    queryKey: ['payouts', partnerId ?? 'all'],
    queryFn: () =>
      api<{ payouts: Payout[] }>(partnerId ? `/partners/${partnerId}/payouts` : `/partners/${queryPartnerId ?? ''}/payouts`),
    enabled: !!partnerId,
  });

  const runPayouts = useMutation({
    mutationFn: () => api<{ runId: string; payouts: unknown[] }>('/payouts/run', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payouts'] });
      qc.invalidateQueries({ queryKey: ['commissions'] });
    },
  });

  if (principal.role === 'admin' && !partnerId) {
    return (
      <Page
        title="Payouts"
        actions={
          <Button onClick={() => runPayouts.mutate()} disabled={runPayouts.isPending}>
            {runPayouts.isPending ? 'Running…' : 'Run payouts'}
          </Button>
        }
      >
        <ErrorBanner error={runPayouts.error} />
        {runPayouts.data && (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Run #{runPayouts.data.runId}</div>
            <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, fontSize: 12, overflow: 'auto' }}>
              {JSON.stringify(runPayouts.data.payouts, null, 2)}
            </pre>
          </Card>
        )}
        <Card>
          <div style={{ color: '#666' }}>
            Pick a partner from the admin list to see their payout history, or click <strong>Run payouts</strong> to process all approved commissions.
          </div>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Payouts">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <Table
          columns={['ID', 'Amount', 'Method', 'Status', 'Created', 'Completed']}
          rows={(data?.payouts ?? []).map((p) => [
            <code style={{ fontSize: 12 }}>{p.id.slice(0, 10)}…</code>,
            money(p.amount, p.currency),
            p.method,
            <StatusPill status={p.status} />,
            formatDate(p.createdAt),
            formatDate(p.completedAt),
          ])}
        />
      )}
    </Page>
  );
}
