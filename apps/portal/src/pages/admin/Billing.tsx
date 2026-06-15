import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, ExternalLink } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Page } from '../../ui.js';

type Plan = 'flex' | 'revshare' | 'enterprise';
type Mode = 'selfhost' | 'flat' | 'revshare';

interface BillingStatus {
  mode: Mode;
  plan: Plan | null;
  // Flat / hosted-with-sub:
  subscribed?: boolean;
  subscriptionId?: string;
  status?: string;
  currentPeriodEnd?: number;
  trialEnd?: number | null;
  trialEndsAt?: string | null;
  inTrial?: boolean;
  hasUsedTrial?: boolean;
  trialExpiredWithoutSubscription?: boolean;
  // Revshare:
  feeRate?: string;
  accruedPlatformFees?: Record<string, number>;
  // Selfhost:
  billed?: boolean;
  // Enterprise:
  enterprise?: boolean;
  message?: string;
}

interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: number;
  periodStart: number;
  periodEnd: number;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

const PLAN_LABELS: Record<Plan, { name: string; tagline: string }> = {
  flex: { name: 'Flex', tagline: '$49/mo + 1.5% of attributed GMV' },
  revshare: { name: 'Revshare', tagline: '3% of attributed GMV, no monthly fee' },
  enterprise: { name: 'Enterprise', tagline: 'Custom pricing — billed out of band' },
};

export function AdminBilling() {
  const status = useQuery({
    queryKey: ['billing-status'],
    queryFn: () => api<BillingStatus>('/billing/status'),
  });
  const invoices = useQuery({
    queryKey: ['billing-invoices'],
    queryFn: () => api<{ invoices: Invoice[] }>('/billing/invoices'),
    enabled: status.data?.mode !== 'selfhost',
  });

  return (
    <Page
      title="Billing"
      subtitle="Manage your subscription, payment method, and invoices."
    >
      <ErrorBanner error={status.error ?? invoices.error} />
      {status.isLoading ? (
        <Card>Loading…</Card>
      ) : status.data ? (
        <>
          <PlanCard status={status.data} />
          <div style={{ height: 16 }} />
          {(invoices.data?.invoices ?? []).length > 0 && (
            <InvoicesCard invoices={invoices.data?.invoices ?? []} />
          )}
        </>
      ) : null}
    </Page>
  );
}

