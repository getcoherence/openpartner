import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label } from '../../ui.js';
import { papi, friendlyPlatformError } from './lib.js';

interface SetupWizardState {
  settings: { enabled: boolean; hints: { percent: string; fixed: string } };
}

/**
 * The first-run setup wizard for new brands (API platform-settings.ts):
 * the switch, and the hint line its commission step shows under the value.
 */
export function SetupWizardPanel({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const key = ['platform-setup-wizard'];
  const state = useQuery({ queryKey: key, queryFn: () => papi<SetupWizardState>('/platform-admin/setup-wizard') });
  const [percent, setPercent] = useState('');
  const [fixed, setFixed] = useState('');
  const s = state.data?.settings;
  useEffect(() => {
    if (!s) return;
    setPercent(s.hints.percent);
    setFixed(s.hints.fixed);
  }, [s]);

  const save = useMutation({
    mutationFn: (body: { enabled?: boolean; hints?: { percent: string; fixed: string } }) =>
      papi<SetupWizardState>('/platform-admin/setup-wizard', { method: 'PUT', body }),
    onSuccess: (next) => qc.setQueryData(key, next),
  });

  if (!s) return null;
  const hintsChanged = percent.trim() !== s.hints.percent || fixed.trim() !== s.hints.fixed;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Setup wizard</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: s.enabled ? theme.success : theme.textMuted }}>{s.enabled ? 'On for new brands' : 'Off'}</span>
          {canWrite && (
            <Button size="sm" variant="secondary" disabled={save.isPending} onClick={() => save.mutate({ enabled: !s.enabled })}>
              {s.enabled ? 'Turn off' : 'Turn on'}
            </Button>
          )}
        </div>
      </div>
      <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : null} />
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <div>
          <Label htmlFor="wizard-hint-percent">Commission hint, percentage</Label>
          <Input id="wizard-hint-percent" value={percent} maxLength={160} disabled={!canWrite} onChange={(e) => setPercent(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="wizard-hint-fixed">Commission hint, fixed amount</Label>
          <Input id="wizard-hint-fixed" value={fixed} maxLength={160} disabled={!canWrite} onChange={(e) => setFixed(e.target.value)} />
        </div>
      </div>
      {canWrite && hintsChanged && (
        <div style={{ marginTop: 12 }}>
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ hints: { percent: percent.trim(), fixed: fixed.trim() } })}>
            Save hints
          </Button>
        </div>
      )}
    </Card>
  );
}
