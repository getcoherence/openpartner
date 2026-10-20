import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, CreditCard, ExternalLink, FileText } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { alpha, theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page } from '../../ui.js';

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
  /** How the platform fee is worked out (docs/platform-fee.md). */
  fee?: FeeDescription | null;
  /** How a new subscription is collected (docs/invoice-billing.md). */
  collection?: Collection;
  /** How the live subscription is collected. */
  subscriptionCollectionMethod?: CollectionMethod | null;
  /** Set while a pay-by-invoice subscription is past due. */
  invoiceOverdue?: { since: string; graceEndsAt: string; graceExpired: boolean; neverPaid: boolean } | null;
}

type CollectionMethod = 'send_invoice' | 'charge_automatically';

interface Collection {
  method: CollectionMethod;
  source: 'ops' | 'country' | 'default';
  daysUntilDue: number;
  country: string | null;
  gstin: string | null;
  gstinRequired: boolean;
}

interface FeeDescription {
  revenueRate: number;
  commissionRate: number;
  rule: 'old' | 'scheduled' | 'new';
  effectiveAt: string | null;
  contract: boolean;
  monthlyMinimumUsd: number | null;
}

interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  currency: string;
  created: number;
  /** Pay-by-invoice invoices only (unix seconds). */
  dueDate: number | null;
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
          {payingByInvoice(status.data) && (
            <OpenInvoicesCard invoices={invoices.data?.invoices ?? []} overdue={status.data.invoiceOverdue ?? null} />
          )}
          {/* Every Indian brand needs a GSTIN, by card or by invoice. The
              pay-by-invoice form asks for it itself before the plan starts. */}
          {status.data.collection?.gstinRequired &&
            !(status.data.plan && !status.data.subscribed && payingByInvoice(status.data)) && (
              <>
                <div style={{ height: 16 }} />
                <TaxDetailsCard gstin={status.data.collection.gstin} />
              </>
            )}
          {status.data.fee && (
            <>
              <div style={{ height: 16 }} />
              <FeeBasisCard fee={status.data.fee} />
            </>
          )}
          {status.data.mode !== 'selfhost' && (
            <>
              <div style={{ height: 16 }} />
              <FundingCard />
            </>
          )}
          <div style={{ height: 16 }} />
          {(invoices.data?.invoices ?? []).length > 0 && (
            <InvoicesCard invoices={invoices.data?.invoices ?? []} />
          )}
        </>
      ) : null}
    </Page>
  );
}

/** Does this tenant pay by invoice: its live subscription, or the terms a
 *  new one would get? */
function payingByInvoice(status: BillingStatus): boolean {
  if (status.mode === 'selfhost' || status.plan === 'enterprise') return false;
  return status.subscribed
    ? status.subscriptionCollectionMethod === 'send_invoice'
    : status.collection?.method === 'send_invoice';
}

/** The server's human sentence, without the error-code prefix. */
function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const d = (err.detail as { detail?: unknown } | null)?.detail;
    return typeof d === 'string' ? d : err.message;
  }
  return fallback;
}

