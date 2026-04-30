import { useQuery } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { TenantLink } from '../../tenant-link.js';
import { Card, EmptyState, ErrorBanner, Page, Stat, StatusPill, formatDate, money } from '../../ui.js';
import { theme } from '../../theme.js';

interface Affiliation {
  id: string;
  vendorId: string;
  vendorPartnerId: string;
  status: string;
  joinedVendorAt: string;
  vendorName: string;
  vendorInstanceUrl: string;
}

interface Earnings {
  partnerId: string;
  since: string;
  clicks: number;
  attributedEvents: number;
  attributedRevenue: number;
  commissionByStatus: Record<string, number>;
}

function EarningsBlock({ aff }: { aff: Affiliation }) {
  // Skip the federated dashboard fetch for non-active affiliations.
  // Pending = no Partner row yet on that vendor; revoked = cut access.
  const enabled = aff.status === 'active';
  const { data, isLoading, error } = useQuery<Earnings, ApiError>({
    queryKey: ['network-aff-earnings', aff.id],
    queryFn: () => api<Earnings>(`/network/me/affiliations/${aff.id}/earnings`),
    enabled,
    retry: false,
    staleTime: 60_000,
  });

  if (!enabled) {
    return <p style={{ color: theme.textMuted, fontSize: 13 }}>Earnings appear once the partnership is active.</p>;
  }
  if (isLoading) return <p style={{ color: theme.textMuted, fontSize: 13 }}>Loading earnings…</p>;
  if (error) {
    if (error.status === 502) {
      return <p style={{ color: theme.textMuted, fontSize: 13 }}>Vendor instance unreachable — earnings will refresh when it&apos;s back.</p>;
    }
    return <p style={{ color: theme.textMuted, fontSize: 13 }}>Couldn&apos;t load earnings.</p>;
  }
  if (!data) return null;
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 12 }}>
      <Stat label="Clicks (30d)" value={data.clicks.toLocaleString()} />
      <Stat label="Attributed events" value={data.attributedEvents.toLocaleString()} />
      <Stat label="Revenue" value={money(data.attributedRevenue, 'USD')} />
      {Object.entries(data.commissionByStatus ?? {}).map(([status, amount]) => (
        <Stat key={status} label={`${status} commission`} value={money(amount, 'USD')} />
      ))}
    </div>
  );
}

export function MyAffiliationsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['network-my-affiliations'],
    queryFn: () => api<{ affiliations: Affiliation[] }>(`/network/me/affiliations`),
    retry: false,
  });

  return (
    <Page title="My partnerships" subtitle="Programs across the Network you&rsquo;re actively partnered with.">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : !data || data.affiliations.length === 0 ? (
        <EmptyState
          title="No partnerships yet"
          hint="Browse and apply to programs to get started."
          icon={<Globe size={28} strokeWidth={1.25} />}
        />
      ) : (
        data.affiliations.map((a) => (
          <Card key={a.id}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <h3 style={{ marginTop: 0, marginBottom: 4, flex: 1 }}>
                <TenantLink to={`/network/vendors/${a.vendorId}`}>{a.vendorName}</TenantLink>
              </h3>
              <StatusPill status={a.status} />
            </div>
            <p style={{ color: theme.textMuted, fontSize: 13 }}>Joined {formatDate(a.joinedVendorAt, { relative: true })}</p>
            <EarningsBlock aff={a} />
          </Card>
        ))
      )}
    </Page>
  );
}
