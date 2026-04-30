import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, ApiError } from '../api.js';
import { theme } from '../theme.js';
import { TenantLink } from '../tenant-link.js';
import { Button, Card, ErrorBanner, Input, Label, Page } from '../ui.js';

interface Partner {
  id: string;
  name: string;
}

interface CouponRow {
  id: string;
  code: string;
  campaignId: string;
  createdAt: string;
  redemptions90d?: number;
  revenue90d?: number;
}

interface CampaignBrief {
  id: string;
  name: string;
}

export function AdminPartnerCoupons() {
  const { id } = useParams<{ id: string }>();
  const partnerId = id ?? '';
  const qc = useQueryClient();

  const partner = useQuery({
    queryKey: ['partner', partnerId],
    queryFn: () => api<Partner>(`/partners/${partnerId}`),
    enabled: !!partnerId,
  });

  const coupons = useQuery({
    queryKey: ['partner-coupons', partnerId],
    queryFn: () => api<{ coupons: CouponRow[] }>(`/partners/${partnerId}/coupons`),
    enabled: !!partnerId,
  });
  const campaigns = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<{ campaigns: CampaignBrief[] }>('/campaigns'),
  });

  const [pickedCampaign, setPickedCampaign] = useState('');
  const [customCode, setCustomCode] = useState('');

  const mint = useMutation({
    mutationFn: () =>
      api(`/partners/${partnerId}/coupons`, {
        method: 'POST',
        body: { campaignId: pickedCampaign, code: customCode.trim() ? customCode.trim().toUpperCase() : undefined },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['partner-coupons', partnerId] });
      setCustomCode('');
      setPickedCampaign('');
    },
  });

  const gateError = mint.error instanceof ApiError && mint.error.message === 'verification_required'
    ? (mint.error.detail as { detail?: string; threshold?: number; existing?: number } | undefined)
    : null;

  const existingCampaignIds = new Set((coupons.data?.coupons ?? []).map((c) => c.campaignId));
  const availableCampaigns = (campaigns.data?.campaigns ?? []).filter((c) => !existingCampaignIds.has(c.id));
  const campaignNameById = new Map((campaigns.data?.campaigns ?? []).map((c) => [c.id, c.name]));
  const partnerName = partner.data?.name ?? '…';

  return (
    <Page
      title={`Coupons · ${partnerName}`}
      subtitle="Coupons attribute conversions when customers enter a code at checkout instead of clicking a share link. Your site calls POST /coupons/redeem with the code; same downstream commission flow as click-driven attribution."
    >
      <div style={{ marginBottom: 14 }}>
        <TenantLink to="/admin/partners" style={{ color: theme.textMuted, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={14} /> Back to Partners
        </TenantLink>
      </div>
      <ErrorBanner error={partner.error ?? coupons.error ?? (gateError ? null : mint.error)} />
      {gateError && (
        <div style={{ background: `${theme.danger}10`, border: `1px solid ${theme.danger}55`, borderRadius: theme.radiusSm, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: theme.danger, fontWeight: 500, marginBottom: 6 }}>
            Verify your coupon integration before minting more
          </div>
          <div style={{ fontSize: 12, color: theme.text, lineHeight: 1.5 }}>
            {gateError.detail}
          </div>
        </div>
      )}
      <Card>
        {coupons.isLoading ? (
          <p style={{ color: theme.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <>
            {(coupons.data?.coupons ?? []).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                {(coupons.data?.coupons ?? []).map((c) => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: theme.surface2, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm }}>
                    <code style={{ fontSize: 14, fontWeight: 500, color: theme.text, flex: 1 }}>{c.code}</code>
                    <span style={{ color: theme.textMuted, fontSize: 12 }}>
                      {campaignNameById.get(c.campaignId) ?? c.campaignId}
                    </span>
                    <span style={{ color: theme.textMuted, fontSize: 11, whiteSpace: 'nowrap' }}>
                      {(c.redemptions90d ?? 0) > 0
                        ? `${c.redemptions90d} redemption${c.redemptions90d === 1 ? '' : 's'} (90d)`
                        : 'unused (90d)'}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {availableCampaigns.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                <div>
                  <Label>Campaign</Label>
                  <select
                    value={pickedCampaign}
                    onChange={(e) => setPickedCampaign(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', background: theme.surface2, border: `1px solid ${theme.border}`, borderRadius: theme.radiusSm, color: theme.text, fontSize: 13 }}
                  >
                    <option value="">— pick a campaign —</option>
                    {availableCampaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <Label>Code (optional)</Label>
                  <Input
                    value={customCode}
                    onChange={(e) => setCustomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
                    placeholder="auto-generates if blank"
                    style={{ fontFamily: theme.fontMono }}
                  />
                </div>
                <Button onClick={() => mint.mutate()} disabled={!pickedCampaign || mint.isPending}>
                  {mint.isPending ? 'Minting…' : 'Mint coupon'}
                </Button>
              </div>
            ) : (
              <p style={{ color: theme.textMuted, fontSize: 13, margin: 0 }}>
                {(coupons.data?.coupons ?? []).length === 0
                  ? 'No campaigns available. Create one in Campaigns first.'
                  : 'This partner has a coupon for every campaign already.'}
              </p>
            )}
          </>
        )}
      </Card>
    </Page>
  );
}
