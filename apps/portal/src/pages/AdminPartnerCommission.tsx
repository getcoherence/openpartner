import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../api.js';
import { alpha, theme } from '../theme.js';
import { TenantLink } from '../tenant-link.js';
import { Button, Card, ErrorBanner, Input, Label, Page, SectionHeading } from '../ui.js';
import { CompoundRuleEditor, ruleEventTypeMissing, ruleSlabProblem, type CommissionSubRule } from '../lib/CompoundRuleEditor.js';
import { renderCommissionSummary } from '../lib/commission-summary.js';
import { useIsMobile } from '../lib/useMediaQuery.js';

interface Partner {
  id: string;
  name: string;
  email: string;
}

type CommissionSource = 'approval' | 'backfill' | 'amendment';

interface Snapshot {
  id?: string;
  partnerId: string;
  /** Null = partner-wide; set = terms for that one program. */
  programId?: string | null;
  /** Legacy single-rule summary. The engine ignores these whenever
   *  commissionRules is set. */
  commissionType: 'percent' | 'fixed';
  commissionValue: string; // decimal as string
  recurring: boolean;
  /** The terms the engine actually pays on. Null on snapshots that
   *  predate compound rules. */
  commissionRules: CommissionSubRule[] | null;
  holdbackDays: number | null;
  source: CommissionSource;
  snapshottedAt: string;
}

/** One row of GET /partners/:id/programs. */
interface ProgramTerms {
  id: string;
  name: string;
  granted: boolean;
  /** The program's own rule (always the array shape post-migration). */
  commissionRule: CommissionSubRule[] | null;
  holdbackDays: number | null;
  /** This partner's program-scoped terms, if any. */
  commission: Snapshot | null;
}

/** The rule array the engine resolves for this snapshot, with the same
 *  precedence as the API's resolveCommissionRule: the stored array when
 *  present, else the legacy columns as one every-event rule. */
function snapshotRules(snapshot: Snapshot): CommissionSubRule[] {
  if (snapshot.commissionRules && snapshot.commissionRules.length > 0) return snapshot.commissionRules;
  return [
    {
      trigger: 'every',
      type: snapshot.commissionType,
      value: Number(snapshot.commissionValue),
      recurring: snapshot.recurring,
    },
  ];
}

const DEFAULT_RULES: CommissionSubRule[] = [{ trigger: 'every', type: 'percent', value: 20, recurring: true }];

const SOURCE_LABEL: Record<CommissionSource, string> = {
  approval: 'Stamped at PartnershipRequest approval',
  backfill: 'Backfilled from current  Program rule',
  amendment: 'Admin override',
};

export function AdminPartnerCommission() {
  const { id } = useParams<{ id: string }>();
  const partnerId = id ?? '';
  const qc = useQueryClient();

  const partner = useQuery({
    queryKey: ['partner', partnerId],
    queryFn: () => api<Partner>(`/partners/${partnerId}`),
    enabled: !!partnerId,
  });

  const snapshot = useQuery({
    queryKey: ['partner-commission-snapshot', partnerId],
    queryFn: () => api<{ snapshot: Snapshot | null }>(`/partners/${partnerId}/commission-snapshot`),
    enabled: !!partnerId,
  });

  // Same query (and key) as the Programs page: every program in the
  // tenant with this partner's grant state and program-scoped terms.
  const programs = useQuery({
    queryKey: ['partner-campaigns', partnerId],
    queryFn: () => api<{ programs: ProgramTerms[] }>(`/partners/${partnerId}/programs`),
    enabled: !!partnerId,
  });

  const partnerName = partner.data?.name ?? '…';
  const partnerWide = snapshot.data?.snapshot ?? null;

  return (
    <Page
      title={`Commission · ${partnerName}`}
      subtitle="Override this partner's commission terms, for every program at once or for one program. Useful for VIP creators on a higher cut than the program default."
    >
      <div style={{ marginBottom: 14 }}>
        <TenantLink to="/admin/partners" style={{ color: theme.textMuted, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={14} /> Back to Partners
        </TenantLink>
      </div>
      <ErrorBanner error={partner.error ?? snapshot.error ?? programs.error} />
      {snapshot.isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <SectionHeading>Partner-wide default</SectionHeading>
          <CurrentSnapshotCard snapshot={partnerWide} />
          <div style={{ height: 14 }} />
          <EditCard
            scope="partner"
            endpoint={`/partners/${partnerId}/commission-snapshot`}
            current={partnerWide}
            fallbackRules={DEFAULT_RULES}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ['partner-commission-snapshot', partnerId] });
            }}
          />
          <SectionHeading>Per-program terms</SectionHeading>
          <ProgramTermsList
            partnerId={partnerId}
            programs={programs.data?.programs}
            loading={programs.isLoading}
            partnerWide={partnerWide}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ['partner-campaigns', partnerId] });
            }}
          />
        </>
      )}
    </Page>
  );
}

