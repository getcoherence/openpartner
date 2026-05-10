import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HelpCircle, Plus, Tag, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { theme } from '../theme.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, Table, formatDate } from '../ui.js';
import { renderCommissionSummary } from '../lib/commission-summary.js';

interface CommissionSubRule {
  trigger: 'every' | 'first' | 'subsequent';
  eventType?: string;
  type: 'percent' | 'fixed';
  value: number;
  currency?: string;
  recurring?: boolean;
  recurringMonths?: number;
}

interface CustomerReward {
  type: 'percent_off' | 'amount_off' | 'free_months';
  value: number;
  currency?: string;
  duration: 'once' | 'forever' | 'repeating';
  durationInMonths?: number;
}

interface Campaign {
  id: string;
  name: string;
  /** Server returns the array form post-migration. The single-object
   *  shape is still tolerated client-side for older API responses
   *  surfaced during a deploy gap — `normalizeRules` handles both. */
  commissionRule: CommissionSubRule[] | { type: 'percent' | 'fixed'; value: number; recurring?: boolean };
  attributionWindowDays: number;
  attributionModel: string;
  destinationUrl: string;
  deepLinkAllowedDomains: string | null;
  holdbackDays: number | null;
  startsAt: string | null;
  endsAt: string | null;
  customerReward: CustomerReward | null;
  shareOnNetwork: boolean;
  marketplaceDescription: string | null;
  networkOfferingId: string | null;
  createdAt: string;
}

interface NetworkConnectionState {
  enabled: boolean;
}

function normalizeRules(raw: Campaign['commissionRule']): CommissionSubRule[] {
  if (Array.isArray(raw)) return raw;
  return [{ trigger: 'every', type: raw.type, value: raw.value, recurring: raw.recurring }];
}

function summarizeRules(raw: Campaign['commissionRule'], reward: CustomerReward | null): string {
  return renderCommissionSummary(normalizeRules(raw), reward);
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
  const [editing, setEditing] = useState<Campaign | null>(null);
  const campaigns = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<{ campaigns: Campaign[] }>('/campaigns'),
  });

  // End-now sets endsAt = current time. Existing share-links keep
  // redirecting (the router doesn't gate on endsAt — that would break
  // creators' embeds), only new commission accrual stops. So this is
  // safe to fire without a multi-step flow.
  const endNow = useMutation({
    mutationFn: (id: string) =>
      api(`/campaigns/${id}`, {
        method: 'PATCH',
        body: { endsAt: new Date().toISOString() },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['campaigns'] }),
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
      <ErrorBanner error={campaigns.error ?? endNow.error} />
      {showCreate && (
        <CreateCampaign
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['campaigns'] });
          }}
        />
      )}
      {editing && (
        <EditCampaignDates
          campaign={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
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
          columns={['Name', 'Status', 'Destination', 'Commission', 'Window', 'Holdback', 'Model', 'Created', 'Actions']}
          rows={(campaigns.data?.campaigns ?? []).map((c) => {
            const status = statusOf(c);
            return [
              <span style={{ fontWeight: 500 }}>{c.name}</span>,
              <CampaignStatusPill campaign={c} />,
              <span style={{ color: theme.textMuted, fontSize: 12, fontFamily: theme.fontMono }}>
                {c.destinationUrl ? new URL(c.destinationUrl).hostname + new URL(c.destinationUrl).pathname.replace(/\/$/, '') : '—'}
                {c.deepLinkAllowedDomains && (
                  <span style={{ color: theme.accent, fontSize: 11, marginLeft: 8 }}>+ deep links</span>
                )}
              </span>,
              <span style={{ fontSize: 13 }}>{summarizeRules(c.commissionRule, c.customerReward)}</span>,
              <span style={{ color: theme.textMuted }}>{c.attributionWindowDays}d</span>,
              <span style={{ color: c.holdbackDays ? theme.text : theme.textDim }}>
                {c.holdbackDays ? `${c.holdbackDays}d` : '—'}
              </span>,
              <code style={{ color: theme.accent, fontSize: 12 }}>{c.attributionModel}</code>,
              <span style={{ color: theme.textMuted }}>{formatDate(c.createdAt, { relative: true })}</span>,
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setEditing(c)}
                  style={smallActionStyle(theme.textMuted)}
                >
                  Edit
                </button>
                {status !== 'ended' && (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`End "${c.name}" now? Existing share-links keep redirecting; new commissions stop accruing.`)) {
                        endNow.mutate(c.id);
                      }
                    }}
                    disabled={endNow.isPending}
                    style={smallActionStyle(theme.danger)}
                  >
                    End now
                  </button>
                )}
              </div>,
            ];
          })}
        />
      )}
    </Page>
  );
}

