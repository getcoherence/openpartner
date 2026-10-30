/**
 * Discover creators → "Not on OpenPartner yet" (openpartner-network
 * docs/creator-index.md §4, §5). Creators the Network listed from their
 * public profiles who haven't joined. A brand on Flex or Enterprise can
 * search them and invite them to collaborate: the Network emails the
 * creator on the brand's behalf, and the message opens as a conversation
 * when they claim their free profile.
 *
 * Other plans get the plan_required answer from the API, and this shows
 * what the plan would unlock instead of an error.
 */

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Users } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Select, Textarea } from '../../ui.js';
import { alpha, theme } from '../../theme.js';
import { TenantLink } from '../../tenant-link.js';

interface IndexedPlatform {
  platform: string;
  handle: string | null;
  profileUrl: string;
  followerCount: number | null;
  postsLast30d: number | null;
  avgReactions: number | null;
}

interface IndexedCreator {
  kind: 'indexed';
  id: string;
  name: string;
  avatarUrl: string | null;
  headline: string | null;
  country: string | null;
  categories: string[];
  topics: string[];
  platforms: IndexedPlatform[];
  totalReach: number;
  invitable: boolean;
  invite: { id: string; status: string; createdAt: string } | null;
  refreshedAt: string | null;
}

interface SearchPage {
  creators: IndexedCreator[];
  nextCursor: string | null;
  total: number;
}

/** The Network's vocabulary (creator-index/classify.ts). */
const CATEGORIES = [
  'sales', 'marketing', 'revops', 'customer-success', 'ai', 'devtools', 'engineering', 'data',
  'product', 'design', 'startups', 'founders', 'leadership', 'hr', 'recruiting', 'career',
  'finance', 'venture-capital', 'ecommerce', 'creator-economy', 'productivity', 'security',
];

const PLATFORMS = [
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'twitter', label: 'X' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'substack', label: 'Substack' },
];

const PLATFORM_LABEL: Record<string, string> = Object.fromEntries(PLATFORMS.map((p) => [p.value, p.label]));

export function IndexedCreatorsSection() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [category, setCategory] = useState('');
  const [platform, setPlatform] = useState('');
  const [locations, setLocations] = useState('');
  const [minFollowers, setMinFollowers] = useState<number | ''>('');
  const [sort, setSort] = useState<'reach' | 'newest'>('reach');

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ) p.set('q', debouncedQ);
    if (category) p.set('categories', category);
    if (platform) p.set('platforms', platform);
    const codes = locations
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]{2}$/.test(s));
    if (codes.length > 0) p.set('locations', codes.join(','));
    if (minFollowers !== '' && minFollowers > 0) p.set('minFollowers', String(minFollowers));
    if (sort !== 'reach') p.set('sort', sort);
    return p.toString();
  }, [debouncedQ, category, platform, locations, minFollowers, sort]);

  const search = useInfiniteQuery({
    queryKey: ['admin-indexed-creators', qs],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(qs);
      if (pageParam) p.set('after', pageParam);
      return api<SearchPage>(`/admin/network/indexed-creators?${p.toString()}`);
    },
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
    staleTime: 60_000,
  });

  if (search.error instanceof ApiError && search.error.status === 402) return <PlanUpsell />;

  const rows = search.data?.pages.flatMap((p) => p.creators) ?? [];
  const total = search.data?.pages[0]?.total ?? 0;

  return (
    <>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px', lineHeight: 1.5 }}>
        These creators haven&rsquo;t joined OpenPartner. We list them from their public profiles so you can find them. An invite
        emails them on your behalf, and they reply once they claim their free profile. Prices appear when they set them.
      </p>
      <ErrorBanner error={search.error} />
      <Card>
        <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
          <div>
            <Label>Search</Label>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, headline, topic…" />
          </div>
          <div>
            <Label>Category</Label>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Any</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Platform</Label>
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">Any</option>
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Countries</Label>
            <Input value={locations} onChange={(e) => setLocations(e.target.value)} placeholder="US, CA, IN" />
          </div>
          <div>
            <Label>Min. followers</Label>
            <Input
              type="number"
              min={0}
              value={minFollowers}
              onChange={(e) => setMinFollowers(e.target.value === '' ? '' : Math.max(0, Number(e.target.value)))}
              placeholder="5000"
            />
          </div>
          <div>
            <Label>Sort</Label>
            <Select value={sort} onChange={(e) => setSort(e.target.value as 'reach' | 'newest')}>
              <option value="reach">Total followers</option>
              <option value="newest">Newest</option>
            </Select>
          </div>
        </div>
      </Card>

      <div style={{ height: 18 }} />

      {search.isLoading ? (
        <Card>Loading creators…</Card>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No creators match those filters"
          hint="Loosen the filters. New creators are added every day."
          icon={<Users size={28} strokeWidth={1.25} />}
        />
      ) : (
        <>
          <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 10 }}>
            {total.toLocaleString()} creator{total === 1 ? '' : 's'} not on OpenPartner yet
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
            {rows.map((c) => (
              <IndexedCreatorCard key={c.id} creator={c} />
            ))}
          </div>
          {search.hasNextPage && (
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <Button variant="secondary" onClick={() => search.fetchNextPage()} disabled={search.isFetchingNextPage}>
                {search.isFetchingNextPage ? 'Loading…' : 'Show more'}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function PlanUpsell() {
  return (
    <Card>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <UserPlus size={26} strokeWidth={1.5} style={{ color: theme.accentText, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Search creators who aren&rsquo;t on OpenPartner yet</div>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: '6px 0 14px', lineHeight: 1.5 }}>
            Thousands more creators, found from their public profiles, with their audience and the topics they cover. Invite any of
            them and we&rsquo;ll email them for you. This comes with the Flex and Enterprise plans.
          </p>
          <TenantLink to="/admin/billing" style={{ textDecoration: 'none' }}>
            <Button>See plans</Button>
          </TenantLink>
        </div>
      </div>
    </Card>
  );
}

const INVITE_STATUS: Record<string, string> = {
  held: 'Invited. We’ll email them this week.',
  sent: 'Invited. We emailed them.',
  claimed: 'Joined. Your message is in Messages.',
};

function IndexedCreatorCard({ creator }: { creator: IndexedCreator }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        {creator.avatarUrl ? (
          <img src={creator.avatarUrl} alt="" style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', background: theme.surface2 }} />
        ) : (
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: theme.surface2, color: theme.textMuted, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 600 }}>
            {creator.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{creator.name}</div>
          <span style={{ display: 'inline-block', marginTop: 3, background: theme.surface2, color: theme.textMuted, fontSize: 10, padding: '2px 8px', borderRadius: 10 }}>
            Not on OpenPartner yet
          </span>
        </div>
        {creator.country && <span style={{ fontSize: 12, color: theme.textDim }}>{creator.country}</span>}
      </div>
      {creator.headline && (
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 10px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {creator.headline}
        </p>
      )}
      <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 10 }}>
        {creator.platforms.map((p, i) => (
          <span key={p.profileUrl}>
            {i > 0 && ' · '}
            <a href={p.profileUrl} target="_blank" rel="noreferrer noopener" style={{ color: theme.textMuted }}>
              {PLATFORM_LABEL[p.platform] ?? p.platform}
            </a>
            {p.followerCount != null && <> {p.followerCount.toLocaleString()}</>}
          </span>
        ))}
      </div>
      {creator.topics.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
          {creator.topics.slice(0, 5).map((t) => (
            <span key={t} style={{ background: theme.surface2, color: theme.textMuted, fontSize: 10, padding: '2px 7px', borderRadius: 10 }}>{t}</span>
          ))}
        </div>
      )}
      {creator.invite ? (
        <div style={{ fontSize: 13, color: creator.invite.status === 'claimed' ? theme.success : theme.textMuted }}>
          {INVITE_STATUS[creator.invite.status] ?? 'Invited.'}
        </div>
      ) : creator.invitable ? (
        <Button onClick={() => setOpen(true)} style={{ width: '100%' }}>Invite to collaborate</Button>
      ) : (
        <div style={{ fontSize: 13, color: theme.textDim }}>Can&rsquo;t be invited yet</div>
      )}
      {open && <IndexInviteDialog creator={creator} onClose={() => setOpen(false)} />}
    </Card>
  );
}