function CurrentSnapshotCard({ snapshot }: { snapshot: Snapshot | null }) {
  if (!snapshot) {
    return (
      <Card>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>No snapshot</div>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: 0, lineHeight: 1.5 }}>
          This partner has no partner-wide <code>PartnerCommission</code> row, so programs
          without their own terms below accrue at the program&rsquo;s live rate. Editing the
          program post-conversion would re-price their accruals — set an override below to
          grandfather their current rate and protect them from future program edits.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>Current snapshot</div>
      <div style={{ marginBottom: 14 }}>
        <Stat label="Terms" value={renderCommissionSummary(snapshotRules(snapshot))} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 }}>
        <Stat label="Holdback" value={snapshot.holdbackDays != null ? `${snapshot.holdbackDays} days` : '—'} />
        <Stat label="Source" value={SOURCE_LABEL[snapshot.source]} muted />
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: theme.textDim }}>
        Snapshotted {new Date(snapshot.snapshottedAt).toLocaleString()}
      </div>
    </Card>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: theme.textDim, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: muted ? 12 : 15, color: muted ? theme.textMuted : theme.text, marginTop: 2, lineHeight: 1.4 }}>
        {value}
      </div>
    </div>
  );
}

/** What a commission on this program pays, resolved the way the engine
 *  does: program-scoped terms → partner-wide → the program's own rule.
 *  Whichever terms win also set the holdback; terms that leave it blank
 *  use the program's (API: EFFECTIVE_HOLDBACK_SQL). */
function effectiveTerms(program: ProgramTerms, partnerWide: Snapshot | null) {
  const terms = program.commission ?? partnerWide;
  const source = program.commission ? 'program' : partnerWide ? 'partner' : 'rule';
  const rules = terms ? snapshotRules(terms) : (program.commissionRule ?? []);
  const holdbackDays = terms?.holdbackDays ?? program.holdbackDays;
  return { source, rules, holdbackDays } as const;
}

const EFFECTIVE_LABEL = {
  program: 'Program-specific terms',
  partner: 'Partner-wide default',
  rule: 'Program rule',
} as const;