function smallActionStyle(color: string): React.CSSProperties {
  return {
    background: 'transparent',
    border: `1px solid ${color}55`,
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    color,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

/**
 * Inline edit form for an existing campaign.
 *
 * Dates section: free to edit. Just scheduling.
 *
 * Terms section: behind a banner explaining the snapshot semantics.
 * Editing commission rate or holdback only affects partnerships
 * approved AFTER the change — existing partners keep the rate they
 * were quoted (snapshot is stamped at PartnershipRequest approval
 * time and stored on PartnerCommission, queried at accrual). This is
 * what makes "rate cut without losing creators" safe and matches the
 * grandfathering pattern of mature affiliate networks (Impact,
 * Partnerize).
 */
function EditCampaignDates({
  campaign,
  onClose,
  onSaved,
}: {
  campaign: Campaign;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [startsAt, setStartsAt] = useState(campaign.startsAt ? toDateTimeLocal(campaign.startsAt) : '');
  const [endsAt, setEndsAt] = useState(campaign.endsAt ? toDateTimeLocal(campaign.endsAt) : '');
  const [rules, setRules] = useState<CommissionSubRule[]>(normalizeRules(campaign.commissionRule));
  const [customerReward, setCustomerReward] = useState<CustomerReward | null>(campaign.customerReward);
  const [shareOnNetwork, setShareOnNetwork] = useState(campaign.shareOnNetwork);
  const [marketplaceDescription, setMarketplaceDescription] = useState(campaign.marketplaceDescription ?? '');
  const [holdbackDays, setHoldbackDays] = useState(
    campaign.holdbackDays != null ? String(campaign.holdbackDays) : '0',
  );

  const save = useMutation({
    mutationFn: () =>
      api(`/campaigns/${campaign.id}`, {
        method: 'PATCH',
        body: {
          startsAt: startsAt ? new Date(startsAt).toISOString() : null,
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
          commissionRule: rules,
          customerReward,
          shareOnNetwork,
          marketplaceDescription: marketplaceDescription.trim() || null,
          holdbackDays: Number(holdbackDays) || 0,
        },
      }),
    onSuccess: onSaved,
  });

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>
        Edit campaign — {campaign.name}
      </div>
      <ErrorBanner error={save.error} />

      <div style={{ marginTop: 14, fontSize: 12, color: theme.textMuted, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        Schedule
      </div>
      <p style={{ fontSize: 12, color: theme.textDim, margin: '4px 0 12px' }}>
        Setting <strong>Ends</strong> to a past date marks the campaign Ended immediately. Past the
        end date, existing share-links keep redirecting but no new commissions accrue.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
        <div>
          <Label>Starts</Label>
          <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
            Blank = started immediately. Future date hides from creators until then.
          </div>
        </div>
        <div>
          <Label>Ends</Label>
          <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
            Blank = runs indefinitely.
          </div>
        </div>
      </div>

      <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        Terms
      </div>
      <div
        style={{
          margin: '6px 0 12px',
          padding: 10,
          background: `${theme.accent}10`,
          border: `1px solid ${theme.accent}55`,
          borderRadius: 6,
          fontSize: 12,
          color: theme.text,
        }}
      >
        Editing the rate or holdback affects <strong>new partnerships only</strong>. Existing
        partners keep the rate they were approved under — the snapshot is stamped at approval
        time and stored on PartnerCommission, queried at accrual.
      </div>
      <CompoundRuleEditor rules={rules} onChange={setRules} />
      <CustomerRewardEditor reward={customerReward} onChange={setCustomerReward} />
      <MarketplaceFields
        shareOnNetwork={shareOnNetwork}
        onShareChange={setShareOnNetwork}
        description={marketplaceDescription}
        onDescriptionChange={setMarketplaceDescription}
      />
      <div style={{ marginBottom: 16 }}>
        <Label>Payout holdback (days)</Label>
        <Select value={holdbackDays} onChange={(e) => setHoldbackDays(e.target.value)}>
          <option value="0">None</option>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
          <option value="60">60 days</option>
          <option value="90">90 days</option>
        </Select>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => save.mutate()} disabled={save.isPending || rules.length === 0}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}

/** Format an ISO timestamp into the value shape <input type="datetime-local">
 *  expects (YYYY-MM-DDTHH:mm in local time). The native control will not
 *  pre-fill from a Z-suffixed ISO string. */
function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CreateCampaign({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  // Network status drives the smart default for shareOnNetwork. When the
  // brand is connected, default ON; otherwise hide the toggle entirely
  // (no point promising marketplace listing for a brand that isn't on
  // the marketplace).
  const network = useQuery({
    queryKey: ['network-membership'],
    queryFn: () => api<NetworkConnectionState>('/config/network'),
  });
  const networkEnabled = network.data?.enabled ?? false;

  const [name, setName] = useState('');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [deepLinkDomains, setDeepLinkDomains] = useState('');
  const [rules, setRules] = useState<CommissionSubRule[]>([
    { trigger: 'every', type: 'percent', value: 20, recurring: true },
  ]);
  const [customerReward, setCustomerReward] = useState<CustomerReward | null>(null);
  const [shareOnNetwork, setShareOnNetwork] = useState(true);
  const [marketplaceDescription, setMarketplaceDescription] = useState('');
  const [windowDays, setWindowDays] = useState('60');
  const [model, setModel] = useState<'last_click' | 'first_click' | 'linear' | 'position'>('last_click');
  const [holdbackDays, setHoldbackDays] = useState('0');
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
          commissionRule: rules,
          attributionWindowDays: Number(windowDays),
          attributionModel: model,
          holdbackDays: Number(holdbackDays) || undefined,
          startsAt: startsAt ? new Date(startsAt).toISOString() : null,
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
          customerReward,
          // Only send shareOnNetwork when the brand is connected; otherwise
          // let the server apply its own default (false). Same for
          // marketplaceDescription which has no effect when not listed.
          shareOnNetwork: networkEnabled ? shareOnNetwork : undefined,
          marketplaceDescription:
            networkEnabled && shareOnNetwork && marketplaceDescription.trim()
              ? marketplaceDescription.trim()
              : undefined,
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
      <CompoundRuleEditor rules={rules} onChange={setRules} />
      <CustomerRewardEditor reward={customerReward} onChange={setCustomerReward} />
      {networkEnabled && (
        <MarketplaceFields
          shareOnNetwork={shareOnNetwork}
          onShareChange={setShareOnNetwork}
          description={marketplaceDescription}
          onDescriptionChange={setMarketplaceDescription}
        />
      )}
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
      <div style={{ marginBottom: 16 }}>
        <LabelWithHelp
          label="Payout holdback (days)"
          help={[
            'How long a commission must age past the conversion before it can be paid out.',
            '',
            'Set this to match your refund window or trial period — e.g. 30 days for a SaaS with a 30-day money-back guarantee, or 14 for a 14-day trial. Commissions accrue immediately on conversion but stay in "holdback" until this window elapses.',
            '',
            'Visible to creators on the program listing so they know your terms before applying.',
            '',
            '0 (default) = no holdback, commissions can be approved as soon as they accrue.',
          ].join('\n')}
        />
        <Select value={holdbackDays} onChange={(e) => setHoldbackDays(e.target.value)}>
          <option value="0">None — approve immediately</option>
          <option value="7">7 days</option>
          <option value="14">14 days (matches a 14-day trial)</option>
          <option value="30">30 days (matches a 30-day refund window)</option>
          <option value="60">60 days</option>
          <option value="90">90 days</option>
        </Select>
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
        <Button
          onClick={() => mut.mutate()}
          disabled={!name || rules.length === 0 || rules.some((r) => !r.value) || !destinationUrl || mut.isPending}
        >
          {mut.isPending ? 'Creating…' : 'Create campaign'}
        </Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}

/**
 * Editor for one Campaign's commissionRule[]. Each row is one sub-rule.
 *
 * Sub-rules combine: a `subscription_created` event might match both a
 * first-sale bonus AND an every-event recurring rule, producing two
 * Commission rows against the same Attribution. Order in the array doesn't
 * affect engine semantics (each sub-rule evaluates independently).
 */
function CompoundRuleEditor({
  rules,
  onChange,
}: {
  rules: CommissionSubRule[];
  onChange: (rules: CommissionSubRule[]) => void;
}) {
  const update = (i: number, patch: Partial<CommissionSubRule>) => {
    onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const remove = (i: number) => {
    onChange(rules.filter((_, j) => j !== i));
  };
  const add = () => {
    onChange([...rules, { trigger: 'first', eventType: 'subscription_created', type: 'fixed', value: 100 }]);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <Label>Commission rules</Label>
        <span style={{ fontSize: 12, color: theme.textDim }}>
          Multiple rules combine — e.g. one-time bonus + recurring revenue share.
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
        {rules.map((rule, i) => (
          <SubRuleRow
            key={i}
            rule={rule}
            onChange={(patch) => update(i, patch)}
            onRemove={rules.length > 1 ? () => remove(i) : undefined}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        style={{
          background: 'transparent',
          border: `1px dashed ${theme.accent}88`,
          borderRadius: 6,
          padding: '6px 12px',
          color: theme.accent,
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        + Add bonus or rule
      </button>
    </div>
  );
}

/** Built-in event types brands typically reward on. The list mirrors
 *  EventType in @openpartner/db; custom event names are still accepted
 *  by the engine (string passthrough) but require the "Custom…" escape
 *  hatch in the UI so a typo doesn't silently misroute commissions to
 *  an event that never fires. */
const STANDARD_EVENT_TYPES = [
  { value: 'invoice_paid', label: 'Invoice paid' },
  { value: 'subscription_created', label: 'Subscription created' },
  { value: 'trial_started', label: 'Trial started' },
  { value: 'signup', label: 'Signup' },
] as const;
const STANDARD_EVENT_VALUES: ReadonlySet<string> = new Set(STANDARD_EVENT_TYPES.map((e) => e.value));

function SubRuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: CommissionSubRule;
  onChange: (patch: Partial<CommissionSubRule>) => void;
  onRemove?: () => void;
}) {
  // 'custom' is a UI-only sentinel that flips the picker to a freeform
  // input. The eventType payload itself is still a plain string.
  const isCustomEvent = rule.eventType != null && !STANDARD_EVENT_VALUES.has(rule.eventType);
  // Default for the 'every'-trigger "all events" case (no eventType set)
  // is the empty-string sentinel — distinct from picking a known type so
  // the UI can render "All events with value" as the selected option.
  const eventSelectValue = isCustomEvent ? '__custom__' : rule.eventType ?? '';

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '110px 180px 110px 1fr 90px auto',
        gap: 8,
        alignItems: 'center',
        padding: 8,
        background: theme.surface2,
        borderRadius: 6,
      }}
    >
      <Select
        value={rule.trigger}
        onChange={(e) => {
          const trigger = e.target.value as 'every' | 'first' | 'subsequent';
          // Re-default eventType per trigger when the prior value would
          // be confusing in the new context. 'first' / 'subsequent'
          // require an event type — pick a sensible default. 'every'
          // tolerates absent (= all events with value).
          const patch: Partial<CommissionSubRule> = { trigger };
          if ((trigger === 'first' || trigger === 'subsequent') && !rule.eventType) {
            patch.eventType = trigger === 'first' ? 'subscription_created' : 'invoice_paid';
          }
          onChange(patch);
        }}
      >
        <option value="every">On every</option>
        <option value="first">On first</option>
        <option value="subsequent">On every subsequent</option>
      </Select>
      <Select
        value={eventSelectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__custom__') {
            // Seed with the current value if we already had one, else
            // empty so the user is forced to type. Empty string passes
            // through as undefined on save.
            onChange({ eventType: rule.eventType && !STANDARD_EVENT_VALUES.has(rule.eventType) ? rule.eventType : '' });
          } else if (v === '') {
            onChange({ eventType: undefined });
          } else {
            onChange({ eventType: v });
          }
        }}
      >
        {/* Empty-string option only meaningful for 'every' — 'first' and
            'subsequent' require a specific eventType, so we hide it. */}
        {rule.trigger === 'every' && <option value="">All events with value</option>}
        {STANDARD_EVENT_TYPES.map((e) => (
          <option key={e.value} value={e.value}>{e.label}</option>
        ))}
        <option value="__custom__">Custom event…</option>
      </Select>
      <Select value={rule.type} onChange={(e) => onChange({ type: e.target.value as 'percent' | 'fixed' })}>
        <option value="percent">Percent</option>
        <option value="fixed">Fixed $</option>
      </Select>
      <Input
        type="number"
        value={rule.value}
        onChange={(e) => onChange({ value: Number(e.target.value) })}
      />
      <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', color: theme.textMuted }}>
        <input
          type="checkbox"
          checked={rule.recurring ?? false}
          onChange={(e) => onChange({ recurring: e.target.checked, recurringMonths: e.target.checked ? rule.recurringMonths : undefined })}
        />
        Recurring
      </label>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove rule"
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.danger,
            cursor: 'pointer',
            padding: 4,
            display: 'flex',
          }}
        >
          <Trash2 size={14} />
        </button>
      ) : (
        <span />
      )}
      {isCustomEvent && (
        <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: theme.textMuted }}>Custom event name</span>
          <Input
            placeholder="e.g. demo_booked"
            value={rule.eventType ?? ''}
            onChange={(e) => onChange({ eventType: e.target.value.trim() || undefined })}
          />
        </div>
      )}
      {rule.recurring && (
        <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'auto 120px 1fr', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: theme.textMuted }}>Cap recurring at</span>
          <Input
            type="number"
            placeholder="∞"
            value={rule.recurringMonths ?? ''}
            onChange={(e) => onChange({ recurringMonths: e.target.value ? Number(e.target.value) : undefined })}
          />
          <span style={{ fontSize: 12, color: theme.textDim }}>
            months from the partner's first attributed event of this type. Blank = no cap.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Editor for the Campaign-level customer-side reward (dual-sided incentive).
 *
 * When set, every Coupon auto-minted for this Campaign also provisions a
 * matching Stripe Coupon + PromotionCode so the customer's discount applies
 * automatically at checkout. Without Stripe configured the OpenPartner Coupon
 * still works for partner attribution; the customer just doesn't get the
 * discount auto-applied.
 *
 * Defaults when toggled on: 20% off for the first 3 months — a sane
 * starting point that mirrors how Dub presents the feature.
 */
