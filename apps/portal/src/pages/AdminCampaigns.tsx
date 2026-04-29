import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HelpCircle, Plus, Tag } from 'lucide-react';
import { api } from '../api.js';
import { theme } from '../theme.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, Table, formatDate } from '../ui.js';

interface Campaign {
  id: string;
  name: string;
  commissionRule: { type: string; value: number; recurring?: boolean };
  attributionWindowDays: number;
  attributionModel: string;
  destinationUrl: string;
  deepLinkAllowedDomains: string | null;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
}

type CampaignStatus = 'scheduled' | 'active' | 'ended';
function statusOf(c: Pick<Campaign, 'startsAt' | 'endsAt'>, at: Date = new Date()): CampaignStatus {
  if (c.startsAt && at < new Date(c.startsAt)) return 'scheduled';
  if (c.endsAt && at >= new Date(c.endsAt)) return 'ended';
  return 'active';
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
          columns={['Name', 'Status', 'Destination', 'Commission', 'Window', 'Model', 'Created']}
          rows={(campaigns.data?.campaigns ?? []).map((c) => [
            <span style={{ fontWeight: 500 }}>{c.name}</span>,
            <CampaignStatusPill campaign={c} />,
            <span style={{ color: theme.textMuted, fontSize: 12, fontFamily: theme.fontMono }}>
              {c.destinationUrl ? new URL(c.destinationUrl).hostname + new URL(c.destinationUrl).pathname.replace(/\/$/, '') : '—'}
              {c.deepLinkAllowedDomains && (
                <span style={{ color: theme.accent, fontSize: 11, marginLeft: 8 }}>+ deep links</span>
              )}
            </span>,
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
  const [destinationUrl, setDestinationUrl] = useState('');
  const [deepLinkDomains, setDeepLinkDomains] = useState('');
  const [ruleType, setRuleType] = useState<'percent' | 'fixed'>('percent');
  const [ruleValue, setRuleValue] = useState('20');
  const [recurring, setRecurring] = useState(true);
  const [windowDays, setWindowDays] = useState('60');
  const [model, setModel] = useState<'last_click' | 'first_click' | 'linear' | 'position'>('last_click');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [grantToAllPartners, setGrantToAllPartners] = useState(false);

  const mut = useMutation({
    mutationFn: () =>
      api<Campaign>('/campaigns', {
        method: 'POST',
        body: {
          name,
          destinationUrl,
          deepLinkAllowedDomains: deepLinkDomains.trim() || undefined,
          commissionRule: { type: ruleType, value: Number(ruleValue), recurring },
          attributionWindowDays: Number(windowDays),
          attributionModel: model,
          startsAt: startsAt ? new Date(startsAt).toISOString() : null,
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
          grantToAllPartners: grantToAllPartners || undefined,
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
      <div style={{ marginBottom: 14 }}>
        <Label>Destination URL</Label>
        <Input
          type="url"
          value={destinationUrl}
          onChange={(e) => setDestinationUrl(e.target.value)}
          placeholder="https://yourbrand.com/landing-page"
        />
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
          Where partner share-links for this campaign land. Partners can&rsquo;t change this unless you allow deep links below.
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <Label>Allowed deep-link domains (optional)</Label>
        <Input
          value={deepLinkDomains}
          onChange={(e) => setDeepLinkDomains(e.target.value)}
          placeholder="yourbrand.com,docs.yourbrand.com"
        />
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
          Comma-separated host list. Partners can override the destination on share-links as long as their override matches one of these. Leave blank to lock destinations.
        </div>
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
          <LabelWithHelp
            label="Attribution model"
            help={[
              'Which click gets the commission when a conversion has multiple touches in the window.',
              '',
              'Last click — the most recent click gets 100%. Simple, predictable, the default for most programs.',
              'First click — the very first click gets 100%. Rewards partners who introduced the brand.',
              'Linear — every click in the window splits the commission evenly.',
              'Position (40 / 20 / 40) — first + last click get 40% each, middle clicks split the remaining 20%.',
            ].join('\n')}
          />
          <Select value={model} onChange={(e) => setModel(e.target.value as typeof model)}>
            <option value="last_click">Last click</option>
            <option value="first_click">First click</option>
            <option value="linear">Linear</option>
            <option value="position">Position (40 / 20 / 40)</option>
          </Select>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
        <div>
          <Label>Starts (optional)</Label>
          <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
            Leave blank to start immediately. Before this date the campaign is hidden from creators.
          </div>
        </div>
        <div>
          <Label>Ends (optional)</Label>
          <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
            Leave blank to run indefinitely. Past this date existing share-links keep redirecting but no new commissions accrue.
          </div>
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.text }}>
          <input
            type="checkbox"
            checked={grantToAllPartners}
            onChange={(e) => setGrantToAllPartners(e.target.checked)}
          />
          Also grant access to all existing partners
        </label>
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4, marginLeft: 24 }}>
          Off by default so VIP / scoped campaigns stay private. Only affects the current
          partner roster &mdash; new invitees still need to be granted explicitly.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => mut.mutate()} disabled={!name || !ruleValue || !destinationUrl || mut.isPending}>
          {mut.isPending ? 'Creating…' : 'Create campaign'}
        </Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}

/** Field label with a hover-to-explain question-mark icon. Uses the
 *  native `title` attribute so we don't need a tooltip library — the
 *  browser handles positioning, multi-line via \n. Help text should be
 *  plain prose; no HTML. */
function LabelWithHelp({ label, help }: { label: string; help: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Label>{label}</Label>
      <span
        title={help}
        aria-label={help}
        style={{ display: 'inline-flex', alignItems: 'center', color: theme.textDim, cursor: 'help', marginBottom: 4 }}
      >
        <HelpCircle size={14} />
      </span>
    </div>
  );
}

function CampaignStatusPill({ campaign }: { campaign: Pick<Campaign, 'startsAt' | 'endsAt'> }) {
  const status = statusOf(campaign);
  const palette: Record<CampaignStatus, { bg: string; fg: string; label: string }> = {
    active: { bg: theme.successSoft, fg: theme.success, label: 'Active' },
    scheduled: { bg: `${theme.accent}15`, fg: theme.accent, label: 'Scheduled' },
    ended: { bg: theme.surface2, fg: theme.textMuted, label: 'Ended' },
  };
  const { bg, fg, label } = palette[status];
  return (
    <span style={{ background: bg, color: fg, fontSize: 11, padding: '2px 8px', borderRadius: 12, fontWeight: 600 }}>
      {label}
    </span>
  );
}
