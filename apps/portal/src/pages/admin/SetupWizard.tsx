/**
 * First-run setup for a new hosted brand: program, commission, tracking,
 * marketplace, plan, then a recap that hands off to the dashboard.
 *
 * Every step saves through the routes the rest of the portal uses (programs,
 * /config/onboarding, tracking health, billing), so the dashboard checklist
 * and the setup reminders see what was done here. Progress is kept
 * server-side (`wizard.step` on /admin/onboarding-status), so a reload, or
 * the return from Stripe Checkout, resumes where the brand left off. "Finish
 * later" is always there: nothing in here is required to use the portal.
 *
 * Who sees it is decided by the API (routes/onboarding.ts setupWizardStatus):
 * hosted brands with no program yet, when the operator switch is on.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clickDestinationProblem } from '@openpartner/db';
import { ApiError, api } from '../../api.js';
import { alpha, theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Select, Textarea, money } from '../../ui.js';
import { useTenantBase } from '../../tenant-base.js';
import { TenantLink } from '../../tenant-link.js';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import { useBrand, useDefaultCurrency } from '../../lib/useBrand.js';
import { useShareUrlRoot } from '../../lib/shareUrl.js';
import { Stepper } from '../../lib/Stepper.js';
import { CodeSnippet, useScriptTag } from '../../lib/InstallSnippet.js';
import { commissionExample } from '../../lib/commission-example.js';
import { TestClickPanel, testClickErrorMessage } from './TrackingHealth.js';

// ---------------------------------------------------------------------------
// What the wizard reads
// ---------------------------------------------------------------------------

export interface SetupWizardStatus {
  available: boolean;
  redirect: boolean;
  completedAt: string | null;
  exitedAt: string | null;
  step: number;
  programId: string | null;
  hints: { percent: string; fixed: string };
}

interface OnboardingStatus {
  networkConnected: boolean;
  networkListingSkipped?: boolean;
  trackingInstalled?: boolean;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  /** Absent on an API that predates the wizard. */
  wizard?: SetupWizardStatus;
}

type SubRule = { trigger: string; type: 'percent' | 'fixed'; value: number; recurring?: boolean; [k: string]: unknown };

interface WizardProgram {
  id: string;
  name: string;
  destinationUrl: string;
  commissionRule: SubRule[] | { type: 'percent' | 'fixed'; value: number; recurring?: boolean };
  attributionWindowDays: number;
  recruiterCommissionPercent?: string | null;
  shareOnNetwork: boolean;
  marketplaceDescription: string | null;
  createdAt: string;
}

type Plan = 'flex' | 'revshare' | 'enterprise';

interface BillingStatus {
  mode: 'selfhost' | 'flat' | 'revshare';
  plan: Plan | null;
  subscribed?: boolean;
  trialEnd?: number | null;
  trialEndsAt?: string | null;
  collection?: { method: 'send_invoice' | 'charge_automatically'; gstin: string | null; gstinRequired: boolean };
}

const STATUS_KEY = ['admin-onboarding-status'];
const PROGRAMS_KEY = ['campaigns'];
const BILLING_KEY = ['billing-status'];

/** The wizard's status for the signed-in admin; undefined while it loads. */
export function useSetupWizard(enabled: boolean) {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => api<OnboardingStatus>('/admin/onboarding-status'),
    staleTime: 30_000,
    retry: false,
    enabled,
  });
}

/**
 * Wraps the dashboard: a brand that should be in the wizard is sent there.
 * Renders nothing for the moment the status takes to load, so the dashboard
 * doesn't flash first; a failed read shows the dashboard.
 */
