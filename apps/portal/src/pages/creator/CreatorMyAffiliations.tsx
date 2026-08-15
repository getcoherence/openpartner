import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Globe } from 'lucide-react';
import { Card, EmptyState, ErrorBanner, Page, Stat, StatusPill, formatDate, money } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi, ApiError } from './creator-api.js';

interface PartnershipLite {
  id: string;
  offeringId: string;
}

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

interface EarningsLink {
  linkKey: string;
  clicks: number;
  attributedEvents: number;
  attributedRevenue: number;
}

interface Earnings {
  partnerId: string;
  since: string;
  clicks: number;
  attributedEvents: number;
  attributedRevenue: number;
  commissionByStatus: Record<string, number>;
  links?: EarningsLink[];
}

function EarningsBlock({ aff }: { aff: Affiliation }) {
  const enabled = aff.status === 'active';
  const { data, isLoading, error } = useQuery<Earnings, ApiError>({
    queryKey: ['creator-aff-earnings', aff.id],
    // includeLinks=true threads through openpartner's per-Link
    // breakdown for channel-level performance ("newsletter vs TikTok").
    queryFn: () => creatorApi<Earnings>(`/creators/me/affiliations/${aff.id}/earnings?includeLinks=true`),
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
  const linksWithActivity = (data.links ?? []).filter((l) => l.clicks > 0 || l.attributedEvents > 0);
  return (
    <>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 12 }}>
        <Stat label="Clicks (30d)" value={data.clicks.toLocaleString()} />
        <Stat label="Attributed events" value={data.attributedEvents.toLocaleString()} />
        <Stat label="Revenue" value={money(data.attributedRevenue, 'USD')} />
        {Object.entries(data.commissionByStatus ?? {}).map(([status, amount]) => (
          <Stat key={status} label={`${status} commission`} value={money(amount, 'USD')} />
        ))}
      </div>
      {linksWithActivity.length > 1 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            By link (30d)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {linksWithActivity.map((l) => {
              const conversionRate = l.clicks > 0 ? (l.attributedEvents / l.clicks) * 100 : 0;
              return (
                <div
                  key={l.linkKey}
                  className="op-grid-collapse"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr',
                    gap: 8,
                    fontSize: 13,
                    padding: '8px 10px',
                    background: theme.surface2,
                    border: `1px solid ${theme.borderSubtle}`,
                    borderRadius: theme.radiusSm,
                    alignItems: 'center',
                  }}
                >
                  <code style={{ fontSize: 12, color: theme.textMuted }}>{l.linkKey}</code>
                  <div style={{ color: theme.textMuted }}>{l.clicks.toLocaleString()} clicks</div>
                  <div style={{ color: theme.textMuted }}>{l.attributedEvents.toLocaleString()} events</div>
                  <div style={{ color: theme.text }}>{money(l.attributedRevenue, 'USD')}</div>
                  <div style={{ color: conversionRate >= 1 ? theme.success : theme.textMuted, fontWeight: conversionRate >= 1 ? 500 : 400 }}>
                    {conversionRate.toFixed(2)}% CVR
                  </div>
                </div>
              );
            })}
          </div>
          <p style={{ color: theme.textDim, fontSize: 11, marginTop: 6, marginBottom: 0 }}>
            Different links = different channels. Higher CVR means that channel converts better &mdash; focus there.
          </p>
        </div>
      )}
    </>
  );
}

export function CreatorMyAffiliationsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-my-affiliations'],
    queryFn: () => creatorApi<{ affiliations: Affiliation[] }>('/creators/me/affiliations'),
    retry: false,
  });

  // Pull the partnerships list (same query key share-links uses, so it's
  // cache-shared) to map offeringId → partnershipId. The affiliations
  // endpoint returns offerings but the program detail page is keyed by
  // partnership; without this lookup the "View dashboard" link can't
  // route correctly.
  const partnerships = useQuery({
    queryKey: ['creator-partnerships'],
    queryFn: () => creatorApi<{ partnerships: PartnershipLite[] }>('/creators/me/partnerships'),
    retry: false,
  });
  const partnershipByOffering = new Map(
    (partnerships.data?.partnerships ?? []).map((p) => [p.offeringId, p.id]),
  );

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
              <div style={{ marginTop: 4 }}>
                <p style={{ color: theme.textMuted, fontSize: 13, marginBottom: 4 }}>Approved for:</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {a.approvedOfferings.map((o) => {
                    const partnershipId = partnershipByOffering.get(o.id);
                    return (
                      <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                        <Link to={`/creator/offerings/${o.id}`} style={{ color: theme.text }}>
                          {o.title}
                        </Link>
                        {partnershipId && (
                          <Link
                            to={`/creator/programs/${partnershipId}`}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              color: theme.accent,
                              fontSize: 12,
                              textDecoration: 'none',
                            }}
                          >
                            View dashboard <ArrowUpRight size={12} />
                          </Link>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <EarningsBlock aff={a} />
          </Card>
        ))
      )}
    </Page>
  );
}
