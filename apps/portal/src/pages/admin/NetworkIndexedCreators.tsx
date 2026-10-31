/**
 * Discover creators → external creators (openpartner-network
 * docs/creator-index.md §4, §5): creators the Network listed from their
 * public profiles who haven't joined, in the same list after OpenPartner's
 * own creators (NetworkCreators.tsx), under the same filters, each badged
 * "External creator". Only creators we can email are listed. A brand on
 * Flex or Enterprise can invite them to collaborate: the Network emails the
 * creator on the brand's behalf, and the message opens as a conversation
 * when they claim their free profile.
 *
 * Creators who already take partnerships (a sponsorship storefront, a
 * sponsor page, sponsored posts) are marked, and a brand can show only them.
 * A row opens the creator (/admin/network/indexed-creators/:id, or the side
 * panel on a wide screen): what they publish, each channel's numbers and
 * top posts, the products they mention, and why they can or can't be
 * invited.
 *
 * Other plans get the plan_required answer from the API, and this shows
 * what the plan would unlock instead of an error.
 */

import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, UserPlus, Users } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { Button, Card, EmptyState, ErrorBanner, Label, Page, Textarea, formatDate } from '../../ui.js';
import { alpha, theme } from '../../theme.js';
import { TenantLink } from '../../tenant-link.js';
import { brandSignalLabel, type PartnershipSignal } from '../../lib/partnership-signals.js';
import { ChannelCount, ChannelCounts, PlatformMark, compactCount, platformName } from '../../lib/PlatformMark.js';
import { FlatCards, SectionCard, useFlatCards } from '../../lib/Surface.js';
import { ListingBanner } from '../creator/ListingBanner.js';
import { CreatorRow, PanelBar, RowFigure } from './CreatorRow.js';

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
  /** Shows they take partnerships: a storefront, a sponsor page,
   *  sponsored posts. Kinds and counts only. */
  openToPartnerships?: boolean;
  partnershipSignals?: PartnershipSignal[];
  invitable: boolean;
  invite: { id: string; status: string; createdAt: string } | null;
  refreshedAt: string | null;
}

interface SearchPage {
  creators: IndexedCreator[];
  nextCursor: string | null;
  total: number;
}

/** One creator's page: every channel with its numbers, and what we read. */
interface IndexedCreatorProfile extends Omit<IndexedCreator, 'platforms'> {
  platforms: Array<IndexedPlatform & { avgComments: number | null; avgReposts: number | null; topPostUrls: string[] }>;
  summary: string | null;
  productsMentioned: Array<{ name: string; count: number }>;
  /** Why an invite can't be sent, or null. */
  blocker: string | null;
}

const profilePath = (id: string) => `/admin/network/indexed-creators/${encodeURIComponent(id)}`;

/** The Network's vocabulary for external creators (creator-index/classify.ts),
 *  offered alongside members' categories in the shared filter. */
export const EXTERNAL_CATEGORIES = [
  'sales', 'marketing', 'revops', 'customer-success', 'ai', 'devtools', 'engineering', 'data',
  'product', 'design', 'startups', 'founders', 'leadership', 'hr', 'recruiting', 'career',
  'finance', 'venture-capital', 'ecommerce', 'creator-economy', 'productivity', 'security',
];

/** What brands see on a creator who hasn't joined (Keith, Oct 31). */
export const EXTERNAL_BADGE = 'External creator';

/** What the badge means, on hover. */
const EXTERNAL_MEANS = 'Not on OpenPartner yet. We list them from their public profiles; an invite emails them for you, and they reply once they claim their free profile. Prices appear when they set them.';

function ExternalBadge({ size = 10 }: { size?: number }) {
  return (
    <span
      title={EXTERNAL_MEANS}
      style={{ display: 'inline-block', background: theme.surface2, color: theme.textMuted, fontSize: size, padding: '2px 8px', borderRadius: 10, cursor: 'help' }}
    >
      {EXTERNAL_BADGE}
    </span>
  );
}

/** The Discover creators filters that mean something for external
 *  creators (NetworkCreators.tsx passes them down). */
export interface ExternalFilters {
  q?: string;
  /** Creator must have all of them. */
  categories?: string[];
  /** Creator must have at least one. */
  platforms?: string[];
  minFollowers?: number;
  /** Only those who already take partnerships. */
  openToPartnerships?: boolean;
  sort?: 'reach' | 'newest';
}

/** The external creators under the page's filters, a page at a time. Their
 *  rows go in Discover creators' one list after OpenPartner's own;
 *  `planRequired` when the brand's plan doesn't include them. */
