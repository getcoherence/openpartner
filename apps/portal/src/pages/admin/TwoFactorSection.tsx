import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, SectionHeading, StatusPill } from '../../ui.js';
import { EditOnly } from '../../lib/viewOnly.js';
import { CodeForm, RecoveryCodes, TwoFactorSetup } from '../auth/TwoFactor.js';

interface Status {
  enabled: boolean;
  recoveryCodesLeft: number;
  verified: boolean;
  requiredByBrand: boolean;
}

type Mode = 'idle' | 'setup' | 'disable' | 'new-codes';

/** Admin → Admins: the signed-in admin's own two-step sign-in, and the
 *  brand's rule for every admin (docs/two-step-sign-in.md). */
export function TwoFactorSection() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('idle');
  const [codes, setCodes] = useState<string[] | null>(null);
  const status = useQuery({ queryKey: ['two-factor'], queryFn: () => api<Status>('/auth/two-factor') });
  const refresh = () => {
    setMode('idle');
    qc.invalidateQueries({ queryKey: ['two-factor'] });
    qc.invalidateQueries({ queryKey: ['admins'] });
  };

  const s = status.data;
  return (
    <>
      <SectionHeading>Two-step sign-in</SectionHeading>
      <Card>
        <ErrorBanner error={status.error} />
        {s && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <ShieldCheck size={18} color={s.enabled ? theme.success : theme.textDim} />
              <span style={{ fontWeight: 500 }}>You</span>
              <StatusPill status={s.enabled ? 'on' : 'off'} />
              {s.enabled && (
                <span style={{ fontSize: 13, color: theme.textMuted }}>
                  {s.recoveryCodesLeft} recovery {s.recoveryCodesLeft === 1 ? 'code' : 'codes'} left
                </span>
              )}
              {mode === 'idle' && !codes && (
                <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                  {s.enabled ? (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => setMode('new-codes')}>
                        New recovery codes
                      </Button>
                      {!s.requiredByBrand && (
                        <Button variant="secondary" size="sm" onClick={() => setMode('disable')}>
                          Turn off
                        </Button>
                      )}
                    </>
                  ) : (
                    <Button size="sm" onClick={() => setMode('setup')}>
                      Turn on
                    </Button>
                  )}
                </div>
              )}
            </div>

            {mode === 'setup' && (
              <div style={{ maxWidth: 380 }}>
                <TwoFactorSetup onEnabled={refresh} />
              </div>
            )}
            {(mode === 'disable' || mode === 'new-codes') && (
              <div style={{ maxWidth: 320 }}>
                <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 8 }}>
                  {mode === 'disable' ? 'Enter a code to turn it off.' : 'Enter a code to make new recovery codes.'}
                </div>
                <CodeForm
                  submitLabel={mode === 'disable' ? 'Turn off' : 'Make new codes'}
                  submit={async (code) => {
                    if (mode === 'disable') {
                      await api('/auth/two-factor/disable', { method: 'POST', body: { code } });
                      refresh();
                    } else {
                      const r = await api<{ recoveryCodes: string[] }>('/auth/two-factor/recovery-codes', { method: 'POST', body: { code } });
                      setMode('idle');
                      setCodes(r.recoveryCodes);
                    }
                  }}
                  footer={
                    <Button variant="ghost" size="sm" onClick={() => setMode('idle')}>
                      Cancel
                    </Button>
                  }
                />
              </div>
            )}
            {codes && (
              <div style={{ maxWidth: 380 }}>
                <RecoveryCodes
                  codes={codes}
                  onDone={() => {
                    setCodes(null);
                    refresh();
                  }}
                />
              </div>
            )}

            <EditOnly>
              <RequireForEveryone />
            </EditOnly>
          </div>
        )}
      </Card>
    </>
  );
}

function RequireForEveryone() {
  const qc = useQueryClient();
  const rule = useQuery({
    queryKey: ['admin-security'],
    queryFn: () => api<{ requireTwoFactor: boolean }>('/config/admin-security'),
  });
  const save = useMutation({
    mutationFn: (requireTwoFactor: boolean) => api('/config/admin-security', { method: 'POST', body: { requireTwoFactor } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-security'] });
      qc.invalidateQueries({ queryKey: ['two-factor'] });
    },
  });
  const notEnabled = save.error instanceof ApiError && (save.error.detail as { error?: string } | null)?.error === 'two_factor_not_enabled';

  return (
    <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 14 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={rule.data?.requireTwoFactor ?? false}
          disabled={!rule.data || save.isPending}
          onChange={(e) => save.mutate(e.target.checked)}
        />
        Require for every admin
      </label>
      {save.error && (
        <div style={{ fontSize: 12, color: theme.danger, marginTop: 6 }}>
          {notEnabled ? 'Turn it on for yourself first.' : save.error instanceof Error ? save.error.message : String(save.error)}
        </div>
      )}
    </div>
  );
}
