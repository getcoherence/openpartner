import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { ArrowLeft, UserCheck } from 'lucide-react';
import { api, type Principal } from '../api.js';
import { useIsMobile } from '../lib/useMediaQuery.js';
import { alpha, theme } from '../theme.js';
import { TenantLink } from '../tenant-link.js';
import { Button, Card, EmptyState, ErrorBanner, Page, StatusPill, formatDate, moneyByCurrency } from '../ui.js';

/**
 * Referrals: each customer the partner referred and the stages they've
 * reached (GET /partners/:id/referrals). The brand picks which event types
 * show as stages and what they're called (Admin → Settings → Referral
 * stages); everything else stays hidden. A partner never sees the brand's
 * userId: a customer is "Referral #n", or the label the brand sends when it
 * shows those. Admins get the same view per partner, plus the userId.
 */

export interface ReferralStageDefinition {
  eventType: string;
  label: string;
}

export interface ReferralStageReached extends ReferralStageDefinition {
  firstAt: string;
  lastAt: string;
  count: number;
  reversed: boolean;
}

export interface Referral {
  referralId: string;
  number: number;
  label: string;
  customerLabel: string | null;
  /** Admins only. */
  userId?: string;
  referredAt: string;
  stages: ReferralStageReached[];
  latestStage: { eventType: string; label: string; at: string } | null;
  commission: number;
  commissionByCurrency: Record<string, number>;
}

export interface ReferralPage {
  partnerId: string;
  stages: ReferralStageDefinition[];
  currency: string;
  referrals: Referral[];
  total: number;
  nextCursor: string | null;
}

const PAGE_SIZE = 50;

/** The signed-in partner's own referrals. */
export function ReferralsPage({ principal }: { principal: Principal }) {
  return (
    <Page title="Referrals" subtitle="Everyone you referred, and how far they've come.">
      <ReferralList partnerId={principal.partnerId ?? ''} adminView={false} />
    </Page>
  );
}

/** Admin → Partners → Referrals: what that partner sees. */
export function AdminPartnerReferrals() {
  const { id = '' } = useParams<{ id: string }>();
  const partner = useQuery({
    queryKey: ['partner', id],
    queryFn: () => api<{ id: string; name: string; revokedAt: string | null }>(`/partners/${id}`),
    enabled: !!id,
  });
  const name = partner.data?.name ?? '…';
  return (
    <Page title={`Referrals · ${name}`} subtitle={`What ${partner.data?.name ?? 'this partner'} sees on their Referrals page.`}>
      <div style={{ marginBottom: 14 }}>
        <TenantLink to="/admin/partners" style={{ color: theme.textMuted, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={14} /> Back to Partners
        </TenantLink>
      </div>
      <ErrorBanner error={partner.error} />
      {partner.data?.revokedAt && (
        <div style={{ fontSize: 13, color: theme.danger, background: theme.dangerSoft, borderRadius: theme.radiusSm, padding: '10px 14px', marginBottom: 14 }}>
          This partner is revoked: they can&rsquo;t sign in, and these referrals are history.
        </div>
      )}
      <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6, marginBottom: 16, maxWidth: 720 }}>
        Only you see each customer&rsquo;s user ID. Choose which stages partners see, and whether they see customer
        labels, in{' '}
        <TenantLink to="/admin/settings" style={{ color: theme.accentText }}>
          Settings → Referral stages
        </TenantLink>
        .
      </div>
      <ReferralList partnerId={id} adminView />
    </Page>
  );
}

