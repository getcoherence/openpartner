import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Globe } from 'lucide-react';
import { Card, EmptyState, ErrorBanner, Page, Stat, StatusPill, formatDate, money } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi, ApiError } from './creator-api.js';

interface Affiliation {
  id: string;
  vendorId: string;
  vendorPartnerId: string;
  status: string;
  joinedVendorAt: string;
  vendorName: string;
  vendorInstanceUrl: string;
  approvedOfferings: Array<{ id: string; title: string }>;
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
  const enabled = aff.status === 'active';
  const { data, isLoading, error } = useQuery<Earnings, ApiError>({
    queryKey: ['creator-aff-earnings', aff.id],
    queryFn: () => creatorApi<Earnings>(`/creators/me/affiliations/${aff.id}/earnings`),
    enabled,
    retry: false,
    staleTime: 60_000,
  });

  if (!enabled) return <p style={{ color: theme.textMuted, fontSize: 13 }}>Earnings appear once the partnership is active.</p>;
  if (isLoading) return <p style={{ color: theme.textMuted, fontSize: 13 }}>Loading earnings…</p>;
  if (error) {
    if (error.status === 502) return <p style={{ color: theme.textMuted, fontSize: 13 }}>Vendor instance unreachable — earnings will refresh when it&rsquo;s back.</p>;
    return <p style={{ color: theme.textMuted, fontSize: 13 }}>Couldn&rsquo;t load earnings.</p>;
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

export function CreatorMyAffiliationsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-my-affiliations'],
    queryFn: () => creatorApi<{ affiliations: Affiliation[] }>('/creators/me/affiliations'),
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
                <Link to={`/creator/vendors/${a.vendorId}`}>{a.vendorName}</Link>
              </h3>
              <StatusPill status={a.status} />
            </div>
            <p style={{ color: theme.textMuted, fontSize: 13 }}>Joined {formatDate(a.joinedVendorAt, { relative: true })}</p>
            {a.approvedOfferings.length > 0 && (
              <p style={{ color: theme.textMuted, fontSize: 13, marginTop: 4 }}>
                Approved for:{' '}
                {a.approvedOfferings.map((o, i) => (
                  <span key={o.id}>
                    {i > 0 && ', '}
                    <Link to={`/creator/offerings/${o.id}`}>{o.title}</Link>
                  </span>
                ))}
              </p>
            )}
            <EarningsBlock aff={a} />
          </Card>
        ))
      )}
    </Page>
  );
}
