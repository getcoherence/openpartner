/**
 * Brand-side creator discovery directory.
 *
 * Brand admins call /admin/network/discover/creators (which proxies to
 * Network's /vendors/me/discover/creators) and browse a filtered grid
 * of creator cards. Each card links to the public creator profile so
 * the admin can read the full thing before deciding to invite. Unique
 * angle vs Modash/Aspire: we have actual conversion data per creator.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select } from '../../ui.js';
import { theme } from '../../theme.js';

interface PlatformRow {
  id: string;
  platform: string;
  handle: string;
  profileUrl: string | null;
  followerCount: number | null;
  verified: boolean;
}

interface DirectoryRow {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  bio: string | null;
  categories: string[];
  audienceLocations: string[];
  audienceAgeRange: string | null;
  pastBrands: string[];
  clicks90d: number;
  conversions90d: number;
  revenue90d: string;
  commission90d: string;
  topCategories: string[];
  lastAggregatedAt: string | null;
  createdAt: string;
  platforms: PlatformRow[];
  totalReach: number;
}

const CATEGORIES = [
  'tech', 'business', 'finance', 'productivity', 'marketing', 'design',
  'lifestyle', 'fitness', 'health', 'beauty', 'fashion', 'food', 'travel',
  'gaming', 'music', 'art', 'photography', 'education', 'parenting',
  'entertainment', 'news', 'sports',
];

const PLATFORMS = [
  { value: 'tiktok', label: 'TikTok' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'twitter', label: 'X / Twitter' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'substack', label: 'Substack' },
  { value: 'twitch', label: 'Twitch' },
  { value: 'podcast', label: 'Podcast' },
  { value: 'website', label: 'Website' },
];

type SortKey = 'revenue' | 'followers' | 'newest' | 'name';

export function AdminNetworkCreators() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [locations, setLocations] = useState('');
  const [minFollowers, setMinFollowers] = useState<number | ''>('');
  const [minRevenue, setMinRevenue] = useState<number | ''>('');
  const [sort, setSort] = useState<SortKey>('revenue');

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ) p.set('q', debouncedQ);
    if (categories.length > 0) p.set('categories', categories.join(','));
    if (platforms.length > 0) p.set('platforms', platforms.join(','));
    const cleanLocations = locations
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]{2}$/.test(s));
    if (cleanLocations.length > 0) p.set('locations', cleanLocations.join(','));
    if (minFollowers !== '' && minFollowers > 0) p.set('minFollowers', String(minFollowers));
    if (minRevenue !== '' && minRevenue > 0) p.set('minRevenue90d', String(minRevenue));
    if (sort !== 'revenue') p.set('sort', sort);
    return p.toString();
  }, [debouncedQ, categories, platforms, locations, minFollowers, minRevenue, sort]);

  const list = useQuery({
    queryKey: ['admin-discover-creators', qs],
    queryFn: () => api<{ creators: DirectoryRow[] }>(`/admin/network/discover/creators${qs ? '?' + qs : ''}`),
    retry: false,
    staleTime: 30_000,
  });

  const rows = list.data?.creators ?? [];

  return (
    <Page
      title="Discover creators"
      subtitle="Browse the OpenPartner Network for creators who match your audience. Filter by category, platform, audience size, and past performance."
    >
      <ErrorBanner error={list.error} />
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 14 }}>
          <div>
            <Label>Search</Label>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, handle, bio…"
            />
          </div>
          <div>
            <Label>Sort</Label>
            <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="revenue">90-day revenue</option>
              <option value="followers">Total followers</option>
              <option value="newest">Newest</option>
              <option value="name">Name (A-Z)</option>
            </Select>
          </div>
          <div>
            <Label>Min total followers</Label>
            <Input
              type="number"
              value={minFollowers}
              onChange={(e) => setMinFollowers(e.target.value === '' ? '' : Number(e.target.value))}
              placeholder="e.g. 10000"
            />
          </div>
          <div>
            <Label>Min 90-day revenue ($)</Label>
            <Input
              type="number"
              value={minRevenue}
              onChange={(e) => setMinRevenue(e.target.value === '' ? '' : Number(e.target.value))}
              placeholder="e.g. 500"
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <Label>Audience locations (ISO codes, comma-separated)</Label>
            <Input
              value={locations}
              onChange={(e) => setLocations(e.target.value)}
              placeholder="US, CA, GB"
              style={{ fontFamily: theme.fontMono }}
            />
          </div>
        </div>
        <div>
          <Label>Categories (creator must have all selected)</Label>
          <ChipMultiSelect
            options={CATEGORIES}
            selected={categories}
            onChange={setCategories}
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <Label>Platforms (creator must have at least one)</Label>
          <ChipMultiSelect
            options={PLATFORMS.map((p) => p.value)}
            labels={PLATFORMS.reduce<Record<string, string>>((acc, p) => { acc[p.value] = p.label; return acc; }, {})}
            selected={platforms}
            onChange={setPlatforms}
          />
        </div>
      </Card>

      <div style={{ height: 18 }} />

      {list.isLoading ? (
        <Card>Loading creators…</Card>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No creators match those filters"
          hint={qs ? 'Loosen the filters, or check back as more creators join.' : 'No creators on the Network yet.'}
          icon={<Users size={28} strokeWidth={1.25} />}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {rows.map((r) => <CreatorCard key={r.id} creator={r} />)}
        </div>
      )}
    </Page>
  );
}

function CreatorCard({ creator }: { creator: DirectoryRow }) {
  const revenue = Number(creator.revenue90d);
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        {creator.avatarUrl ? (
          <img src={creator.avatarUrl} alt={creator.name} style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', background: theme.surface2 }} />
        ) : (
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: theme.accent, color: theme.accentInk, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 600 }}>
            {creator.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{creator.name}</div>
          <div style={{ color: theme.textMuted, fontSize: 12, fontFamily: theme.fontMono }}>@{creator.handle}</div>
        </div>
      </div>
      {creator.categories.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {creator.categories.slice(0, 4).map((c) => (
            <span key={c} style={{ background: theme.surface2, color: theme.textMuted, fontSize: 10, padding: '2px 7px', borderRadius: 10 }}>{c}</span>
          ))}
          {creator.categories.length > 4 && (
            <span style={{ color: theme.textDim, fontSize: 10, padding: '2px 4px' }}>+{creator.categories.length - 4}</span>
          )}
        </div>
      )}
      {creator.platforms.length > 0 && (
        <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 10 }}>
          {creator.platforms.map((p) => p.platform).join(' · ')}
          {creator.totalReach > 0 && (
            <> · <strong style={{ color: theme.text }}>{creator.totalReach.toLocaleString()}</strong> reach</>
          )}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
        <Stat label="90d revenue" value={revenue > 0 ? `$${revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'} accent={revenue > 0} />
        <Stat label="90d clicks" value={creator.clicks90d > 0 ? creator.clicks90d.toLocaleString() : '—'} />
      </div>
      {creator.bio && (
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 12px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {creator.bio}
        </p>
      )}
      <a
        href={`/creators/${creator.handle}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{ textDecoration: 'none' }}
      >
        <Button variant="secondary" style={{ width: '100%' }}>View profile →</Button>
      </a>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ background: theme.surface2, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 500, color: accent ? theme.success : theme.text, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function ChipMultiSelect({
  options,
  labels,
  selected,
  onChange,
}: {
  options: string[];
  labels?: Record<string, string>;
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  function toggle(o: string) {
    onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {options.map((o) => {
        const on = selected.includes(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() => toggle(o)}
            style={{
              padding: '4px 10px',
              borderRadius: 14,
              border: `1px solid ${on ? theme.accent : theme.borderSubtle}`,
              background: on ? `${theme.accent}22` : theme.surface2,
              color: on ? theme.accent : theme.textMuted,
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: on ? 500 : 400,
            }}
          >
            {labels?.[o] ?? o}
          </button>
        );
      })}
    </div>
  );
}
