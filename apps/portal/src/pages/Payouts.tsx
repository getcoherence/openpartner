import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, Play } from 'lucide-react';
import { api, type Principal } from '../api.js';
import { theme } from '../theme.js';
import { Button, Card, EmptyState, ErrorBanner, Page, StatusPill, Table, formatDate, money, shortId } from '../ui.js';

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

  const runPayouts = useMutation({
    mutationFn: () =>
      api<{
        runId: string;
        payouts: unknown[];
        skippedBelowThreshold: Array<{ partnerId: string; currency: string; amount: number }>;
      }>('/payouts/run', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payouts'] });
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['admin-overview'] });
    },
  });

  const payouts = useQuery({
    queryKey: ['payouts', partnerId ?? 'none'],
    queryFn: () => api<{ payouts: Payout[] }>(`/partners/${partnerId}/payouts`),
    enabled: !!partnerId,
  });

  const subtitle =
    principal.role === 'admin'
      ? partnerId
        ? 'History for this partner.'
        : 'Kick off a batch to pay out every approved commission.'
      : 'Your payout history.';

  const actions =
    principal.role === 'admin' ? (
      <Button icon={<Play size={14} />} onClick={() => runPayouts.mutate()} disabled={runPayouts.isPending}>
        {runPayouts.isPending ? 'Running…' : 'Run payouts'}
      </Button>
    ) : undefined;

  return (
    <Page title="Payouts" subtitle={subtitle} actions={actions}>
      <ErrorBanner error={runPayouts.error ?? payouts.error} />

      {runPayouts.data && (
        <Card style={{ marginBottom: 14, borderColor: `${theme.accent}55` }}>
          <div style={{ fontSize: 13, color: theme.accent, fontWeight: 500, marginBottom: 8 }}>
            Run #{shortId(runPayouts.data.runId)} — {runPayouts.data.payouts.length} payout
            {runPayouts.data.payouts.length === 1 ? '' : 's'}
            {runPayouts.data.skippedBelowThreshold?.length > 0 && (
              <span style={{ color: theme.textMuted, fontWeight: 400 }}>
                {' '}
                · {runPayouts.data.skippedBelowThreshold.length} skipped below threshold
              </span>
            )}
          </div>
          <pre
            style={{
              margin: 0,
              background: theme.bg,
              color: theme.text,
              padding: 14,
              borderRadius: theme.radiusSm,
              fontSize: 12,
              overflow: 'auto',
              maxHeight: 280,
            }}
          >
            {JSON.stringify(
              {
                payouts: runPayouts.data.payouts,
                ...(runPayouts.data.skippedBelowThreshold?.length
                  ? { skippedBelowThreshold: runPayouts.data.skippedBelowThreshold }
                  : {}),
              },
              null,
              2,
            )}
          </pre>
        </Card>
      )}

      {!partnerId ? (
        <EmptyState
          title="Pick a partner"
          hint="Open a partner from Admin → Partners to see their payout history."
          icon={<Banknote size={28} strokeWidth={1.25} />}
        />
      ) : payouts.isLoading ? (
        <Card>Loading…</Card>
      ) : (payouts.data?.payouts ?? []).length === 0 ? (
        <EmptyState
          title="No payouts yet"
          hint="Approved commissions become payouts on the next run."
          icon={<Banknote size={28} strokeWidth={1.25} />}
        />
      ) : (
        <Table
          columns={['ID', { label: 'Amount', align: 'right' }, 'Method', 'Status', 'Created', 'Completed']}
          rows={(payouts.data?.payouts ?? []).map((p) => [
            <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(p.id)}</code>,
            <span style={{ fontWeight: 500 }}>{money(p.amount, p.currency)}</span>,
            <span style={{ color: theme.textMuted }}>{p.method.replace('_', ' ')}</span>,
            <StatusPill status={p.status} />,
            <span style={{ color: theme.textMuted }}>{formatDate(p.createdAt, { relative: true })}</span>,
            <span style={{ color: theme.textMuted }}>{formatDate(p.completedAt, { relative: true })}</span>,
          ])}
        />
      )}
    </Page>
  );
}
