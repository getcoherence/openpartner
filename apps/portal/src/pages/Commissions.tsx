import { useQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { api, type Principal } from '../api.js';
import { theme } from '../theme.js';
import { Card, EmptyState, ErrorBanner, Page, StatusPill, Table, formatDate, money, shortId } from '../ui.js';

export { StatusPill };

interface Commission {
  id: string;
  partnerId: string;
  amount: string;
  currency: string;
  status: string;
  accruedAt: string;
  paidAt: string | null;
}

export function CommissionsPage({ principal }: { principal: Principal }) {
  const queryPartnerId = new URLSearchParams(window.location.search).get('partnerId');
  const partnerId = principal.partnerId ?? queryPartnerId;

  const url = partnerId ? `/partners/${partnerId}/commissions?limit=500` : `/commissions?limit=500`;
  const { data, error, isLoading } = useQuery({
    queryKey: ['commissions', partnerId ?? 'all'],
    queryFn: () => api<{ commissions: Commission[] }>(url),
  });

  const isAdminView = principal.role === 'admin' && !partnerId;
  const columns = isAdminView
    ? ['ID', 'Partner', { label: 'Amount', align: 'right' as const }, 'Status', 'Accrued', 'Paid']
    : ['ID', { label: 'Amount', align: 'right' as const }, 'Status', 'Accrued', 'Paid'];

  const rows = (data?.commissions ?? []).map((c) => {
    const base = [
      <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(c.id)}</code>,
      isAdminView ? <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(c.partnerId)}</code> : null,
      <span style={{ fontWeight: 500 }}>{money(c.amount, c.currency)}</span>,
      <StatusPill status={c.status} />,
      <span style={{ color: theme.textMuted }}>{formatDate(c.accruedAt, { relative: true })}</span>,
      <span style={{ color: theme.textMuted }}>{formatDate(c.paidAt, { relative: true })}</span>,
    ];
    return base.filter((x) => x !== null) as React.ReactNode[];
  });

  return (
    <Page title="Commissions" subtitle={partnerId ? 'Earnings on attributed events.' : 'Every partner, every commission.'}>
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No commissions yet"
          hint="Commissions accrue when an attributed event is ingested."
          icon={<Receipt size={28} strokeWidth={1.25} />}
        />
      ) : (
        <Table columns={columns} rows={rows} />
      )}
    </Page>
  );
}
