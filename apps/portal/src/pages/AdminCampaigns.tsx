import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Table, formatDate } from '../ui.js';

interface Campaign {
  id: string;
  name: string;
  commissionRule: { type: string; value: number; recurring?: boolean };
  attributionWindowDays: number;
  attributionModel: string;
  createdAt: string;
}

export function AdminCampaigns() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const campaigns = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<{ campaigns: Campaign[] }>('/campaigns'),
  });

  return (
    <Page title="Campaigns" actions={<Button onClick={() => setShowCreate(true)}>New campaign</Button>}>
      <ErrorBanner error={campaigns.error} />
      {showCreate && (
        <CreateCampaign
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['campaigns'] });
          }}
        />
      )}
      {campaigns.isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <Table
          columns={['Name', 'Commission', 'Window', 'Model', 'Created']}
          rows={(campaigns.data?.campaigns ?? []).map((c) => [
            <strong>{c.name}</strong>,
            c.commissionRule.type === 'percent'
              ? `${c.commissionRule.value}% ${c.commissionRule.recurring ? '(recurring)' : ''}`
              : `$${c.commissionRule.value} fixed ${c.commissionRule.recurring ? '(recurring)' : ''}`,
            `${c.attributionWindowDays}d`,
            <code style={{ fontSize: 12 }}>{c.attributionModel}</code>,
            formatDate(c.createdAt),
          ])}
        />
      )}
    </Page>
  );
}

function CreateCampaign({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [ruleType, setRuleType] = useState<'percent' | 'fixed'>('percent');
  const [ruleValue, setRuleValue] = useState('20');
  const [recurring, setRecurring] = useState(true);
  const [windowDays, setWindowDays] = useState('60');
  const [model, setModel] = useState<'last_click' | 'first_click' | 'linear' | 'position'>('last_click');

  const mut = useMutation({
    mutationFn: () =>
      api<Campaign>('/campaigns', {
        method: 'POST',
        body: {
          name,
          commissionRule: { type: ruleType, value: Number(ruleValue), recurring },
          attributionWindowDays: Number(windowDays),
          attributionModel: model,
        },
      }),
    onSuccess: onCreated,
  });

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>New campaign</div>
      <ErrorBanner error={mut.error} />
      <div style={{ marginBottom: 12 }}>
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12, alignItems: 'end', marginBottom: 12 }}>
        <div>
          <Label>Rule</Label>
          <select value={ruleType} onChange={(e) => setRuleType(e.target.value as 'percent' | 'fixed')} style={{ padding: '8px 10px', fontSize: 14, border: '1px solid #ddd', borderRadius: 4 }}>
            <option value="percent">Percent</option>
            <option value="fixed">Fixed</option>
          </select>
        </div>
        <div>
          <Label>Value</Label>
          <Input type="number" value={ruleValue} onChange={(e) => setRuleValue(e.target.value)} />
        </div>
        <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 8 }}>
          <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
          Recurring
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
        <div>
          <Label>Attribution window (days)</Label>
          <Input type="number" value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
        </div>
        <div>
          <Label>Attribution model</Label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as typeof model)}
            style={{ padding: '8px 10px', fontSize: 14, border: '1px solid #ddd', borderRadius: 4, width: '100%' }}
          >
            <option value="last_click">Last click</option>
            <option value="first_click">First click</option>
            <option value="linear">Linear</option>
            <option value="position">Position (40/20/40)</option>
          </select>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Button onClick={() => mut.mutate()} disabled={!name || !ruleValue || mut.isPending}>
          {mut.isPending ? 'Creating…' : 'Create'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
