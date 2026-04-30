import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../api.js';
import { theme } from '../theme.js';
import { TenantLink } from '../tenant-link.js';
import { Card, ErrorBanner, Page } from '../ui.js';

interface Partner {
  id: string;
  name: string;
}

interface CampaignGrant {
  id: string;
  name: string;
  destinationUrl: string;
  granted: boolean;
  grantSource: 'admin' | 'offering' | null;
}

export function AdminPartnerPrograms() {
  const { id } = useParams<{ id: string }>();
  const partnerId = id ?? '';
  const qc = useQueryClient();

  const partner = useQuery({
    queryKey: ['partner', partnerId],
    queryFn: () => api<Partner>(`/partners/${partnerId}`),
    enabled: !!partnerId,
  });

  const grants = useQuery({
    queryKey: ['partner-campaigns', partnerId],
    queryFn: () => api<{ campaigns: CampaignGrant[] }>(`/partners/${partnerId}/campaigns`),
    enabled: !!partnerId,
  });

  const add = useMutation({
    mutationFn: (campaignId: string) =>
      api(`/partners/${partnerId}/campaigns`, { method: 'POST', body: { campaignIds: [campaignId] } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner-campaigns', partnerId] }),
  });
  const remove = useMutation({
    mutationFn: (campaignId: string) =>
      api(`/partners/${partnerId}/campaigns/${campaignId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner-campaigns', partnerId] }),
  });

  const busyId = add.isPending ? add.variables : remove.isPending ? remove.variables : null;
  const partnerName = partner.data?.name ?? '…';

  return (
    <Page
      title={`Programs · ${partnerName}`}
      subtitle="Toggle which programs this partner can create share-links for. Revoking a program doesn't remove existing links — those keep working until the partner deletes them."
    >
      <div style={{ marginBottom: 14 }}>
        <TenantLink to="/admin/partners" style={{ color: theme.textMuted, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={14} /> Back to Partners
        </TenantLink>
      </div>
      <ErrorBanner error={partner.error ?? grants.error ?? add.error ?? remove.error} />
      <Card>
        {grants.isLoading ? (
          <div style={{ color: theme.textMuted }}>Loading…</div>
        ) : !grants.data || grants.data.campaigns.length === 0 ? (
          <div style={{ color: theme.textMuted }}>No campaigns exist yet — create one in Campaigns.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {grants.data.campaigns.map((c) => {
              const busy = busyId === c.id;
              return (
                <label
                  key={c.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    background: c.granted ? `${theme.success}10` : theme.surface2,
                    border: `1px solid ${c.granted ? `${theme.success}44` : theme.borderSubtle}`,
                    borderRadius: theme.radiusSm,
                    cursor: busy ? 'wait' : 'pointer',
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={c.granted}
                    disabled={busy}
                    onChange={(e) => (e.target.checked ? add.mutate(c.id) : remove.mutate(c.id))}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: theme.textMuted, fontFamily: theme.fontMono }}>{c.destinationUrl}</div>
                  </div>
                  {c.grantSource === 'offering' && (
                    <span style={{ fontSize: 11, color: theme.accent, padding: '3px 8px', background: `${theme.accent}15`, borderRadius: 12 }}>
                      via Network
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </Card>
    </Page>
  );
}