export function useIndexedCreators(filters: ExternalFilters, enabled = true) {
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
    if (filters.categories?.length) p.set('categories', filters.categories.join(','));
    if (filters.platforms?.length) p.set('platforms', filters.platforms.join(','));
    if (filters.minFollowers && filters.minFollowers > 0) p.set('minFollowers', String(filters.minFollowers));
    if (filters.openToPartnerships) p.set('openToPartnerships', '1');
    if (filters.sort && filters.sort !== 'reach') p.set('sort', filters.sort);
    return p.toString();
  }, [filters.q, filters.categories, filters.platforms, filters.minFollowers, filters.openToPartnerships, filters.sort]);

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
    enabled,
  });

  const planRequired = search.error instanceof ApiError && search.error.status === 402;
  return {
    rows: search.data?.pages.flatMap((p) => p.creators ?? []) ?? [],
    total: search.data?.pages[0]?.total ?? 0,
    isLoading: enabled && search.isLoading,
    planRequired,
    error: planRequired ? null : search.error,
    hasMore: search.hasNextPage,
    loadingMore: search.isFetchingNextPage,
    loadMore: () => search.fetchNextPage(),
  };
}

export function PlanUpsell() {
  return (
    <Card>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <UserPlus size={26} strokeWidth={1.5} style={{ color: theme.accentText, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>See external creators too</div>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: '6px 0 14px', lineHeight: 1.5 }}>
            Thousands more creators who haven&rsquo;t joined OpenPartner yet, found from their public profiles, with their audience
            and the topics they cover. Invite any of them and we&rsquo;ll email them for you. This comes with the Flex and Enterprise
            plans.
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

function Avatar({ creator, size }: { creator: Pick<IndexedCreator, 'avatarUrl' | 'name'>; size: number }) {
  return creator.avatarUrl ? (
    <img src={creator.avatarUrl} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', background: theme.surface2, flexShrink: 0 }} />
  ) : (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: theme.surface2,
        color: theme.textMuted,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.4),
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {creator.name.charAt(0).toUpperCase()}
    </div>
  );
}

function OpenBadge() {
  return (
    <span style={{ display: 'inline-block', background: theme.successSoft, color: theme.success, fontSize: 10, padding: '2px 8px', borderRadius: 10 }}>
      Open to partnerships
    </span>
  );
}

export function ExternalRow({ creator, selected, onSelect }: { creator: IndexedCreator; selected: boolean; onSelect?: () => void }) {
  const [open, setOpen] = useState(false);
  const signals = creator.partnershipSignals ?? [];
  return (
    <>
      <CreatorRow
        name={creator.name}
        to={profilePath(creator.id)}
        selected={selected}
        onSelect={onSelect}
        avatar={<Avatar creator={creator} size={44} />}
        meta={
          <>
            <ExternalBadge />
            {creator.openToPartnerships && <OpenBadge />}
            {creator.country && <span style={{ fontSize: 12, color: theme.textDim }}>{creator.country}</span>}
          </>
        }
        line={creator.headline}
        channels={creator.platforms.map((p) => (
          <ChannelCount key={p.profileUrl} platform={p.platform} followers={p.followerCount} href={p.profileUrl} />
        ))}
        side={<RowFigure value={compactCount(creator.totalReach)} caption="followers" />}
        tags={creator.topics}
        note={
          <>
            {signals.length > 0 && <div style={{ color: theme.text }}>{signals.map(brandSignalLabel).join(' · ')}</div>}
            {creator.invite ? (
              <div style={{ color: creator.invite.status === 'claimed' ? theme.success : theme.textMuted }}>{INVITE_STATUS[creator.invite.status] ?? 'Invited.'}</div>
            ) : !creator.invitable ? (
              <div style={{ color: theme.textDim }}>Can&rsquo;t be invited yet</div>
            ) : null}
          </>
        }
        actions={
          !creator.invite && creator.invitable ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              Invite
            </Button>
          ) : undefined
        }
      />
      {open && <IndexInviteDialog creator={creator} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Why an invite can't go out, in the brand's terms. */
const BLOCKERS: Record<string, string> = {
  unreachable:
    'We can’t email them yet: they haven’t published a business email address we can use, or we’ve already emailed them as often as we will (three times).',
  not_accepting_invites: 'They’ve asked not to receive emails from OpenPartner. They’re still listed, and you can contact them through their own channels.',
};

/** A channel's numbers, left out when the platform doesn't give them. */
function channelNumbers(p: IndexedCreatorProfile['platforms'][number]): string[] {
  const out: string[] = [];
  if (p.followerCount != null) out.push(`${p.followerCount.toLocaleString()} followers`);
  if (p.postsLast30d != null) out.push(`${p.postsLast30d} post${p.postsLast30d === 1 ? '' : 's'} in the last 30 days`);
  if (p.avgReactions != null) out.push(`${p.avgReactions.toLocaleString()} reactions a post`);
  if (p.avgComments != null) out.push(`${p.avgComments.toLocaleString()} comments a post`);
  if (p.avgReposts != null) out.push(`${p.avgReposts.toLocaleString()} reposts a post`);
  return out;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>{children}</div>;
}

function useIndexedCreator(id: string) {
  return useQuery({
    queryKey: ['admin-indexed-creators', 'profile', id],
    queryFn: () => api<{ creator: IndexedCreatorProfile }>(profilePath(id)).then((r) => r.creator),
    retry: false,
  });
}

/** /admin/network/indexed-creators/:id — one creator who isn't on
 *  OpenPartner yet, in full. Flex and Enterprise, like the search. */
export function IndexedCreatorPage() {
  const { id = '' } = useParams<{ id: string }>();
  const profile = useIndexedCreator(id);

  const back = (
    <TenantLink to="/admin/network/creators?show=external" style={{ color: theme.textMuted, fontSize: 13, textDecoration: 'none' }}>
      ← Discover creators
    </TenantLink>
  );

  if (profile.error instanceof ApiError && profile.error.status === 402) {
    return (
      <Page title="Creator" back={back}>
        <PlanUpsell />
      </Page>
    );
  }
  if (profile.error instanceof ApiError && profile.error.status === 404) {
    return (
      <Page title="Creator not found" back={back}>
        <EmptyState title="This creator is no longer listed" hint="They may have joined OpenPartner, or asked to be removed." icon={<Users size={28} strokeWidth={1.25} />} />
      </Page>
    );
  }
  const c = profile.data;
  if (!c) {
    return (
      <Page title="Creator" back={back}>
        <ErrorBanner error={profile.error} />
        {profile.isLoading && <Card>Loading…</Card>}
      </Page>
    );
  }

  return (
    <Page title={c.name} back={back} subtitle={c.headline ?? undefined}>
      <div style={{ maxWidth: 860 }}>
        <IndexedCreatorBody c={c} />
      </div>
    </Page>
  );
}

/** The same creator beside Discover creators' list on a wide screen. */
export function IndexedCreatorPanel({ id }: { id: string }) {
  const profile = useIndexedCreator(id);
  if (profile.error instanceof ApiError && profile.error.status === 402) return <PlanUpsell />;
  if (profile.error instanceof ApiError && profile.error.status === 404) {
    return <EmptyState title="This creator is no longer listed" hint="They may have joined OpenPartner, or asked to be removed." icon={<Users size={28} strokeWidth={1.25} />} />;
  }
  const c = profile.data;
  if (!c) {
    return (
      <>
        <ErrorBanner error={profile.error} />
        {profile.isLoading && <Card>Loading…</Card>}
      </>
    );
  }
  return (
    <>
      <PanelBar to={profilePath(id)} />
      <FlatCards>
        <IndexedCreatorBody c={c} named />
      </FlatCards>
    </>
  );
}

/** What we hold on an external creator: their page's body, and the side
 *  panel's. `named` adds their name and headline, which the page has as
 *  its title. */
function IndexedCreatorBody({ c, named = false }: { c: IndexedCreatorProfile; named?: boolean }) {
  const [inviting, setInviting] = useState(false);
  const signals = c.partnershipSignals ?? [];
  const flat = useFlatCards();
  const badges = (
    <>
      <ExternalBadge size={11} />
      {c.openToPartnerships && (
        <span style={{ background: theme.successSoft, color: theme.success, fontSize: 11, padding: '2px 8px', borderRadius: 10 }}>Open to partnerships</span>
      )}
      {c.country && <span style={{ fontSize: 12, color: theme.textDim }}>{c.country}</span>}
    </>
  );
  const reach = (
    <>
      <strong style={{ color: theme.text }}>{c.totalReach.toLocaleString()}</strong> followers across {c.platforms.length} channel
      {c.platforms.length === 1 ? '' : 's'}
      {c.refreshedAt && <> · read {formatDate(c.refreshedAt)}</>}
    </>
  );
  const inviteControl = c.invite ? (
    <div style={{ fontSize: 13, color: c.invite.status === 'claimed' ? theme.success : theme.textMuted }}>{INVITE_STATUS[c.invite.status] ?? 'Invited.'}</div>
  ) : c.invitable ? (
    <Button onClick={() => setInviting(true)} style={{ width: '100%' }}>
      Invite to collaborate
    </Button>
  ) : (
    <div style={{ fontSize: 13, color: theme.textDim }}>Can&rsquo;t be invited yet</div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: flat ? 0 : 16 }}>
      <SectionCard>
        {named ? (
          <>
            {/* No cover of their own: a short wash. */}
            <ListingBanner coverUrl={null} logoUrl={c.avatarUrl} style={{ margin: '-20px -20px 0', aspectRatio: 'auto', height: 112 }} />
            {/* Positioned, so it sits over the banner rather than under it. */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: -36 }}>
              <div style={{ display: 'flex', borderRadius: '50%', border: `4px solid ${theme.surface}`, background: theme.surface }}>
                <Avatar creator={c} size={72} />
              </div>
              <div style={{ minWidth: 200 }}>{inviteControl}</div>
            </div>
            <div style={{ fontSize: 20, fontWeight: 600, marginTop: 10 }}>{c.name}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>{badges}</div>
            <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 8 }}>{reach}</div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <Avatar creator={c} size={56} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>{badges}</div>
              <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6 }}>{reach}</div>
            </div>
            <div style={{ minWidth: 200 }}>{inviteControl}</div>
          </div>
        )}
        {named && c.headline && <p style={{ fontSize: 14, color: theme.text, margin: '14px 0 0', lineHeight: 1.5 }}>{c.headline}</p>}
        <ChannelCounts style={{ marginTop: 14 }}>
          {c.platforms.map((p) => (
            <ChannelCount key={p.profileUrl} platform={p.platform} followers={p.followerCount} href={p.profileUrl} size={16} />
          ))}
        </ChannelCounts>
        {!c.invite && !c.invitable && (
          <p style={{ fontSize: 13, color: theme.textMuted, margin: '12px 0 0', lineHeight: 1.5 }}>
            {(c.blocker && BLOCKERS[c.blocker]) ?? BLOCKERS.unreachable}
          </p>
        )}
      </SectionCard>

      {signals.length > 0 && (
        <SectionCard>
          <SectionTitle>Why they&rsquo;re open to partnerships</SectionTitle>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.7 }}>
            {signals.map((s) => (
              <li key={s.kind}>{brandSignalLabel(s)}</li>
            ))}
          </ul>
        </SectionCard>
      )}

      {c.summary && (
        <SectionCard>
          <SectionTitle>What they publish</SectionTitle>
          <p style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>{c.summary}</p>
          {(c.topics.length > 0 || c.categories.length > 0) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 12 }}>
              {[...new Set([...c.categories, ...c.topics])].map((t) => (
                <span key={t} style={{ background: theme.surface2, color: theme.textMuted, fontSize: 11, padding: '2px 8px', borderRadius: 10 }}>{t}</span>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      <SectionCard>
        <SectionTitle>Channels</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {c.platforms.map((p) => (
            <div key={p.profileUrl}>
              <a href={p.profileUrl} target="_blank" rel="noreferrer noopener" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500, color: theme.text }}>
                <PlatformMark platform={p.platform} size={16} />
                {platformName(p.platform)}
                <ExternalLink size={13} />
              </a>
              <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 3 }}>{channelNumbers(p).join(' · ') || 'No numbers yet'}</div>
              {p.topPostUrls.length > 0 && (
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  Top posts:{' '}
                  {p.topPostUrls.map((u, i) => (
                    <span key={u}>
                      {i > 0 && ' · '}
                      <a href={u} target="_blank" rel="noreferrer noopener" style={{ color: theme.accentText }}>
                        {i + 1}
                      </a>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </SectionCard>

      {c.productsMentioned.length > 0 && (
        <SectionCard>
          <SectionTitle>Products and companies they mention</SectionTitle>
          <div style={{ fontSize: 14, lineHeight: 1.7 }}>
            {c.productsMentioned.map((m) => `${m.name} (${m.count} post${m.count === 1 ? '' : 's'})`).join(' · ')}
          </div>
        </SectionCard>
      )}

      <p style={{ fontSize: 12, color: theme.textDim, margin: 0, padding: flat ? '0 20px 20px' : 0, lineHeight: 1.5 }}>
        Read from their public profiles. Their rates and packages appear once they join OpenPartner and set them.
      </p>
      {inviting && <IndexInviteDialog creator={c} onClose={() => setInviting(false)} />}
    </div>
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