/**
 * Marketplace presence for the campaign. Only rendered when the brand is
 * connected to the Network (caller gates the mount). Toggle off = the
 * campaign stays private (existing partners only); toggle on = every save
 * upserts the Network listing automatically.
 *
 * marketplaceDescription is the public-facing card copy. Optional — when
 * empty the card renders without a description block.
 */
function MarketplaceFields({
  shareOnNetwork,
  onShareChange,
  description,
  onDescriptionChange,
}: {
  shareOnNetwork: boolean;
  onShareChange: (v: boolean) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.text, marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={shareOnNetwork}
          onChange={(e) => onShareChange(e.target.checked)}
        />
        List on the OpenPartner Network marketplace
      </label>
      <div style={{ fontSize: 12, color: theme.textDim, marginLeft: 24, marginBottom: shareOnNetwork ? 12 : 0 }}>
        Creators on the marketplace can discover this campaign and apply.
        Off = private (existing partners only — VIP / scoped programs).
      </div>
      {shareOnNetwork && (
        <div style={{ marginLeft: 24 }}>
          <Label>Marketplace description (optional)</Label>
          <textarea
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            rows={3}
            placeholder="What you sell, who it's for, why it converts."
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 13,
              background: theme.surface,
              color: theme.text,
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: 6,
              fontFamily: 'inherit',
              resize: 'vertical',
            }}
          />
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
            Public copy on the discover card. Leave blank to render the card
            without a description block.
          </div>
        </div>
      )}
    </div>
  );
}

