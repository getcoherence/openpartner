import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CreditCard, CheckCircle2, Landmark, XCircle } from 'lucide-react';
import { api, ApiError, type Principal } from '../api.js';
import { theme } from '../theme.js';
import { TenantLink } from '../tenant-link.js';
import { useBrand, useConnectPayouts } from '../lib/useBrand.js';
import { countryOptions } from '../lib/CountryField.js';
import { Button, Card, EmptyState, ErrorBanner, Label, Page, Select } from '../ui.js';

interface ConnectStatus {
  connected: boolean;
  accountMode?: 'standard' | 'custom_payouts';
  activityDescriptionPrefilled?: boolean;
  accountId?: string;
  accountType?: 'standard' | 'custom' | 'express';
  transfersEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
}

export function ConnectPage({ principal }: { principal: Principal }) {
  const partnerId = principal.role === 'partner' ? principal.partnerId : null;
  const { programName } = useBrand();
  const connectPayouts = useConnectPayouts();
  const [country, setCountry] = useState('');
  const countries = useMemo(() => countryOptions(), []);

  const status = useQuery({
    queryKey: ['connect-status', partnerId],
    queryFn: () => api<ConnectStatus>(`/partners/${partnerId}/connect/status`),
    retry: false,
    enabled: !!partnerId && connectPayouts,
  });

  const linkUrls = {
    returnUrl: `${window.location.origin}/connect?done=1`,
    refreshUrl: `${window.location.origin}/connect`,
  };
  const start = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/partners/${partnerId}/connect/start`, {
        method: 'POST',
        body: { ...linkUrls, ...(country ? { country } : {}) },
      }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });
  // Custom accounts have no Stripe dashboard: Stripe's update flow is the
  // only place their partners can change bank or personal details.
  const update = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/partners/${partnerId}/connect/update`, { method: 'POST', body: linkUrls }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  if (!partnerId) {
    return (
      <Page title="Stripe Connect">
        <EmptyState title="Partners only" hint="Stripe Connect onboarding is a partner-side flow." icon={<CreditCard size={28} strokeWidth={1.25} />} />
      </Page>
    );
  }

  // The nav hides this page when the brand can't pay through Connect; a
  // bookmark still lands here, so say where payouts go instead of
  // offering an account that would never be paid.
  if (!connectPayouts) {
    return (
      <Page title="Stripe Connect">
        <Card>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>
            {programName} doesn’t pay through Stripe Connect
          </div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 16, maxWidth: 560 }}>
            Add your PayPal or bank details on the Payout details page so {programName} knows where to send your
            payouts.
          </div>
          <TenantLink to="/payout-details" style={{ textDecoration: 'none' }}>
            <Button icon={<Landmark size={14} />}>Go to Payout details</Button>
          </TenantLink>
        </Card>
      </Page>
    );
  }

  const s = status.data;
  const custom = s?.connected ? s.accountType === 'custom' : s?.accountMode === 'custom_payouts';

  return (
    <Page
      title="Stripe Connect"
      subtitle={custom
        ? 'Set up your payout details to receive affiliate commissions.'
        : 'Receive payouts straight into your own Stripe account.'}
    >
      <ErrorBanner
        error={
          status.error ??
          (rejectedByStripe(start.error)
            ? `Stripe can't set up payouts for the country you chose. Check it's where you're based, or contact ${programName}.`
            : start.error) ??
          update.error
        }
      />
      {status.isLoading ? (
        <Card>Loading…</Card>
      ) : !s?.connected && custom ? (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>Set up affiliate payouts</div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 16, maxWidth: 560 }}>
            Stripe will collect the details required to set up your affiliate payouts.{' '}
            {s?.activityDescriptionPrefilled && 'Your affiliate activity description is already filled in. '}
            Once you've finished, {programName} can send your approved commissions.
          </div>
          {/* Stripe fixes a Custom account's country when it's created. */}
          <div style={{ maxWidth: 320, marginBottom: 16 }}>
            <Label htmlFor="connect-country">Country you're based in</Label>
            <Select id="connect-country" autoComplete="country" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="" disabled>
                Select a country
              </option>
              {countries.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={() => start.mutate()} disabled={!country || start.isPending}>
            {start.isPending ? 'Preparing…' : 'Set up payouts'}
          </Button>
        </Card>
      ) : !s?.connected ? (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>Connect an account</div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 16, maxWidth: 560 }}>
            You'll be redirected to Stripe's hosted onboarding. Once you've finished,
            {' '}{programName} will transfer approved commissions directly to your balance.
          </div>
          <Button onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? 'Preparing…' : 'Connect Stripe'}
          </Button>
        </Card>
      ) : (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <CreditCard size={18} style={{ color: theme.accentText }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Connected</div>
              <code style={{ fontSize: 12, color: theme.textMuted }}>{s.accountId}</code>
            </div>
          </div>
          <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <ChecklistItem label="Details submitted" ok={!!s.detailsSubmitted} />
            <ChecklistItem label="Transfers enabled" ok={!!s.transfersEnabled} />
            <ChecklistItem label="Payouts enabled" ok={!!s.payoutsEnabled} />
          </div>
          {!s.payoutsEnabled || !s.transfersEnabled ? (
            <div style={{ marginTop: 16 }}>
              <Button onClick={() => start.mutate()} disabled={start.isPending}>
                {start.isPending ? 'Preparing…' : 'Finish onboarding'}
              </Button>
            </div>
          ) : custom && (
            <div style={{ marginTop: 16 }}>
              <Button variant="secondary" onClick={() => update.mutate()} disabled={update.isPending}>
                {update.isPending ? 'Preparing…' : 'Update payout details'}
              </Button>
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}

/** Stripe refused to create the account, e.g. for an unsupported country. */
function rejectedByStripe(error: unknown): boolean {
  return error instanceof ApiError && (error.detail as { error?: string } | undefined)?.error === 'stripe_account_rejected';
}

function ChecklistItem({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div
      style={{
        background: theme.bg,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
      }}
    >
      {ok ? <CheckCircle2 size={14} style={{ color: theme.success }} /> : <XCircle size={14} style={{ color: theme.textDim }} />}
      <span style={{ color: ok ? theme.text : theme.textMuted }}>{label}</span>
    </div>
  );
}