export function SetupWizardGate({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const tenantBase = useTenantBase();
  const status = useSetupWizard(enabled);
  if (enabled && status.isPending) return null;
  if (enabled && status.data?.wizard?.redirect) return <Navigate to={`${tenantBase}/setup`} replace />;
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Canonical step numbers: what `wizard.step` counts, whatever steps show. */
type StepId = 'program' | 'commission' | 'tracking' | 'marketplace' | 'plan';
const STEP_NUMBER: Record<StepId, number> = { program: 1, commission: 2, tracking: 3, marketplace: 4, plan: 5 };
const STEP_LABEL: Record<StepId, string> = {
  program: 'Program',
  commission: 'Commission',
  tracking: 'Tracking',
  marketplace: 'Marketplace',
  plan: 'Plan',
};

const DEFAULT_RULE: SubRule = { trigger: 'every', type: 'percent', value: 20, recurring: true };
const DEFAULT_RECRUITER_PERCENT = '10';

function saveStep(id: StepId, extra: Record<string, unknown> = {}) {
  return api('/config/onboarding', { method: 'POST', body: { wizardStep: STEP_NUMBER[id], ...extra } });
}

/** The server's sentence when it sent one, without the error code. */
function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const d = (err.detail as { detail?: unknown } | null)?.detail;
    return typeof d === 'string' ? d : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function SetupWizardPage() {
  const tenantBase = useTenantBase();
  const nav = useNavigate();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const { programName, whiteLabel, isLoading: brandLoading } = useBrand();

  const status = useSetupWizard(true);
  const programs = useQuery({
    queryKey: PROGRAMS_KEY,
    queryFn: () => api<{ programs: WizardProgram[] }>('/programs'),
  });
  const billing = useQuery({ queryKey: BILLING_KEY, queryFn: () => api<BillingStatus>('/billing/status') });

  // Back from Stripe Checkout. Read once, then dropped from the URL so a
  // reload doesn't replay it.
  const [checkout] = useState<'success' | 'cancelled' | null>(() => {
    const c = params.get('checkout');
    return c === 'success' || c === 'cancelled' ? c : null;
  });
  useEffect(() => {
    if (params.has('checkout')) setParams({}, { replace: true });
  }, [params, setParams]);

  const [at, setAt] = useState<StepId | 'recap' | null>(null);
  // A step opened from the recap's Edit goes back to the recap.
  const [fromRecap, setFromRecap] = useState(false);

  const leave = useMutation({
    mutationFn: (body: { wizardExited?: true; wizardCompleted?: true }) =>
      api('/config/onboarding', { method: 'POST', body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: STATUS_KEY });
      nav(`${tenantBase}/`, { replace: true });
    },
  });

  // Opening the wizard again after "Finish later" takes it back up. Not
  // while leaving: "Finish later" itself sets the stamp this would clear.
  const exitedAt = status.data?.wizard?.exitedAt;
  const leaving = !leave.isIdle;
  useEffect(() => {
    if (!exitedAt || leaving) return;
    void api('/config/onboarding', { method: 'POST', body: { wizardExited: false } }).then(() =>
      qc.invalidateQueries({ queryKey: STATUS_KEY }),
    );
  }, [exitedAt, leaving, qc]);

  // A completed Checkout is the plan step done.
  useEffect(() => {
    if (checkout !== 'success') return;
    void saveStep('plan').then(() => qc.invalidateQueries({ queryKey: STATUS_KEY }));
  }, [checkout, qc]);

  const loading = status.isPending || programs.isPending || billing.isPending || brandLoading;
  const failed = status.error ?? programs.error ?? billing.error;
  const wizard = status.data?.wizard;

  if (!loading && !failed && !wizard?.available && !leave.isPending && !leave.isSuccess) {
    return <Navigate to={`${tenantBase}/`} replace />;
  }

  const list = programs.data?.programs ?? [];
  const program =
    list.find((p) => p.id === wizard?.programId) ??
    [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ??
    null;

  const b = billing.data;
  const steps: StepId[] = [
    'program',
    'commission',
    'tracking',
    ...(!whiteLabel && status.data?.networkConnected ? (['marketplace'] as const) : []),
    ...(b && b.mode !== 'selfhost' && b.plan !== 'enterprise' ? (['plan'] as const) : []),
  ];

  // Where to resume: the first step not saved yet. Without a program
  // everything else has nothing to edit, so it starts over at the top.
  const saved = wizard?.step ?? 0;
  const resumeAt: StepId | 'recap' = !program
    ? 'program'
    : checkout === 'cancelled' && steps.includes('plan')
      ? 'plan'
      : checkout === 'success'
        ? 'recap'
        : (steps.find((s) => STEP_NUMBER[s] > saved) ?? 'recap');
  const current = at ?? resumeAt;
  const index = current === 'recap' ? steps.length : steps.indexOf(current);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: STATUS_KEY }),
      qc.invalidateQueries({ queryKey: PROGRAMS_KEY }),
      qc.invalidateQueries({ queryKey: BILLING_KEY }),
    ]);
  const next = async () => {
    await refresh();
    setAt(fromRecap ? 'recap' : (steps[index + 1] ?? 'recap'));
    setFromRecap(false);
  };
  const back = fromRecap
    ? () => {
        setAt('recap');
        setFromRecap(false);
      }
    : index > 0
      ? () => setAt(steps[index - 1]!)
      : undefined;

  return (
    <div style={{ minHeight: '100vh', background: theme.bg, color: theme.text, fontFamily: theme.fontSans }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: isMobile ? '20px 16px 40px' : '40px 24px 64px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
            Set up {programName}
          </h1>
          {current !== 'recap' && (
            <Button variant="ghost" size="sm" disabled={leave.isPending} onClick={() => leave.mutate({ wizardExited: true })}>
              Finish later
            </Button>
          )}
        </div>
        <ErrorBanner error={failed ?? leave.error} />
        {loading ? (
          <Card>Loading…</Card>
        ) : failed ? null : (
          <>
            {current !== 'recap' && <Stepper steps={steps.map((s) => STEP_LABEL[s])} current={index} compact={isMobile} />}
            <Card>
              {current === 'program' && <ProgramStep program={program} onDone={next} />}
              {current === 'commission' && program && (
                <CommissionStep
                  program={program}
                  // Until this step has been saved once, two-tier starts on.
                  firstVisit={saved < STEP_NUMBER.commission}
                  hints={wizard?.hints ?? { percent: '', fixed: '' }}
                  onBack={back}
                  onDone={next}
                />
              )}
              {current === 'tracking' && program && (
                <TrackingStep program={program} verified={!!status.data?.trackingInstalled} onBack={back} onDone={next} />
              )}
              {current === 'marketplace' && program && (
                <MarketplaceStep
                  program={program}
                  firstVisit={saved < STEP_NUMBER.marketplace}
                  pending={status.data?.approvalStatus === 'pending'}
                  onBack={back}
                  onDone={next}
                />
              )}
              {current === 'plan' && b && <PlanStep billing={b} cancelled={checkout === 'cancelled'} onBack={back} onDone={next} />}
              {current === 'recap' && (
                <Recap
                  program={program}
                  status={status.data!}
                  billing={b ?? null}
                  listed={steps.includes('marketplace')}
                  awaitingCheckout={checkout === 'success'}
                  onEdit={(s) => {
                    setFromRecap(true);
                    setAt(s);
                  }}
                  finishing={leave.isPending}
                  onFinish={() => leave.mutate({ wizardCompleted: true })}
                />
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function StepTitle({ children }: { children: ReactNode }) {
  return <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 16px' }}>{children}</h2>;
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6, lineHeight: 1.5 }}>{children}</div>;
}

function Footer({
  onBack,
  onNext,
  nextLabel = 'Continue',
  disabled,
  busy,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 20 }}>
      {onBack ? (
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
      ) : (
        <span />
      )}
      <Button onClick={onNext} disabled={disabled || busy}>
        {busy ? 'Saving…' : nextLabel}
      </Button>
    </div>
  );
}

/** One of a few exclusive choices, as a row the whole of which is the target. */
function Choice({
  name,
  checked,
  onSelect,
  title,
  detail,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${checked ? theme.accent : theme.border}`,
        background: checked ? theme.accentA10 : 'transparent',
        borderRadius: theme.radiusSm,
        padding: '12px 14px',
        marginBottom: 10,
      }}
    >
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input type="radio" name={name} checked={checked} onChange={onSelect} style={{ accentColor: theme.accent, marginTop: 3 }} />
        <span>
          <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{title}</span>
          {detail && <span style={{ display: 'block', fontSize: 13, color: theme.textMuted, marginTop: 2 }}>{detail}</span>}
        </span>
      </label>
      {checked && children && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Program
// ---------------------------------------------------------------------------

function ProgramStep({ program, onDone }: { program: WizardProgram | null; onDone: () => Promise<void> }) {
  const { programName } = useBrand();
  const [name, setName] = useState(program?.name ?? `${programName} partner program`);
  const [url, setUrl] = useState(program?.destinationUrl ?? '');

  let problem: string | null = null;
  if (url.trim()) {
    try {
      const parsed = new URL(url.trim());
      problem = /^https?:$/.test(parsed.protocol) ? clickDestinationProblem(url.trim()) : 'Start the URL with https://';
    } catch {
      problem = 'Enter a full URL, starting with https://';
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      // The start stamp goes first: it is what keeps the wizard open once
      // the program below exists.
      await saveStep('program', { wizardStarted: true });
      if (program) {
        await api(`/programs/${program.id}`, { method: 'PATCH', body: { name: name.trim(), destinationUrl: url.trim() } });
      } else {
        // Private until the marketplace step says otherwise: a brand on the
        // Network would otherwise need a listing description right here.
        await api('/programs', {
          method: 'POST',
          body: { name: name.trim(), destinationUrl: url.trim(), commissionRule: [DEFAULT_RULE], shareOnNetwork: false },
        });
      }
    },
    onSuccess: onDone,
  });

  return (
    <>
      <StepTitle>Your program</StepTitle>
      <Field label="Program name" htmlFor="wiz-name">
        <Input id="wiz-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </Field>
      <Field label="Product URL" htmlFor="wiz-url">
        <Input id="wiz-url" type="url" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        {problem ? <Hint>{problem}</Hint> : <Hint>Partner links send visitors here.</Hint>}
      </Field>
      <ErrorBanner error={save.error ? errorText(save.error) : null} />
      <Footer onNext={() => save.mutate()} disabled={!name.trim() || !url.trim() || !!problem} busy={save.isPending} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 2. Commission
// ---------------------------------------------------------------------------

/** The program's rule when it is the one simple rule this step edits. */
function simpleRule(raw: WizardProgram['commissionRule']): SubRule | null {
  if (!Array.isArray(raw)) return { trigger: 'every', ...raw };
  if (raw.length !== 1) return null;
  const r = raw[0]!;
  const known = new Set(['trigger', 'type', 'value', 'recurring']);
  return r.trigger === 'every' && Object.keys(r).every((k) => known.has(k) || r[k] == null) ? r : null;
}

function CommissionStep({
  program,
  firstVisit,
  hints,
  onBack,
  onDone,
}: {
  program: WizardProgram;
  firstVisit: boolean;
  hints: { percent: string; fixed: string };
  onBack?: () => void;
  onDone: () => Promise<void>;
}) {
  const currency = useDefaultCurrency();
  const rule = simpleRule(program.commissionRule);
  const [type, setType] = useState<'percent' | 'fixed'>(rule?.type ?? 'percent');
  const [value, setValue] = useState(String(rule?.value ?? 20));
  const [recurring, setRecurring] = useState(rule?.recurring ?? true);
  const [windowDays, setWindowDays] = useState(String(program.attributionWindowDays));
  const [twoTier, setTwoTier] = useState(firstVisit ? true : program.recruiterCommissionPercent != null);
  const [recruiterPct, setRecruiterPct] = useState(
    program.recruiterCommissionPercent != null ? String(Number(program.recruiterCommissionPercent)) : DEFAULT_RECRUITER_PERCENT,
  );

  const v = Number(value);
  const pct = Number(recruiterPct);
  const valueOk = Number.isFinite(v) && v > 0 && (type === 'fixed' || v <= 100);
  const pctOk = !twoTier || (Number.isFinite(pct) && pct > 0 && pct <= 50 && Math.round(pct * 100) === pct * 100);
  const example = commissionExample({ type, value: v, recruiterPercent: twoTier && pctOk ? pct : null });
  const hint = hints[type];

  const save = useMutation({
    mutationFn: async () => {
      await api(`/programs/${program.id}`, {
        method: 'PATCH',
        body: {
          // A program whose rules were built on the Programs page keeps them.
          ...(rule ? { commissionRule: [{ trigger: 'every', type, value: v, recurring }] } : {}),
          attributionWindowDays: Number(windowDays),
          recruiterCommissionPercent: twoTier ? pct : null,
          recruiterCommissionMonths: null,
        },
      });
      await saveStep('commission');
    },
    onSuccess: onDone,
  });

  const cents = (n: number) => money(n / 100, currency);

  return (
    <>
      <StepTitle>Commission</StepTitle>
      {rule ? (
        <>
          <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Partners earn" htmlFor="wiz-type">
              <Select id="wiz-type" value={type} onChange={(e) => setType(e.target.value as 'percent' | 'fixed')}>
                <option value="percent">A percentage of each sale</option>
                <option value="fixed">A fixed amount per sale</option>
              </Select>
            </Field>
            <Field label={type === 'percent' ? 'Percent' : `Amount (${currency})`} htmlFor="wiz-value">
              <Input id="wiz-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
              {hint && <Hint>{hint}</Hint>}
            </Field>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 14, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)}
              style={{ accentColor: theme.accent, margin: 0 }}
            />
            Pay on every renewal, not just the first payment
          </label>
        </>
      ) : (
        <Hint>
          This program has custom commission rules. Edit them on the <TenantLink to="/admin/programs">Programs page</TenantLink>.
        </Hint>
      )}

      <Field label="Attribution window" htmlFor="wiz-window">
        <Select id="wiz-window" value={windowDays} onChange={(e) => setWindowDays(e.target.value)}>
          {[...new Set([30, 60, 90, program.attributionWindowDays])]
            .sort((a, c) => a - c)
            .map((d) => (
              <option key={d} value={d}>
                {d} days after the click
              </option>
            ))}
        </Select>
      </Field>

      <div style={{ borderTop: `1px solid ${theme.borderSubtle}`, paddingTop: 14, marginTop: 4 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={twoTier}
            onChange={(e) => setTwoTier(e.target.checked)}
            style={{ accentColor: theme.accent, margin: 0 }}
          />
          Recruiter commission
        </label>
        <Hint>A partner who brings in another partner earns a share of that partner’s commissions. You pay it on top.</Hint>
        {twoTier && (
          <div style={{ marginTop: 10, maxWidth: 200 }}>
            <Label htmlFor="wiz-recruiter">Recruiter’s share (%)</Label>
            <Input id="wiz-recruiter" inputMode="decimal" value={recruiterPct} onChange={(e) => setRecruiterPct(e.target.value)} />
            {!pctOk && <Hint>Between 0 and 50, up to two decimals.</Hint>}
          </div>
        )}
      </div>

      {rule && valueOk && (
        <div
          data-testid="commission-example"
          style={{
            marginTop: 16,
            padding: '12px 14px',
            background: theme.surface2,
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: theme.radiusSm,
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>On a {cents(example.sale)} sale</div>
          <ExampleRow label="Partner’s commission" value={cents(example.partner)} />
          {twoTier && pctOk && <ExampleRow label="Recruiter’s share" value={cents(example.recruiter)} />}
          <ExampleRow label="You pay" value={cents(example.total)} strong />
        </div>
      )}

      <ErrorBanner error={save.error ? errorText(save.error) : null} />
      <Footer onBack={onBack} onNext={() => save.mutate()} disabled={(rule ? !valueOk : false) || !pctOk} busy={save.isPending} />
    </>
  );
}

function ExampleRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '4px 0',
        fontWeight: strong ? 600 : 400,
        borderTop: strong ? `1px solid ${theme.border}` : undefined,
        marginTop: strong ? 4 : 0,
        paddingTop: strong ? 8 : 4,
      }}
    >
      <span style={{ color: strong ? theme.text : theme.textMuted }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Tracking
// ---------------------------------------------------------------------------

function TrackingStep({
  program,
  verified,
  onBack,
  onDone,
}: {
  program: WizardProgram;
  verified: boolean;
  onBack?: () => void;
  onDone: () => Promise<void>;
}) {
  const scriptTag = useScriptTag();
  const testRoot = useShareUrlRoot();
  const [sending, setSending] = useState(false);
  const [email, setEmail] = useState('');
  const [test, setTest] = useState<{ id: string; url: string } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);

  const send = useMutation({
    mutationFn: () => api('/admin/tracking-health/send-to-developer', { method: 'POST', body: { email: email.trim() } }),
  });
  const save = useMutation({ mutationFn: () => saveStep('tracking'), onSuccess: onDone });

  const startTest = async () => {
    if (!testRoot) return;
    // Opened inside the click so the browser doesn't block it as a popup.
    const tab = window.open('', '_blank');
    setTestError(null);
    setMaking(true);
    try {
      const made = await api<{ id: string; path: string }>('/admin/tracking-health/test-click', {
        method: 'POST',
        body: { programId: program.id },
      });
      const url = `${testRoot}${made.path}`;
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      }
      setTest({ id: made.id, url });
    } catch (err) {
      tab?.close();
      setTestError(testClickErrorMessage(err));
    } finally {
      setMaking(false);
    }
  };

  return (
    <>
      <StepTitle>Tracking</StepTitle>
      <Label>Add this to every page of your site</Label>
      <CodeSnippet code={scriptTag} label="Tracking script tag" />
      <Hint>
        Then call <code style={{ fontFamily: theme.fontMono }}>openpartner.identify(userId)</code> when someone signs up or logs in.
      </Hint>

      <div style={{ marginTop: 16 }}>
        {send.isSuccess ? (
          <div role="status" style={{ fontSize: 13, color: theme.success }}>
            Sent to {email.trim()}.
          </div>
        ) : sending ? (
          <>
            <Label htmlFor="wiz-dev-email">Developer’s email</Label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Input
                id="wiz-dev-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="dev@example.com"
                style={{ flex: 1, minWidth: 180 }}
              />
              <Button variant="secondary" disabled={!/^\S+@\S+\.\S+$/.test(email.trim()) || send.isPending} onClick={() => send.mutate()}>
                {send.isPending ? 'Sending…' : 'Send'}
              </Button>
            </div>
            <Hint>We email them the script and the install guide.</Hint>
            <ErrorBanner error={send.error ? sendErrorText(send.error) : null} />
          </>
        ) : (
          <Button variant="secondary" onClick={() => setSending(true)}>
            Send to a developer
          </Button>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${theme.borderSubtle}`, marginTop: 18, paddingTop: 14 }}>
        {verified ? (
          <div role="status" style={{ fontSize: 13, color: theme.success, fontWeight: 600 }}>
            Tracking verified.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button variant="secondary" disabled={!testRoot || making} onClick={() => void startTest()}>
                {making ? 'Making a test link…' : 'Send a test click'}
              </Button>
              <span style={{ fontSize: 12, color: theme.textMuted }}>Checks the script once it’s live.</span>
            </div>
            {testError && (
              <div style={{ marginTop: 8 }}>
                <ErrorBanner error={testError} />
              </div>
            )}
            {test && <TestClickPanel test={test} onClose={() => setTest(null)} />}
          </>
        )}
      </div>

      <ErrorBanner error={save.error ? errorText(save.error) : null} />
      <Footer onBack={onBack} onNext={() => save.mutate()} busy={save.isPending} />
    </>
  );
}

