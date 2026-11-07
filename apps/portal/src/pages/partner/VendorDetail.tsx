import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { api } from '../../api.js';
import { TenantLink } from '../../tenant-link.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Page } from '../../ui.js';
import { theme } from '../../theme.js';
import { TermsLines, type NetworkProgram } from './Discover.js';

/** The Network's GET /vendors/:id: the brand and its published programs. */
interface VendorResponse {
  vendor: {
    id: string;
    displayName: string;
    partnerCount: number;
    createdAt: string;
  };
  offerings: NetworkProgram[];
}

/** Past this many programs the page offers a search box. */
const SEARCH_FROM = 7;

export function VendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['network-vendor', id],
    queryFn: () => api<VendorResponse>(`/network/vendors/${id}`),
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
            <div style={{ color: theme.textMuted, fontSize: 13 }}>
              {vendor.partnerCount} partner{vendor.partnerCount === 1 ? '' : 's'}
              {' · '}
              Member since {new Date(vendor.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
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
            <EmptyState title="No programs published" hint="This brand hasn't published any programs yet." />
          ) : shown.length === 0 ? (
            <EmptyState title={`No programs match "${q.trim()}"`} hint="Try a different keyword." />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
              {shown.map((o) => (
                <Card key={o.id}>
                  <h4 style={{ marginTop: 0, marginBottom: 6 }}>
                    <TenantLink to={`/network/offerings/${o.id}`}>{o.title}</TenantLink>
                  </h4>
                  <TermsLines terms={[o.terms]} />
                  {o.description && (
                    <p
                      style={{
                        fontSize: 13,
                        color: theme.text,
                        margin: '8px 0 0',
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
                  <div style={{ marginTop: 12 }}>
                    <TenantLink to={`/network/offerings/${o.id}`}>
                      <Button>View &amp; apply</Button>
                    </TenantLink>
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