const INVITE_ERRORS: Record<string, string> = {
  already_invited: 'You’ve already invited this creator.',
  unreachable: 'We can’t reach this creator by email.',
  not_accepting_invites: 'This creator has asked not to be emailed.',
  not_found: 'This creator is no longer listed.',
  rate_limited: 'You’ve sent 20 invites today. Try again tomorrow.',
  plan_required: 'Inviting these creators comes with the Flex and Enterprise plans.',
  brand_pending_review: 'You can invite creators once your brand is approved.',
};

function IndexInviteDialog({ creator, onClose }: { creator: IndexedCreator; onClose: () => void }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const trimmed = message.trim();
  const send = useMutation({
    mutationFn: () => api('/admin/network/creator-invites', { method: 'POST', body: { indexedCreatorId: creator.id, message: trimmed } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-indexed-creators'] }),
  });
  const errorCode = send.error instanceof ApiError ? ((send.error.detail as { error?: string } | null)?.error ?? null) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{ position: 'fixed', inset: 0, background: theme.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={{ background: theme.surface, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: 24, maxWidth: 480, width: '92%' }}>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Invite {creator.name}</div>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 16px', lineHeight: 1.5 }}>
          They&rsquo;re not on OpenPartner yet. We&rsquo;ll email them your message this week, together with any other brands that
          invited them. When they claim their free profile, it opens as a conversation in Messages.
        </p>
        {send.isSuccess ? (
          <>
            <div style={{ background: theme.successSoft, border: `1px solid ${alpha(theme.success, 0.333)}`, borderRadius: theme.radiusSm, padding: 12, fontSize: 13, color: theme.success, marginBottom: 14 }}>
              Invited. We&rsquo;ll tell you when they join.
            </div>
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            {send.error && <ErrorBanner error={(errorCode && INVITE_ERRORS[errorCode]) || send.error} />}
            <Label>Your message</Label>
            <Textarea
              rows={6}
              value={message}
              maxLength={2000}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Who you are, what you'd like to work on together, and roughly when."
            />
            <div style={{ fontSize: 12, color: theme.textDim, margin: '6px 0 16px' }}>
              {trimmed.length < 20 ? `At least 20 characters (${trimmed.length}/20)` : `${trimmed.length}/2000`}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button onClick={() => send.mutate()} disabled={trimmed.length < 20 || send.isPending}>
                {send.isPending ? 'Sending…' : 'Send invite'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
