import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Tag } from 'lucide-react';
import { api } from '../api.js';
import { theme } from '../theme.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, Table, formatDate } from '../ui.js';

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
    <Page
      title="Campaigns"
      subtitle="Commission rules, attribution windows, and models applied to partner clicks."
      actions={
        <Button icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
          New campaign
        </Button>
      }
    >
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
      ) : (campaigns.data?.campaigns ?? []).length === 0 ? (
        <EmptyState title="No campaigns yet" hint="A campaign holds the commission rule and attribution settings." icon={<Tag size={28} strokeWidth={1.25} />} />
      ) : (
        <Table
          columns={['Name', 'Commission', 'Window', 'Model', 'Created']}
          rows={(campaigns.data?.campaigns ?? []).map((c) => [
            <span style={{ fontWeight: 500 }}>{c.name}</span>,
            <span>
              {c.commissionRule.type === 'percent' ? `${c.commissionRule.value}%` : `$${c.commissionRule.value} fixed`}
              {c.commissionRule.recurring && <span style={{ color: theme.textDim, fontSize: 12, marginLeft: 6 }}>(recurring)</span>}
            </span>,
            <span style={{ color: theme.textMuted }}>{c.attributionWindowDays}d</span>,
            <code style={{ color: theme.accent, fontSize: 12 }}>{c.attributionModel}</code>,
            <span style={{ color: theme.textMuted }}>{formatDate(c.createdAt, { relative: true })}</span>,
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
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 14 }}>New campaign</div>
      <ErrorBanner error={mut.error} />
      <div style={{ marginBottom: 14 }}>
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Default" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr auto', gap: 12, marginBottom: 14, alignItems: 'end' }}>
        <div>
          <Label>Rule</Label>
          <Select value={ruleType} onChange={(e) => setRuleType(e.target.value as 'percent' | 'fixed')}>
            <option value="percent">Percent</option>
            <option value="fixed">Fixed</option>
          </Select>
        </div>
        <div>
          <Label>Value</Label>
          <Input type="number" value={ruleValue} onChange={(e) => setRuleValue(e.target.value)} />
        </div>
        <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', paddingBottom: 10, color: theme.textMuted }}>
          <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
          Recurring
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14, marginBottom: 16 }}>
        <div>
          <Label>Attribution window (days)</Label>
          <Input type="number" value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
        </div>
        <div>
          <Label>Attribution model</Label>
          <Select value={model} onChange={(e) => setModel(e.target.value as typeof model)}>
            <option value="last_click">Last click</option>
            <option value="first_click">First click</option>
            <option value="linear">Linear</option>
            <option value="position">Position (40 / 20 / 40)</option>
          </Select>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => mut.mutate()} disabled={!name || !ruleValue || mut.isPending}>
          {mut.isPending ? 'Creating…' : 'Create campaign'}
        </Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}