function PlanCard({ status }: { status: BillingStatus }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const startCheckout = useMutation({
    mutationFn: () =>
      api<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: {
          successUrl: `${window.location.origin}${window.location.pathname}?checkout=success`,
          cancelUrl: window.location.href,
        },
      }),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  });

  // Pick a plan inline (legacy tenants + anyone signed up before the
  // marketing pricing CTAs were live). Stamps Tenant.billingPlan, then
  // chains immediately into Checkout so it's a single click from the
  // user's perspective.
  const pickPlan = useMutation({
    mutationFn: (plan: Plan) =>
      api<{ ok: boolean; plan: Plan }>('/billing/plan', { method: 'POST', body: { plan } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['billing-status'] });
      // Auto-trigger Checkout once the plan stuck.
      startCheckout.mutate();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  });

  const openPortal = useMutation({
    mutationFn: () =>
      api<{ url: string }>('/billing/portal', {
        method: 'POST',
        body: { returnUrl: window.location.href },
      }),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  });

  // Selfhost: no billing layer.
  if (status.mode === 'selfhost') {
    return (
      <Card>
        <SectionHeader icon={<CreditCard size={18} />} title="Self-hosted" />
        <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>
          You're running the open-source self-hosted build. No platform billing.
        </p>
      </Card>
    );
  }

  // Enterprise: handled out of band.
  if (status.plan === 'enterprise') {
    return (
      <Card>
        <SectionHeader icon={<CreditCard size={18} />} title="Enterprise" />
        <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>
          {status.message ?? 'Billed out of band — contact your account manager.'}
        </p>
      </Card>
    );
  }

  const plan = status.plan;
  const planMeta = plan ? PLAN_LABELS[plan] : null;
  const subscribed = !!status.subscribed;
  const trialEndsAtMs = status.trialEnd
    ? status.trialEnd * 1000
    : status.trialEndsAt
      ? Date.parse(status.trialEndsAt)
      : null;
  const daysLeftInTrial =
    trialEndsAtMs && trialEndsAtMs > Date.now()
      ? Math.ceil((trialEndsAtMs - Date.now()) / (24 * 60 * 60 * 1000))
      : null;

  return (
    <Card>
      <SectionHeader
        icon={<CreditCard size={18} />}
        title={planMeta ? `${planMeta.name} plan` : 'Billing not set up'}
      />
      {planMeta && (
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px' }}>
          {planMeta.tagline}
        </p>
      )}

      {!plan && (
        <>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px' }}>
            Pick a tier to start your 14-day free trial. No card required up front.
          </p>
          <PlanPicker
            disabled={pickPlan.isPending || startCheckout.isPending}
            onPick={(picked) => pickPlan.mutate(picked)}
          />
          {(pickPlan.isPending || startCheckout.isPending) && (
            <p style={{ fontSize: 12, color: theme.textMuted, marginTop: 8 }}>
              {pickPlan.isPending ? 'Saving plan…' : 'Opening Stripe Checkout…'}
            </p>
          )}
        </>
      )}

      {error && <ErrorBanner error={error} />}

      {plan && !subscribed && (
        <div>
          {status.trialExpiredWithoutSubscription ? (
            <>
              <div
                style={{
                  background: `${theme.danger}10`,
                  border: `1px solid ${theme.danger}55`,
                  borderRadius: theme.radiusSm,
                  padding: 12,
                  marginBottom: 14,
                  fontSize: 13,
                  color: theme.text,
                }}
              >
                <strong style={{ color: theme.danger }}>Trial expired.</strong> Your 14-day free trial
                has ended without a payment method. New programs, partners, coupons, and offerings
                are paused until you re-subscribe — but click ingestion + attribution still run, so
                no data is being lost.
              </div>
              <Button onClick={() => startCheckout.mutate()} disabled={startCheckout.isPending}>
                {startCheckout.isPending ? 'Opening Stripe…' : 'Re-subscribe (card required)'}
              </Button>
            </>
          ) : status.hasUsedTrial ? (
            <>
              <div
                style={{
                  background: `${theme.accent}10`,
                  border: `1px solid ${theme.accent}55`,
                  borderRadius: theme.radiusSm,
                  padding: 12,
                  marginBottom: 14,
                  fontSize: 13,
                  color: theme.text,
                }}
              >
                You've previously used your free trial. Re-subscribing requires a payment method up
                front — the trial doesn't reset.
              </div>
              <Button onClick={() => startCheckout.mutate()} disabled={startCheckout.isPending}>
                {startCheckout.isPending ? 'Opening Stripe…' : 'Subscribe (card required)'}
              </Button>
            </>
          ) : (
            <>
              <div
                style={{
                  background: `${theme.accent}10`,
                  border: `1px solid ${theme.accent}55`,
                  borderRadius: theme.radiusSm,
                  padding: 12,
                  marginBottom: 14,
                  fontSize: 13,
                  color: theme.text,
                }}
              >
                Your trial hasn't started yet. Activate it now — no card required for the first 14 days.
              </div>
              <Button onClick={() => startCheckout.mutate()} disabled={startCheckout.isPending}>
                {startCheckout.isPending ? 'Opening Stripe…' : 'Activate 14-day free trial'}
              </Button>
            </>
          )}
        </div>
      )}

      {plan && subscribed && (
        <div>
          {daysLeftInTrial !== null && (
            <div
              style={{
                background: `${theme.accent}10`,
                border: `1px solid ${theme.accent}55`,
                borderRadius: theme.radiusSm,
                padding: 12,
                marginBottom: 14,
                fontSize: 13,
                color: theme.text,
              }}
            >
              Trial active — <strong>{daysLeftInTrial} day{daysLeftInTrial === 1 ? '' : 's'}</strong> left.
              Stripe will email you ~3 days before it ends to add a payment method.
            </div>
          )}
          {status.status && status.status !== 'active' && status.status !== 'trialing' && (
            <div
              style={{
                background: `${theme.danger}10`,
                border: `1px solid ${theme.danger}55`,
                borderRadius: theme.radiusSm,
                padding: 12,
                marginBottom: 14,
                fontSize: 13,
                color: theme.danger,
              }}
            >
              Subscription status: <code>{status.status}</code>. Manage in the Stripe Portal to resolve.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button onClick={() => openPortal.mutate()} disabled={openPortal.isPending}>
              {openPortal.isPending ? 'Opening Stripe…' : 'Manage in Stripe Portal'}
            </Button>
            <span style={{ color: theme.textDim, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              <ExternalLink size={12} /> Switch plans, update card, view full invoice history
            </span>
          </div>
          {status.currentPeriodEnd && (
            <p style={{ marginTop: 10, fontSize: 12, color: theme.textDim }}>
              Current period ends {new Date(status.currentPeriodEnd * 1000).toLocaleDateString()}.
            </p>
          )}
          {status.feeRate && (
            <p style={{ marginTop: 6, fontSize: 12, color: theme.textDim }}>
              Metered fee: {status.feeRate} of attributed GMV.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function PlanPicker({ onPick, disabled }: { onPick: (plan: Plan) => void; disabled?: boolean }) {
  return (
    <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
      {(['flex', 'revshare'] as const).map((p) => (
        <button
          key={p}
          onClick={() => onPick(p)}
          disabled={disabled}
          style={{
            background: theme.surface2,
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: theme.radiusSm,
            padding: 14,
            textAlign: 'left',
            cursor: disabled ? 'wait' : 'pointer',
            opacity: disabled ? 0.6 : 1,
            color: theme.text,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>{PLAN_LABELS[p].name}</div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 4 }}>
            {PLAN_LABELS[p].tagline}
          </div>
        </button>
      ))}
    </div>
  );
}

function InvoicesCard({ invoices }: { invoices: Invoice[] }) {
  return (
    <Card>
      <SectionHeader title="Recent invoices" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {invoices.map((inv) => (
          <div
            key={inv.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 12px',
              background: theme.surface2,
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: theme.radiusSm,
            }}
          >
            <span style={{ fontSize: 13, fontFamily: theme.fontMono, color: theme.textMuted, flex: '0 0 auto' }}>
              {inv.number ?? inv.id.slice(0, 8)}
            </span>
            <span style={{ fontSize: 13, color: theme.textMuted }}>
              {new Date(inv.created * 1000).toLocaleDateString()}
            </span>
            <span style={{ flex: 1, fontSize: 13, color: theme.text }}>
              {formatMoney(inv.amountPaid > 0 ? inv.amountPaid : inv.amountDue, inv.currency)}
            </span>
            <span
              style={{
                fontSize: 11,
                color: inv.status === 'paid' ? theme.success : theme.textMuted,
                textTransform: 'uppercase',
                fontWeight: 600,
              }}
            >
              {inv.status ?? '—'}
            </span>
            {inv.hostedInvoiceUrl && (
              <a
                href={inv.hostedInvoiceUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 12, color: theme.accent }}
              >
                View
              </a>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function SectionHeader({ icon, title }: { icon?: React.ReactNode; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      {icon && <span style={{ color: theme.accent, display: 'flex' }}>{icon}</span>}
      <div style={{ fontSize: 15, fontWeight: 500 }}>{title}</div>
    </div>
  );
}

function formatMoney(cents: number, currency: string): string {
  const value = cents / 100;
  try {
    return value.toLocaleString(undefined, { style: 'currency', currency: currency.toUpperCase() });
  } catch {
    return `${value.toFixed(2)} ${currency.toUpperCase()}`;
  }
}
