import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Card, EmptyState, ErrorBanner, Page } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';

interface Vendor {
  id: string;
  displayName: string;
  logoUrl: string | null;
  tier: 'hosted' | 'self_hosted';
  partnerCount: number;
  createdAt: string;
}

interface OfferingTerms {
  commissionDescription?: string;
  cookieWindowDays?: number;
  payoutCadence?: string;
  payoutHoldbackDays?: number;
  recurring?: boolean;
  campaignEndsAt?: string | null;
}

interface VendorOffering {
  id: string;
  title: string;
  description: string | null;
  productUrl: string;
  terms: OfferingTerms;
  createdAt: string;
}

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

  const vendor = data?.vendor;
  const offerings = data?.offerings ?? [];

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
          {offerings.length === 0 ? (
            <EmptyState
              title="No programs published"
              hint="This brand hasn't published any offerings yet. Check back later."
            />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
              {offerings.map((o) => (
                <Card key={o.id}>
                  <h4 style={{ marginTop: 0, marginBottom: 6 }}>
                    <Link to={`/creator/offerings/${o.id}`}>{o.title}</Link>
                  </h4>
                  {o.terms.commissionDescription && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontSize: 10, color: theme.textDim, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                        Commission
                      </div>
                      <div style={{ fontSize: 13, color: theme.text, marginTop: 2 }}>
                        {o.terms.commissionDescription}
                      </div>
                    </div>
                  )}
                  {o.description && (
                    <p style={{ fontSize: 13, color: theme.textMuted, margin: '10px 0 0', lineHeight: 1.5 }}>
                      {o.description.length > 160 ? `${o.description.slice(0, 160)}…` : o.description}
                    </p>
                  )}
                  <div style={{ marginTop: 12 }}>
                    <Link to={`/creator/offerings/${o.id}`} style={{ fontSize: 13, color: theme.accent }}>
                      View &amp; apply →
                    </Link>
                  </div>
                </Card>
              ))}
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
