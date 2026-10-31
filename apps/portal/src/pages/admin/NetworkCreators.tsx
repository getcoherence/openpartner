/**
 * Brand-side creator discovery directory.
 *
 * Brand admins call /admin/network/discover/creators (which proxies to
 * Network's /vendors/me/discover/creators) and browse a filtered list of
 * creators: each with their channels as platform logos and followers, and
 * Invite and Book. The filters sit in one bar, each opening below its chip.
 * On a wide screen the selected creator shows beside the list (kept in the
 * URL: ?creator=, ?external=); otherwise a click opens their page. Unique
 * angle vs Modash/Aspire: we have actual conversion data per creator.
 *
 * External creators (not on OpenPartner yet) follow under the same
 * filters, badged; members' sales, audience and verification filters
 * leave them out.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, Users } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, Textarea } from '../../ui.js';
import { alpha, theme } from '../../theme.js';
import { ChannelCount, compactCount } from '../../lib/PlatformMark.js';
import { useMediaQuery } from '../../lib/useMediaQuery.js';
import { PLATFORMS as CREATOR_PLATFORMS } from '../../lib/NetworkProfileEditor.js';
import { BookCreatorDialog } from './BookCreatorDialog.js';
import { CreatorList, CreatorRow, RowFigure } from './CreatorRow.js';
import { NetworkCreatorStorefrontPanel } from './NetworkCreatorStorefront.js';
import { EXTERNAL_CATEGORIES, IndexedCreatorPanel, IndexedCreatorsSection, type ExternalFilters } from './NetworkIndexedCreators.js';

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

/** Members' categories, then external creators' business topics. */
const ALL_CATEGORIES = [...CATEGORIES, ...EXTERNAL_CATEGORIES.filter((c) => !CATEGORIES.includes(c))];

const PLATFORMS = CREATOR_PLATFORMS.map((p) => ({ value: p.kind, label: p.label }));

type SortKey = 'revenue' | 'followers' | 'newest' | 'name';
type ShowKey = 'all' | 'members' | 'external';

/** Wide enough for the list and the selected creator side by side. */
const SIDE_BY_SIDE = '(min-width: 1200px)';
/** Page's padding under the content, so the columns end at the window's edge. */
const PAGE_BOTTOM_PADDING = 32;
/** On a very short window the page scrolls rather than squash the columns. */
const MIN_SPLIT_HEIGHT = 360;

const FOLLOWER_STEPS = [1_000, 10_000, 50_000, 100_000, 1_000_000];

/** The creator beside the list, kept in the URL: ?creator=<handle> for
 *  OpenPartner's, ?external=<id> for an external one. */
type Selected = { kind: 'member'; handle: string } | { kind: 'external'; id: string } | null;

