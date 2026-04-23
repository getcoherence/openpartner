import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { api, type Principal } from '../../api.js';
import { theme } from '../../theme.js';
import { Card, EmptyState, ErrorBanner, Page, StatusPill, Table, formatDate, shortId } from '../../ui.js';

interface PartnershipRequest {
  id: string;
  offeringId: string;
  vendorId: string;
  creatorId: string;
  direction: 'creator_to_vendor' | 'vendor_to_creator';
  message: string | null;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export function MyRequestsPage({ principal }: { principal: Principal }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['network-requests-mine'],
    queryFn: () => api<{ requests: PartnershipRequest[] }>('/network/requests/mine'),
  });

  const rows = (data?.requests ?? []).map((r) => [
    <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(r.id)}</code>,
    <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(r.offeringId)}</code>,
    <span style={{ color: theme.textMuted }}>
      {r.direction === 'creator_to_vendor' ? 'You → Vendor' : 'Vendor → You'}
    </span>,
    <StatusPill status={r.status} />,
    <span style={{ color: theme.textMuted }}>{formatDate(r.createdAt, { relative: true })}</span>,
  ]);

  const subtitle =
    principal.role === 'network_creator'
      ? 'Applications you have submitted to vendors.'
      : 'Applications creators have submitted to your offerings.';

  return (
    <Page title="Requests" subtitle={subtitle}>
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        <EmptyState title="No requests yet" icon={<Inbox size={28} strokeWidth={1.25} />} />
      ) : (
        <Table columns={['ID', 'Offering', 'Direction', 'Status', 'Created']} rows={rows} />
      )}
    </Page>
  );
}
