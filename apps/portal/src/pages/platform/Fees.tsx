import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Table, Textarea, formatDate, money } from '../../ui.js';
import {
  papi,
  friendlyPlatformError,
  type ContractStatement,
  type FeeEstimate,
  type FeeReviewSignals,
  type FeeRuleSettings,
  type FeesState,
  type FeeTenantStatus,
  type NoticeRun,
  type PlatformOperator,
} from './lib.js';

const PLAN_LABEL: Record<'flat' | 'revshare', string> = { flat: 'Flex', revshare: 'Revshare' };

/** Tenant.billingPlan for display. Enterprise meters as `flat`, so label
 *  from the plan, never the mode. */
function planLabel(plan: string | null): string {
  if (plan === 'flex') return 'Flex';
  if (plan === 'revshare') return 'Revshare';
  if (plan === 'enterprise') return 'Enterprise';
  return plan ?? '—';
}

function pct(rate: number): string {
  return `${Number((rate * 100).toFixed(3))}%`;
}

/** Fraction → percent text field, without float noise (0.035 → "3.5"). */
function rateField(rate: number): string {
  return String(Number((rate * 100).toFixed(4)));
}

/** Percent text field ↔ fraction. */
function toRate(text: string): number | null {
  const n = Number(text);
  return text.trim() === '' || !Number.isFinite(n) || n < 0 || n > 100 ? null : n / 100;
}

/** Effective dates are UTC midnights (period boundaries, the contract
 *  date): show the UTC day, as the notice email does, not the local one. */
function utcDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const muted = { fontSize: 13, color: theme.textMuted, lineHeight: 1.5 } as const;
const sectionTitle = { fontSize: 15, fontWeight: 600 } as const;

/**
 * The commission-floor platform fee: its settings, who is on which rule,
 * the shadow comparison and live estimate, the pricing-change notice, contract
 * terms, and review signals. docs/platform-fee.md explains the rule.
 */
export function FeesPage({ operator }: { operator: PlatformOperator }) {
  const canWrite = operator.role === 'admin';
  const state = useQuery({ queryKey: ['platform-fees'], queryFn: () => papi<FeesState>('/platform-admin/fees') });

  return (
    <Page
      title="Platform fee"
      subtitle="Per conversion: max(revenue rate × revenue, commission rate × commissions). Nothing changes for a brand until its plan starts after the cutover, or its pricing notice runs out."
    >
      <ErrorBanner error={state.error} />
      {state.isLoading || !state.data ? (
        <Card>Loading…</Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SettingsCard state={state.data} canWrite={canWrite} />
          <TenantsCard state={state.data} canWrite={canWrite} />
          <EstimateCard tenants={state.data.tenants} />
          <NoticeCard state={state.data} canWrite={canWrite} />
          <SignalsCard />
        </div>
      )}
    </Page>
  );
}

