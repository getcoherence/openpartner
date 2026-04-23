import { useQuery } from '@tanstack/react-query';
import { api, type Principal } from '../api.js';
import { Card, ErrorBanner, Page, Table, formatDate, money } from '../ui.js';

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

  const rows = (data?.commissions ?? []).map((c) => [
    <code style={{ fontSize: 12 }}>{c.id.slice(0, 10)}…</code>,
    principal.role === 'admin' ? <code style={{ fontSize: 12 }}>{c.partnerId.slice(0, 10)}…</code> : null,
    money(c.amount, c.currency),
    <StatusPill status={c.status} />,
    formatDate(c.accruedAt),
    formatDate(c.paidAt),
  ].filter((x) => x !== null));

  const columns = principal.role === 'admin'
    ? ['ID', 'Partner', 'Amount', 'Status', 'Accrued', 'Paid']
    : ['ID', 'Amount', 'Status', 'Accrued', 'Paid'];

  return (
    <Page title="Commissions">
      <ErrorBanner error={error} />
      {isLoading ? <Card>Loading…</Card> : <Table columns={columns} rows={rows} />}
    </Page>
  );
}

export function StatusPill({ status }: { status: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    accrued: { bg: '#fef3c7', fg: '#92400e' },
    approved: { bg: '#dbeafe', fg: '#1e40af' },
    paid: { bg: '#d1fae5', fg: '#065f46' },
    reversed: { bg: '#fee2e2', fg: '#991b1b' },
    pending: { bg: '#e5e7eb', fg: '#374151' },
    failed: { bg: '#fee2e2', fg: '#991b1b' },
  };
  const c = colors[status] ?? { bg: '#e5e7eb', fg: '#374151' };
  return (
    <span style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600 }}>
      {status}
    </span>
  );
}
