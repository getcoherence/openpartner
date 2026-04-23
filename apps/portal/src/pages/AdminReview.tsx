import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { Button, Card, ErrorBanner, Page, Table, formatDate, money } from '../ui.js';
import { StatusPill } from './Commissions.js';

interface Commission {
  id: string;
  partnerId: string;
  amount: string;
  currency: string;
  status: string;
  accruedAt: string;
}

export function AdminReview() {
  const qc = useQueryClient();
  const pending = useQuery({
    queryKey: ['review', 'accrued'],
    queryFn: () => api<{ commissions: Commission[] }>('/commissions?status=accrued&limit=500'),
  });

  const approve = useMutation({
    mutationFn: (id: string) => api(`/commissions/${id}/approve`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['review'] }),
  });
  const reverse = useMutation({
    mutationFn: (id: string) => api(`/commissions/${id}/reverse`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['review'] }),
  });

  return (
    <Page title="Review queue">
      <ErrorBanner error={pending.error ?? approve.error ?? reverse.error} />
      {pending.isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <Table
          columns={['Partner', 'Amount', 'Status', 'Accrued', 'Actions']}
          rows={(pending.data?.commissions ?? []).map((c) => [
            <code style={{ fontSize: 12 }}>{c.partnerId.slice(0, 10)}…</code>,
            money(c.amount, c.currency),
            <StatusPill status={c.status} />,
            formatDate(c.accruedAt),
            <div style={{ display: 'flex', gap: 6 }}>
              <Button onClick={() => approve.mutate(c.id)} disabled={approve.isPending}>
                Approve
              </Button>
              <Button variant="danger" onClick={() => reverse.mutate(c.id)} disabled={reverse.isPending}>
                Reverse
              </Button>
            </div>,
          ])}
        />
      )}
    </Page>
  );
}