function sendErrorText(err: unknown): string {
  const code = err instanceof ApiError ? (err.detail as { error?: string } | null)?.error : undefined;
  if (code === 'too_many_emails') return 'That’s as many as one day allows. Copy the script instead.';
  if (code === 'mail_send_failed') return 'The email couldn’t be sent. Check the address, or copy the script instead.';
  return errorText(err);
}

// ---------------------------------------------------------------------------
// 4. Marketplace
// ---------------------------------------------------------------------------

function MarketplaceStep({
  program,
  firstVisit,
  pending,
  onBack,
  onDone,
}: {
  program: WizardProgram;
  firstVisit: boolean;
  pending: boolean;
  onBack?: () => void;
  onDone: () => Promise<void>;
}) {
  const [list, setList] = useState(firstVisit ? true : program.shareOnNetwork);
  const [description, setDescription] = useState(program.marketplaceDescription ?? '');

  const save = useMutation({
    mutationFn: async () => {
      await api(`/programs/${program.id}`, {
        method: 'PATCH',
        body: list ? { shareOnNetwork: true, marketplaceDescription: description.trim() } : { shareOnNetwork: false },
      });
      // "Keep private" is the checklist's "Not now" for the listing.
      await saveStep('marketplace', { networkListingSkipped: !list });
    },
    onSuccess: onDone,
  });

  return (
    <>
      <StepTitle>Marketplace</StepTitle>
      <Choice
        name="wiz-listing"
        checked={list}
        onSelect={() => setList(true)}
        title="List on the OpenPartner marketplace"
        detail="Creators can find your program and apply."
      >
        <Label htmlFor="wiz-description">What creators should know</Label>
        <Textarea
          id="wiz-description"
          rows={4}
          maxLength={4000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What you sell, who buys it, and who you’d like to work with."
        />
        {pending && <Hint>Goes live once your brand is approved and your tracking is verified.</Hint>}
      </Choice>
      <Choice
        name="wiz-listing"
        checked={!list}
        onSelect={() => setList(false)}
        title="Keep it private"
        detail="Only partners you invite can join. You can list it later."
      />
      <ErrorBanner error={save.error ? errorText(save.error) : null} />
      <Footer onBack={onBack} onNext={() => save.mutate()} disabled={list && !description.trim()} busy={save.isPending} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 5. Plan
// ---------------------------------------------------------------------------

/** Mirrors the API's checkoutTrialEnd: Checkout carries the rest of the
 *  trial when 48 hours or more of it remain. */
function deferredChargeDate(trialEndsAt: string | null | undefined): Date | null {
  if (!trialEndsAt) return null;
  const end = Date.parse(trialEndsAt);
  return end - Date.now() > 48 * 60 * 60 * 1000 + 5 * 60 * 1000 ? new Date(end) : null;
}

const day = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function PlanStep({
  billing,
  cancelled,
  onBack,
  onDone,
}: {
  billing: BillingStatus;
  cancelled: boolean;
  onBack?: () => void;
  onDone: () => Promise<void>;
}) {
  const tenantBase = useTenantBase();
  const current = billing.plan === 'flex' || billing.plan === 'revshare' ? billing.plan : null;
  const [plan, setPlan] = useState<'flex' | 'revshare' | null>(current);
  const [gstin, setGstin] = useState('');
  const subscribed = !!billing.subscribed;
  const byInvoice = billing.collection?.method === 'send_invoice';
  const needsGstin = !!billing.collection?.gstinRequired && !billing.collection.gstin;
  const chargeOn = deferredChargeDate(billing.trialEndsAt);
  const toStripe = plan === 'flex' && !byInvoice && !subscribed;

  const save = useMutation({
    mutationFn: async () => {
      if (subscribed) return saveStep('plan');
      await api('/billing/plan', { method: 'POST', body: { plan } });
      if (needsGstin && gstin.trim()) {
        await api('/billing/tax-details', { method: 'PUT', body: { gstin: gstin.trim() } });
      }
      // Saved before leaving for Stripe: a brand that backs out of Checkout
      // comes back to this step with its choice kept.
      if (!toStripe) return saveStep('plan');
      const base = `${window.location.origin}${tenantBase}/setup`;
      const r = await api<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: { successUrl: `${base}?checkout=success`, cancelUrl: `${base}?checkout=cancelled` },
      });
      window.location.href = r.url;
      // Hold the button in its busy state while the browser leaves.
      return new Promise<never>(() => {});
    },
    onSuccess: onDone,
  });

  if (subscribed) {
    return (
      <>
        <StepTitle>Plan</StepTitle>
        <div role="status" style={{ fontSize: 14 }}>
          {current === 'flex' ? 'Flex' : 'Revshare'} plan active.
          {billing.trialEnd ? ` First charge on ${day(new Date(billing.trialEnd * 1000))}.` : ''}
        </div>
        <ErrorBanner error={save.error ? errorText(save.error) : null} />
        <Footer onBack={onBack} onNext={() => save.mutate()} busy={save.isPending} />
      </>
    );
  }

  return (
    <>
      <StepTitle>Plan</StepTitle>
      {cancelled && (
        <div
          role="status"
          style={{
            background: theme.warnSoft,
            border: `1px solid ${alpha(theme.warn, 0.333)}`,
            borderRadius: theme.radiusSm,
            padding: '10px 12px',
            fontSize: 13,
            marginBottom: 14,
          }}
        >
          Checkout wasn’t completed, and nothing was charged. Try again, or pick Revshare.
        </div>
      )}
      <Choice
        name="wiz-plan"
        checked={plan === 'revshare'}
        onSelect={() => setPlan('revshare')}
        title="Revshare"
        detail="3% of partner-attributed sales. No monthly fee."
      >
        <Hint>{byInvoice ? 'Billed by invoice.' : 'No card now. You’ll add one before your first partner joins.'}</Hint>
      </Choice>
      <Choice
        name="wiz-plan"
        checked={plan === 'flex'}
        onSelect={() => setPlan('flex')}
        title="Flex"
        detail="$49 a month, plus 1.5% of partner-attributed sales."
      >
        <Hint>
          {byInvoice
            ? 'Billed by invoice. Start the plan from Billing when you’re ready.'
            : chargeOn
              ? `Card required. First charge on ${day(chargeOn)}, when your free trial ends.`
              : 'Card required. Your first month is charged today.'}
        </Hint>
      </Choice>
      {needsGstin && (
        <Field label="GSTIN" htmlFor="wiz-gstin">
          <Input id="wiz-gstin" value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} maxLength={15} />
          <Hint>OpenPartner bills businesses in India only when they are registered for GST.</Hint>
        </Field>
      )}
      <ErrorBanner error={save.error ? errorText(save.error) : null} />
      <Footer
        onBack={onBack}
        onNext={() => save.mutate()}
        nextLabel={toStripe ? 'Continue to Stripe' : 'Continue'}
        // A card Checkout refuses an Indian brand without a GSTIN.
        disabled={!plan || (toStripe && needsGstin && !gstin.trim())}
        busy={save.isPending}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Recap
// ---------------------------------------------------------------------------

function Recap({
  program,
  status,
  billing,
  listed,
  awaitingCheckout,
  onEdit,
  onFinish,
  finishing,
}: {
  program: WizardProgram | null;
  status: OnboardingStatus;
  billing: BillingStatus | null;
  /** The marketplace step applies to this brand. */
  listed: boolean;
  /** Just back from a completed Checkout: the webhook may not have landed. */
  awaitingCheckout: boolean;
  onEdit: (s: StepId) => void;
  onFinish: () => void;
  finishing: boolean;
}) {
  const currency = useDefaultCurrency();
  const qc = useQueryClient();
  const subscribed = !!billing?.subscribed;

  // Stripe redirects before its webhook reaches us: look again for a while.
  const [polls, setPolls] = useState(0);
  const confirming = awaitingCheckout && !subscribed && polls < 15;
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => {
      setPolls((n) => n + 1);
      void qc.invalidateQueries({ queryKey: BILLING_KEY });
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    }, 2000);
    return () => clearTimeout(t);
  }, [confirming, polls, qc]);

  const rule = program ? simpleRule(program.commissionRule) : null;
  const commission = !rule
    ? 'Custom rules'
    : `${rule.type === 'percent' ? `${rule.value}%` : money(rule.value, currency)} ${rule.recurring ? 'on every payment' : 'on the first payment'}`;
  const recruiter =
    program?.recruiterCommissionPercent != null ? `${Number(program.recruiterCommissionPercent)}% of a recruit’s commissions` : 'Off';
  const byInvoice = billing?.collection?.method === 'send_invoice';
  const chargeOn = billing?.trialEnd ? new Date(billing.trialEnd * 1000) : null;
  const planName = billing?.plan === 'flex' ? 'Flex' : billing?.plan === 'revshare' ? 'Revshare' : null;
  const planLine = !planName
    ? 'Not chosen'
    : subscribed
      ? `${planName}${chargeOn ? `, first charge on ${day(chargeOn)}` : ''}`
      : confirming
        ? `${planName}, confirming your payment method…`
        : awaitingCheckout
          ? `${planName}, still confirming. Check Billing in a minute.`
          : byInvoice
            ? `${planName}, start it from Billing`
            : `${planName}, add a card before your first partner`;

  return (
    <>
      <StepTitle>You’re set up</StepTitle>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {program && <RecapRow label="Program" value={program.name} detail={program.destinationUrl} onEdit={() => onEdit('program')} />}
        {program && <RecapRow label="Commission" value={commission} onEdit={() => onEdit('commission')} />}
        {program && <RecapRow label="Recruiter commission" value={recruiter} onEdit={() => onEdit('commission')} />}
        <RecapRow
          label="Tracking"
          value={status.trackingInstalled ? 'Verified' : 'Not verified yet'}
          tone={status.trackingInstalled ? 'done' : 'todo'}
          onEdit={() => onEdit('tracking')}
        />
        {listed && program && (
          <RecapRow
            label="Marketplace"
            value={program.shareOnNetwork ? 'Listed' : 'Private'}
            onEdit={() => onEdit('marketplace')}
          />
        )}
        {billing && billing.mode !== 'selfhost' && billing.plan !== 'enterprise' && (
          <RecapRow label="Plan" value={planLine} tone={subscribed ? 'done' : undefined} onEdit={subscribed ? undefined : () => onEdit('plan')} />
        )}
      </div>
      {status.approvalStatus === 'pending' && (
        <Hint>We’re reviewing your brand. Partners can join once it’s approved and your tracking is verified.</Hint>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
        <Button onClick={onFinish} disabled={finishing}>
          {finishing ? 'Opening…' : 'Go to dashboard'}
        </Button>
      </div>
    </>
  );
}

function RecapRow({
  label,
  value,
  detail,
  tone,
  onEdit,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'done' | 'todo';
  onEdit?: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        padding: '10px 0',
        borderTop: `1px solid ${theme.borderSubtle}`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: theme.textMuted }}>{label}</div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            marginTop: 2,
            color: tone === 'done' ? theme.success : tone === 'todo' ? theme.warn : theme.text,
            overflowWrap: 'anywhere',
          }}
        >
          {value}
        </div>
        {detail && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2, overflowWrap: 'anywhere' }}>{detail}</div>}
      </div>
      {onEdit && (
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Edit
        </Button>
      )}
    </div>
  );
}
