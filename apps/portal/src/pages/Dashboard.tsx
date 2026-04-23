import { useQuery } from '@tanstack/react-query';
import { api, type Principal } from '../api.js';
import { Card, ErrorBanner, Page, Stat, money } from '../ui.js';

interface DashboardStats {
  partnerId: string;
  since: string;
  clicks: number;
  attributedEvents: number;
  attributedRevenue: number;
  commissionByStatus: Record<string, number>;
}

export function Dashboard({ principal }: { principal: Principal }) {
  if (principal.role === 'admin') return <AdminDashboard />;
  return <PartnerDashboard partnerId={principal.partnerId!} />;
}

function PartnerDashboard({ partnerId }: { partnerId: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['dashboard', partnerId],
    queryFn: () => api<DashboardStats>(`/partners/${partnerId}/dashboard`),
  });

  return (
    <Page title="Dashboard">
      <ErrorBanner error={error} />
      {isLoading || !data ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
            <Stat label="Clicks (30d)" value={data.clicks} />
            <Stat label="Attributed events" value={data.attributedEvents} />
            <Stat label="Attributed revenue" value={money(data.attributedRevenue)} />
          </div>
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Commission by status (30d)</div>
            {Object.keys(data.commissionByStatus).length === 0 ? (
              <div style={{ color: '#888' }}>No commissions yet.</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {Object.entries(data.commissionByStatus).map(([status, amount]) => (
                  <li key={status}>
                    <strong>{status}:</strong> {money(amount)}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </Page>
  );
}

interface AdminSummary {
  totalPartners: number;
  totalClicks30d: number;
  pendingCommissions: number;
  approvedCommissions: number;
}

function AdminDashboard() {
  const partners = useQuery({ queryKey: ['admin', 'partners'], queryFn: () => api<{ partners: unknown[] }>('/partners') });
  const commissions = useQuery({
    queryKey: ['admin', 'commissions'],
    queryFn: () => api<{ commissions: Array<{ status: string; amount: string }> }>('/commissions?limit=500'),
  });

  const summary: AdminSummary = {
    totalPartners: partners.data?.partners.length ?? 0,
    totalClicks30d: 0,
    pendingCommissions: commissions.data?.commissions.filter((c) => c.status === 'accrued').length ?? 0,
    approvedCommissions: commissions.data?.commissions.filter((c) => c.status === 'approved').length ?? 0,
  };

  return (
    <Page title="Admin dashboard">
      <ErrorBanner error={commissions.error ?? partners.error} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        <Stat label="Partners" value={summary.totalPartners} />
        <Stat label="Awaiting review" value={summary.pendingCommissions} />
        <Stat label="Approved, unpaid" value={summary.approvedCommissions} />
        <Stat label="Commissions tracked" value={commissions.data?.commissions.length ?? 0} />
      </div>
      <Card>
        <div style={{ fontSize: 13, color: '#666' }}>
          Use the admin nav to manage partners, campaigns, approve commissions, and export data.
        </div>
      </Card>
    </Page>
  );
}