function PlanCard({ status }: { status: BillingStatus }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const byInvoice = payingByInvoice(status);

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
      // Auto-trigger Checkout once the plan stuck. Pay-by-invoice brands
      // start from the invoice form below instead.
      if (!byInvoice) startCheckout.mutate();
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
            {byInvoice
              ? 'Pick a tier. You’ll pay by invoice: nothing is charged automatically.'
              : 'Pick a tier to start your 14-day free trial. No card required up front.'}
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

      {plan && !subscribed && byInvoice && status.collection && (
        <InvoiceSubscribe collection={status.collection} trialExpired={!!status.trialExpiredWithoutSubscription} />
      )}

      {plan && !subscribed && !byInvoice && status.collection?.gstinRequired && !status.collection.gstin && (
        <Notice tone="danger">
          Add your GSTIN under Tax details below before subscribing. OpenPartner bills businesses in India only when
          they are registered for GST.
        </Notice>
      )}

      {plan && !subscribed && !byInvoice && (
        <div>
          {status.trialExpiredWithoutSubscription ? (
            <>
              <div
                style={{
                  background: alpha(theme.danger, 0.063),
                  border: `1px solid ${alpha(theme.danger, 0.333)}`,
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
                  background: `${theme.accentA10}`,
                  border: `1px solid ${theme.accentA55}`,
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
                  background: `${theme.accentA10}`,
                  border: `1px solid ${theme.accentA55}`,
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
                background: `${theme.accentA10}`,
                border: `1px solid ${theme.accentA55}`,
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
          {byInvoice && status.invoiceOverdue && <OverdueBanner overdue={status.invoiceOverdue} />}
          {!byInvoice && status.status && status.status !== 'active' && status.status !== 'trialing' && (
            <div
              style={{
                background: alpha(theme.danger, 0.063),
                border: `1px solid ${alpha(theme.danger, 0.333)}`,
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
              <ExternalLink size={12} />{' '}
              {byInvoice
                ? 'Switch plans, update billing details, view full invoice history'
                : 'Switch plans, update card, view full invoice history'}
            </span>
          </div>
          {status.currentPeriodEnd && (
            <p style={{ marginTop: 10, fontSize: 12, color: theme.textDim }}>
              Current period ends {new Date(status.currentPeriodEnd * 1000).toLocaleDateString()}.
            </p>
          )}
          {byInvoice && (
            <p style={{ marginTop: 6, fontSize: 12, color: theme.textDim }}>
              You pay by invoice: Stripe emails each one, and you pay it by card or bank transfer from the
              invoice page. Nothing is charged automatically.
            </p>
          )}
          {/* The fee card below explains the fee; on the commission-floor
              rule this one-liner would be wrong. */}
          {status.feeRate && !status.fee && (
            <p style={{ marginTop: 6, fontSize: 12, color: theme.textDim }}>
              Metered fee: {status.feeRate} of attributed GMV.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Start the plan on pay-by-invoice terms (docs/invoice-billing.md). An
 * Indian brand gives its GSTIN here: it prints on every invoice, and
 * OpenPartner invoices businesses in India only when they're registered
 * for GST.
 */
function InvoiceSubscribe({ collection, trialExpired }: { collection: Collection; trialExpired: boolean }) {
  const qc = useQueryClient();
  const [legalName, setLegalName] = useState('');
  const [gstin, setGstin] = useState(collection.gstin ?? '');
  const [billingEmail, setBillingEmail] = useState('');
  const [promotionCode, setPromotionCode] = useState('');
  // On success the page re-renders as subscribed, and "Invoices to pay"
  // carries the first invoice's pay link.
  const start = useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>('/billing/invoice-subscription', {
        method: 'POST',
        body: {
          ...(legalName.trim() ? { legalName: legalName.trim() } : {}),
          ...(billingEmail.trim() ? { billingEmail: billingEmail.trim() } : {}),
          ...(collection.country === 'IN' && gstin.trim() ? { gstin: gstin.trim() } : {}),
          ...(promotionCode.trim() ? { promotionCode: promotionCode.trim() } : {}),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing-status'] });
      void qc.invalidateQueries({ queryKey: ['billing-invoices'] });
    },
  });
  const needsGstin = collection.gstinRequired && !gstin.trim();

  return (
    <div>
      {trialExpired && (
        <Notice tone="danger">
          <strong style={{ color: theme.danger }}>Trial expired.</strong> New programs, partners, coupons, and
          offerings are paused until you start your plan. Click ingestion and attribution still run, so no data is
          being lost.
        </Notice>
      )}
      <Notice tone="accent">
        You pay OpenPartner by invoice. Each month Stripe emails an invoice, due {collection.daysUntilDue} days
        later. Pay it from the invoice page by card or by bank transfer: ACH, a US wire, or an international SWIFT
        wire, in US dollars. Nothing is charged automatically.
      </Notice>
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <Label>Legal business name (printed on invoices)</Label>
          <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Your registered company name" />
        </div>
        <div>
          <Label>Send invoices to (optional)</Label>
          <Input type="email" value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} placeholder="accounts@yourcompany.com" />
        </div>
      </div>
      {collection.country === 'IN' && (
        <div style={{ marginBottom: 12 }}>
          <Label>GSTIN</Label>
          <Input
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
            placeholder="27AAPFU0939F1ZV"
            maxLength={20}
            style={{ fontFamily: theme.fontMono, maxWidth: 260 }}
          />
          <p style={{ fontSize: 12, color: theme.textDim, margin: '6px 0 0' }}>
            Invoices show your GSTIN and “Reverse charge applicable”: you account for GST on them yourself. We can
            only invoice businesses in India that are registered for GST.
          </p>
        </div>
      )}
      <div style={{ marginBottom: 12, maxWidth: 260 }}>
        <Label>Promotion code (optional)</Label>
        <Input value={promotionCode} onChange={(e) => setPromotionCode(e.target.value.trim())} placeholder="CODE" />
      </div>
      {start.error && <ErrorBanner error={errorText(start.error, 'Could not start your plan.')} />}
      <Button onClick={() => start.mutate()} disabled={start.isPending || needsGstin}>
        {start.isPending ? 'Starting…' : 'Start plan, pay by invoice'}
      </Button>
    </div>
  );
}

function OverdueBanner({ overdue }: { overdue: NonNullable<BillingStatus['invoiceOverdue']> }) {
  const graceEnd = new Date(overdue.graceEndsAt).toLocaleDateString();
  return (
    <Notice tone="danger">
      <strong style={{ color: theme.danger }}>Invoice overdue.</strong>{' '}
      {overdue.graceExpired
        ? overdue.neverPaid
          ? 'Adding new partners is paused until your first invoice is paid. Everything else keeps running.'
          : 'New partners are paused until your overdue invoices are paid. Everything else keeps running.'
        : `Pay it below. If it’s still unpaid on ${graceEnd}, adding new partners pauses until it is.`}
    </Notice>
  );
}

/** Invoices waiting to be paid, each with its hosted pay link. */
function OpenInvoicesCard({
  invoices,
  overdue,
}: {
  invoices: Invoice[];
  overdue: BillingStatus['invoiceOverdue'];
}) {
  const open = invoices.filter((i) => i.status === 'open' && i.amountRemaining > 0);
  if (open.length === 0) return null;
  const now = Date.now() / 1000;
  return (
    <>
      <div style={{ height: 16 }} />
      <Card>
        <SectionHeader icon={<FileText size={18} />} title="Invoices to pay" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {open.map((inv) => {
            const late = !!inv.dueDate && inv.dueDate < now;
            return (
              <div
                key={inv.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 12,
                  padding: '10px 12px',
                  background: theme.surface2,
                  border: `1px solid ${late ? alpha(theme.danger, 0.333) : theme.borderSubtle}`,
                  borderRadius: theme.radiusSm,
                }}
              >
                <span style={{ fontSize: 13, fontFamily: theme.fontMono, color: theme.textMuted }}>
                  {inv.number ?? inv.id.slice(0, 8)}
                </span>
                <span style={{ flex: 1, fontSize: 13, color: theme.text, minWidth: 120 }}>
                  {formatMoney(inv.amountRemaining, inv.currency)}
                </span>
                {inv.dueDate && (
                  <span style={{ fontSize: 12, color: late ? theme.danger : theme.textMuted }}>
                    {late ? 'Overdue since' : 'Due'} {new Date(inv.dueDate * 1000).toLocaleDateString()}
                  </span>
                )}
                {inv.hostedInvoiceUrl && (
                  <a
                    href={inv.hostedInvoiceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 13, fontWeight: 600, color: theme.accentText }}
                  >
                    Pay invoice
                  </a>
                )}
              </div>
            );
          })}
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 12, color: theme.textDim }}>
          Pay by card or bank transfer from the invoice page. For a bank transfer, quote the invoice number as the
          reference so it’s matched automatically.
          {overdue && !overdue.graceExpired ? ` Pay by ${new Date(overdue.graceEndsAt).toLocaleDateString()} to keep adding partners.` : ''}
        </p>
      </Card>
    </>
  );
}

/** An Indian brand's GSTIN, printed on its invoices. */
function TaxDetailsCard({ gstin }: { gstin: string | null }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(gstin ?? '');
  const [editing, setEditing] = useState(!gstin);
  const save = useMutation({
    mutationFn: () => api<{ ok: boolean; gstin: string }>('/billing/tax-details', { method: 'PUT', body: { gstin: value.trim() } }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['billing-status'] });
    },
  });
  return (
    <Card>
      <SectionHeader title="Tax details" />
      {!editing && gstin ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: theme.textMuted }}>GSTIN</span>
          <code style={{ fontSize: 13 }}>{gstin}</code>
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 10px' }}>
            {gstin
              ? 'Your GSTIN prints on your OpenPartner invoices, with “Reverse charge applicable”.'
              : 'OpenPartner bills businesses in India only when they are registered for GST. Add your GSTIN: it prints on your invoices, with “Reverse charge applicable”.'}
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value.toUpperCase())}
              placeholder="27AAPFU0939F1ZV"
              maxLength={20}
              style={{ fontFamily: theme.fontMono, maxWidth: 260 }}
            />
            <Button onClick={() => save.mutate()} disabled={save.isPending || !value.trim()}>
              {save.isPending ? 'Saving…' : 'Save GSTIN'}
            </Button>
          </div>
        </>
      )}
      {save.error && <ErrorBanner error={errorText(save.error, 'Could not save the GSTIN.')} />}
    </Card>
  );
}

function Notice({ tone, children }: { tone: 'accent' | 'danger'; children: React.ReactNode }) {
  const palette =
    tone === 'danger'
      ? { bg: alpha(theme.danger, 0.063), border: alpha(theme.danger, 0.333) }
      : { bg: theme.accentA10, border: theme.accentA55 };
  return (
    <div
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: theme.radiusSm,
        padding: 12,
        marginBottom: 14,
        fontSize: 13,
        color: theme.text,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

const ATTENTION_LABELS: Record<string, string> = {
  funding_charge_refunded: 'The funding charge for this batch was refunded.',
  funding_charge_disputed: 'The funding charge for this batch was disputed.',
  funding_timed_out: 'Funding for this batch timed out and was released.',
  authorization_revoked: 'Commission funding authorization was missing or revoked.',
  billing_not_set_up: 'No billing customer is set up for funding.',
  needs_review: 'This batch needs review — contact support.',
};

interface FundingBatch {
  id: string;
  status: string;
  currency: string;
  principal: string;
  grossCharge: string;
  residual: string;
  createdAt: string;
  fundedAt: string | null;
  settledAt: string | null;
  needsAttention?: boolean;
  attentionCode?: string | null;
}

interface FundingStatus {
  available: boolean;
  reason?: string;
  enabled?: boolean;
  termsVersion?: string;
  currency?: string;
  authorization: { acceptedAt: string; termsVersion: string; paymentMethodType: string } | null;
  batches?: FundingBatch[];
}

const BATCH_STATUS_LABELS: Record<string, string> = {
  reserved: 'Reserved',
  invoicing: 'Collecting',
  payment_processing: 'Collecting',
  funded: 'Funded',
  transferring: 'Paying partners',
  settled: 'Settled',
  settled_with_residual: 'Settled (residual)',
  funding_failed: 'Payment failed',
  funding_disputed: 'Disputed',
  release_requested: 'Releasing',
  released: 'Released',
  recovery_required: 'Needs support',
};

/**
 * Commission funding: the brand authorizes OpenPartner to debit their
 * bank account (ACH) for approved partner commissions before transfers
 * go out. Setup = accept terms + a Stripe Checkout setup-mode redirect
 * that collects the bank mandate; the return leg posts the session id
 * to /billing/funding/complete which verifies it server-side.
 */
function FundingCard() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);

  const funding = useQuery({
    queryKey: ['billing-funding'],
    queryFn: () => api<FundingStatus>('/billing/funding'),
  });

  const complete = useMutation({
    mutationFn: (sessionId: string) =>
      api<{ ok: boolean }>('/billing/funding/complete', { method: 'POST', body: { sessionId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing-funding'] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'setup completion failed'),
  });

  // Return leg of the Checkout setup redirect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (params.get('funding_setup') === 'success' && sessionId) {
      complete.mutate(sessionId);
      params.delete('funding_setup');
      params.delete('session_id');
      const qs = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setup = useMutation({
    mutationFn: () =>
      api<{ url: string }>('/billing/funding/setup', {
        method: 'POST',
        body: {
          successUrl: `${window.location.origin}${window.location.pathname}?funding_setup=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: window.location.href,
          termsVersion: funding.data?.termsVersion,
        },
      }),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'setup failed'),
  });

  const revoke = useMutation({
    mutationFn: () => api<{ ok: boolean }>('/billing/funding/revoke', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing-funding'] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'revoke failed'),
  });

  if (funding.isLoading || !funding.data?.available) return null;
  const f = funding.data;
  const batches = f.batches ?? [];

  return (
    <Card>
      <SectionHeader icon={<Banknote size={18} />} title="Commission funding" />
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px' }}>
        Automated partner payouts collect the commission total from your bank account (ACH debit)
        first — partner transfers only go out after your payment settles. Without funding set up,
        payouts run on the manual rail: you transfer to partners yourself and confirm each payout.
      </p>
      {error && <ErrorBanner error={error} />}
      {complete.isPending && (
        <p style={{ fontSize: 12, color: theme.textMuted }}>Finishing bank setup…</p>
      )}

      {f.authorization ? (
        <>
          <div
            style={{
              background: alpha(theme.success, 0.063),
              border: `1px solid ${alpha(theme.success, 0.333)}`,
              borderRadius: theme.radiusSm,
              padding: 12,
              marginBottom: 14,
              fontSize: 13,
              color: theme.text,
            }}
          >
            <strong style={{ color: theme.success }}>Bank account connected.</strong> Funding
            authorized on {new Date(f.authorization.acceptedAt).toLocaleDateString()} (terms{' '}
            <code>{f.authorization.termsVersion}</code>).
            {!f.enabled && ' Automated funding is not switched on for this deployment yet — payouts stay on the manual rail until it is.'}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* The API refuses setup while funding is off; revoke stays available. */}
            {f.enabled && (
              <Button variant="secondary" onClick={() => setup.mutate()} disabled={setup.isPending}>
                {setup.isPending ? 'Opening Stripe…' : 'Replace bank account'}
              </Button>
            )}
            <Button variant="danger" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
              {revoke.isPending ? 'Revoking…' : 'Revoke authorization'}
            </Button>
          </div>
          <p style={{ marginTop: 8, fontSize: 12, color: theme.textDim }}>
            Revoking stops new funding collections. Batches already in progress finish under the
            authorization they started with.
          </p>
        </>
      ) : !f.enabled ? (
        // Shown only for a tenant with funding history (the API hides the
        // card otherwise): no new authorization until funding is on.
        <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>
          Automated funding isn&rsquo;t switched on for this deployment. Payouts stay on the manual
          rail.
        </p>
      ) : (
        <>
          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              fontSize: 13,
              color: theme.text,
              marginBottom: 12,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              I authorize OpenPartner to debit our bank account for approved partner commission
              batches, per the{' '}
              <a
                href="https://openpartner.dev/terms"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: theme.accentText }}
              >
                funding terms
              </a>
              . Debits happen only for commissions we approved; every batch is itemized here.
            </span>
          </label>
          <Button onClick={() => setup.mutate()} disabled={!termsAccepted || setup.isPending}>
            {setup.isPending ? 'Opening Stripe…' : 'Connect bank account (US ACH)'}
          </Button>
          <p style={{ marginTop: 8, fontSize: 12, color: theme.textDim }}>
            US bank accounts only at launch; UK/EU bank debit is on the roadmap. Until funding is
            set up, use Settings → Payout settings → rail “Manual”.
          </p>
        </>
      )}

      {batches.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Recent funding batches</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {batches.map((b) => (
              <div
                key={b.id}
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
                <span style={{ fontSize: 12, fontFamily: theme.fontMono, color: theme.textMuted }}>
                  {b.id.slice(-8)}
                </span>
                <span style={{ fontSize: 13, color: theme.textMuted }}>
                  {new Date(b.createdAt).toLocaleDateString()}
                </span>
                <span style={{ flex: 1, fontSize: 13, color: theme.text }}>
                  {b.grossCharge} {b.currency.toUpperCase()}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    // A settled batch whose funding charge was later
                    // refunded or disputed keeps its terminal status but
                    // carries a reason. Rendering it as a plain "Settled"
                    // hid the clawback completely.
                    color: b.needsAttention ? theme.danger : theme.textMuted,
                    textTransform: 'uppercase',
                    fontWeight: 600,
                  }}
                  title={b.needsAttention ? (ATTENTION_LABELS[b.attentionCode ?? ''] ?? 'This batch needs review — contact support.') : undefined}
                >
                  {BATCH_STATUS_LABELS[b.status] ?? b.status}
                  {b.needsAttention ? ' ⚠' : ''}
                </span>
              </div>
            ))}
          </div>
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
              {inv.status === 'open' && inv.dueDate && (
                <span style={{ color: theme.textDim, fontSize: 12 }}>
                  {' '}· due {new Date(inv.dueDate * 1000).toLocaleDateString()}
                </span>
              )}
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
                style={{ fontSize: 12, color: theme.accentText }}
              >
                {inv.status === 'open' ? 'Pay' : 'View'}
              </a>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function pct(rate: number): string {
  return `${Number((rate * 100).toFixed(3))}%`;
}

function feeDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Plain-language account of the platform fee. On the commission-floor rule
 * each conversion costs the greater of a share of its revenue and a share of
 * the commissions partners earned on it; a brand still on the old rule sees
 * the date it moves, when it has one.
 */
function FeeBasisCard({ fee }: { fee: FeeDescription }) {
  const rr = pct(fee.revenueRate);
  const cr = pct(fee.commissionRate);
  const breakEven = fee.commissionRate > 0 ? pct(fee.revenueRate / fee.commissionRate) : null;
  const p = { fontSize: 13, color: theme.textMuted, margin: '0 0 10px', lineHeight: 1.55 } as const;
  const newRule = (
    <>
      <p style={p}>
        For each conversion a partner is credited for, you pay the greater of{' '}
        <strong style={{ color: theme.text }}>{rr} of its revenue</strong>
        {fee.commissionRate > 0 && (
          <>
            {' '}or <strong style={{ color: theme.text }}>{cr} of the commissions</strong> partners earned on it
          </>
        )}
        .
      </p>
      <p style={p}>
        A conversion counts as revenue when it’s an invoice or subscription payment, when it pays a percentage
        commission, or when its event type is marked as revenue on the program (Programs → Revenue event types).
      </p>
      {breakEven && fee.revenueRate > 0 && (
        <p style={p}>
          If your commissions are at most {breakEven} of the revenue you report, that’s simply {rr} of revenue. The
          commission minimum only matters for a conversion with no value, an understated value, or a fixed bounty
          larger than {breakEven} of its value.
        </p>
      )}
      <p style={p}>A refund lowers the fee once the partner’s commission on that conversion is reversed or clawed back.</p>
    </>
  );
  return (
    <Card>
      <SectionHeader title="How your platform fee is calculated" />
      {fee.rule === 'old' && (
        <p style={p}>
          {rr} of partner-attributed revenue: the value of invoice and subscription payments, and of event types you
          mark as revenue on a program, that a partner was credited for. A refund lowers it once the partner’s
          commission on that conversion is reversed or clawed back.
        </p>
      )}
      {fee.rule === 'scheduled' && (
        <>
          <p style={{ ...p, color: theme.text }}>
            Until {fee.effectiveAt ? feeDate(fee.effectiveAt) : 'your change date'}: {rr} of partner-attributed revenue,
            as today. From then on, as we let you know by email:
          </p>
          {newRule}
        </>
      )}
      {fee.rule === 'new' && newRule}
      {fee.contract && (
        <p style={p}>
          These rates come from your contract
          {fee.monthlyMinimumUsd !== null ? `, with a minimum of $${fee.monthlyMinimumUsd.toLocaleString()} a month` : ''}.
        </p>
      )}
      <p style={{ ...p, margin: 0 }}>
        <a href="https://openpartner.dev/pricing" target="_blank" rel="noreferrer" style={{ color: theme.accentText }}>
          Pricing details
        </a>
      </p>
    </Card>
  );
}

function SectionHeader({ icon, title }: { icon?: React.ReactNode; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      {icon && <span style={{ color: theme.accentText, display: 'flex' }}>{icon}</span>}
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
