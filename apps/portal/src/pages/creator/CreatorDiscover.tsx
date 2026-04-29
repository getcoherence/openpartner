import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, Globe } from 'lucide-react';
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
      <CreatorOnboarding />
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

interface CreatorProfile {
  id: string;
  email: string;
  name: string;
  handle: string | null;
  bio: string | null;
}

interface RequestRow {
  id: string;
  status: string;
}

/** Three-step nudge for new creators: handle, bio, first application.
 *  Card disappears once everything's done; never shown for creators
 *  who already filled in their profile. */
function CreatorOnboarding() {
  const profile = useQuery({
    queryKey: ['creator-my-profile'],
    queryFn: () => creatorApi<CreatorProfile>('/creators/me'),
    staleTime: 30_000,
    retry: false,
  });
  const requests = useQuery({
    queryKey: ['creator-my-requests'],
    queryFn: () => creatorApi<{ requests: RequestRow[] }>('/creators/me/requests'),
    staleTime: 30_000,
    retry: false,
  });

  if (!profile.data) return null;
  const handleSet = !!profile.data.handle && profile.data.handle.length > 0;
  const bioSet = !!profile.data.bio && profile.data.bio.length > 0;
  const hasApplied = (requests.data?.requests ?? []).length > 0;
  const complete = handleSet && bioSet && hasApplied;
  if (complete) return null;

  const items = [
    { done: true, label: 'Account created', href: null as string | null },
    { done: handleSet, label: 'Pick a handle', hint: 'Used as the default slug for your share links.', href: '/creator/profile' },
    { done: bioSet, label: 'Add a short bio', hint: 'Brands see this on your applications.', href: '/creator/profile' },
    { done: hasApplied, label: 'Apply to your first program', hint: 'Browse below and click "View & apply" on anything that fits.', href: null },
  ];

  return (
    <Card style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Getting started</div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
        Three quick steps to put your best foot forward when applying. Card disappears when done.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((it, i) => (
          <CreatorStep key={i} done={it.done} label={it.label} hint={it.hint} href={it.href} />
        ))}
      </div>
    </Card>
  );
}

function CreatorStep({ done, label, hint, href }: { done: boolean; label: string; hint?: string; href: string | null }) {
  const inner = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        background: done ? theme.successSoft : theme.surface2,
        border: `1px solid ${done ? `${theme.success}44` : theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
      }}
    >
      <div style={{ color: done ? theme.success : theme.textDim, display: 'inline-flex' }}>
        {done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: theme.text, textDecoration: done ? 'line-through' : 'none' }}>
          {label}
        </div>
        {hint && !done && <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>{hint}</div>}
      </div>
    </div>
  );
  if (done || !href) return inner;
  return <Link to={href} style={{ textDecoration: 'none' }}>{inner}</Link>;
}