function ProgramTermsList({
  partnerId,
  programs,
  loading,
  partnerWide,
  onSaved,
}: {
  partnerId: string;
  programs: ProgramTerms[] | undefined;
  loading: boolean;
  partnerWide: Snapshot | null;
  onSaved: () => void;
}) {
  const isMobile = useIsMobile();
  const [editing, setEditing] = useState<string | null>(null);
  // Granted programs, plus any program that still has terms after its
  // grant was revoked — so those can be seen and cleared.
  const rows = (programs ?? []).filter((p) => p.granted || p.commission);

  if (loading) return <Card>Loading…</Card>;
  if (rows.length === 0) {
    return (
      <Card>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: 0, lineHeight: 1.5 }}>
          This partner isn&rsquo;t granted any programs yet. Grant one on the Programs page to give it
          its own terms.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <p style={{ fontSize: 12, color: theme.textMuted, margin: '0 0 14px', lineHeight: 1.5 }}>
        Terms set here apply to that program only and win over the partner-wide default. Programs
        without their own terms use the partner-wide default, or the program&rsquo;s rule when there
        isn&rsquo;t one.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((p) => {
          const eff = effectiveTerms(p, partnerWide);
          const open = editing === p.id;
          return (
            <div
              key={p.id}
              style={{
                padding: '10px 12px',
                background: p.commission ? alpha(theme.success, 0.063) : theme.surface2,
                border: `1px solid ${p.commission ? alpha(theme.success, 0.267) : theme.borderSubtle}`,
                borderRadius: theme.radiusSm,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: isMobile ? 'column' : 'row',
                  alignItems: isMobile ? 'stretch' : 'center',
                  gap: isMobile ? 8 : 12,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    {p.name}
                    {!p.granted && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: theme.textMuted, fontWeight: 400 }}>
                        not granted
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2, lineHeight: 1.4 }}>
                    <span style={{ color: theme.textDim }}>{EFFECTIVE_LABEL[eff.source]}:</span>{' '}
                    {renderCommissionSummary(eff.rules)}
                    {' · '}
                    {eff.holdbackDays ? `${eff.holdbackDays}-day holdback` : 'no holdback'}
                  </div>
                </div>
                <Button variant="secondary" onClick={() => setEditing(open ? null : p.id)}>
                  {open ? 'Close' : p.commission ? 'Edit terms' : 'Set terms'}
                </Button>
              </div>
              {open && (
                <div style={{ marginTop: 12 }}>
                  <EditCard
                    scope="program"
                    endpoint={`/partners/${partnerId}/programs/${p.id}/commission`}
                    current={p.commission}
                    fallbackRules={eff.rules.length > 0 ? eff.rules : DEFAULT_RULES}
                    fallbackHoldback={eff.holdbackDays}
                    onSaved={() => {
                      setEditing(null);
                      onSaved();
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const SCOPE_COPY = {
  partner: {
    title: (hasCurrent: boolean) => (hasCurrent ? 'Edit override' : 'Set override'),
    save: (hasCurrent: boolean) => (hasCurrent ? 'Update override' : 'Set override'),
    clear: 'Clear override',
    clearing: 'Clearing…',
    confirm: 'Clear this partner’s partner-wide override? Programs without their own terms fall back to the live program rule.',
    holdback: "Holdback (days, blank = program's)",
    applies: 'this partner’s commissions on every program without its own terms accrue on the terms below',
  },
  program: {
    title: (hasCurrent: boolean) => (hasCurrent ? 'Edit program terms' : 'Set program terms'),
    save: () => 'Save program terms',
    clear: 'Clear program terms',
    clearing: 'Clearing…',
    confirm: 'Clear this program’s terms? Its commissions fall back to the partner-wide default, or the program rule.',
    holdback: "Holdback (days, blank = program's)",
    applies: 'this partner’s commissions on this program accrue on the terms below, whatever the partner-wide default or program rule says',
  },
} as const;

function EditCard({
  scope,
  endpoint,
  current,
  fallbackRules,
  fallbackHoldback = null,
  onSaved,
}: {
  scope: 'partner' | 'program';
  endpoint: string;
  current: Snapshot | null;
  /** Editor's starting rules when there's no row yet. */
  fallbackRules: CommissionSubRule[];
  /** Editor's starting holdback when there's no row yet. Program terms
   *  start from the holdback the program gets today, so saving them
   *  doesn't silently drop a longer partner-wide holdback: a blank one
   *  would mean the program's own. */
  fallbackHoldback?: number | null;
  onSaved: () => void;
}) {
  const copy = SCOPE_COPY[scope];
  const startHoldback = () => {
    const days = current ? current.holdbackDays : fallbackHoldback;
    return days != null ? String(days) : '';
  };
  // Edits the snapshot's full rule array. This form used to show only
  // the legacy single-rule columns and PUT without commissionRules, which
  // the API reads as "replace with a single rule" and clears the stored
  // array, so saving any edit silently dropped a partner's compound
  // terms (first-sale bonus, event filters, recurring caps).
  const [rules, setRules] = useState<CommissionSubRule[]>(current ? snapshotRules(current) : fallbackRules);
  const [holdback, setHoldback] = useState(startHoldback);

  // Re-sync the form when the underlying snapshot changes (e.g. after
  // the user just saved). Without this the form would keep showing
  // the pre-save values until a hard refresh. Keyed on `current` only:
  // the fallbacks are recomputed each render.
  useEffect(() => {
    setRules(current ? snapshotRules(current) : fallbackRules);
    setHoldback(startHoldback());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const rulesInvalid =
    rules.length === 0 ||
    rules.some((r) => !Number.isFinite(r.value) || r.value < 0 || ruleEventTypeMissing(r) || ruleSlabProblem(r) !== null);

  const save = useMutation({
    mutationFn: () => {
      // The legacy columns are still NOT NULL. Fill them with the same
      // best-effort summary the approval-time snapshot uses (first
      // every-event rule, else the first rule); the engine reads
      // commissionRules.
      const summary = rules.find((r) => r.trigger === 'every') ?? rules[0]!;
      return api(endpoint, {
        method: 'PUT',
        body: {
          commissionType: summary.type,
          commissionValue: summary.value,
          recurring: summary.recurring ?? false,
          commissionRules: rules,
          holdbackDays: holdback === '' ? null : Number(holdback),
        },
      });
    },
    onSuccess: onSaved,
  });

  const clear = useMutation({
    mutationFn: () => api(endpoint, { method: 'DELETE' }),
    onSuccess: onSaved,
  });

  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{copy.title(!!current)}</div>
      <p style={{ fontSize: 12, color: theme.textMuted, margin: '0 0 14px', lineHeight: 1.5 }}>
        Stamps a <code>PartnerCommission</code> row with{' '}
        <code>source = &lsquo;amendment&rsquo;</code>. From the next conversion onward, {copy.applies}.
        Past commissions aren&rsquo;t recomputed — only future events.
      </p>
      <ErrorBanner error={save.error ?? clear.error} />
      <CompoundRuleEditor rules={rules} onChange={setRules} />
      <div style={{ marginBottom: 14, maxWidth: 220 }}>
        <Label>{copy.holdback}</Label>
        <Input
          type="number"
          value={holdback}
          onChange={(e) => setHoldback(e.target.value)}
          placeholder="0"
        />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button onClick={() => save.mutate()} disabled={save.isPending || rulesInvalid}>
          {save.isPending ? 'Saving…' : copy.save(!!current)}
        </Button>
        {current && (
          <button
            type="button"
            onClick={() => {
              if (confirm(copy.confirm)) {
                clear.mutate();
              }
            }}
            disabled={clear.isPending}
            style={{
              background: 'transparent',
              border: `1px solid ${alpha(theme.danger, 0.333)}`,
              borderRadius: 6,
              padding: '8px 14px',
              fontSize: 13,
              color: theme.danger,
              cursor: 'pointer',
            }}
          >
            {clear.isPending ? copy.clearing : copy.clear}
          </button>
        )}
      </div>
    </Card>
  );
}