export function AdminNetworkCreators() {
  const [params, setParams] = useSearchParams();
  const sideBySide = useMediaQuery(SIDE_BY_SIDE);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [locations, setLocations] = useState('');
  const [minFollowers, setMinFollowers] = useState<number | ''>('');
  const [minRevenue, setMinRevenue] = useState<number | ''>('');
  const [openOnly, setOpenOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>('revenue');

  // One list: OpenPartner's creators first, then external creators the
  // Network listed who haven't joined (NetworkIndexedCreators.tsx), under
  // the same filters. ?show=external (or the old ?tab=index) shows only those.
  const show: ShowKey =
    params.get('show') === 'external' || params.get('tab') === 'index' ? 'external' : params.get('show') === 'members' ? 'members' : 'all';
  const creatorParam = params.get('creator');
  const externalParam = params.get('external');
  const selected: Selected = creatorParam
    ? { kind: 'member', handle: creatorParam }
    : externalParam
      ? { kind: 'external', id: externalParam }
      : null;
  const updateParams = (change: (p: URLSearchParams) => void) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        change(next);
        return next;
      },
      { replace: true },
    );
  const setShow = (value: ShowKey) =>
    updateParams((p) => {
      p.delete('tab');
      if (value === 'all') p.delete('show');
      else p.set('show', value);
    });
  const select = (s: Exclude<Selected, null>) =>
    updateParams((p) => {
      p.delete('creator');
      p.delete('external');
      if (s.kind === 'member') p.set('creator', s.handle);
      else p.set('external', s.id);
    });

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const cleanLocations = useMemo(
    () =>
      locations
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z]{2}$/.test(s)),
    [locations],
  );

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ) p.set('q', debouncedQ);
    if (categories.length > 0) p.set('categories', categories.join(','));
    if (platforms.length > 0) p.set('platforms', platforms.join(','));
    if (verifiedOnly) p.set('verified', 'true');
    if (cleanLocations.length > 0) p.set('locations', cleanLocations.join(','));
    if (minFollowers !== '' && minFollowers > 0) p.set('minFollowers', String(minFollowers));
    if (minRevenue !== '' && minRevenue > 0) p.set('minRevenue90d', String(minRevenue));
    if (sort !== 'revenue') p.set('sort', sort);
    return p.toString();
  }, [debouncedQ, categories, platforms, verifiedOnly, cleanLocations, minFollowers, minRevenue, sort]);

  const list = useQuery({
    queryKey: ['admin-discover-creators', qs],
    queryFn: () => api<{ creators: DirectoryRow[] }>(`/admin/network/discover/creators${qs ? '?' + qs : ''}`),
    retry: false,
    staleTime: 30_000,
    enabled: show !== 'external',
  });

  const rows = list.data?.creators ?? [];

  // External creators have no sales, audience or verification data, so
  // these filters leave them out.
  const memberOnlyFilters = verifiedOnly || (minRevenue !== '' && minRevenue > 0) || locations.trim() !== '';
  const externalFilters = useMemo<ExternalFilters>(
    () => ({
      q: debouncedQ || undefined,
      categories,
      platforms,
      minFollowers: minFollowers === '' ? undefined : minFollowers,
      openToPartnerships: openOnly,
      sort: sort === 'newest' ? 'newest' : 'reach',
    }),
    [debouncedQ, categories, platforms, minFollowers, openOnly, sort],
  );

  const filtered =
    q.trim() !== '' ||
    categories.length > 0 ||
    platforms.length > 0 ||
    verifiedOnly ||
    minFollowers !== '' ||
    minRevenue !== '' ||
    locations.trim() !== '' ||
    openOnly;
  const resetAll = () => {
    setQ('');
    setCategories([]);
    setPlatforms([]);
    setVerifiedOnly(false);
    setMinFollowers('');
    setMinRevenue('');
    setLocations('');
    setOpenOnly(false);
  };

  // A newly picked creator starts at the top of the panel.
  const panel = useRef<HTMLElement>(null);
  const selectedKey = selected ? `${selected.kind}:${selected.kind === 'member' ? selected.handle : selected.id}` : '';
  useEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
  }, [selectedKey]);

  // Side by side, the page itself stays put: the title and filters stay in
  // view, and the list and the creator fill the rest of the window, each
  // scrolling on its own. Refitted when the window or the filter bar (which
  // wraps) changes size.
  const bar = useRef<HTMLDivElement>(null);
  const split = useRef<HTMLDivElement>(null);
  const [splitHeight, setSplitHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!sideBySide) return;
    const fit = () => {
      if (!split.current) return;
      const top = split.current.getBoundingClientRect().top + window.scrollY;
      setSplitHeight(Math.max(MIN_SPLIT_HEIGHT, Math.floor(window.innerHeight - top - PAGE_BOTTOM_PADDING)));
    };
    fit();
    window.addEventListener('resize', fit);
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    if (bar.current) resized?.observe(bar.current);
    return () => {
      window.removeEventListener('resize', fit);
      resized?.disconnect();
    };
  }, [sideBySide]);

  const listColumn = (
    <div style={{ minWidth: 0 }}>
      {show !== 'external' && (
        <section>
          {show === 'all' && <SectionHeading>On OpenPartner</SectionHeading>}
          {list.isLoading ? (
            <Card>Loading creators…</Card>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No creators on OpenPartner match those filters"
              hint={qs ? 'Loosen the filters, or check back as more creators join.' : 'No creators on the Network yet.'}
              icon={<Users size={28} strokeWidth={1.25} />}
            />
          ) : (
            <CreatorList>
              {rows.map((r) => (
                <MemberRow
                  key={r.id}
                  creator={r}
                  selected={sideBySide && selected?.kind === 'member' && selected.handle === r.handle}
                  onSelect={sideBySide ? () => select({ kind: 'member', handle: r.handle }) : undefined}
                />
              ))}
            </CreatorList>
          )}
        </section>
      )}

      {show !== 'members' && (
        <section style={{ marginTop: show === 'all' ? 28 : 0 }}>
          {show === 'all' && <SectionHeading>External creators</SectionHeading>}
          {memberOnlyFilters ? (
            <p style={{ fontSize: 13, color: theme.textMuted, margin: 0, lineHeight: 1.5 }}>
              External creators have no sales, audience-location or verification data yet, so they&rsquo;re hidden while those
              filters are on.
            </p>
          ) : (
            <IndexedCreatorsSection
              filters={externalFilters}
              selectedId={sideBySide && selected?.kind === 'external' ? selected.id : null}
              onSelect={sideBySide ? (id) => select({ kind: 'external', id }) : undefined}
            />
          )}
        </section>
      )}
    </div>
  );

  return (
    <Page
      title="Discover creators"
      subtitle="Find creators who match your audience: those on OpenPartner first, then external creators we can invite for you. Filter by category, platform, audience size, and past performance."
    >
      <div ref={bar} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search creators" placeholder="Search name, handle, bio…" />
          </div>
          <Select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as ShowKey)} style={{ width: 'auto' }}>
            <option value="all">Everyone</option>
            <option value="members">On OpenPartner</option>
            <option value="external">External creators</option>
          </Select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.textMuted }}>
            Sort by
            <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={{ width: 'auto' }}>
              <option value="revenue">90-day revenue</option>
              <option value="followers">Total followers</option>
              <option value="newest">Newest</option>
              <option value="name">Name (A-Z)</option>
            </Select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <FilterMenu label="Categories" count={categories.length || null}>
            <MenuHint>Creators must have all you pick.</MenuHint>
            <ChipMultiSelect options={ALL_CATEGORIES} selected={categories} onChange={setCategories} />
          </FilterMenu>
          <FilterMenu label="Platforms" count={platforms.length + (verifiedOnly ? 1 : 0) || null}>
            <MenuHint>Creators must have at least one you pick.</MenuHint>
            <ChipMultiSelect
              options={PLATFORMS.map((p) => p.value)}
              labels={PLATFORMS.reduce<Record<string, string>>((acc, p) => {
                acc[p.value] = p.label;
                return acc;
              }, {})}
              selected={platforms}
              onChange={setPlatforms}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: theme.text, cursor: 'pointer' }}>
              <input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} />
              Verified accounts only
            </label>
            <MenuHint>
              {platforms.length > 0 ? 'Verified on one of the platforms you picked.' : 'The creator proved they own the account.'} On
              OpenPartner only.
            </MenuHint>
          </FilterMenu>
          <FilterMenu label="Followers" count={minFollowers !== '' && minFollowers > 0 ? `${compactCount(minFollowers)}+` : null}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {FOLLOWER_STEPS.map((n) => (
                <ToggleChip key={n} on={minFollowers === n} onClick={() => setMinFollowers(minFollowers === n ? '' : n)}>
                  {compactCount(n)}+
                </ToggleChip>
              ))}
            </div>
            <Label>Or at least</Label>
            <Input
              type="number"
              min={0}
              value={minFollowers}
              onChange={(e) => setMinFollowers(e.target.value === '' ? '' : Number(e.target.value))}
              placeholder="e.g. 10000"
            />
          </FilterMenu>
          <FilterMenu label="Sales" count={minRevenue !== '' && minRevenue > 0 ? `$${minRevenue.toLocaleString()}+` : null}>
            <Label>Min 90-day revenue ($)</Label>
            <Input
              type="number"
              min={0}
              value={minRevenue}
              onChange={(e) => setMinRevenue(e.target.value === '' ? '' : Number(e.target.value))}
              placeholder="e.g. 500"
            />
            <MenuHint>Sales through OpenPartner, so creators on OpenPartner only.</MenuHint>
          </FilterMenu>
          <FilterMenu label="Audience" count={cleanLocations.length || null}>
            <Label>Audience locations (ISO codes, comma-separated)</Label>
            <Input value={locations} onChange={(e) => setLocations(e.target.value)} placeholder="US, CA, GB" style={{ fontFamily: theme.fontMono }} />
            <MenuHint>Where their audience is, as they report it: creators on OpenPartner only.</MenuHint>
          </FilterMenu>
          <ToggleChip on={openOnly} onClick={() => setOpenOnly(!openOnly)} title="External creators who already take brand partnerships">
            Open to partnerships
          </ToggleChip>
          {filtered && (
            <button
              type="button"
              onClick={resetAll}
              style={{ background: 'none', border: 'none', color: theme.accentText, fontSize: 13, cursor: 'pointer', padding: '6px 8px' }}
            >
              Reset all
            </button>
          )}
        </div>
      </div>
      <ErrorBanner error={list.error} />

      {sideBySide ? (
        <div
          ref={split}
          style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 6fr)', gap: 20, height: splitHeight ?? undefined }}
        >
          <div data-testid="creator-list-scroll" style={{ minWidth: 0, overflowY: 'auto', overscrollBehavior: 'contain', paddingRight: 6 }}>
            {listColumn}
          </div>
          <aside
            ref={panel}
            aria-label="Selected creator"
            style={{
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              minWidth: 0,
              // One surface of its own, set apart from the list.
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              borderRadius: 12,
              boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06), 0 12px 32px rgba(0, 0, 0, 0.08)',
            }}
          >
            {selected?.kind === 'member' ? (
              <NetworkCreatorStorefrontPanel key={selected.handle} handle={selected.handle} />
            ) : selected?.kind === 'external' ? (
              <IndexedCreatorPanel key={selected.id} id={selected.id} />
            ) : (
              <div style={{ padding: '64px 24px', textAlign: 'center' }}>
                <Users size={28} strokeWidth={1.25} style={{ color: theme.textDim }} />
                <div style={{ fontSize: 15, fontWeight: 500, marginTop: 12 }}>Pick a creator</div>
                <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6 }}>Their profile, channels and what they offer show here, beside the list.</div>
              </div>
            )}
          </aside>
        </div>
      ) : (
        listColumn
      )}
    </Page>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px' }}>{children}</h2>;
}

