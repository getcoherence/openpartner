import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../api.js';
import { alpha, theme } from '../theme.js';
import { TenantLink } from '../tenant-link.js';
import { Button, Card, ErrorBanner, Input, Label, Page } from '../ui.js';
import { CompoundRuleEditor, ruleEventTypeMissing, type CommissionSubRule } from '../lib/CompoundRuleEditor.js';
import { renderCommissionSummary } from '../lib/commission-summary.js';

interface Partner {
  id: string;
  name: string;
  email: string;
}

type CommissionSource = 'approval' | 'backfill' | 'amendment';

interface Snapshot {
  partnerId: string;
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

  const partnerName = partner.data?.name ?? '…';

  return (
    <Page
      title={`Commission · ${partnerName}`}
      subtitle="Override this partner's commission rate or holdback. Useful for VIP creators on a higher cut than the campaign default."
    >
      <div style={{ marginBottom: 14 }}>
        <TenantLink to="/admin/partners" style={{ color: theme.textMuted, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={14} /> Back to Partners
        </TenantLink>
      </div>
      <ErrorBanner error={partner.error ?? snapshot.error} />
      {snapshot.isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <CurrentSnapshotCard snapshot={snapshot.data?.snapshot ?? null} />
          <div style={{ height: 14 }} />
          <EditCard
            partnerId={partnerId}
            current={snapshot.data?.snapshot ?? null}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ['partner-commission-snapshot', partnerId] });
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
          This partner has no <code>PartnerCommission</code> row, so commissions accrue at
          their bound campaign&rsquo;s live rate. Editing the campaign post-conversion would
          re-price their accruals — set an override below to grandfather their current rate
          and protect them from future campaign edits.
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

function EditCard({
  partnerId,
  current,
  onSaved,
}: {
  partnerId: string;
  current: Snapshot | null;
  onSaved: () => void;
}) {
  // Edits the snapshot's full rule array. This form used to show only
  // the legacy single-rule columns and PUT without commissionRules, which
  // the API reads as "replace with a single rule" and clears the stored
  // array, so saving any edit silently dropped a partner's compound
  // terms (first-sale bonus, event filters, recurring caps).
  const [rules, setRules] = useState<CommissionSubRule[]>(current ? snapshotRules(current) : DEFAULT_RULES);
  const [holdback, setHoldback] = useState(
    current?.holdbackDays != null ? String(current.holdbackDays) : '',
  );

  // Re-sync the form when the underlying snapshot changes (e.g. after
  // the user just saved). Without this the form would keep showing
  // the pre-save values until a hard refresh.
  useEffect(() => {
    setRules(current ? snapshotRules(current) : DEFAULT_RULES);
    setHoldback(current?.holdbackDays != null ? String(current.holdbackDays) : '');
  }, [current]);

  const rulesInvalid =
    rules.length === 0 || rules.some((r) => !Number.isFinite(r.value) || r.value < 0 || ruleEventTypeMissing(r));

  const save = useMutation({
    mutationFn: () => {
      // The legacy columns are still NOT NULL. Fill them with the same
      // best-effort summary the approval-time snapshot uses (first
      // every-event rule, else the first rule); the engine reads
      // commissionRules.
      const summary = rules.find((r) => r.trigger === 'every') ?? rules[0]!;
      return api(`/partners/${partnerId}/commission-snapshot`, {
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
    mutationFn: () =>
      api(`/partners/${partnerId}/commission-snapshot`, { method: 'DELETE' }),
    onSuccess: onSaved,
  });

  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
        {current ? 'Edit override' : 'Set override'}
      </div>
      <p style={{ fontSize: 12, color: theme.textMuted, margin: '0 0 14px', lineHeight: 1.5 }}>
        Stamps a <code>PartnerCommission</code> row with{' '}
        <code>source = &lsquo;amendment&rsquo;</code>. From the next conversion onward, this
        partner&rsquo;s commissions accrue on the terms below regardless of the campaign rule.
        Past commissions aren&rsquo;t recomputed — only future events.
      </p>
      <ErrorBanner error={save.error ?? clear.error} />
      <CompoundRuleEditor rules={rules} onChange={setRules} />
      <div style={{ marginBottom: 14, maxWidth: 220 }}>
        <Label>Holdback (days, blank = none)</Label>
        <Input
          type="number"
          value={holdback}
          onChange={(e) => setHoldback(e.target.value)}
          placeholder="0"
        />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => save.mutate()} disabled={save.isPending || rulesInvalid}>
          {save.isPending ? 'Saving…' : current ? 'Update override' : 'Set override'}
        </Button>
        {current && (
          <button
            type="button"
            onClick={() => {
              if (confirm('Clear this partner’s override? They’ll fall back to the live campaign rule.')) {
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
            {clear.isPending ? 'Clearing…' : 'Clear override'}
          </button>
        )}
      </div>
    </Card>
  );
}
