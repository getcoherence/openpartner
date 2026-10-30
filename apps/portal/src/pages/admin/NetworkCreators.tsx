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
import { useMutation, useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, Textarea } from '../../ui.js';
import { alpha, theme } from '../../theme.js';
import { VerifiedBadge } from '../../lib/VerifiedBadge.js';
import { PLATFORMS as CREATOR_PLATFORMS } from '../../lib/NetworkProfileEditor.js';
import { TenantLink } from '../../tenant-link.js';
import { BookCreatorDialog } from './BookCreatorDialog.js';
import { IndexedCreatorsSection } from './NetworkIndexedCreators.js';

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

const PLATFORMS = CREATOR_PLATFORMS.map((p) => ({ value: p.kind, label: p.label }));

type SortKey = 'revenue' | 'followers' | 'newest' | 'name';

export function AdminNetworkCreators() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [locations, setLocations] = useState('');
  const [minFollowers, setMinFollowers] = useState<number | ''>('');
  const [minRevenue, setMinRevenue] = useState<number | ''>('');
  const [sort, setSort] = useState<SortKey>('revenue');
  // Members, or creators the Network listed who haven't joined yet
  // (NetworkIndexedCreators.tsx). ?tab=index opens the second.
  const [tab, setTab] = useState<DirectoryTab>(() =>
    new URLSearchParams(window.location.search).get('tab') === 'index' ? 'index' : 'members',
  );

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ) p.set('q', debouncedQ);
    if (categories.length > 0) p.set('categories', categories.join(','));
    if (platforms.length > 0) p.set('platforms', platforms.join(','));
    if (verifiedOnly) p.set('verified', 'true');
    const cleanLocations = locations
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]{2}$/.test(s));
    if (cleanLocations.length > 0) p.set('locations', cleanLocations.join(','));
    if (minFollowers !== '' && minFollowers > 0) p.set('minFollowers', String(minFollowers));
    if (minRevenue !== '' && minRevenue > 0) p.set('minRevenue90d', String(minRevenue));
    if (sort !== 'revenue') p.set('sort', sort);
    return p.toString();
  }, [debouncedQ, categories, platforms, verifiedOnly, locations, minFollowers, minRevenue, sort]);

  const list = useQuery({
    queryKey: ['admin-discover-creators', qs],
    queryFn: () => api<{ creators: DirectoryRow[] }>(`/admin/network/discover/creators${qs ? '?' + qs : ''}`),
    retry: false,
    staleTime: 30_000,
    enabled: tab === 'members',
  });

  const rows = list.data?.creators ?? [];

  if (tab === 'index') {
    return (
      <Page
        title="Discover creators"
        subtitle="Browse the OpenPartner Network for creators who match your audience. Filter by category, platform, audience size, and past performance."
      >
        <DirectoryTabs tab={tab} onChange={setTab} />
        <IndexedCreatorsSection />
      </Page>
    );
  }

  return (
    <Page
      title="Discover creators"
      subtitle="Browse the OpenPartner Network for creators who match your audience. Filter by category, platform, audience size, and past performance."
    >
      <DirectoryTabs tab={tab} onChange={setTab} />
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
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13, color: theme.text, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={verifiedOnly}
              onChange={(e) => setVerifiedOnly(e.target.checked)}
            />
            Verified accounts only
            <span style={{ color: theme.textMuted, fontSize: 12 }}>
              {platforms.length > 0 ? '(verified on one of the selected platforms)' : '(creator proved they own the account)'}
            </span>
          </label>
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

type DirectoryTab = 'members' | 'index';

function DirectoryTabs({ tab, onChange }: { tab: DirectoryTab; onChange: (t: DirectoryTab) => void }) {
  const item = (value: DirectoryTab, label: string) => (
    <button
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={tab === value}
      style={{
        background: 'transparent',
        border: 0,
        borderBottom: `2px solid ${tab === value ? theme.accent : 'transparent'}`,
        color: tab === value ? theme.text : theme.textMuted,
        fontWeight: tab === value ? 600 : 400,
        fontSize: 14,
        padding: '8px 2px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: 'flex', gap: 20, borderBottom: `1px solid ${theme.borderSubtle}`, marginBottom: 16 }}>
      {item('members', 'On OpenPartner')}
      {item('index', 'Not on OpenPartner yet')}
    </div>
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
          {creator.platforms.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ' · '}
              {p.platform}
              {p.verified && <> <VerifiedBadge compact /></>}
            </span>
          ))}
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
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <TenantLink to={`/admin/network/creators/${encodeURIComponent(creator.handle)}`} style={{ textDecoration: 'none', flex: 1 }}>
          <Button variant="secondary" style={{ width: '100%' }}>View storefront</Button>
        </TenantLink>
        <InviteButton creator={creator} />
        <BookButton creator={creator} />
      </div>
    </Card>
  );
}

