import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
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
} from 'lucide-react';
import { api, type Principal } from '../api.js';
import { theme } from '../theme.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Page, SectionHeading, Stat, StatusPill, money } from '../ui.js';

// ---------- Partner ----------

interface PartnerDashboard {
  partnerId: string;
  since: string;
  clicks: number;
  attributedEvents: number;
  attributedRevenue: number;
  commissionByStatus: Record<string, number>;
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
  const links = useQuery({
    queryKey: ['links', partnerId],
    queryFn: () => api<{ links: unknown[] }>(`/partners/${partnerId}/links`),
  });

  const linkCount = links.data?.links.length ?? 0;
  const hasLink = linkCount > 0;
  const hasActiveConnect = !!connect.data?.connected && !!connect.data?.payoutsEnabled;

  const owedAmount = (data?.commissionByStatus.approved ?? 0) + (data?.commissionByStatus.accrued ?? 0);
  const needsConnect =
    !!data &&
    owedAmount > 0 &&
    connect.data != null &&
    (!connect.data.connected || !connect.data.payoutsEnabled);

  // Getting-started card shows while EITHER onboarding task is outstanding.
  // We only render it once we know the state of both (connect + links),
  // otherwise the card can flash during initial load.
  const showGettingStarted =
    !links.isLoading && !connect.isLoading && (!hasLink || !hasActiveConnect);

  return (
    <Page
      title={`Hi ${name.split(' ')[0] || 'there'}`}
      subtitle="Last 30 days"
    >
      <ErrorBanner error={error} />
      {showGettingStarted && (
        <GettingStarted hasLink={hasLink} connectReady={hasActiveConnect} />
      )}
      {needsConnect && !showGettingStarted && (
        <ConnectNudge owed={owedAmount} connected={connect.data!.connected} />
      )}
      {isLoading || !data ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            <Stat label="Clicks" value={data.clicks} icon={<MousePointerClick size={16} />} />
            <Stat label="Attributed events" value={data.attributedEvents} icon={<Receipt size={16} />} />
            <Stat label="Attributed revenue" value={money(data.attributedRevenue)} icon={<Wallet size={16} />} />
            <Stat label="Earned (paid)" value={money(data.commissionByStatus.paid ?? 0)} icon={<Wallet size={16} />} />
          </div>

          {funnel.data && <FunnelChart funnel={funnel.data} />}

          <SectionHeading>Commissions</SectionHeading>
          <Card>
            {Object.keys(data.commissionByStatus).length === 0 ? (
              <div style={{ color: theme.textMuted, fontSize: 14 }}>
                You'll see commission activity here once events start attributing.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(['accrued', 'approved', 'paid', 'reversed'] as const).map((status) => {
                  const amount = data.commissionByStatus[status] ?? 0;
                  if (amount === 0) return null;
                  return (
                    <div key={status} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <StatusPill status={status} />
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 15, fontWeight: 500 }}>
                        {money(amount)}
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

function GettingStarted({ hasLink, connectReady }: { hasLink: boolean; connectReady: boolean }) {
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
        <ChecklistRow
          done={connectReady}
          icon={<CreditCard size={16} />}
          title="Connect Stripe to get paid"
          hint="Commissions you earn land directly in your Stripe balance."
          cta={connectReady ? 'Manage' : 'Connect Stripe'}
          to="/connect"
        />
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
        border: `1px solid ${done ? `${theme.success}44` : theme.borderSubtle}`,
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
        <Link to={to} style={{ textDecoration: 'none' }}>
          <Button size="sm">{cta}</Button>
        </Link>
      )}
    </div>
  );
}

function ConnectNudge({ owed, connected }: { owed: number; connected: boolean }) {
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
            You have {money(owed)} in commissions {connected ? 'waiting — complete onboarding to get paid.' : 'that can’t be paid out yet.'}
          </div>
        </div>
        <Link to="/connect" style={{ textDecoration: 'none' }}>
          <Button icon={<CreditCard size={14} />}>{connected ? 'Finish onboarding' : 'Connect Stripe'}</Button>
        </Link>
      </div>
    </Card>
  );
}