function CustomerRewardEditor({
  reward,
  onChange,
}: {
  reward: CustomerReward | null;
  onChange: (reward: CustomerReward | null) => void;
}) {
  const enabled = reward != null;
  const update = (patch: Partial<CustomerReward>) => {
    onChange({ ...(reward as CustomerReward), ...patch });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.text, marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) =>
            onChange(
              e.target.checked
                ? { type: 'percent_off', value: 20, duration: 'repeating', durationInMonths: 3 }
                : null,
            )
          }
        />
        Offer customer-side discount (dual-sided)
      </label>
      <div style={{ fontSize: 12, color: theme.textDim, marginLeft: 24, marginBottom: 8 }}>
        Auto-provisioned as a Stripe coupon on each partner's code. Customer types
        the code at your Stripe checkout → discount applies automatically.
      </div>
      {enabled && reward && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '160px 130px 130px 1fr',
            gap: 8,
            padding: 8,
            background: theme.surface2,
            borderRadius: 6,
            alignItems: 'end',
          }}
        >
          <div>
            <Label>Type</Label>
            <Select
              value={reward.type}
              onChange={(e) => {
                const type = e.target.value as CustomerReward['type'];
                if (type === 'free_months') {
                  onChange({ type, value: reward.value || 1, duration: 'repeating' });
                } else {
                  update({ type });
                }
              }}
            >
              <option value="percent_off">% off</option>
              <option value="amount_off">$ off</option>
              <option value="free_months">Free months</option>
            </Select>
          </div>
          <div>
            <Label>{reward.type === 'free_months' ? 'Months' : 'Value'}</Label>
            <Input
              type="number"
              value={reward.value}
              onChange={(e) => update({ value: Number(e.target.value) })}
            />
          </div>
          {reward.type === 'amount_off' ? (
            <div>
              <Label>Currency</Label>
              <Input
                value={reward.currency ?? ''}
                placeholder="USD"
                onChange={(e) => update({ currency: e.target.value.toUpperCase().slice(0, 3) || undefined })}
              />
            </div>
          ) : (
            <div />
          )}
          {reward.type === 'free_months' ? (
            <span style={{ fontSize: 12, color: theme.textDim, paddingBottom: 8 }}>
              Delivered as a 100% Stripe coupon for the configured number of months.
            </span>
          ) : (
            <div>
              <Label>Duration</Label>
              <Select
                value={reward.duration}
                onChange={(e) => {
                  const duration = e.target.value as CustomerReward['duration'];
                  update({
                    duration,
                    durationInMonths: duration === 'repeating' ? reward.durationInMonths ?? 3 : undefined,
                  });
                }}
              >
                <option value="once">First invoice only</option>
                <option value="forever">Every invoice</option>
                <option value="repeating">First N months</option>
              </Select>
            </div>
          )}
          {reward.type !== 'free_months' && reward.duration === 'repeating' && (
            <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'auto 120px 1fr', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: theme.textMuted }}>Apply for</span>
              <Input
                type="number"
                value={reward.durationInMonths ?? ''}
                onChange={(e) => update({ durationInMonths: e.target.value ? Number(e.target.value) : undefined })}
              />
              <span style={{ fontSize: 12, color: theme.textDim }}>months from the customer's first invoice.</span>
            </div>
          )}
        </div>
      )}
    </div>
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