export function ReferralList({ partnerId, adminView }: { partnerId: string; adminView: boolean }) {
  const { data, error, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['referrals', partnerId],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam) qs.set('cursor', pageParam);
      return api<ReferralPage>(`/partners/${partnerId}/referrals?${qs}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!partnerId,
  });

  const first = data?.pages[0];
  const referrals = data?.pages.flatMap((p) => p.referrals) ?? [];

  if (isLoading) return <Card>Loading…</Card>;
  return (
    <>
      <ErrorBanner error={error} />
      {referrals.length === 0 ? (
        <EmptyState
          title="No referrals yet"
          hint={
            adminView
              ? 'Customers credited to this partner appear here, with each stage they reach.'
              : "When someone you referred signs up, they'll appear here with each step they take."
          }
          icon={<UserCheck size={28} strokeWidth={1.25} />}
        />
      ) : (
        <>
          <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 12 }}>
            {first!.total === 1 ? '1 referral' : `${first!.total.toLocaleString()} referrals`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {referrals.map((r) => (
              <ReferralCard key={r.referralId} referral={r} stages={first!.stages} currency={first!.currency} adminView={adminView} />
            ))}
          </div>
          {hasNextPage && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
              <Button variant="secondary" size="sm" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? 'Loading…' : `Load ${PAGE_SIZE} more`}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function ReferralCard({
  referral,
  stages,
  currency,
  adminView,
}: {
  referral: Referral;
  stages: ReferralStageDefinition[];
  currency: string;
  adminView: boolean;
}) {
  const isMobile = useIsMobile();
  const earned = Object.values(referral.commissionByCurrency).some((n) => n !== 0);
  return (
    <article aria-label={referral.label}>
      <Card style={{ padding: isMobile ? 16 : 20 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            justifyContent: 'space-between',
            alignItems: isMobile ? 'stretch' : 'flex-start',
            gap: isMobile ? 8 : 16,
            marginBottom: stages.length > 0 ? 16 : 0,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }}>{referral.label}</div>
            <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 3 }}>
              Referred {formatDate(referral.referredAt)}
              {referral.customerLabel && ` · Referral #${referral.number}`}
              {referral.latestStage && ` · ${referral.latestStage.label}`}
            </div>
            {adminView && referral.userId && (
              <div style={{ fontSize: 12, color: theme.textDim, marginTop: 3, overflowWrap: 'anywhere' }}>
                User ID <code style={{ fontFamily: theme.fontMono }}>{referral.userId}</code>
              </div>
            )}
          </div>
          <div
            style={{
              textAlign: isMobile ? 'left' : 'right',
              flexShrink: 0,
              // One line on a phone: "₹6,500.00 earned".
              ...(isMobile ? { display: 'flex', alignItems: 'baseline', gap: 6 } : {}),
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: earned ? theme.text : theme.textDim }}>
              {moneyByCurrency(referral.commissionByCurrency, currency)}
            </div>
            <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>earned</div>
          </div>
        </div>
        {stages.length > 0 && <StageTimeline stages={stages} reached={referral.stages} vertical={isMobile} />}
      </Card>
    </article>
  );
}

type StepState = 'reached' | 'reversed' | 'pending';

/** The brand's stages in order, each reached (with its date), reversed, or
 *  not yet. Horizontal on desktop, a vertical list on phones. */
export function StageTimeline({
  stages,
  reached,
  vertical,
}: {
  stages: ReferralStageDefinition[];
  reached: ReferralStageReached[];
  vertical: boolean;
}) {
  const byType = new Map(reached.map((s) => [s.eventType, s]));
  // The line is drawn in the accent up to the furthest stage reached and
  // not reversed: how far the customer has really come.
  const furthest = stages.reduce((max, s, i) => {
    const hit = byType.get(s.eventType);
    return hit && !hit.reversed ? i : max;
  }, -1);
  return (
    <ol
      aria-label="Stages"
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: vertical ? 'column' : 'row',
        gap: vertical ? 10 : 0,
      }}
    >
      {stages.map((stage, i) => {
        const hit = byType.get(stage.eventType);
        const state: StepState = !hit ? 'pending' : hit.reversed ? 'reversed' : 'reached';
        const when = hit ? formatDate(hit.firstAt) : 'Not yet';
        return (
          <li
            key={stage.eventType}
            data-state={state}
            aria-label={`${stage.label}: ${state === 'pending' ? 'not yet' : `${when}${state === 'reversed' ? ', reversed' : ''}`}`}
            style={{
              flex: vertical ? undefined : 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: vertical ? 'row' : 'column',
              alignItems: vertical ? 'center' : 'flex-start',
              gap: vertical ? 10 : 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', width: vertical ? 'auto' : '100%' }}>
              <StepDot state={state} />
              {!vertical && i < stages.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: 2,
                    margin: '0 6px',
                    borderRadius: 1,
                    background: i < furthest ? theme.accent : theme.border,
                  }}
                />
              )}
            </div>
            <div style={{ minWidth: 0, paddingRight: vertical ? 0 : 8, display: vertical ? 'flex' : 'block', flex: vertical ? 1 : undefined, justifyContent: 'space-between', gap: 8 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: state === 'pending' ? 400 : 500,
                  color: state === 'pending' ? theme.textDim : theme.text,
                  textDecoration: state === 'reversed' ? 'line-through' : 'none',
                  overflowWrap: 'anywhere',
                }}
              >
                {stage.label}
                {hit && hit.count > 1 && <span style={{ color: theme.textMuted, fontWeight: 400 }}> ×{hit.count}</span>}
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted, marginTop: vertical ? 0 : 2, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                {when}
                {state === 'reversed' && <StatusPill status="reversed" />}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepDot({ state }: { state: StepState }) {
  const size = 12;
  const palette: Record<StepState, { bg: string; border: string }> = {
    reached: { bg: theme.accent, border: theme.accent },
    reversed: { bg: alpha(theme.danger, 0.2), border: theme.danger },
    pending: { bg: 'transparent', border: theme.border },
  };
  const p = palette[state];
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        background: p.bg,
        border: `2px solid ${p.border}`,
        boxSizing: 'border-box',
      }}
    />
  );
}