function SettingsCard({ state, canWrite }: { state: FeesState; canWrite: boolean }) {
  const qc = useQueryClient();
  const s = state.settings;
  const [cutover, setCutover] = useState(s.cutoverAt ? s.cutoverAt.slice(0, 16) : '');
  const [rates, setRates] = useState({
    flat: { revenueRate: rateField(s.rates.flat.revenueRate), commissionRate: rateField(s.rates.flat.commissionRate) },
    revshare: { revenueRate: rateField(s.rates.revshare.revenueRate), commissionRate: rateField(s.rates.revshare.commissionRate) },
  });
  const save = useMutation({
    mutationFn: (patch: Partial<Omit<FeeRuleSettings, 'rates'>> & { rates?: FeeRuleSettings['rates'] }) =>
      papi('/platform-admin/fees/settings', { method: 'PUT', body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-fees'] }),
  });

  function saveRates() {
    const next = {
      flat: { revenueRate: toRate(rates.flat.revenueRate), commissionRate: toRate(rates.flat.commissionRate) },
      revshare: { revenueRate: toRate(rates.revshare.revenueRate), commissionRate: toRate(rates.revshare.commissionRate) },
    };
    if (Object.values(next).some((r) => r.revenueRate === null || r.commissionRate === null)) {
      window.alert('Rates are percentages between 0 and 100.');
      return;
    }
    if (window.confirm('New rates apply to conversions first billed from now on, for brands on the new rule. Already-billed conversions keep theirs. Save?')) {
      save.mutate({ rates: next as FeeRuleSettings['rates'] });
    }
  }

  function saveCutover(clear: boolean) {
    // The field is UTC (it's prefilled from the stored UTC instant), so
    // don't let the browser read it as local time.
    const at = clear ? null : new Date(`${cutover}Z`);
    if (at && Number.isNaN(at.getTime())) return;
    const msg = at
      ? `Set the cutover to ${at.toUTCString()}? Paid plans starting from then are billed on the new rule from day one.`
      : 'Clear the cutover? Brands already moved stay moved; no more move automatically.';
    if (window.confirm(msg)) save.mutate({ cutoverAt: at ? at.toISOString() : null });
  }

  return (
    <Card>
      <div style={sectionTitle}>Rule settings</div>
      <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : null} />
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
        <div>
          <Label>Shadow comparison</Label>
          <div style={muted}>
            On every usage report of a brand still on the old rule, also record what the new rule would bill. Billing is unchanged.
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: s.shadow ? theme.success : theme.textMuted }}>{s.shadow ? 'on' : 'off'}</span>
            {canWrite && (
              <Button size="sm" variant="secondary" disabled={save.isPending} onClick={() => save.mutate({ shadow: !s.shadow })}>
                {s.shadow ? 'Turn off' : 'Turn on'}
              </Button>
            )}
          </div>
        </div>
        <div>
          <Label>Cutover (UTC)</Label>
          <div style={muted}>
            Paid plans that start at or after this are billed on the new rule from day one. Older plans move only after their pricing notice. Publish the pricing page and Terms first.
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Input type="datetime-local" value={cutover} disabled={!canWrite} onChange={(e) => setCutover(e.target.value)} style={{ maxWidth: 240 }} />
            {canWrite && (
              <>
                <Button size="sm" disabled={save.isPending || !cutover} onClick={() => saveCutover(false)}>
                  Set
                </Button>
                {s.cutoverAt && (
                  <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => saveCutover(true)}>
                    Clear
                  </Button>
                )}
              </>
            )}
          </div>
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
            {s.cutoverAt ? `Set: ${new Date(s.cutoverAt).toUTCString()}` : 'Not set: no brand moves automatically.'}
          </div>
        </div>
      </div>

      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        {(['revshare', 'flat'] as const).map((mode) => {
          const rr = toRate(rates[mode].revenueRate);
          const cr = toRate(rates[mode].commissionRate);
          return (
            <div key={mode} style={{ border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{PLAN_LABEL[mode]}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <div style={{ flex: 1 }}>
                  <Label>Revenue rate %</Label>
                  <Input
                    value={rates[mode].revenueRate}
                    disabled={!canWrite}
                    onChange={(e) => setRates({ ...rates, [mode]: { ...rates[mode], revenueRate: e.target.value } })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Label>Commission floor %</Label>
                  <Input
                    value={rates[mode].commissionRate}
                    disabled={!canWrite}
                    onChange={(e) => setRates({ ...rates, [mode]: { ...rates[mode], commissionRate: e.target.value } })}
                  />
                </div>
              </div>
              <div style={{ fontSize: 12, color: theme.textDim, marginTop: 8, lineHeight: 1.5 }}>
                {rr !== null && cr ? `Honest programs paying up to ${pct(rr / cr)} commission pay exactly ${pct(rr)} of revenue. ` : ''}
                Stripe price: {pct(state.meterRates[mode])} per unit of basis; the basis is the fee ÷ {pct(state.meterRates[mode])}.
              </div>
            </div>
          );
        })}
      </div>
      {canWrite && (
        <div style={{ marginTop: 12 }}>
          <Button size="sm" variant="secondary" disabled={save.isPending} onClick={saveRates}>
            Save rates
          </Button>
        </div>
      )}
    </Card>
  );
}

function ruleLabel(t: FeeTenantStatus): string {
  if (t.rule === 'old') return 'Old rule';
  const when = t.effectiveAt && new Date(t.effectiveAt).getTime() > 0 ? utcDate(t.effectiveAt) : 'first conversion';
  const why = t.effectiveSource === 'new_plan' ? 'new plan' : t.effectiveSource === 'notice' ? 'notice' : 'contract';
  return t.rule === 'scheduled' ? `Moves ${when} (${why})` : `New rule since ${when} (${why})`;
}

function TenantsCard({ state, canWrite }: { state: FeesState; canWrite: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const rows = state.tenants;
  return (
    <Card>
      <div style={sectionTitle}>Brands</div>
      <div style={{ ...muted, marginTop: 4 }}>
        Shadow columns sum the last 30 days of usage reports while shadow comparison is on: what the old rule billed and what the new one would have.
      </div>
      <div style={{ marginTop: 12 }}>
        <Table
          columns={['Brand', 'Plan', 'Rule', 'Rates', { label: 'Old fee (30d)', align: 'right' }, { label: 'New fee (30d)', align: 'right' }, 'Floor / renamed', '']}
          empty="No hosted brands."
          // The table never wraps by itself (max-content), so the wordy
          // cells get a width to wrap at: eight columns must leave the
          // Contract button on screen at a 1280px laptop width.
          rows={rows.map((t) => [
            <div key="b" style={{ minWidth: 0, maxWidth: 170 }}>
              <div style={{ fontSize: 13 }}>{t.displayName}</div>
              <div style={{ fontSize: 12, color: theme.textDim }}>/t/{t.slug}/</div>
            </div>,
            <span key="p" style={{ fontSize: 13 }}>
              {planLabel(t.plan)}
              {!t.subscribed && t.plan !== 'enterprise' ? <div style={{ fontSize: 12, color: theme.textDim }}>no subscription</div> : null}
            </span>,
            <div key="r" style={{ fontSize: 12.5, maxWidth: 150, color: t.rule === 'old' ? theme.textMuted : theme.text }}>
              {ruleLabel(t)}
              {t.noticeSentAt ? <div style={{ color: theme.textDim }}>noticed {formatDate(t.noticeSentAt)}</div> : null}
            </div>,
            <span key="rt" style={{ fontSize: 12.5 }}>
              {pct(t.revenueRate)} / {pct(t.commissionRate)}
              {t.contract ? <div style={{ color: theme.accentText }}>contract</div> : null}
              {t.monthlyMinimumUsd !== null ? <div style={{ color: theme.textDim }}>min {money(t.monthlyMinimumUsd)}/mo</div> : null}
            </span>,
            t.shadow ? money(t.shadow.oldFeeUsd) : '—',
            t.shadow ? (
              <span key="n" style={{ color: t.shadow.newFeeUsd > t.shadow.oldFeeUsd ? theme.warn : theme.text }}>{money(t.shadow.newFeeUsd)}</span>
            ) : (
              '—'
            ),
            t.shadow ? `${t.shadow.floorConversions} / ${t.shadow.renamedSaleConversions}` : '—',
            canWrite ? (
              <Button key="e" size="sm" variant="ghost" onClick={() => setEditing(editing === t.tenantId ? null : t.tenantId)}>
                {editing === t.tenantId ? 'Close' : 'Contract'}
              </Button>
            ) : null,
          ])}
        />
      </div>
      {/* Keyed by brand: switching brands must not carry the last one's
          typed terms (or statement) over to the next. */}
      {editing && <ContractEditor key={editing} tenant={rows.find((t) => t.tenantId === editing)!} onDone={() => setEditing(null)} />}
    </Card>
  );
}

function ContractEditor({ tenant, onDone }: { tenant: FeeTenantStatus; onDone: () => void }) {
  const qc = useQueryClient();
  const [rr, setRr] = useState(tenant.contract ? rateField(tenant.revenueRate) : '');
  const [cr, setCr] = useState(tenant.contract ? rateField(tenant.commissionRate) : '');
  const [minimum, setMinimum] = useState(tenant.monthlyMinimumUsd === null ? '' : String(tenant.monthlyMinimumUsd));
  const [effective, setEffective] = useState(tenant.effectiveSource === 'contract' && tenant.effectiveAt ? tenant.effectiveAt.slice(0, 10) : '');
  const [note, setNote] = useState(tenant.contractNote ?? '');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const save = useMutation({
    mutationFn: () =>
      papi(`/platform-admin/fees/contracts/${tenant.tenantId}`, {
        method: 'PUT',
        body: {
          revenueRate: rr.trim() === '' ? null : toRate(rr),
          commissionRate: cr.trim() === '' ? null : toRate(cr),
          monthlyMinimumUsd: minimum.trim() === '' ? null : Number(minimum),
          effectiveAt: effective ? new Date(`${effective}T00:00:00Z`).toISOString() : null,
          note: note.trim() || null,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform-fees'] });
      onDone();
    },
  });
  const statement = useMutation({
    mutationFn: () => papi<ContractStatement>(`/platform-admin/fees/contracts/${tenant.tenantId}/statement?month=${month}`),
  });

  return (
    <div style={{ marginTop: 14, borderTop: `1px solid ${theme.borderSubtle}`, paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>Contract terms: {tenant.displayName}</div>
      <div style={{ ...muted, marginTop: 4 }}>
        Blank rates use the plan’s. A monthly minimum needs the Enterprise plan: Enterprise is invoiced by hand from the statement below, never through Stripe. The effective date moves conversions first attributed from then on to these terms.
      </div>
      <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : statement.error ? friendlyPlatformError(statement.error) : null} />
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 10 }}>
        <div>
          <Label>Revenue rate %</Label>
          <Input value={rr} onChange={(e) => setRr(e.target.value)} placeholder={pct(tenant.revenueRate)} />
        </div>
        <div>
          <Label>Commission rate %</Label>
          <Input value={cr} onChange={(e) => setCr(e.target.value)} placeholder={pct(tenant.commissionRate)} />
        </div>
        <div>
          <Label>Monthly minimum (USD)</Label>
          <Input value={minimum} onChange={(e) => setMinimum(e.target.value)} placeholder="none" />
        </div>
        <div>
          <Label>Effective from (UTC date)</Label>
          <Input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Label>Note</Label>
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Contract reference" />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save terms'}
        </Button>
        <span style={{ width: 16 }} />
        <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 170 }} />
        <Button size="sm" variant="secondary" disabled={statement.isPending} onClick={() => statement.mutate()}>
          {statement.isPending ? 'Working…' : 'Statement'}
        </Button>
      </div>
      {statement.data && (
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.7 }}>
          <div>
            {statement.data.conversions} conversion{statement.data.conversions === 1 ? '' : 's'} · revenue{' '}
            {Object.entries(statement.data.revenueByCurrency).map(([c, a]) => money(a, c)).join(' + ') || '—'} · commissions{' '}
            {Object.entries(statement.data.commissionsByCurrency).map(([c, a]) => money(a, c)).join(' + ') || '—'}
          </div>
          <div>
            Fee {money(statement.data.feeUsd)}
            {statement.data.minimumTopUpUsd > 0 ? ` + minimum top-up ${money(statement.data.minimumTopUpUsd)}` : ''} ={' '}
            <strong>{money(statement.data.amountOwedUsd)} owed</strong> for {statement.data.month}
          </div>
          {statement.data.heldOut && (
            <div style={{ color: theme.warn }}>No ECB rate for: {Object.keys(statement.data.heldOut).join(', ')}. Bill those by hand.</div>
          )}
          <div style={{ fontSize: 12, color: theme.textDim }}>
            Live from the raw data: a refund recorded later changes it. Invoice once the month’s refund window has closed.
          </div>
        </div>
      )}
    </div>
  );
}

