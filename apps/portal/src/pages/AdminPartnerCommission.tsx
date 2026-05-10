import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../api.js';
import { theme } from '../theme.js';
import { TenantLink } from '../tenant-link.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select } from '../ui.js';

interface Partner {
  id: string;
  name: string;
  email: string;
}

type CommissionSource = 'approval' | 'backfill' | 'amendment';

interface Snapshot {
  partnerId: string;
  commissionType: 'percent' | 'fixed';
  commissionValue: string; // decimal as string
  recurring: boolean;
  holdbackDays: number | null;
  source: CommissionSource;
  snapshottedAt: string;
}

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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 }}>
        <Stat
          label="Rate"
          value={
            snapshot.commissionType === 'percent'
              ? `${Number(snapshot.commissionValue)}%`
              : `$${Number(snapshot.commissionValue).toFixed(2)} fixed`
          }
        />
        <Stat label="Recurring" value={snapshot.recurring ? 'Yes' : 'No'} />
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
  const [type, setType] = useState<'percent' | 'fixed'>(current?.commissionType ?? 'percent');
  const [value, setValue] = useState(current ? String(Number(current.commissionValue)) : '20');
  const [recurring, setRecurring] = useState(current?.recurring ?? true);
  const [holdback, setHoldback] = useState(
    current?.holdbackDays != null ? String(current.holdbackDays) : '',
  );

  // Re-sync the form when the underlying snapshot changes (e.g. after
  // the user just saved). Without this the form would keep showing
  // the pre-save values until a hard refresh.
  useEffect(() => {
    setType(current?.commissionType ?? 'percent');
    setValue(current ? String(Number(current.commissionValue)) : '20');
    setRecurring(current?.recurring ?? true);
    setHoldback(current?.holdbackDays != null ? String(current.holdbackDays) : '');
  }, [current]);

  const save = useMutation({
    mutationFn: () =>
      api(`/partners/${partnerId}/commission-snapshot`, {
        method: 'PUT',
        body: {
          commissionType: type,
          commissionValue: Number(value),
          recurring,
          holdbackDays: holdback === '' ? null : Number(holdback),
        },
      }),
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
        partner&rsquo;s commissions accrue at the rate below regardless of the campaign rule.
        Past commissions aren&rsquo;t recomputed — only future events.
      </p>
      <ErrorBanner error={save.error ?? clear.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr auto', gap: 12, marginBottom: 14, alignItems: 'end' }}>
        <div>
          <Label>Rate type</Label>
          <Select value={type} onChange={(e) => setType(e.target.value as 'percent' | 'fixed')}>
            <option value="percent">Percent</option>
            <option value="fixed">Fixed</option>
          </Select>
        </div>
        <div>
          <Label>Value</Label>
          <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', paddingBottom: 10, color: theme.textMuted }}>
          <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
          Recurring
        </label>
      </div>
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
        <Button onClick={() => save.mutate()} disabled={save.isPending || !value}>
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
              border: `1px solid ${theme.danger}55`,
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