interface OfferingOption {
  id: string;
  title: string;
  published: boolean;
}

/** Book one of the creator's storefront packages as a tracked deal. */
function BookButton({ creator }: { creator: DirectoryRow }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} style={{ flex: 1 }}>Book</Button>
      {open && <BookCreatorDialog creator={creator} onClose={() => setOpen(false)} />}
    </>
  );
}

function InviteButton({ creator }: { creator: DirectoryRow }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} style={{ flex: 1 }}>Invite</Button>
      {open && <InviteDialog creator={creator} onClose={() => setOpen(false)} />}
    </>
  );
}

function InviteDialog({ creator, onClose }: { creator: DirectoryRow; onClose: () => void }) {
  const offerings = useQuery({
    queryKey: ['admin-network-offerings'],
    queryFn: () => api<{ offerings: OfferingOption[] }>('/admin/network/offerings'),
    retry: false,
  });
  const published = (offerings.data?.offerings ?? []).filter((o) => o.published);

  const [offeringId, setOfferingId] = useState('');
  const [message, setMessage] = useState('');

  // Default-select the only published offering when there's one — saves
  // a click in the common case.
  useEffect(() => {
    if (!offeringId && published.length === 1) setOfferingId(published[0]!.id);
  }, [offeringId, published]);

  const send = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; expiresAt: string; deeplink?: string }>(
        `/admin/network/offerings/${offeringId}/invite-creator`,
        {
          method: 'POST',
          body: { creatorId: creator.id, message: message.trim() || undefined },
        },
      ),
  });

  const sent = send.isSuccess;
  const deeplink = send.data?.deeplink;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!deeplink) return;
    navigator.clipboard.writeText(deeplink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {/* ignore */});
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: theme.overlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: theme.surface,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: theme.radiusSm,
          padding: 24,
          maxWidth: 480,
          width: '92%',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>
          Invite @{creator.handle}
        </div>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 16px' }}>
          They&rsquo;ll get an email with a one-click link to apply to whichever offering you pick.
        </p>
        {sent ? (
          <>
            <div style={{ background: theme.successSoft, border: `1px solid ${alpha(theme.success, 0.333)}`, borderRadius: theme.radiusSm, padding: 12, fontSize: 13, color: theme.success, marginBottom: 14 }}>
              Invitation sent. They&rsquo;ll see your message + a deeplink in their inbox.
            </div>
            {deeplink && (
              <div style={{ marginBottom: 14 }}>
                <Label>Deeplink (in case email lands in spam)</Label>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: theme.surface2,
                    border: `1px solid ${theme.borderSubtle}`,
                    borderRadius: theme.radiusSm,
                    padding: '8px 10px',
                    marginTop: 6,
                  }}
                >
                  <code style={{ flex: 1, fontSize: 12, wordBreak: 'break-all' }}>{deeplink}</code>
                  <button
                    onClick={copy}
                    style={{
                      background: 'transparent',
                      border: `1px solid ${theme.borderSubtle}`,
                      borderRadius: 6,
                      padding: '5px 9px',
                      fontSize: 12,
                      color: copied ? theme.success : theme.textMuted,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
            <Button onClick={onClose} variant="secondary">Close</Button>
          </>
        ) : (
          <>
            {send.error && (
              <ErrorBanner error={
                send.error instanceof ApiError && send.error.message === 'creator_not_found'
                  ? 'This creator is no longer available (deleted account?).'
                  : send.error
              } />
            )}
            <div style={{ marginBottom: 14 }}>
              <Label>Offering</Label>
              {offerings.isLoading ? (
                <p style={{ fontSize: 13, color: theme.textMuted, margin: '6px 0 0' }}>Loading…</p>
              ) : published.length === 0 ? (
                <p style={{ fontSize: 13, color: theme.textMuted, margin: '6px 0 0' }}>
                  No published offerings yet. <a href="/admin/network/offerings" style={{ color: theme.accentText }}>Create one</a>.
                </p>
              ) : (
                <Select value={offeringId} onChange={(e) => setOfferingId(e.target.value)}>
                  <option value="">— pick an offering —</option>
                  {published.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                </Select>
              )}
            </div>
            <div style={{ marginBottom: 16 }}>
              <Label>Message (optional)</Label>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                placeholder="Why you'd love to have them. Specific is better than generic."
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                onClick={() => send.mutate()}
                disabled={!offeringId || send.isPending}
              >
                {send.isPending ? 'Sending…' : 'Send invitation'}
              </Button>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </div>
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
              background: on ? `${theme.accentA22}` : theme.surface2,
              color: on ? theme.accentText : theme.textMuted,
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
