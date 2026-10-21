import { useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  MousePointerClick,
  Receipt,
  Wallet,
  Users,
  UserCheck,
  CreditCard,
  AlertCircle,
  Link2,
  CheckCircle2,
  Circle,
  ArrowRight,
  Landmark,
} from 'lucide-react';
import { api, type Principal } from '../api.js';
import { useTenantBase } from '../tenant-base.js';
import { TenantLink } from '../tenant-link.js';
import { alpha, theme } from '../theme.js';
import { useBrand, useDefaultCurrency } from '../lib/useBrand.js';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  SectionHeading,
  Select,
  Stat,
  StatusPill,
  moneyByCurrency,
  statusAmounts,
} from '../ui.js';

// ---------- Partner ----------

interface PartnerDashboard {
  partnerId: string;
  since: string;
  /** The brand's default currency: the currency of the scalar fields.
   *  The ByCurrency maps are absent from an API that predates them. */
  currency?: string;
  clicks: number;
  attributedEvents: number;
  attributedRevenue: number;
  attributedRevenueByCurrency?: Record<string, number>;
  commissionByStatus: Record<string, number>;
  commissionByCurrency?: Record<string, Record<string, number>>;
}

/** Every currency's amounts, never added together. An API that predates
 *  the ByCurrency maps only has the scalars, in `currency`. */
function dashboardAmounts(data: PartnerDashboard, fallbackCurrency: string) {
  const currency = data.currency ?? fallbackCurrency;
  return {
    currency,
    revenue: data.attributedRevenueByCurrency ?? { [currency]: data.attributedRevenue },
    commissions: data.commissionByCurrency ?? { [currency]: data.commissionByStatus },
  };
}

export function Dashboard({ principal }: { principal: Principal }) {
  if (principal.role === 'admin') return <AdminDashboard />;
  if (principal.role === 'partner') {
    return <PartnerDashboard partnerId={principal.partnerId!} name={principal.partner?.name ?? ''} />;
  }
  return null;
}

interface Funnel {
  stages: { clicks: number; identities: number; signups: number; paid: number };
  rates: { stitchRate: number; signupRate: number; paidRate: number; overall: number };
  revenue: number;
}

interface ConnectStatus {
  connected: boolean;
  payoutsEnabled?: boolean;
}

/** GET /partners/:id/payout-profile, the parts the dashboard reads. `rail`
 *  is absent from an API that predates it. */
interface PayoutProfileStatus {
  profile: { details: unknown } | null;
  rail?: 'auto' | 'stripe_connect' | 'manual';
}

