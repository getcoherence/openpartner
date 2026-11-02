import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select, Table, formatDate } from '../../ui.js';
import { Pill } from './components.js';
import {
  papi,
  friendlyPlatformError,
  type BlocklistEntry,
  type BrandSignupSettings,
  type PlatformOperator,
} from './lib.js';

/**
 * Sign-up blocklist. Emails or whole domains that are barred from creating a
 * brand (populated here or as a side effect of rejecting a brand with a ban
 * checkbox), and the switch that refuses free mail addresses (Gmail and the
 * like) as a new brand's. Admin operators can change them; read-only
 * operators view only.
 */
export function BlocklistPage({ operator }: { operator: PlatformOperator }) {
  const canWrite = operator.role === 'admin';
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['platform-blocklist'],
    queryFn: () => papi<{ entries: BlocklistEntry[] }>('/platform-admin/blocklist'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['platform-blocklist'] });

  const remove = useMutation({
    mutationFn: (id: string) => papi(`/platform-admin/blocklist/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const [type, setType] = useState<'email' | 'domain'>('email');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const add = useMutation({
    mutationFn: () =>
      papi('/platform-admin/blocklist', {
        method: 'POST',
        body: { type, value: value.trim(), reason: reason.trim() || undefined },
      }),
    onSuccess: () => {
      setValue('');
      setReason('');
      invalidate();
    },
  });

  const entries = list.data?.entries ?? [];

  const rows = entries.map((e) => [
    <span style={{ fontFamily: theme.fontMono, fontSize: 13 }}>{e.value}</span>,
    e.type,
    e.reason ?? <span style={{ color: theme.textDim }}>—</span>,
    e.createdByEmail ?? <span style={{ color: theme.textDim }}>—</span>,
    formatDate(e.createdAt, { relative: true }),
    canWrite ? (
      <button
        onClick={() => remove.mutate(e.id)}
        disabled={remove.isPending && remove.variables === e.id}
        title="Remove from blocklist"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          background: 'transparent',
          border: 'none',
          color: theme.danger,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <Trash2 size={15} />
      </button>
    ) : (
      <span style={{ color: theme.textDim }}>—</span>
    ),
  ]);

  return (
    <Page title="Blocklist" subtitle="Emails and domains barred from creating a brand.">
      <ErrorBanner error={remove.error ? friendlyPlatformError(remove.error) : list.error} />

      <WorkEmailCard canWrite={canWrite} />

      {canWrite && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Add a block</div>
          <ErrorBanner error={add.error ? friendlyPlatformError(add.error) : null} />
          <div
            className="op-grid-collapse"
            style={{ display: 'grid', gridTemplateColumns: '140px 1fr 1fr', gap: 12, alignItems: 'end' }}
          >
            <div>
              <Label>Type</Label>
              <Select value={type} onChange={(e) => setType(e.target.value as 'email' | 'domain')}>
                <option value="email">Email</option>
                <option value="domain">Domain</option>
              </Select>
            </div>
            <div>
              <Label>{type === 'email' ? 'Email address' : 'Domain'}</Label>
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={type === 'email' ? 'spammer@example.com' : 'example.com'}
              />
            </div>
            <div>
              <Label>Reason (optional)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. phishing" />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <Button onClick={() => add.mutate()} disabled={add.isPending || !value.trim()}>
              {add.isPending ? 'Adding…' : 'Add to blocklist'}
            </Button>
          </div>
        </Card>
      )}

      {list.isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <Table columns={['Value', 'Type', 'Reason', 'Added by', 'When', '']} rows={rows} empty="Nothing blocked yet." />
      )}
    </Page>
  );
}

function WorkEmailCard({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ['platform-brand-signup'],
    queryFn: () => papi<{ settings: BrandSignupSettings }>('/platform-admin/brand-signup'),
  });
  const save = useMutation({
    mutationFn: (workEmailRequired: boolean) =>
      papi<{ settings: BrandSignupSettings }>('/platform-admin/brand-signup', { method: 'PUT', body: { workEmailRequired } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-brand-signup'] }),
  });
  const on = state.data?.settings?.workEmailRequired;

  return (
    <Card style={{ marginBottom: 16 }}>
      <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : state.error} />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Work email required</span>
            {on !== undefined && (
              <Pill
                label={on ? 'on' : 'off'}
                tone={on ? { bg: theme.successSoft, fg: theme.success } : { bg: theme.surface2, fg: theme.textMuted }}
              />
            )}
          </div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6 }}>
            New brands can’t sign up with Gmail, Outlook, iCloud or another free mail address.
          </div>
        </div>
        {canWrite && on !== undefined && (
          <Button size="sm" variant={on ? 'secondary' : 'primary'} disabled={save.isPending} onClick={() => save.mutate(!on)}>
            {save.isPending ? 'Saving…' : on ? 'Turn off' : 'Turn on'}
          </Button>
        )}
      </div>
    </Card>
  );
}
