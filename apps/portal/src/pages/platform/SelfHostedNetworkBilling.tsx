import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label } from '../../ui.js';
import { papi, friendlyPlatformError } from './lib.js';

interface SelfHostedNetworkState {
  settings: { requiredFrom: string | null; graceDays: number };
  maxGraceDays: number;
  vendors: { listed: number; paying: number; held: number };
}

interface SaveResult extends SelfHostedNetworkState {
  sweep: { noticed: number; held: number; released: number };
}

/** The deadline starts at midnight UTC on the day set, and the Network's
 *  emails quote that day, so show it in UTC. */
const utcDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Self-hosted brands pay for Network access directly ($29/mo + 3%). From
 * the date set here, an unpaid one is held: off the marketplace and no new
 * partnerships (openpartner-network selfhost-billing.ts). Brands that join
 * later get the grace days from signup. Saving emails each unpaid brand its
 * deadline, or holds it if the date has passed.
 */
export function SelfHostedNetworkBillingCard({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ['platform-self-hosted-network'],
    queryFn: () => papi<SelfHostedNetworkState>('/platform-admin/fees/self-hosted-network'),
  });
  const [day, setDay] = useState('');
  const [grace, setGrace] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: { requiredFrom: string | null; graceDays: number }) =>
      papi<SaveResult>('/platform-admin/fees/self-hosted-network', { method: 'PUT', body }),
    onSuccess: (r) => {
      setDay('');
      setGrace(null);
      const parts = [
        r.sweep.noticed ? `${plural(r.sweep.noticed, 'brand')} emailed` : null,
        r.sweep.held ? `${plural(r.sweep.held, 'brand')} held` : null,
        r.sweep.released ? `${plural(r.sweep.released, 'hold')} lifted` : null,
      ].filter(Boolean);
      setResult(`Saved${parts.length ? ` · ${parts.join(' · ')}` : ''}.`);
      void qc.invalidateQueries({ queryKey: ['platform-self-hosted-network'] });
    },
  });

  const s = state.data;
  if (!s) {
    // Nothing to show until the Network answers; its error if it can't.
    return state.error ? (
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Self-hosted Network subscription</div>
        <ErrorBanner error={friendlyPlatformError(state.error)} />
      </Card>
    ) : null;
  }
  const from = s.settings.requiredFrom;
  const graceValue = grace ?? String(s.settings.graceDays);
  const unpaid = s.vendors.listed - s.vendors.paying;

  function submit(requiredFrom: string | null) {
    if (!s) return;
    const graceDays = Number(graceValue);
    if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > s.maxGraceDays) {
      window.alert(`Grace is a whole number of days, 0 to ${s.maxGraceDays}.`);
      return;
    }
    // Only a new date sends anything worth confirming; a grace change on
    // the same date affects brands that join later.
    if (requiredFrom && requiredFrom !== from && unpaid > 0) {
      const passed = new Date(requiredFrom).getTime() <= Date.now();
      const ask = passed
        ? `That date has passed: ${plural(unpaid, 'unpaid brand')} go on hold now. Save?`
        : `Email ${plural(unpaid, 'unpaid brand')} the new deadline now?`;
      if (!window.confirm(ask)) return;
    }
    setResult(null);
    save.mutate({ requiredFrom, graceDays });
  }

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Self-hosted Network subscription</div>
        <div style={{ fontSize: 13, color: from ? theme.text : theme.textMuted }}>
          {from ? `Required from ${utcDay(from)}` : 'Not required'}
        </div>
      </div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6 }}>
        {plural(s.vendors.listed, 'approved brand')} · {s.vendors.paying} paying · {s.vendors.held} on hold
      </div>
      <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : null} />
      {result && <div style={{ fontSize: 13, color: theme.success, marginTop: 8 }}>{result}</div>}
      {canWrite && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
          <div>
            <Label>Required from</Label>
            <Input type="date" aria-label="Required from" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 170 }} />
          </div>
          <div>
            <Label>Grace for new brands (days)</Label>
            <Input value={graceValue} onChange={(e) => setGrace(e.target.value)} style={{ width: 90 }} />
          </div>
          <Button
            size="sm"
            disabled={save.isPending || (!day && (grace === null || !from))}
            onClick={() => submit(day ? new Date(`${day}T00:00:00Z`).toISOString() : from)}
          >
            {from ? 'Save' : 'Set date'}
          </Button>
          {from && (
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => submit(null)}>
              Turn off
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