function EstimateCard({ tenants }: { tenants: FeeTenantStatus[] }) {
  const [days, setDays] = useState('90');
  const planOf = new Map(tenants.map((t) => [t.tenantId, t.plan]));
  const run = useMutation({
    mutationFn: () => papi<{ days: number; estimates: FeeEstimate[] }>('/platform-admin/fees/estimate', { method: 'POST', body: { days: Number(days) || 90 } }),
  });
  const totals = run.data?.estimates.reduce((acc, e) => ({ old: acc.old + e.oldFeeUsd, next: acc.next + e.newFeeUsd }), { old: 0, next: 0 });
  return (
    <Card>
      <div style={sectionTitle}>Estimate</div>
      <div style={{ ...muted, marginTop: 4 }}>
        Compares the two rules live over every hosted brand’s conversions first attributed in the window, at its rates. Read-only. No need to wait for shadow rows.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <Input value={days} onChange={(e) => setDays(e.target.value)} style={{ maxWidth: 90 }} />
        <span style={muted}>days</span>
        <Button size="sm" variant="secondary" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? 'Working…' : 'Estimate'}
        </Button>
      </div>
      <ErrorBanner error={run.error ? friendlyPlatformError(run.error) : null} />
      {run.data && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            {run.data.estimates.length} brand{run.data.estimates.length === 1 ? '' : 's'} with conversions · old {money(totals!.old)} → new {money(totals!.next)} over {run.data.days} days
          </div>
          <Table
            columns={['Brand', 'Plan', { label: 'Conversions', align: 'right' }, { label: 'Old fee', align: 'right' }, { label: 'New fee', align: 'right' }, 'Floor / renamed']}
            empty="No conversions in the window."
            rows={run.data.estimates.map((e) => [
              `/t/${e.slug}/`,
              planOf.has(e.tenantId) ? planLabel(planOf.get(e.tenantId)!) : e.mode === 'flat' ? 'Flex' : 'Revshare',
              String(e.conversions),
              money(e.oldFeeUsd),
              <span key="n" style={{ color: e.newFeeUsd > e.oldFeeUsd ? theme.warn : theme.text }}>{money(e.newFeeUsd)}</span>,
              `${e.floorConversions} / ${e.renamedSaleConversions}`,
            ])}
          />
        </div>
      )}
    </Card>
  );
}

