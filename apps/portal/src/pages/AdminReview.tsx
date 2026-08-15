import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api.js';
import { theme } from '../theme.js';
import { Button, Card, EmptyState, ErrorBanner, Page, StatusPill, Table, formatDate, money, shortId } from '../ui.js';

interface Commission {
  id: string;
  partnerId: string;
  amount: string;
  currency: string;
  status: string;
  accruedAt: string;
  holdbackDays: number | null;
  matureAt: string | null;
  campaignName: string | null;
}

function daysFromNow(iso: string): number {
  return Math.ceil((Date.parse(iso) - Date.now()) / (24 * 60 * 60 * 1000));
}

export function AdminReview() {
  const qc = useQueryClient();
  const pending = useQuery({
    queryKey: ['review', 'accrued'],
    queryFn: () => api<{ commissions: Commission[] }>('/commissions?status=accrued&limit=500'),
  });

  const approve = useMutation({
    mutationFn: (id: string) => api(`/commissions/${id}/approve`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['review'] });
      qc.invalidateQueries({ queryKey: ['admin-overview'] });
    },
  });
  const reverse = useMutation({
    mutationFn: (id: string) => api(`/commissions/${id}/reverse`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['review'] });
      qc.invalidateQueries({ queryKey: ['admin-overview'] });
    },
  });

  const rows = pending.data?.commissions ?? [];

  return (
    <Page
      title="Review queue"
      subtitle={`${rows.length} commission${rows.length === 1 ? '' : 's'} awaiting your decision.`}
    >
      <ErrorBanner error={pending.error ?? approve.error ?? reverse.error} />
      {pending.isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        <EmptyState title="Queue's clear" hint="New commissions will land here as events attribute." icon={<ShieldCheck size={28} strokeWidth={1.25} />} />
      ) : (
        <Table
          columns={['Partner', { label: 'Amount', align: 'right' }, 'Status', 'Accrued', 'Actions']}
          rows={rows.map((c) => {
            const inHoldback = c.matureAt ? Date.parse(c.matureAt) > Date.now() : false;
            const daysLeft = c.matureAt ? daysFromNow(c.matureAt) : 0;
            return [
              <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(c.partnerId)}</code>,
              <span style={{ fontWeight: 500 }}>{money(c.amount, c.currency)}</span>,
              inHoldback ? (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: theme.textMuted,
                    background: theme.surface2,
                    border: `1px solid ${theme.border}`,
                    borderRadius: 999,
                    padding: '3px 9px',
                    whiteSpace: 'nowrap',
                  }}
                  title={`Holdback policy: ${c.holdbackDays} days. Auto-approves on ${new Date(c.matureAt!).toLocaleDateString()}.`}
                >
                  Holdback · {daysLeft}d left
                </span>
              ) : (
                <StatusPill status={c.status} />
              ),
              <span style={{ color: theme.textMuted }}>{formatDate(c.accruedAt, { relative: true })}</span>,
              <div style={{ display: 'flex', gap: 6 }}>
                <span title={inHoldback ? `In holdback until ${new Date(c.matureAt!).toLocaleDateString()}` : ''}>
                  <Button
                    size="sm"
                    onClick={() => approve.mutate(c.id)}
                    disabled={approve.isPending || inHoldback}
                  >
                    Approve
                  </Button>
                </span>
                <Button size="sm" variant="danger" onClick={() => reverse.mutate(c.id)} disabled={reverse.isPending}>
                  Reverse
                </Button>
              </div>,
            ];
          })}
        />
      )}
    </Page>
  );
}
