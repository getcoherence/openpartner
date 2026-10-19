import { useState } from 'react';
import type { CustomerReward } from '@openpartner/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { api, ApiError } from '../api.js';
import { alpha, theme } from '../theme.js';
import { TenantLink } from '../tenant-link.js';
import { Button, Card, ErrorBanner, Input, Label, Page, money } from '../ui.js';

interface Partner {
  id: string;
  name: string;
}

interface CouponRow {
  id: string;
  canEdit?: boolean;
  stripePromotionCodeId?: string | null;
  code: string;
  programId: string;
  createdAt: string;
  redemptions90d?: number;
  revenue90d?: number;
  /** Null = active. Non-null = retired; the Stripe PromotionCode is
   *  disabled so customers entering this string at checkout get an
   *  invalid-code error. Historical attribution stays attached. */
  deactivatedAt?: string | null;
}

interface ProgramBrief {
  customerReward?: CustomerReward | null;
  partnersMayCustomizeCode?: boolean;
  id: string;
  name: string;
}

export function AdminPartnerCoupons({ ownPartnerId }: { ownPartnerId?: string } = {}) {
  const { id } = useParams<{ id: string }>();
  const partnerId = ownPartnerId ?? id ?? '';
  const selfService = !!ownPartnerId;
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
    queryKey: [selfService ? 'me-campaigns' : 'campaigns'],
    queryFn: () => api<{ programs: ProgramBrief[] }>(selfService ? '/me/programs' : '/programs'),
  });

  const [pickedProgram, setPickedProgram] = useState('');
  const [customCode, setCustomCode] = useState('');
  const selectedProgram = campaigns.data?.programs.find((program) => program.id === pickedProgram);

  const mint = useMutation({
    mutationFn: () =>
      api(`/partners/${partnerId}/coupons`, {
        method: 'POST',
        body: { programId: pickedProgram, code: customCode.trim() ? customCode.trim().toUpperCase() : undefined },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['partner-coupons', partnerId] });
      setCustomCode('');
      setPickedProgram('');
    },
  });

  const gateError = mint.error instanceof ApiError && mint.error.message === 'verification_required'
    ? (mint.error.detail as { detail?: string; threshold?: number; existing?: number } | undefined)
    : null;

  // Programs that still have an ACTIVE coupon — admin can re-mint
  // freely once an old code is deactivated (append-only model).
  const programsWithActiveCoupon = new Set(
    (coupons.data?.coupons ?? []).filter((c) => !c.deactivatedAt).map((c) => c.programId),
  );
  const availableCampaigns = (campaigns.data?.programs ?? []).filter(
    (c) => selfService
      ? c.partnersMayCustomizeCode && (coupons.data?.coupons ?? []).filter((coupon) => coupon.programId === c.id && !coupon.deactivatedAt).length < 5
      : !programsWithActiveCoupon.has(c.id),
  );

  const deactivate = useMutation({
    mutationFn: (couponId: string) =>
      api(`/partners/${partnerId}/coupons/${couponId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner-coupons', partnerId] }),
  });
  const campaignNameById = new Map((campaigns.data?.programs ?? []).map((c) => [c.id, c.name]));
  const partnerName = partner.data?.name ?? '…';

  return (
    <Page
      title={selfService ? 'Your coupon codes' : `Coupons · ${partnerName}`}
      subtitle={selfService
        ? 'Share your codes with your audience. Your brand sets the discount; you choose the code when customization is enabled. Existing codes remain active until you deactivate them.'
        : 'Coupons attribute conversions when customers enter a code at checkout instead of clicking a share link. Your site calls POST /coupons/redeem with the code; same downstream commission flow as click-driven attribution.'}
    >
      {!selfService && <div style={{ marginBottom: 14 }}>
        <TenantLink to="/admin/partners" style={{ color: theme.textMuted, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={14} /> Back to Partners
        </TenantLink>
      </div>}
      <ErrorBanner error={partner.error ?? campaigns.error ?? coupons.error ?? deactivate.error ?? (gateError ? null : mint.error)} />
      {gateError && (
        <div style={{ background: alpha(theme.danger, 0.063), border: `1px solid ${alpha(theme.danger, 0.333)}`, borderRadius: theme.radiusSm, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: theme.danger, fontWeight: 500, marginBottom: 6 }}>
            Verify your coupon integration before minting more
          </div>
          <div style={{ fontSize: 12, color: theme.text, lineHeight: 1.5 }}>
            {gateError.detail}
          </div>
        </div>
      )}
      <Card>
        {selfService && (
          <p style={{ color: theme.textMuted, fontSize: 13 }}>Your brand controls discount terms. Existing codes may retain earlier terms when a program changes. Discount duration does not indicate a code's expiry or redemption limit.</p>
        )}
        {coupons.isLoading ? (
          <p style={{ color: theme.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <>
            {(coupons.data?.coupons ?? []).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                {(coupons.data?.coupons ?? []).map((c) => {
                  const isDeactivated = !!c.deactivatedAt;
                  return (
                    <div
                      key={c.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                        background: theme.surface2,
                        border: `1px solid ${theme.borderSubtle}`,
                        borderRadius: theme.radiusSm,
                        opacity: isDeactivated ? 0.55 : 1,
                      }}
                    >
                      <code style={{ fontSize: 14, fontWeight: 500, color: theme.text, flex: 1, textDecoration: isDeactivated ? 'line-through' : 'none' }}>
                        {c.code}
                      </code>
                      <div style={{ color: theme.textMuted, fontSize: 12 }}>
                        <div>{campaignNameById.get(c.programId) ?? c.programId}</div>
                        <div>Current program discount: {customerDiscount(campaigns.data?.programs.find((program) => program.id === c.programId)?.customerReward)}</div>
                        {/* Only say something when it's true and useful: hosted
                            brands' rewards never live in our Stripe, and a
                            program without a reward has nothing to create. */}
                        {c.deactivatedAt ? (
                          <div>Code deactivated</div>
                        ) : c.stripePromotionCodeId ? (
                          <div>Discount applies automatically at checkout</div>
                        ) : null}
                      </div>
                      <span style={{ color: theme.textMuted, fontSize: 11, whiteSpace: 'nowrap' }}>
                        {(c.redemptions90d ?? 0) > 0
                          ? `${c.redemptions90d} redemption${c.redemptions90d === 1 ? '' : 's'} (90d)`
                          : 'unused (90d)'}
                      </span>
                      {isDeactivated ? (
                        <span style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                          Deactivated
                        </span>
                      ) : (!selfService || c.canEdit) ? (
                        <button
                          onClick={() => deactivate.mutate(c.id)}
                          disabled={deactivate.isPending}
                          style={{
                            background: 'transparent',
                            border: `1px solid ${theme.borderSubtle}`,
                            borderRadius: 6,
                            padding: '4px 8px',
                            fontSize: 11,
                            color: theme.textMuted,
                            cursor: 'pointer',
                          }}
                        >
                          Deactivate
                        </button>
                      ) : <span style={{ fontSize: 12, color: theme.textMuted }}>Managed by brand</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {availableCampaigns.length > 0 ? (
              <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                <div>
                  <Label>Program</Label>
                  <select
                    value={pickedProgram}
                    onChange={(e) => setPickedProgram(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', background: theme.surface2, border: `1px solid ${theme.border}`, borderRadius: theme.radiusSm, color: theme.text, fontSize: 13 }}
                  >
                    <option value="">— pick a campaign —</option>
                    {availableCampaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {selectedProgram && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>Customer discount: {customerDiscount(selectedProgram.customerReward)}</div>}
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
                <Button onClick={() => mint.mutate()} disabled={!pickedProgram || mint.isPending}>
                  {mint.isPending ? 'Minting…' : 'Mint coupon'}
                </Button>
              </div>
            ) : (
              <p style={{ color: theme.textMuted, fontSize: 13, margin: 0 }}>
                {(coupons.data?.coupons ?? []).length === 0
                  ? (selfService ? 'No programs available for customization. Ask your brand admin to enable coupon customization for your program.' : 'No campaigns available. Create one in Campaigns first.')
                  : (selfService ? 'No additional codes available. Your brand controls customization; each program allows up to five active codes.' : 'This partner has a coupon for every campaign already.')}
              </p>
            )}
          </>
        )}
      </Card>
    </Page>
  );
}

function customerDiscount(reward: CustomerReward | null | undefined): string {
  if (reward === undefined) return 'Discount details unavailable';
  if (!reward) return 'No customer discount configured';
  if (reward.type === 'free_months') return `${reward.value} ${reward.value === 1 ? 'month' : 'months'} free`;
  const amount = reward.type === 'percent_off'
    ? `${reward.value}% off`
    : reward.currency ? `${money(reward.value, reward.currency.toUpperCase())} off` : 'Fixed discount (currency not configured)';
  const duration = reward.duration === 'once' ? 'first payment only'
    : reward.duration === 'forever' ? 'every eligible payment'
    : `for ${reward.durationInMonths} months`;
  return `${amount}, ${duration}`;
}