function PartnerDashboard({ partnerId, name }: { partnerId: string; name: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['dashboard', partnerId],
    queryFn: () => api<PartnerDashboard>(`/partners/${partnerId}/dashboard`),
  });
  const funnel = useQuery({
    queryKey: ['funnel', partnerId],
    queryFn: () => api<Funnel>(`/partners/${partnerId}/funnel`),
  });
  // Non-critical — render the rest of the dashboard even if this 503s
  // (Stripe not configured on a selfhost instance, for instance).
  const connect = useQuery({
    queryKey: ['connect-status', partnerId],
    queryFn: () => api<ConnectStatus>(`/partners/${partnerId}/connect/status`),
    retry: false,
  });
  // Says whether the brand pays partners itself (the manual rail), where
  // Stripe Connect isn't used and the partner's payout details are.
  // Non-critical too: without it the card falls back to Stripe.
  const payoutProfile = useQuery({
    queryKey: ['payout-profile', partnerId],
    queryFn: () => api<PayoutProfileStatus>(`/partners/${partnerId}/payout-profile`),
    retry: false,
  });
  const links = useQuery({
    queryKey: ['links', partnerId],
    queryFn: () => api<{ links: unknown[] }>(`/partners/${partnerId}/links`),
  });

  const defaultCurrency = useDefaultCurrency();
  const amounts = data ? dashboardAmounts(data, defaultCurrency) : null;

  const linkCount = links.data?.links.length ?? 0;
  const hasLink = linkCount > 0;
  const hasActiveConnect = !!connect.data?.connected && !!connect.data?.payoutsEnabled;
  // On the manual rail the brand pays from the partner's payout details
  // (bank transfer, PayPal or Wise files): that's the step, not Stripe.
  const paysManually = payoutProfile.data?.rail === 'manual';
  const hasPayoutDetails = !!payoutProfile.data?.profile?.details;
  const payoutReady = paysManually ? hasPayoutDetails : hasActiveConnect;

  const owed = amounts ? statusAmounts(amounts.commissions, 'approved', 'accrued') : {};
  const needsConnect =
    !!amounts &&
    Object.keys(owed).length > 0 &&
    !payoutProfile.isLoading &&
    !paysManually &&
    connect.data != null &&
    (!connect.data.connected || !connect.data.payoutsEnabled);

  // Getting-started card shows while EITHER onboarding task is outstanding.
  // We only render it once we know the state of both (payouts + links),
  // otherwise the card can flash during initial load.
  const showGettingStarted =
    !links.isLoading && !connect.isLoading && !payoutProfile.isLoading && (!hasLink || !payoutReady);

  return (
    <Page
      title={`Hi ${name.split(' ')[0] || 'there'}`}
      subtitle="Last 30 days"
    >
      <ErrorBanner error={error} />
      {showGettingStarted && (
        <GettingStarted hasLink={hasLink} payoutStep={paysManually ? 'details' : 'stripe'} payoutReady={payoutReady} />
      )}
      {needsConnect && !showGettingStarted && (
        <ConnectNudge owed={moneyByCurrency(owed, amounts!.currency)} connected={connect.data!.connected} />
      )}
      {isLoading || !data || !amounts ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            <Stat label="Clicks" value={data.clicks} icon={<MousePointerClick size={16} />} />
            <Stat label="Attributed events" value={data.attributedEvents} icon={<Receipt size={16} />} />
            <Stat
              label="Attributed revenue"
              value={moneyByCurrency(amounts.revenue, amounts.currency)}
              icon={<Wallet size={16} />}
            />
            <Stat
              label="Earned (paid)"
              value={moneyByCurrency(statusAmounts(amounts.commissions, 'paid'), amounts.currency)}
              icon={<Wallet size={16} />}
            />
          </div>

          {funnel.data && <FunnelChart funnel={funnel.data} />}

          <SectionHeading>Commissions</SectionHeading>
          <Card>
            {Object.keys(amounts.commissions).length === 0 ? (
              <div style={{ color: theme.textMuted, fontSize: 14 }}>
                You'll see commission activity here once events start attributing.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(['accrued', 'approved', 'paid', 'reversed'] as const).map((status) => {
                  const byCurrency = statusAmounts(amounts.commissions, status);
                  if (Object.keys(byCurrency).length === 0) return null;
                  return (
                    <div key={status} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <StatusPill status={status} />
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 15, fontWeight: 500 }}>
                        {moneyByCurrency(byCurrency, amounts.currency)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}
    </Page>
  );
}

function GettingStarted({
  hasLink,
  payoutStep,
  payoutReady,
}: {
  hasLink: boolean;
  /** `details`: the brand pays partners itself, from their payout details. */
  payoutStep: 'stripe' | 'details';
  payoutReady: boolean;
}) {
  const { programName } = useBrand();
  return (
    <Card>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Getting started</div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 16 }}>
        Two quick steps and you're earning. This card goes away once both are done.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ChecklistRow
          done={hasLink}
          icon={<Link2 size={16} />}
          title="Create your first share link"
          hint="Pick a short slug; anyone who clicks it gets attributed back to you."
          cta="Create link"
          to="/links"
        />
        {payoutStep === 'details' ? (
          <ChecklistRow
            done={payoutReady}
            icon={<Landmark size={16} />}
            title="Add your payout details"
            hint={`Tell ${programName} where to send your commissions: PayPal, a bank account or another way.`}
            cta="Add details"
            to="/payout-details"
          />
        ) : (
          <ChecklistRow
            done={payoutReady}
            icon={<CreditCard size={16} />}
            title="Connect Stripe to get paid"
            hint="Commissions you earn land directly in your Stripe balance."
            cta={payoutReady ? 'Manage' : 'Connect Stripe'}
            to="/connect"
          />
        )}
      </div>
    </Card>
  );
}

