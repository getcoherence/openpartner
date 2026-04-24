import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings as SettingsIcon } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page } from '../../ui.js';

interface ProgramSettings {
  programName: string | null;
  supportEmail: string | null;
}

export function AdminSettings() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['program-settings'],
    queryFn: () => api<ProgramSettings>('/config/program'),
  });

  const [programName, setProgramName] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [saved, setSaved] = useState(false);

  // Sync form state when the fetched value lands.
  useEffect(() => {
    if (!data) return;
    setProgramName(data.programName ?? '');
    setSupportEmail(data.supportEmail ?? '');
  }, [data]);

  const mut = useMutation({
    mutationFn: () =>
      api<ProgramSettings>('/config/program', {
        method: 'POST',
        body: { programName, supportEmail },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <Page
      title="Settings"
      subtitle="How the partner portal identifies your program."
    >
      <ErrorBanner error={error ?? mut.error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <SettingsIcon size={18} color={theme.accent} />
            <div style={{ fontSize: 15, fontWeight: 500 }}>Program info</div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <Label>Program name</Label>
            <Input
              value={programName}
              onChange={(e) => setProgramName(e.target.value)}
              placeholder="e.g. Coherence Partners"
              maxLength={120}
            />
            <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
              Shown to partners in the portal. Leave blank to fall back to "OpenPartner".
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <Label>Support email</Label>
            <Input
              type="email"
              value={supportEmail}
              onChange={(e) => setSupportEmail(e.target.value)}
              placeholder="support@yourdomain.com"
              maxLength={254}
            />
            <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
              Partners see this in their portal footer for questions about commissions, payouts, or their account.
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
              {mut.isPending ? 'Saving…' : 'Save settings'}
            </Button>
            {saved && <span style={{ color: theme.success, fontSize: 13 }}>Saved.</span>}
          </div>
        </Card>
      )}
    </Page>
  );
}
