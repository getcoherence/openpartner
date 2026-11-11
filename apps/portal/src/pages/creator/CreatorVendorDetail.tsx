import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Button, Card, EmptyState, ErrorBanner, Input, Page } from '../../ui.js';
import { theme } from '../../theme.js';
import { formatCustomerReward } from '../../lib/commission-summary.js';
import { creatorApi, creatorPath } from './creator-api.js';
import { commissionLineOf } from './brand-summary.js';
import { OfferingChips, ctaForStatus, type MyStatus, type OfferingTerms } from './CreatorDiscover.js';

interface Vendor {
  id: string;
  displayName: string;
  logoUrl: string | null;
  tier: 'hosted' | 'self_hosted';
  partnerCount: number;
  createdAt: string;
}

interface VendorOffering {
  id: string;
  title: string;
  description: string | null;
  productUrl: string;
  terms: OfferingTerms;
  createdAt: string;
  /** Absent from a Network predating it; read as 'none'. */
  myStatus?: MyStatus;
}

/** Past this many programs the page offers a search box. */
const SEARCH_FROM = 7;

interface VendorResponse {
  vendor: Vendor;
  offerings: VendorOffering[];
}

export function CreatorVendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-vendor', id],
    queryFn: () => creatorApi<VendorResponse>(`/vendors/${id}`),
    enabled: !!id,
    retry: false,
  });

  const [q, setQ] = useState('');

  const vendor = data?.vendor;
  const offerings = data?.offerings ?? [];
  const query = q.trim().toLowerCase();
  const shown = query
    ? offerings.filter((o) => `${o.title} ${o.description ?? ''}`.toLowerCase().includes(query))
    : offerings;

  return (
    <Page title={vendor?.displayName ?? 'Brand'} subtitle={vendor ? 'Network member' : undefined}>
      <ErrorBanner error={error} />
      {isLoading && <Card>Loading…</Card>}
      {vendor && (
        <>
          <Card>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <BrandMark logoUrl={vendor.logoUrl} name={vendor.displayName} size={56} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 18, fontWeight: 600, color: theme.text }}>{vendor.displayName}</div>
                <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4 }}>
                  {vendor.partnerCount} active partner{vendor.partnerCount === 1 ? '' : 's'}
                  {' · '}
                  Member since {new Date(vendor.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
                </div>
              </div>
            </div>
          </Card>

          <div style={{ height: 18 }} />

          <h3 style={{ fontSize: 14, fontWeight: 500, color: theme.textMuted, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Programs from {vendor.displayName}
          </h3>
          {offerings.length >= SEARCH_FROM && (
            <div style={{ maxWidth: 360, marginBottom: 14 }}>
              <Input
                placeholder={`Search ${offerings.length} programs…`}
                aria-label="Search programs"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          )}
          {offerings.length === 0 ? (
            <EmptyState
              title="No programs published"
              hint="This brand hasn't published any offerings yet. Check back later."
            />
          ) : shown.length === 0 ? (
            <EmptyState title={`No programs match "${q.trim()}"`} hint="Try a different keyword." />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
              {shown.map((o) => {
                const status = o.myStatus ?? 'none';
                return (
                  <Card key={o.id} style={{ display: 'flex', flexDirection: 'column' }}>
                    <h4 style={{ marginTop: 0, marginBottom: 6 }}>
                      <Link to={creatorPath(`/offerings/${o.id}`)}>{o.title}</Link>
                    </h4>
                    {o.description && (
                      <p
                        style={{
                          fontSize: 13,
                          color: theme.textMuted,
                          margin: '0 0 12px',
                          lineHeight: 1.45,
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                        title={o.description}
                      >
                        {o.description}
                      </p>
                    )}
                    <div style={{ flex: 1 }} />
                    <OfferingChips
                      terms={o.terms}
                      commissionLine={commissionLineOf(o.terms)}
                      customerRewardLine={o.terms.customerReward ? formatCustomerReward(o.terms.customerReward) : null}
                    />
                    <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Link to={creatorPath(`/offerings/${o.id}`)}>
                        <Button variant={status === 'approved' || status === 'pending' ? 'secondary' : 'primary'}>
                          {ctaForStatus(status)}
                        </Button>
                      </Link>
                      {(status === 'approved' || status === 'pending') && (
                        <span style={{ fontSize: 12, color: status === 'approved' ? theme.success : theme.textMuted }}>
                          {status === 'approved' ? '✓ Active' : 'Awaiting brand review'}
                        </span>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </Page>
  );
}

/** Brand mark used at the top of the vendor profile. Sized larger
 *  than the discover-card variant since this page is the brand's
 *  own profile — it should feel like a header avatar, not a
 *  thumbnail. Falls back to a colored letter chip when no logo is
 *  set yet. */
function BrandMark({ logoUrl, name, size = 56 }: { logoUrl: string | null; name: string; size?: number }) {
  const initial = name.charAt(0).toUpperCase() || '?';
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        background: logoUrl ? theme.surface2 : theme.accent,
        color: theme.accentInk,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: size * 0.4,
        overflow: 'hidden',
        flexShrink: 0,
        border: `1px solid ${theme.borderSubtle}`,
      }}
    >
      {logoUrl ? (
        <img src={logoUrl} alt={name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      ) : (
        initial
      )}
    </div>
  );
}