function ChecklistRow({
  done,
  icon,
  title,
  hint,
  cta,
  to,
}: {
  done: boolean;
  icon: React.ReactNode;
  title: string;
  hint: string;
  cta: string;
  to: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        background: done ? theme.successSoft : theme.surface2,
        border: `1px solid ${done ? alpha(theme.success, 0.267) : theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
      }}
    >
      <div style={{ color: done ? theme.success : theme.textDim, display: 'inline-flex' }}>
        {done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
      </div>
      <div style={{ color: theme.textMuted, display: 'inline-flex' }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: theme.text, textDecoration: done ? 'line-through' : 'none' }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>{hint}</div>
      </div>
      {!done && (
        <TenantLink to={to} style={{ textDecoration: 'none' }}>
          <Button size="sm">{cta}</Button>
        </TenantLink>
      )}
    </div>
  );
}

function ConnectNudge({ owed, connected }: { owed: string; connected: boolean }) {
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ color: theme.warn, marginTop: 2 }}>
          <AlertCircle size={18} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
            {connected ? 'Finish Stripe onboarding to receive payouts' : 'Connect Stripe to receive payouts'}
          </div>
          <div style={{ fontSize: 13, color: theme.textMuted }}>
            You have {owed} in commissions {connected ? 'waiting — complete onboarding to get paid.' : 'that can’t be paid out yet.'}
          </div>
        </div>
        <TenantLink to="/connect" style={{ textDecoration: 'none' }}>
          <Button icon={<CreditCard size={14} />}>{connected ? 'Finish onboarding' : 'Connect Stripe'}</Button>
        </TenantLink>
      </div>
    </Card>
  );
}

/** One cohort, top to bottom (routes/funnel.ts): the clicks in the window
 *  and what those visitors went on to do, so each stage is a subset of the
 *  last. Renewals from customers won earlier aren't in it. */
function FunnelChart({ funnel }: { funnel: Funnel }) {
  const stages = [
    { key: 'clicks', label: 'Clicks', value: funnel.stages.clicks, icon: <MousePointerClick size={14} />, rate: null },
    { key: 'identities', label: 'Identified', value: funnel.stages.identities, icon: <UserCheck size={14} />, rate: funnel.rates.stitchRate },
    { key: 'signups', label: 'Signed up', value: funnel.stages.signups, icon: <Receipt size={14} />, rate: funnel.rates.signupRate },
    { key: 'paid', label: 'Paid', value: funnel.stages.paid, icon: <CreditCard size={14} />, rate: funnel.rates.paidRate },
  ];
  const max = Math.max(1, ...stages.map((s) => s.value));
  const pct = (n: number | null | undefined) => (n == null ? '' : `${Math.round(n * 100)}%`);

  return (
    <>
      <SectionHeading>Funnel</SectionHeading>
      <Card>
        <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
          Your clicks in the last 30 days, and what those visitors went on to do.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {stages.map((s, i) => {
            const width = `${Math.max(6, (s.value / max) * 100)}%`;
            return (
              <div key={s.key} className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '120px 1fr 140px', gap: 12, alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: theme.textMuted }}>
                  <span style={{ color: theme.accentText, display: 'inline-flex' }}>{s.icon}</span>
                  {s.label}
                </div>
                <div style={{ background: theme.bg, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, height: 28, position: 'relative', overflow: 'hidden' }}>
                  <div
                    style={{
                      width,
                      height: '100%',
                      background: `linear-gradient(90deg, ${theme.accent}, ${theme.accentHover})`,
                      // Saturated bar on dark, a pale tint on light so the
                      // count (dark ink in both) reads on bar and track.
                      opacity: 'var(--op-funnel-opacity, 0.85)',
                    }}
                  />
                  <div style={{ position: 'absolute', left: 12, top: 0, bottom: 0, display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 600, color: `var(--op-funnel-ink, ${theme.accentInk})`, mixBlendMode: 'multiply' }}>
                    {s.value.toLocaleString()}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: theme.textMuted, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {i > 0 && (
                    <>
                      <span style={{ color: theme.textDim }}>from prev</span>{' '}
                      <span style={{ color: theme.text, fontWeight: 500 }}>{pct(s.rate)}</span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${theme.borderSubtle}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: theme.textMuted }}>Click → paid</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: theme.accentText, fontVariantNumeric: 'tabular-nums' }}>
            {pct(funnel.rates.overall)}
          </span>
        </div>
      </Card>
    </>
  );
}

// ---------- Admin ----------

type OverviewSort = 'revenue' | 'commission' | 'clicks';

const OVERVIEW_SORTS: Array<{ value: OverviewSort; label: string }> = [
  { value: 'revenue', label: 'Top by revenue' },
  { value: 'commission', label: 'Top by commission' },
  { value: 'clicks', label: 'Top by clicks' },
];

interface AdminOverview {
  since: string;
  sort: OverviewSort;
  nextCursor: string | null;
  totals: {
    partners: number;
    clicks: number;
    /** The brand's default currency: the currency of the scalar amounts.
     *  The ByCurrency maps are absent from an API that predates them. */
    currency?: string;
    attributedRevenue: number;
    attributedRevenueByCurrency?: Record<string, number>;
    attributedEvents: number;
    commissionAccrued: number;
    commissionApproved: number;
    commissionPaid: number;
    commissionByCurrency?: Record<string, Record<string, number>>;
  };
  partners: Array<{
    id: string;
    name: string;
    email: string;
    stripeConnected: boolean;
    clicks: number;
    revenue: number;
    revenueByCurrency?: Record<string, number>;
    events: number;
    commission: Record<string, number>;
    commissionByCurrency?: Record<string, Record<string, number>>;
  }>;
}

function AdminDashboard() {
  const [sort, setSort] = useState<OverviewSort>('revenue');
  // Totals come from the first page (every page carries the same
  // whole-tenant aggregates); partner cards accumulate page by page so a
  // program with tens of thousands of partners never loads them all.
  const { data, error, isLoading, isFetching, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['admin-overview', sort],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ sort });
      if (pageParam) qs.set('cursor', pageParam);
      return api<AdminOverview>(`/admin/overview?${qs}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
  const totals = data?.pages[0]?.totals;
  const partners = data?.pages.flatMap((p) => p.partners) ?? [];
  const defaultCurrency = useDefaultCurrency();
  const currency = totals?.currency ?? defaultCurrency;
  const totalCommissions = totals
    ? (totals.commissionByCurrency ?? {
        [currency]: { accrued: totals.commissionAccrued, approved: totals.commissionApproved, paid: totals.commissionPaid },
      })
    : {};

  return (
    <Page title="Partner Program" subtitle="Overview of every partner driving attributed revenue.">
      <ErrorBanner error={error} />
      <PendingApprovalsBanner />
      <BrandOnboarding />
      {isLoading || !totals ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            <Stat label="Partners" value={totals.partners.toLocaleString()} icon={<Users size={16} />} />
            <Stat label="Clicks (30d)" value={totals.clicks.toLocaleString()} icon={<MousePointerClick size={16} />} />
            <Stat
              label="Attributed revenue"
              value={moneyByCurrency(totals.attributedRevenueByCurrency ?? { [currency]: totals.attributedRevenue }, currency)}
              icon={<Wallet size={16} />}
            />
            <Stat
              label="Awaiting approval"
              value={moneyByCurrency(statusAmounts(totalCommissions, 'accrued'), currency)}
              hint={`${moneyByCurrency(statusAmounts(totalCommissions, 'approved'), currency)} approved, ${moneyByCurrency(statusAmounts(totalCommissions, 'paid'), currency)} paid`}
              icon={<Receipt size={16} />}
            />
          </div>

          <SectionHeading
            actions={
              totals.partners > 0 && (
                <Select
                  aria-label="Rank partners by"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as OverviewSort)}
                  style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }}
                >
                  {OVERVIEW_SORTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              )
            }
          >
            Partners
          </SectionHeading>
          {partners.length === 0 ? (
            <EmptyState
              title="No partners yet"
              hint="Create one from Admin → Partners to get started."
              icon={<Users size={28} strokeWidth={1.25} />}
            />
          ) : (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: 14,
                  opacity: isFetching && !isFetchingNextPage ? 0.6 : 1,
                  transition: 'opacity 120ms ease',
                }}
              >
                {partners.map((p) => (
                  <PartnerCard key={p.id} partner={p} currency={currency} />
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 16, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: theme.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                  Showing {partners.length.toLocaleString()} of {totals.partners.toLocaleString()} partners
                </span>
                {hasNextPage && (
                  <Button variant="secondary" size="sm" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                    {isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </Page>
  );
}

function PartnerCard({
  partner,
  currency,
}: {
  partner: AdminOverview['partners'][number];
  /** The brand's default currency; it leads, and formats a zero. */
  currency: string;
}) {
  const commissions = partner.commissionByCurrency ?? { [currency]: partner.commission };
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Avatar name={partner.name} size={40} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {partner.name}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {partner.email}
          </div>
        </div>
        {partner.stripeConnected && <StatusPill status="connected" />}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <MiniStat label="Revenue" value={moneyByCurrency(partner.revenueByCurrency ?? { [currency]: partner.revenue }, currency)} />
        <MiniStat label="Payouts" value={moneyByCurrency(statusAmounts(commissions, 'paid', 'approved'), currency)} />
        <MiniStat label="Clicks" value={String(partner.clicks)} />
        <MiniStat label="Events" value={String(partner.events)} />
      </div>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 15, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

interface BrandOnboardingStatus {
  brandInfoComplete: boolean;
  campaignCount: number;
  networkConnected: boolean;
  offeringPublishedCount: number;
  partnerCount: number;
  pendingPartnershipRequests: number;
  billingReady: boolean;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  /** Absent on an older API — treated as not-yet-known (step hidden). */
  trackingInstalled?: boolean;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  complete: boolean;
}

/** Shown above the dashboard when creators have applied via the Network
 *  but the brand hasn't subscribed yet — they can't approve until they
 *  do (trial-gate enforces). Stays present even after the Getting
 *  Started checklist is done; goes away once billing is set up. */
function PendingApprovalsBanner() {
  const tenantBase = useTenantBase();
  const { data } = useQuery({
    queryKey: ['admin-onboarding-status'],
    queryFn: () => api<BrandOnboardingStatus>('/admin/onboarding-status'),
    staleTime: 30_000,
    retry: false,
  });
  if (!data || data.billingReady || data.pendingPartnershipRequests <= 0) return null;
  const expired = data.trialDaysRemaining != null && data.trialDaysRemaining <= 0;
  const tone = expired ? 'danger' : 'warning';
  const palette = tone === 'danger'
    ? { bg: theme.dangerSoft, border: alpha(theme.danger, 0.333), fg: theme.danger }
    : { bg: theme.warnSoft, border: alpha(theme.warn, 0.333), fg: theme.warn };
  const count = data.pendingPartnershipRequests;
  const noun = count === 1 ? 'partner is' : 'partners are';
  const headline = expired
    ? `${count} ${noun} waiting — subscribe to approve them`
    : `${count} ${noun} waiting for your approval`;
  const body = expired
    ? 'Your evaluation period has ended. Subscribe to start approving creator applications again.'
    : 'Subscribe before your evaluation period ends so you can keep approving creators without interruption.';
  return (
    <div
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: theme.radiusSm,
        padding: '14px 16px',
        marginBottom: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <AlertCircle size={20} style={{ color: palette.fg, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: palette.fg, marginBottom: 2 }}>
          {headline}
        </div>
        <div style={{ fontSize: 13, color: theme.textMuted }}>{body}</div>
      </div>
      <TenantLink to={`${tenantBase}/admin/billing`} style={{ textDecoration: 'none' }}>
        <Button size="sm" variant="primary">Set up billing</Button>
      </TenantLink>
    </div>
  );
}

function BrandOnboarding() {
  const tenantBase = useTenantBase();
  const { programName, whiteLabel } = useBrand();
  const { data } = useQuery({
    queryKey: ['admin-onboarding-status'],
    queryFn: () => api<BrandOnboardingStatus>('/admin/onboarding-status'),
    staleTime: 30_000,
    retry: false,
  });
  if (!data || data.complete) return null;
  const items = [
    { done: true, label: 'Brand account created', href: null as string | null },
    {
      done: data.brandInfoComplete,
      label: 'Set your brand name and support email',
      href: `${tenantBase}/admin/settings`,
    },
    {
      done: data.campaignCount > 0,
      label: 'Create your first program (Campaign)',
      hint: 'Set the destination URL and commission terms.',
      href: `${tenantBase}/admin/programs`,
    },
    // The Network is the shared cross-tenant marketplace — white-label
    // tenants are isolated from it, so drop the listing step entirely.
    ...(whiteLabel
      ? []
      : [
          {
            done: data.networkConnected,
            label: 'List your brand on the OpenPartner Network',
            hint: 'Lets creators across the federation discover and apply.',
            href: `${tenantBase}/admin/network`,
          },
        ]),
    // Listing = a program shared to the marketplace (the "Share on the
    // OpenPartner Network" toggle on the program). Only meaningful for
    // on-Network, non-white-label brands.
    ...(data.networkConnected && !whiteLabel
      ? [
          {
            done: data.offeringPublishedCount > 0,
            label: 'Publish a program on the marketplace',
            hint:
              data.approvalStatus === 'pending'
                ? 'Turn on "Share on the OpenPartner Network" for a program. It appears to creators once your brand is approved.'
                : 'Turn on "Share on the OpenPartner Network" for a program so creators can find and apply to it.',
            href: `${tenantBase}/admin/programs`,
          },
        ]
      : []),
    ...(data.trackingInstalled === undefined
      ? []
      : [
          {
            done: data.trackingInstalled,
            label: 'Connect conversion tracking',
            hint: 'Install the OpenPartner SDK (identify signups) or connect Stripe so partner referrals are credited.',
            href: `${tenantBase}/admin/integrations`,
          },
        ]),
    {
      done: data.partnerCount > 0,
      label: whiteLabel ? 'Invite a partner' : 'Invite a partner — or wait for Network applications',
      href: `${tenantBase}/admin/partners`,
    },
    buildBillingStep(data, `${tenantBase}/admin/billing`, programName),
  ];
  return (
    <Card style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Getting started</div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
        A few one-clicks to get your brand fully set up. The card disappears when you&rsquo;re done.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((it, i) => (
          <BrandStep key={i} done={it.done} label={it.label} hint={it.hint} href={it.href} tone={it.tone} />
        ))}
      </div>
    </Card>
  );
}

type StepTone = 'default' | 'warning' | 'danger';

interface OnboardingStep {
  done: boolean;
  label: string;
  hint?: string;
  href: string | null;
  tone?: StepTone;
}

/** The billing step doubles as the trial-deadline pressure. Once
 *  billingReady, it just shows checked. Otherwise the label is
 *  "Subscribe by <date>" and the tone shifts to warning then danger as
 *  the evaluation window closes. */
function buildBillingStep(data: BrandOnboardingStatus, href: string, programName: string): OnboardingStep {
  if (data.billingReady) {
    return { done: true, label: 'Set up billing', href };
  }
  const days = data.trialDaysRemaining;
  if (days == null) {
    return { done: false, label: 'Set up billing', href };
  }
  if (days <= 0) {
    return {
      done: false,
      label: `Subscribe to keep using ${programName}`,
      hint: 'Your 14-day evaluation period has ended.',
      href,
      tone: 'danger',
    };
  }
  const date = data.trialEndsAt ? formatTrialDate(data.trialEndsAt) : '';
  return {
    done: false,
    label: date ? `Subscribe by ${date}` : 'Subscribe before your evaluation ends',
    hint: `${days} day${days === 1 ? '' : 's'} left in your evaluation period.`,
    href,
    tone: days <= 3 ? 'danger' : days <= 7 ? 'warning' : 'default',
  };
}

function formatTrialDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

function BrandStep({ done, label, hint, href, tone = 'default' }: OnboardingStep) {
  const palette = stepPalette(done, tone);
  const inner = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: theme.radiusSm,
      }}
    >
      <div style={{ color: palette.icon, display: 'inline-flex' }}>
        {done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: theme.text, textDecoration: done ? 'line-through' : 'none' }}>
          {label}
        </div>
        {hint && !done && <div style={{ fontSize: 12, color: palette.hint, marginTop: 2 }}>{hint}</div>}
      </div>
      {!done && href && <ArrowRight size={14} style={{ color: theme.textDim }} />}
    </div>
  );
  if (done || !href) return inner;
  return <Link to={href} style={{ textDecoration: 'none' }}>{inner}</Link>;
}

function stepPalette(done: boolean, tone: StepTone) {
  if (done) {
    return { bg: theme.successSoft, border: alpha(theme.success, 0.267), icon: theme.success, hint: theme.textDim };
  }
  if (tone === 'danger') {
    return { bg: theme.dangerSoft, border: alpha(theme.danger, 0.4), icon: theme.danger, hint: theme.danger };
  }
  if (tone === 'warning') {
    return { bg: theme.warnSoft, border: alpha(theme.warn, 0.4), icon: theme.warn, hint: theme.warn };
  }
  return { bg: theme.surface2, border: theme.borderSubtle, icon: theme.textDim, hint: theme.textDim };
}