function FunnelChart({ funnel }: { funnel: Funnel }) {
  const stages = [
    { key: 'clicks', label: 'Clicks', value: funnel.stages.clicks, icon: <MousePointerClick size={14} />, rate: null },
    { key: 'identities', label: 'Stitched', value: funnel.stages.identities, icon: <UserCheck size={14} />, rate: funnel.rates.stitchRate },
    { key: 'signups', label: 'Signups', value: funnel.stages.signups, icon: <Receipt size={14} />, rate: funnel.rates.signupRate },
    { key: 'paid', label: 'Paid', value: funnel.stages.paid, icon: <CreditCard size={14} />, rate: funnel.rates.paidRate },
  ];
  const max = Math.max(1, ...stages.map((s) => s.value));
  const pct = (n: number | null | undefined) => (n == null ? '' : `${Math.round(n * 100)}%`);

  return (
    <>
      <SectionHeading>Funnel</SectionHeading>
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {stages.map((s, i) => {
            const width = `${Math.max(6, (s.value / max) * 100)}%`;
            return (
              <div key={s.key} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 140px', gap: 12, alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: theme.textMuted }}>
                  <span style={{ color: theme.accent, display: 'inline-flex' }}>{s.icon}</span>
                  {s.label}
                </div>
                <div style={{ background: theme.bg, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, height: 28, position: 'relative', overflow: 'hidden' }}>
                  <div
                    style={{
                      width,
                      height: '100%',
                      background: `linear-gradient(90deg, ${theme.accent}, ${theme.accentHover})`,
                      opacity: 0.85,
                    }}
                  />
                  <div style={{ position: 'absolute', left: 12, top: 0, bottom: 0, display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 600, color: theme.accentInk, mixBlendMode: 'multiply' }}>
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
          <span style={{ fontSize: 14, fontWeight: 600, color: theme.accent, fontVariantNumeric: 'tabular-nums' }}>
            {pct(funnel.rates.overall)}
          </span>
        </div>
      </Card>
    </>
  );
}

// ---------- Admin ----------

interface AdminOverview {
  since: string;
  totals: {
    partners: number;
    clicks: number;
    attributedRevenue: number;
    attributedEvents: number;
    commissionAccrued: number;
    commissionApproved: number;
    commissionPaid: number;
  };
  partners: Array<{
    id: string;
    name: string;
    email: string;
    stripeConnected: boolean;
    clicks: number;
    revenue: number;
    events: number;
    commission: Record<string, number>;
  }>;
}

function AdminDashboard() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api<AdminOverview>('/admin/overview'),
  });

  return (
    <Page title="Partner Program" subtitle="Overview of every partner driving attributed revenue.">
      <ErrorBanner error={error} />
      {isLoading || !data ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            <Stat label="Partners" value={data.totals.partners} icon={<Users size={16} />} />
            <Stat label="Clicks (30d)" value={data.totals.clicks} icon={<MousePointerClick size={16} />} />
            <Stat label="Attributed revenue" value={money(data.totals.attributedRevenue)} icon={<Wallet size={16} />} />
            <Stat
              label="Awaiting approval"
              value={money(data.totals.commissionAccrued)}
              hint={`${money(data.totals.commissionApproved)} approved, ${money(data.totals.commissionPaid)} paid`}
              icon={<Receipt size={16} />}
            />
          </div>

          <SectionHeading>Partners</SectionHeading>
          {data.partners.length === 0 ? (
            <EmptyState
              title="No partners yet"
              hint="Create one from Admin → Partners to get started."
              icon={<Users size={28} strokeWidth={1.25} />}
            />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
              {data.partners.map((p) => (
                <PartnerCard key={p.id} partner={p} />
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  );
}

function PartnerCard({
  partner,
}: {
  partner: AdminOverview['partners'][number];
}) {
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
        <MiniStat label="Revenue" value={money(partner.revenue)} />
        <MiniStat
          label="Payouts"
          value={money((partner.commission.paid ?? 0) + (partner.commission.approved ?? 0))}
        />
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