function NoticeCard({ state, canWrite }: { state: FeesState; canWrite: boolean }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<NoticeRun | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => papi<NoticeRun>('/platform-admin/fees/notices', { method: 'POST', body: { dryRun } }),
    onSuccess: (r) => {
      setResult(r);
      if (!r.dryRun) qc.invalidateQueries({ queryKey: ['platform-fees'] });
    },
  });
  const ready = result?.dryRun ? (result.candidates ?? []).filter((c) => !c.error) : [];
  return (
    <Card>
      <div style={sectionTitle}>Pricing-change notice</div>
      <div style={{ ...muted, marginTop: 4 }}>
        Emails every active admin of each brand whose paid plan started before the cutover. The brand moves to the new rule {state.noticeDays} days later, at the start of its next Stripe billing period, as the Terms require. An essential service notice: no unsubscribe link. Nothing is sent until you click send.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <Button size="sm" variant="secondary" disabled={run.isPending} onClick={() => run.mutate(true)}>
          {run.isPending && run.variables === true ? 'Checking…' : 'Preview'}
        </Button>
        {canWrite && ready.length > 0 && (
          <Button
            size="sm"
            disabled={run.isPending}
            onClick={() => {
              const people = ready.reduce((n, c) => n + c.recipients.length, 0);
              if (window.confirm(`Send the pricing-change notice to ${people} admin${people === 1 ? '' : 's'} of ${ready.length} brand${ready.length === 1 ? '' : 's'}? Their effective dates start counting now.`)) {
                run.mutate(false);
              }
            }}
          >
            {run.isPending && run.variables === false ? 'Sending…' : `Send to ${ready.length} brand${ready.length === 1 ? '' : 's'}`}
          </Button>
        )}
      </div>
      <ErrorBanner error={run.error ? friendlyPlatformError(run.error) : null} />
      {result?.dryRun && (
        <div style={{ marginTop: 12 }}>
          {!result.cutoverAt && <div style={{ ...muted, color: theme.warn }}>No cutover set: set one above before sending.</div>}
          <Table
            columns={['Brand', 'Recipients', 'Rates', 'Effective', '']}
            empty="No brand is owed a notice."
            rows={(result.candidates ?? []).map((c) => [
              `/t/${c.slug}/`,
              <span key="r" style={{ fontSize: 12.5 }}>{c.recipients.map((r) => r.email).join(', ') || '—'}</span>,
              `${pct(c.revenueRate)} / ${pct(c.commissionRate)}`,
              c.effectiveAt ? utcDate(c.effectiveAt) : '—',
              c.error ? <span key="e" style={{ fontSize: 12.5, color: theme.danger }}>{c.error}</span> : null,
            ])}
          />
          {result.sample && (
            <div style={{ marginTop: 12 }}>
              <Label>Email to {result.sample.to}</Label>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{result.sample.subject}</div>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, fontFamily: theme.fontSans, color: theme.textMuted, background: theme.surface2, padding: 12, borderRadius: theme.radiusSm, margin: 0 }}>
                {result.sample.text}
              </pre>
            </div>
          )}
        </div>
      )}
      {result && !result.dryRun && (
        <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.6 }}>
          Sent to {result.sent?.length ?? 0} brand{result.sent?.length === 1 ? '' : 's'}
          {result.failed?.length ? `, ${result.failed.length} failed (${result.failed.map((f) => f.slug).join(', ')})` : ''}
          {result.skipped?.length ? `, ${result.skipped.length} skipped` : ''}.
          {(result.sent ?? []).some((s) => s.failedRecipients.length > 0) && (
            <div style={{ color: theme.warn }}>
              Some admins couldn’t be reached:{' '}
              {(result.sent ?? []).flatMap((s) => s.failedRecipients).join(', ')}. The notice counts as given to the rest.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SignalsCard() {
  const signals = useMutation({ mutationFn: () => papi<FeeReviewSignals>('/platform-admin/fees/signals?days=60') });
  const d = signals.data;
  return (
    <Card>
      <div style={sectionTitle}>Review signals</div>
      <div style={{ ...muted, marginTop: 4 }}>
        Reasons to look closer, never automatic actions: brands with traffic but no commission at all, revenue conversions whose commission exceeds their value, and conversion rates far below other brands. Last 60 days.
      </div>
      <div style={{ marginTop: 10 }}>
        <Button size="sm" variant="secondary" disabled={signals.isPending} onClick={() => signals.mutate()}>
          {signals.isPending ? 'Checking…' : d ? 'Refresh' : 'Check'}
        </Button>
      </div>
      <ErrorBanner error={signals.error ? friendlyPlatformError(signals.error) : null} />
      {d && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
          <div>
            <Label>Identified signups or clicks, no commission-bearing conversions</Label>
            <Table
              columns={['Brand', { label: 'Clicks', align: 'right' }, { label: 'Identified users', align: 'right' }]}
              empty="None."
              rows={d.noCommissionActivity.map((r) => [`/t/${r.slug}/`, String(r.clicks), String(r.identities)])}
            />
          </div>
          <div>
            <Label>Revenue conversions where commission exceeds value</Label>
            <Table
              columns={['Brand', { label: 'Conversions', align: 'right' }, 'Latest events']}
              empty="None."
              rows={d.commissionAboveValue.map((r) => [
                `/t/${r.slug}/`,
                String(r.events),
                <span key="s" style={{ fontFamily: theme.fontMono, fontSize: 12 }}>{r.sampleEventIds.join(' ')}</span>,
              ])}
            />
          </div>
          <div>
            <Label>
              Conversion rate far below peers
              {d.lowConversion.peerMedian !== null
                ? ` (peer median ${(d.lowConversion.peerMedian * 100).toFixed(2)}% over ${d.lowConversion.peers} brands)`
                : ` (needs 3+ brands with 200+ clicks; ${d.lowConversion.peers} so far)`}
            </Label>
            <Table
              columns={['Brand', { label: 'Clicks', align: 'right' }, { label: 'Conversions', align: 'right' }, { label: 'Rate', align: 'right' }]}
              empty="None."
              rows={d.lowConversion.tenants.map((r) => [`/t/${r.slug}/`, String(r.clicks), String(r.conversions), `${(r.rate * 100).toFixed(2)}%`])}
            />
          </div>
        </div>
      )}
    </Card>
  );
}
