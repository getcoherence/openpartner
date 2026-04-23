import { useQuery } from '@tanstack/react-query';

interface DashboardStats {
  partnerId: string;
  since: string;
  clicks: number;
  attributedEvents: number;
  attributedRevenue: number;
  commissionByStatus: Record<string, number>;
}

interface Link {
  id: string;
  linkKey: string;
  destinationUrl: string;
  campaignId: string;
  createdAt: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function Dashboard({ partnerId }: { partnerId: string }) {
  const stats = useQuery({
    queryKey: ['dashboard', partnerId],
    queryFn: () => fetchJson<DashboardStats>(`/api/partners/${partnerId}/dashboard`),
  });
  const links = useQuery({
    queryKey: ['links', partnerId],
    queryFn: () => fetchJson<{ links: Link[] }>(`/api/partners/${partnerId}/links`),
  });

  if (stats.isLoading || links.isLoading) return <p>Loading…</p>;
  if (stats.error) return <p style={{ color: 'crimson' }}>Error: {String(stats.error)}</p>;
  if (links.error) return <p style={{ color: 'crimson' }}>Error: {String(links.error)}</p>;

  const s = stats.data!;
  const l = links.data!.links;

  return (
    <div>
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 32 }}>
        <Stat label="Clicks (30d)" value={s.clicks} />
        <Stat label="Attributed events" value={s.attributedEvents} />
        <Stat label="Attributed revenue" value={`$${s.attributedRevenue.toFixed(2)}`} />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Commission by status</h2>
        {Object.keys(s.commissionByStatus).length === 0 ? (
          <p style={{ color: '#666' }}>No commissions yet.</p>
        ) : (
          <ul>
            {Object.entries(s.commissionByStatus).map(([status, amount]) => (
              <li key={status}>
                {status}: ${amount.toFixed(2)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Links</h2>
        {l.length === 0 ? (
          <p style={{ color: '#666' }}>No links yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                <th style={{ padding: '8px 4px' }}>Key</th>
                <th style={{ padding: '8px 4px' }}>Destination</th>
                <th style={{ padding: '8px 4px' }}>Campaign</th>
              </tr>
            </thead>
            <tbody>
              {l.map((link) => (
                <tr key={link.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '8px 4px' }}>
                    <code>/r/{link.linkKey}</code>
                  </td>
                  <td style={{ padding: '8px 4px' }}>{link.destinationUrl}</td>
                  <td style={{ padding: '8px 4px', color: '#666' }}>{link.campaignId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ padding: 16, border: '1px solid #e5e5e5', borderRadius: 8 }}>
      <div style={{ fontSize: 13, color: '#666' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );
}
