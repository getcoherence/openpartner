import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input } from '../../ui.js';
import { papi, friendlyPlatformError } from './lib.js';

interface TrackingGateState {
  settings: { enforceFrom: string | null };
  enforced: boolean;
  affected: { brands: number; listed: number; withPartners: number; noticed: number };
}

/** The gate starts at midnight UTC on the day set, and the notice quotes
 *  that day, so show it in UTC rather than the operator's own zone. */
const utcDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

interface NoticeResult {
  sent: number;
  alreadySent: number;
  noSignedInAdmin: number;
  optedOut: number;
  failed: number;
}

/**
 * The tracking gate (API tracking-verification.ts): from a date, approved
 * brands whose tracking isn't verified take no new partners and leave the
 * marketplace. Set the date, see who it touches, and tell them first.
 */
export function TrackingGatePanel({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ['platform-tracking-gate'],
    queryFn: () => papi<TrackingGateState>('/platform-admin/tracking-gate'),
  });
  const [day, setDay] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform-tracking-gate'] });

  const save = useMutation({
    mutationFn: (enforceFrom: string | null) =>
      papi('/platform-admin/tracking-gate', { method: 'PUT', body: { enforceFrom } }),
    onSuccess: () => {
      setDay('');
      void refresh();
    },
  });
  const send = useMutation({
    mutationFn: () => papi<NoticeResult>('/platform-admin/tracking-gate/notices', { method: 'POST' }),
    onSuccess: (r) => {
      const skipped = r.noSignedInAdmin + r.optedOut;
      setNotice(
        `Notice sent to ${r.sent} brand${r.sent === 1 ? '' : 's'}` +
          (skipped ? `, ${skipped} skipped (no signed-in admin or opted out)` : '') +
          (r.failed ? `, ${r.failed} failed` : '') +
          '.',
      );
      void refresh();
    },
  });

  const s = state.data;
  if (!s) return null;
  const from = s.settings.enforceFrom;
  const unsent = s.affected.brands - s.affected.noticed;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Tracking gate</div>
        <div style={{ fontSize: 13, color: s.enforced ? theme.success : theme.textMuted }}>
          {s.enforced ? `In force since ${utcDay(from!)}` : from ? `Starts ${utcDay(from)} (00:00 UTC)` : 'Off'}
        </div>
      </div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6, lineHeight: 1.5 }}>
        {s.affected.brands} approved brand{s.affected.brands === 1 ? '' : 's'} not verified · {s.affected.listed} listed ·{' '}
        {s.affected.withPartners} with partners · {s.affected.noticed} told
      </div>
      <ErrorBanner error={save.error || send.error ? friendlyPlatformError(save.error ?? send.error) : null} />
      {notice && <div style={{ fontSize: 13, color: theme.success, marginTop: 8 }}>{notice}</div>}
      {canWrite && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
          <Input
            type="date"
            aria-label="Gate start date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            style={{ width: 170 }}
          />
          <Button size="sm" disabled={!day || save.isPending} onClick={() => save.mutate(new Date(`${day}T00:00:00Z`).toISOString())}>
            {from ? 'Change date' : 'Set date'}
          </Button>
          {from && (
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
              Turn off
            </Button>
          )}
          {from && unsent > 0 && (
            <Button size="sm" variant="secondary" disabled={send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? 'Sending…' : `Send notice to ${unsent} brand${unsent === 1 ? '' : 's'}`}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
