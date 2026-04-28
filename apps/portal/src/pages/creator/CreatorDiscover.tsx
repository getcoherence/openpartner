import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Globe } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';

interface OfferingListItem {
  id: string;
  title: string;
  description: string | null;
  productUrl: string;
  vendorId: string;
  vendorName: string;
  vendorPartnerCount: number;
  terms: { commissionDescription?: string };
  createdAt: string;
}

export function CreatorDiscoverPage() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [sort, setSort] = useState<'newest' | 'popular'>('newest');

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams();
  if (debouncedQ) params.set('q', debouncedQ);
  if (sort !== 'newest') params.set('sort', sort);
  const qs = params.toString();

  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-discover', debouncedQ, sort],
    queryFn: () => creatorApi<{ offerings: OfferingListItem[] }>(`/offerings${qs ? '?' + qs : ''}`),
    retry: false,
  });

  return (
    <Page title="Discover programs" subtitle="Partner programs across the OpenPartner Network. Apply to any.">
      <ErrorBanner error={error} />
      <Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <Label>Search</Label>
            <Input placeholder="Title or description…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ minWidth: 160 }}>
            <Label>Sort</Label>
            <Select value={sort} onChange={(e) => setSort(e.target.value as 'newest' | 'popular')}>
              <option value="newest">Newest</option>
              <option value="popular">Most partners</option>
            </Select>
          </div>
        </div>
      </Card>
      <div style={{ height: 18 }} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : !data || data.offerings.length === 0 ? (
        <EmptyState
          title={debouncedQ ? `No matches for "${debouncedQ}"` : 'No programs yet'}
          hint={debouncedQ ? 'Try a different keyword.' : 'Vendors are joining all the time — check back soon.'}
          icon={<Globe size={28} strokeWidth={1.25} />}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {data.offerings.map((o) => (
            <Card key={o.id}>
              <div style={{ color: theme.textMuted, fontSize: 13 }}>
                <Link to={`/creator/vendors/${o.vendorId}`} style={{ color: theme.textMuted }}>{o.vendorName}</Link>
                {o.vendorPartnerCount > 0 && <> · {o.vendorPartnerCount} partner{o.vendorPartnerCount === 1 ? '' : 's'}</>}
              </div>
              <h3 style={{ marginTop: 4, marginBottom: 8 }}>
                <Link to={`/creator/offerings/${o.id}`}>{o.title}</Link>
              </h3>
              {o.terms?.commissionDescription && (
                <p style={{ fontSize: 13, color: theme.textMuted, margin: '4px 0' }}>{o.terms.commissionDescription}</p>
              )}
              {o.description && (
                <p style={{ fontSize: 14, color: theme.text, margin: '8px 0' }}>
                  {o.description.slice(0, 180)}{o.description.length > 180 ? '…' : ''}
                </p>
              )}
              <div style={{ marginTop: 12 }}>
                <Link to={`/creator/offerings/${o.id}`}>
                  <Button>View &amp; apply</Button>
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}