function MenuHint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: theme.textMuted, margin: '8px 0', lineHeight: 1.5 }}>{children}</div>;
}

const chipStyle = (on: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  borderRadius: 999,
  border: `1px solid ${on ? theme.accent : theme.border}`,
  background: on ? alpha(theme.accent, 0.12) : theme.surface,
  color: on ? theme.text : theme.textMuted,
  fontSize: 13,
  fontWeight: on ? 500 : 400,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
});

function ToggleChip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} title={title} style={chipStyle(on)}>
      {children}
    </button>
  );
}

/** One filter in the bar: a chip that opens its controls below it, saying
 *  what's set (`count`) while it's closed. */
function FilterMenu({ label, count, children }: { label: string; count: string | number | null; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  // Pulled left when it would run off the right of the screen.
  const [shift, setShift] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const toggle = () => {
    if (!open && box.current) {
      const width = Math.min(MENU_WIDTH, window.innerWidth - 32);
      setShift(Math.min(0, window.innerWidth - 16 - box.current.getBoundingClientRect().left - width));
    }
    setOpen(!open);
  };
  const on = count != null;
  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button type="button" aria-expanded={open} onClick={toggle} style={chipStyle(on)}>
        {label}
        {on && <span style={{ color: theme.accentText }}>· {count}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="group"
          aria-label={label}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: shift,
            zIndex: 30,
            width: MENU_WIDTH,
            maxWidth: 'calc(100vw - 32px)',
            padding: 14,
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            boxShadow: theme.shadowPopover,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

const MENU_WIDTH = 340;

function MemberRow({ creator, selected, onSelect }: { creator: DirectoryRow; selected: boolean; onSelect?: () => void }) {
  const revenue = Number(creator.revenue90d);
  return (
    <CreatorRow
      name={creator.name}
      to={`/admin/network/creators/${encodeURIComponent(creator.handle)}`}
      selected={selected}
      onSelect={onSelect}
      avatar={
        creator.avatarUrl ? (
          <img src={creator.avatarUrl} alt="" style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', background: theme.surface2, flexShrink: 0 }} />
        ) : (
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: theme.accent, color: theme.accentInk, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 600, flexShrink: 0 }}>
            {creator.name.charAt(0).toUpperCase()}
          </div>
        )
      }
      meta={<span style={{ color: theme.textMuted, fontSize: 12, fontFamily: theme.fontMono }}>@{creator.handle}</span>}
      line={creator.bio}
      channels={
        creator.platforms.length > 0
          ? creator.platforms.map((p) => (
              <ChannelCount key={p.id} platform={p.platform} followers={p.followerCount} href={p.profileUrl} verified={p.verified} />
            ))
          : undefined
      }
      side={
        <RowFigure
          value={creator.totalReach > 0 ? compactCount(creator.totalReach) : '—'}
          caption={
            revenue > 0
              ? `$${revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} in 90 days`
              : creator.clicks90d > 0
                ? `${creator.clicks90d.toLocaleString()} clicks in 90 days`
                : 'followers'
          }
          accent={revenue > 0}
        />
      }
      tags={creator.categories}
      actions={
        <>
          <InviteButton creator={creator} />
          <BookButton creator={creator} />
        </>
      }
    />
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
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Book
      </Button>
      {open && <BookCreatorDialog creator={creator} onClose={() => setOpen(false)} />}
    </>
  );
}

function InviteButton({ creator }: { creator: DirectoryRow }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Invite
      </Button>
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
