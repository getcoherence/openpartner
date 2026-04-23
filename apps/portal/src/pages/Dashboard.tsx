import { useQuery } from '@tanstack/react-query';
import { MousePointerClick, Receipt, Wallet, Users } from 'lucide-react';
import { api, type Principal } from '../api.js';
import { theme } from '../theme.js';
import { Avatar, Card, EmptyState, ErrorBanner, Page, SectionHeading, Stat, StatusPill, money } from '../ui.js';

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
  return <PartnerDashboard partnerId={principal.partnerId!} name={principal.partner?.name ?? ''} />;
}

function PartnerDashboard({ partnerId, name }: { partnerId: string; name: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['dashboard', partnerId],
    queryFn: () => api<PartnerDashboard>(`/partners/${partnerId}/dashboard`),
  });

  return (
    <Page
      title={`Hi ${name.split(' ')[0] || 'there'}`}
      subtitle="Last 30 days"
    >
      <ErrorBanner error={error} />
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
