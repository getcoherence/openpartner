import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HelpCircle, Plus, Tag } from 'lucide-react';
import { api } from '../api.js';
import { alpha, theme } from '../theme.js';
import { useBrand } from '../lib/useBrand.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, Table, formatDate } from '../ui.js';
import { renderCommissionSummary } from '../lib/commission-summary.js';
import { CompoundRuleEditor, ruleEventTypeMissing, ruleSlabProblem, type CommissionSubRule } from '../lib/CompoundRuleEditor.js';
import { PROGRAM_CATEGORIES, clickDestinationProblem, clickDestinationWarning, parseVideoUrl } from '@openpartner/db';

interface CustomerReward {
  type: 'percent_off' | 'amount_off' | 'free_months';
  value: number;
  currency?: string;
  duration: 'once' | 'forever' | 'repeating';
  durationInMonths?: number;
}

interface Program {
  id: string;
  name: string;
  /** Server returns the array form post-migration. The single-object
   *  shape is still tolerated client-side for older API responses
   *  surfaced during a deploy gap — `normalizeRules` handles both. */
  commissionRule: CommissionSubRule[] | { type: 'percent' | 'fixed'; value: number; recurring?: boolean };
  attributionWindowDays: number;
  attributionModel: string;
  /** Older API responses during a deploy gap omit it; treat as on. */
  renewalsStayWithPartner?: boolean;
  destinationUrl: string;
  deepLinkAllowedDomains: string | null;
  holdbackDays: number | null;
  startsAt: string | null;
  endsAt: string | null;
  customerReward: CustomerReward | null;
  shareOnNetwork: boolean;
  partnersMayCustomizeCode?: boolean;
  /** Event types that are sales in this program beyond invoice_paid and
   *  subscription_created. */
  revenueEventTypes?: string[];
  marketplaceDescription: string | null;
  marketplaceCoverUrl?: string | null;
  marketplaceVideoUrl?: string | null;
  networkOfferingId: string | null;
  categories: string[];
  createdAt: string;
}

/** Mirror of the API's customerRewardDelivery(): who puts the customer
 *  discount into checkout on this deployment. 'stripe' = we mint it in
 *  the brand's Stripe (single-tenant self-host with a key, or a hosted
 *  brand that connected Stripe). 'brand' = hosted without a connection /
 *  multi-tenant, the brand sets it up in its own Stripe.
 *  'unconfigured' = self-host with no Stripe key yet. Undefined while
 *  the program list loads (or from an API that predates the field). */
type CustomerRewardDelivery = 'stripe' | 'unconfigured' | 'brand';

interface NetworkConnectionState {
  enabled: boolean;
}

function normalizeRules(raw: Program['commissionRule']): CommissionSubRule[] {
  if (Array.isArray(raw)) return raw;
  return [{ trigger: 'every', type: raw.type, value: raw.value, recurring: raw.recurring }];
}

function summarizeRules(raw: Program['commissionRule'], reward: CustomerReward | null): string {
  return renderCommissionSummary(normalizeRules(raw), reward);
}

type ProgramStatus = 'scheduled' | 'active' | 'ended';
function statusOf(c: Pick<Program, 'startsAt' | 'endsAt'>, at: Date = new Date()): ProgramStatus {
  if (c.startsAt && at < new Date(c.startsAt)) return 'scheduled';
  if (c.endsAt && at >= new Date(c.endsAt)) return 'ended';
  return 'active';
}

export function AdminPrograms() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Program | null>(null);
  const campaigns = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<{ programs: Program[]; customerRewardDelivery?: CustomerRewardDelivery }>('/programs'),
  });
  const rewardDelivery = campaigns.data?.customerRewardDelivery;

  // End-now sets endsAt = current time. Existing share-links keep
  // redirecting (the router doesn't gate on endsAt — that would break
  // creators' embeds), only new commission accrual stops. So this is
  // safe to fire without a multi-step flow.
  const endNow = useMutation({
    mutationFn: (id: string) =>
      api(`/programs/${id}`, {
        method: 'PATCH',
        body: { endsAt: new Date().toISOString() },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['campaigns'] }),
  });

  return (
    <Page
      title="Programs"
      subtitle="Commission rules, attribution windows, and models applied to partner clicks."
      actions={
        <Button icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
          New campaign
        </Button>
      }
    >
      <ErrorBanner error={campaigns.error ?? endNow.error} />
      {showCreate && (
        <CreateProgram
          rewardDelivery={rewardDelivery}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['campaigns'] });
          }}
        />
      )}
      {editing && (
        <EditProgramDates
          campaign={editing}
          rewardDelivery={rewardDelivery}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ['campaigns'] });
          }}
        />
      )}
      {/* Hide the program list while the edit or create form is open —
          duplicating the row being edited is just visual noise, and on a
          single-program tenant it pushes the form off-screen. */}
      {editing || showCreate ? null : campaigns.isLoading ? (
        <Card>Loading…</Card>
      ) : (campaigns.data?.programs ?? []).length === 0 ? (
        <EmptyState title="No programs yet" hint="A program holds the commission rule and attribution settings." icon={<Tag size={28} strokeWidth={1.25} />} />
      ) : (
        <Table
          columns={['Name', 'Status', 'Destination', 'Commission', 'Window', 'Holdback', 'Model', 'Created', 'Actions']}
          rows={(campaigns.data?.programs ?? []).map((c) => {
            const status = statusOf(c);
            return [
              <span style={{ fontWeight: 500 }}>{c.name}</span>,
              <ProgramStatusPill campaign={c} />,
              <span style={{ color: theme.textMuted, fontSize: 12, fontFamily: theme.fontMono }}>
                {c.destinationUrl ? new URL(c.destinationUrl).hostname + new URL(c.destinationUrl).pathname.replace(/\/$/, '') : '—'}
                {c.deepLinkAllowedDomains && (
                  <span style={{ color: theme.accentText, fontSize: 11, marginLeft: 8 }}>+ deep links</span>
                )}
              </span>,
              <span style={{ fontSize: 13 }}>{summarizeRules(c.commissionRule, c.customerReward)}</span>,
              <span style={{ color: theme.textMuted }}>{c.attributionWindowDays}d</span>,
              <span style={{ color: c.holdbackDays ? theme.text : theme.textDim }}>
                {c.holdbackDays ? `${c.holdbackDays}d` : '—'}
              </span>,
              <code style={{ color: theme.accentText, fontSize: 12 }}>{c.attributionModel}</code>,
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
function EditProgramDates({
  campaign,
  rewardDelivery,
  onClose,
  onSaved,
}: {
  campaign: Program;
  rewardDelivery: CustomerRewardDelivery | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [startsAt, setStartsAt] = useState(campaign.startsAt ? toDateTimeLocal(campaign.startsAt) : '');
  const [endsAt, setEndsAt] = useState(campaign.endsAt ? toDateTimeLocal(campaign.endsAt) : '');
  const [destinationUrl, setDestinationUrl] = useState(campaign.destinationUrl ?? '');
  const [deepLinkDomains, setDeepLinkDomains] = useState(campaign.deepLinkAllowedDomains ?? '');
  const [rules, setRules] = useState<CommissionSubRule[]>(normalizeRules(campaign.commissionRule));
  const [customerReward, setCustomerReward] = useState<CustomerReward | null>(campaign.customerReward);
  const { whiteLabel } = useBrand();
  const [shareOnNetwork, setShareOnNetwork] = useState(campaign.shareOnNetwork);
  const [marketplaceDescription, setMarketplaceDescription] = useState(campaign.marketplaceDescription ?? '');
  const [coverUrl, setCoverUrl] = useState<string | null>(campaign.marketplaceCoverUrl ?? null);
  const [videoUrl, setVideoUrl] = useState(campaign.marketplaceVideoUrl ?? '');
  const [categories, setCategories] = useState<string[]>(campaign.categories ?? []);
  const [partnersMayCustomizeCode, setPartnersMayCustomizeCode] = useState(
    campaign.partnersMayCustomizeCode ?? false,
  );
  const [holdbackDays, setHoldbackDays] = useState(
    campaign.holdbackDays != null ? String(campaign.holdbackDays) : '0',
  );
  const [revenueEventTypes, setRevenueEventTypes] = useState((campaign.revenueEventTypes ?? []).join(', '));
  const [renewalsStayWithPartner, setRenewalsStayWithPartner] = useState(
    campaign.renewalsStayWithPartner ?? true,
  );

  const save = useMutation({
    mutationFn: () =>
      api(`/programs/${campaign.id}`, {
        method: 'PATCH',
        body: {
          startsAt: startsAt ? new Date(startsAt).toISOString() : null,
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
          destinationUrl: destinationUrl.trim(),
          // null clears the list: deep links then stay locked to the destination.
          deepLinkAllowedDomains: deepLinkDomains.trim() || null,
          commissionRule: rules,
          customerReward,
          shareOnNetwork,
          marketplaceDescription: marketplaceDescription.trim() || null,
          marketplaceCoverUrl: coverUrl,
          marketplaceVideoUrl: videoUrl.trim() || null,
          categories,
          partnersMayCustomizeCode,
          holdbackDays: Number(holdbackDays) || 0,
          revenueEventTypes: parseEventTypes(revenueEventTypes),
          renewalsStayWithPartner,
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
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
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

      <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 }}>
        Destination
      </div>
      <DestinationFields
        destinationUrl={destinationUrl}
        onDestinationChange={setDestinationUrl}
        deepLinkDomains={deepLinkDomains}
        onDeepLinkDomainsChange={setDeepLinkDomains}
        editing
      />

      <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        Terms
      </div>
      <div
        style={{
          margin: '6px 0 12px',
          padding: 10,
          background: `${theme.accentA10}`,
          border: `1px solid ${theme.accentA55}`,
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
      <CustomerRewardEditor reward={customerReward} delivery={rewardDelivery} onChange={setCustomerReward} />
      <PartnerCodeCustomizationField
        enabled={partnersMayCustomizeCode}
        delivery={rewardDelivery}
        onChange={setPartnersMayCustomizeCode}
      />
      {/* Network listing is a shared-marketplace surface — hidden for
          white-label tenants, which never appear on the Network. */}
      {!whiteLabel && (
        <MarketplaceFields
          shareOnNetwork={shareOnNetwork}
          onShareChange={setShareOnNetwork}
          description={marketplaceDescription}
          onDescriptionChange={setMarketplaceDescription}
          categories={categories}
          onCategoriesChange={setCategories}
          coverUrl={coverUrl}
          onCoverChange={setCoverUrl}
          videoUrl={videoUrl}
          onVideoChange={setVideoUrl}
        />
      )}
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
      <RevenueEventTypesField value={revenueEventTypes} onChange={setRevenueEventTypes} />
      <RenewalsField
        enabled={renewalsStayWithPartner}
        windowDays={campaign.attributionWindowDays}
        onChange={setRenewalsStayWithPartner}
      />

      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          onClick={() => save.mutate()}
          disabled={
            save.isPending ||
            !destinationUrl.trim() ||
            destinationUrlProblem(destinationUrl) !== null ||
            rules.length === 0 ||
            rules.some(ruleEventTypeMissing) ||
            rules.some((r) => ruleSlabProblem(r) !== null) ||
            (shareOnNetwork && !marketplaceDescription.trim()) ||
            (shareOnNetwork && videoLinkInvalid(videoUrl)) ||
            revenueEventTypesProblem(revenueEventTypes) !== null
          }
        >
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}

function parseEventTypes(text: string): string[] {
  return [...new Set(text.split(',').map((t) => t.trim()).filter(Boolean))];
}

/** Corrective event types the API refuses as revenue (CORRECTIVE_TYPES in
 *  apps/api/src/routes/programs.ts). Keep the two lists identical. */
const CORRECTIVE_EVENT_TYPES = new Set(['refund', 'chargeback', 'dispute_created', 'invoice_payment_failed']);

/** What the API's revenueEventTypes schema would refuse, said here
 *  instead of as a bare invalid_body after Save. */
function revenueEventTypesProblem(text: string): string | null {
  const types = parseEventTypes(text);
  const corrective = types.filter((t) => CORRECTIVE_EVENT_TYPES.has(t));
  if (corrective.length === 1) return `${corrective[0]} corrects a sale, so it can’t be revenue. Remove it.`;
  if (corrective.length > 1) return `${corrective.join(', ')} correct sales, so they can’t be revenue. Remove them.`;
  if (types.length > 20) return 'List at most 20 event types.';
  if (types.some((t) => t.length > 80)) return 'An event type can be at most 80 characters.';
  return null;
}

/**
 * Event types that are sales in this program, beyond invoice_paid and
 * subscription_created (always sales). Their value is partner-attributed
 * revenue: on OpenPartner Cloud, the platform fee's revenue basis
 * (docs/platform-fee.md). A conversion that pays a percentage commission
 * counts as a sale whatever its type, so this matters for fixed bounties.
 */
function RevenueEventTypesField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const problem = revenueEventTypesProblem(value);
  return (
    <div style={{ marginBottom: 16 }}>
      <Label>Revenue event types</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. order_paid, deal_won"
        style={problem ? { borderColor: alpha(theme.danger, 0.533) } : undefined}
      />
      {problem && <div style={{ fontSize: 12, color: theme.danger, marginTop: 4 }}>{problem}</div>}
      <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4, lineHeight: 1.5 }}>
        Event types in this program that are sales, comma-separated. <code>invoice_paid</code> and{' '}
        <code>subscription_created</code> always are, and so is any conversion that pays a percentage
        commission. List the rest here, such as an <code>order_paid</code> you pay a fixed bounty on, so
        its value counts as partner-attributed revenue. On OpenPartner Cloud the platform fee is a
        share of that revenue, with a minimum share of the commissions partners earn.
      </div>
    </div>
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

function CreateProgram({
  rewardDelivery,
  onClose,
  onCreated,
}: {
  rewardDelivery: CustomerRewardDelivery | undefined;
  onClose: () => void;
  onCreated: () => void;
}) {
  // Network status drives the smart default for shareOnNetwork. When the
  // brand is connected, default ON; otherwise hide the toggle entirely
  // (no point promising marketplace listing for a brand that isn't on
  // the marketplace).
  const network = useQuery({
    queryKey: ['network-membership'],
    queryFn: () => api<NetworkConnectionState>('/config/network'),
  });
  const { whiteLabel } = useBrand();
  // White-label tenants are isolated from the Network — treat them as
  // never enabled so the marketplace fields never render.
  const networkEnabled = (network.data?.enabled ?? false) && !whiteLabel;

  const [name, setName] = useState('');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [deepLinkDomains, setDeepLinkDomains] = useState('');
  const [rules, setRules] = useState<CommissionSubRule[]>([
    { trigger: 'every', type: 'percent', value: 20, recurring: true },
  ]);
  const [customerReward, setCustomerReward] = useState<CustomerReward | null>(null);
  const [shareOnNetwork, setShareOnNetwork] = useState(true);
  const [marketplaceDescription, setMarketplaceDescription] = useState('');
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [partnersMayCustomizeCode, setPartnersMayCustomizeCode] = useState(false);
  const [windowDays, setWindowDays] = useState('60');
  const [model, setModel] = useState<'last_click' | 'first_click' | 'linear' | 'position'>('last_click');
  const [renewalsStayWithPartner, setRenewalsStayWithPartner] = useState(true);
  const [holdbackDays, setHoldbackDays] = useState('0');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [grantToAllPartners, setGrantToAllPartners] = useState(false);

  const urlProblem = destinationUrlProblem(destinationUrl);

  const mut = useMutation({
    mutationFn: () =>
      api<Program>('/programs', {
        method: 'POST',
        body: {
          name,
          destinationUrl,
          deepLinkAllowedDomains: deepLinkDomains.trim() || undefined,
          commissionRule: rules,
          attributionWindowDays: Number(windowDays),
          attributionModel: model,
          renewalsStayWithPartner,
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
          marketplaceCoverUrl: networkEnabled && shareOnNetwork && coverUrl ? coverUrl : undefined,
          marketplaceVideoUrl:
            networkEnabled && shareOnNetwork && videoUrl.trim() ? videoUrl.trim() : undefined,
          categories: categories.length > 0 ? categories : undefined,
          partnersMayCustomizeCode: partnersMayCustomizeCode || undefined,
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
      <DestinationFields
        destinationUrl={destinationUrl}
        onDestinationChange={setDestinationUrl}
        deepLinkDomains={deepLinkDomains}
        onDeepLinkDomainsChange={setDeepLinkDomains}
      />
      <CompoundRuleEditor rules={rules} onChange={setRules} />
      <CustomerRewardEditor reward={customerReward} delivery={rewardDelivery} onChange={setCustomerReward} />
      <PartnerCodeCustomizationField
        enabled={partnersMayCustomizeCode}
        delivery={rewardDelivery}
        onChange={setPartnersMayCustomizeCode}
      />
      {networkEnabled && (
        <MarketplaceFields
          shareOnNetwork={shareOnNetwork}
          onShareChange={setShareOnNetwork}
          description={marketplaceDescription}
          onDescriptionChange={setMarketplaceDescription}
          categories={categories}
          onCategoriesChange={setCategories}
          coverUrl={coverUrl}
          onCoverChange={setCoverUrl}
          videoUrl={videoUrl}
          onVideoChange={setVideoUrl}
        />
      )}
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14, marginBottom: 16 }}>
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
      <RenewalsField
        enabled={renewalsStayWithPartner}
        windowDays={Number(windowDays) || 60}
        onChange={setRenewalsStayWithPartner}
      />
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
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
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
          disabled={
            !name ||
            rules.length === 0 ||
            rules.some((r) => !r.value) ||
            rules.some(ruleEventTypeMissing) ||
            rules.some((r) => ruleSlabProblem(r) !== null) ||
            !destinationUrl ||
            urlProblem != null ||
            (networkEnabled && shareOnNetwork && !marketplaceDescription.trim()) ||
            (networkEnabled && shareOnNetwork && videoLinkInvalid(videoUrl)) ||
            mut.isPending
          }
        >
          {mut.isPending ? 'Creating…' : 'Create campaign'}
        </Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}

/**
 * Per-program toggle: can partners self-rename their coupon code?
 *
 * Off (default) = admin-only. The Coupon row's `code` is set at mint time
 * and only the admin can change it. On = the creator portal exposes a
 * rename action; the vendor accepts a federated PATCH on the coupon row.
 *
 * Either way the brand owns the discount terms (customerReward); the
 * partner can only change the string customers type at checkout.
 */
function PartnerCodeCustomizationField({
  enabled,
  delivery,
  onChange,
}: {
  enabled: boolean;
  delivery: CustomerRewardDelivery | undefined;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.text, marginBottom: 6 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked)} />
        Let partners customize their coupon code
      </label>
      <div style={{ fontSize: 12, color: theme.textDim, marginLeft: 24 }}>
        Off (default) = you control every code. On = partners on your roster
        and Network creators can add vanity codes from their dashboard (e.g.{' '}
        <code>GRACIE15</code>), up to 5 active per program. The discount terms
        above stay locked — partners only choose the string. Codes are matched
        by name at checkout, so a partner code that equals one of your own
        promo codes would be credited to that partner.
        {delivery === 'stripe' && <>{' '}A deactivated code stops working at checkout.</>}
        {(delivery === 'brand' || delivery === 'unconfigured') && (
          <>
            {' '}Your checkout isn&rsquo;t updated for you: add each new code
            there, and retire deactivated ones there too — OpenPartner stops
            crediting a deactivated code, but it keeps discounting until you do.
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Program.renewalsStayWithPartner. On: the window picks who wins a
 * customer, and that partner keeps the customer's renewals — the
 * click-to-renewal promise. Spec: docs/renewal-attribution.md.
 */
function RenewalsField({
  enabled,
  windowDays,
  onChange,
}: {
  enabled: boolean;
  windowDays: number;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.text, marginBottom: 6 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked)} />
        Renewals stay with the partner who earned the customer
      </label>
      <div style={{ fontSize: 12, color: theme.textDim, marginLeft: 24 }}>
        {enabled ? (
          <>
            On (default): the {windowDays}-day window decides which partner wins a customer&rsquo;s
            first payment. Every renewal after it stays with that partner for as long as the
            customer pays, even if they click another partner&rsquo;s link later. Past the window,
            only rules marked <strong>Recurring</strong> pay, up to their month cap.
          </>
        ) : (
          <>
            Off: every payment is credited to whoever has the latest click in the {windowDays}-day
            window (or as your model splits it). A customer who renews {windowDays} days after
            their last partner click earns nobody a commission.
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Marketplace presence for the campaign. Only rendered when the brand is
 * connected to the Network (caller gates the mount). Toggle off = the
 * campaign stays private (existing partners only); toggle on = every save
 * upserts the Network listing automatically.
 *
 * marketplaceDescription is the public-facing card copy. Required when
 * shareOnNetwork is on — the marketplace card is the brand's only sales
 * surface for cold creator traffic; an empty card is a missed conversion.
 * UI gates Save when missing; the API also rejects 400.
 */
function MarketplaceFields({
  shareOnNetwork,
  onShareChange,
  description,
  onDescriptionChange,
  categories,
  onCategoriesChange,
  coverUrl,
  onCoverChange,
  videoUrl,
  onVideoChange,
}: {
  shareOnNetwork: boolean;
  onShareChange: (v: boolean) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  categories: string[];
  onCategoriesChange: (v: string[]) => void;
  coverUrl: string | null;
  onCoverChange: (v: string | null) => void;
  videoUrl: string;
  onVideoChange: (v: string) => void;
}) {
  const toggleCategory = (slug: string) => {
    if (categories.includes(slug)) {
      onCategoriesChange(categories.filter((c) => c !== slug));
    } else {
      // 5-cap matches the API; UI gates here so the user gets feedback
      // before the request rejects.
      if (categories.length >= 5) return;
      onCategoriesChange([...categories, slug]);
    }
  };
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
          <Label>Marketplace description <span style={{ color: theme.danger }}>*</span></Label>
          <textarea
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            rows={3}
            placeholder="What you sell, who it's for, why it converts."
            required
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 13,
              background: theme.surface,
              color: theme.text,
              border: `1px solid ${description.trim() ? theme.borderSubtle : alpha(theme.danger, 0.4)}`,
              borderRadius: 6,
              fontFamily: 'inherit',
              resize: 'vertical',
            }}
          />
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4, marginBottom: 12 }}>
            Public copy on the discover card. Required when listed on the marketplace.
          </div>
          <Label>Categories (up to 5)</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {PROGRAM_CATEGORIES.map((cat) => {
              const selected = categories.includes(cat.slug);
              const disabled = !selected && categories.length >= 5;
              return (
                <button
                  key={cat.slug}
                  type="button"
                  onClick={() => toggleCategory(cat.slug)}
                  disabled={disabled}
                  style={{
                    fontSize: 12,
                    padding: '4px 10px',
                    borderRadius: 999,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.4 : 1,
                    background: selected ? `${theme.accentA25}` : 'transparent',
                    color: selected ? theme.accentText : theme.textMuted,
                    border: `1px solid ${selected ? theme.accent : theme.borderSubtle}`,
                  }}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
            Helps creators filter the marketplace. Pick the closest matches —
            don&rsquo;t tag every category, it dilutes filtering.
          </div>
          <ProgramCoverField url={coverUrl} onChange={onCoverChange} />
          <ProgramVideoField value={videoUrl} onChange={onVideoChange} />
        </div>
      )}
    </div>
  );
}

/** Non-empty and not a YouTube / Vimeo / Loom link — Save stays disabled
 *  (the API would 400 it anyway). */
function videoLinkInvalid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && parseVideoUrl(trimmed) === null;
}

/**
 * Cover image for the marketplace card + program page. Uploads straight
 * away (POST /uploads/program-cover) but only attaches to the program on
 * Save, like every other field in the form.
 */
function ProgramCoverField({ url, onChange }: { url: string | null; onChange: (v: string | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => api<{ url: string }>('/uploads/program-cover', { method: 'POST', body: file }),
    onSuccess: (r) => {
      setError(null);
      onChange(r.url);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Upload failed'),
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Use a JPEG, PNG or WebP image.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Image too large — max 2 MB.');
      return;
    }
    upload.mutate(file);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <Label>Cover image (optional)</Label>
      {url && (
        <div
          style={{
            maxWidth: 480,
            aspectRatio: '3 / 1',
            borderRadius: 8,
            overflow: 'hidden',
            border: `1px solid ${theme.borderSubtle}`,
            background: theme.surface2,
            marginBottom: 8,
          }}
        >
          <img src={url} alt="Cover preview" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ display: 'inline-block' }}>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onPick}
            style={{ display: 'none' }}
            disabled={upload.isPending}
          />
          <span
            style={{
              display: 'inline-block',
              padding: '6px 12px',
              background: theme.surface2,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radiusSm,
              fontSize: 13,
              color: theme.text,
              cursor: upload.isPending ? 'wait' : 'pointer',
              opacity: upload.isPending ? 0.6 : 1,
            }}
          >
            {upload.isPending ? 'Uploading…' : url ? 'Replace image' : 'Upload image'}
          </span>
        </label>
        {url && (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </Button>
        )}
      </div>
      <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
        A wide banner across the top of your marketplace card and program page. 1500×500
        (3:1) works best; JPEG, PNG or WebP up to 2 MB. Without one, the card shows a banner
        made from your logo.
      </div>
      {error && <div style={{ marginTop: 6, fontSize: 12, color: theme.danger }}>{error}</div>}
    </div>
  );
}

/** YouTube / Vimeo / Loom link with a live player preview, parsed with the
 *  same allowlist the API and the Network enforce. */
function ProgramVideoField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const trimmed = value.trim();
  const video = trimmed ? parseVideoUrl(trimmed) : null;
  const invalid = trimmed !== '' && !video;
  return (
    <div style={{ marginTop: 16 }}>
      <Label>Video (optional)</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://www.youtube.com/watch?v=…"
        style={invalid ? { borderColor: alpha(theme.danger, 0.533) } : undefined}
      />
      <div style={{ fontSize: 12, color: invalid ? theme.danger : theme.textDim, marginTop: 4 }}>
        {invalid
          ? 'Use a YouTube, Vimeo or Loom link.'
          : 'A YouTube, Vimeo or Loom link, shown on your program’s marketplace page. Unlisted videos work too.'}
      </div>
      {video && (
        <div
          style={{
            marginTop: 8,
            maxWidth: 480,
            aspectRatio: '16 / 9',
            borderRadius: 8,
            overflow: 'hidden',
            border: `1px solid ${theme.borderSubtle}`,
            background: '#000', // video letterbox — black in both themes, like the player itself
          }}
        >
          <iframe
            src={video.embedUrl}
            title="Program video preview"
            style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
            allow="encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      )}
    </div>
  );
}

/** Where the customer discount comes from. Only a single-tenant
 *  self-host mints it in Stripe; anywhere else, promising "applies
 *  automatically" would have brands advertise discounts that never
 *  reach their checkout. */
function rewardDeliveryHint(delivery: CustomerRewardDelivery | undefined): React.ReactNode {
  switch (delivery) {
    case 'stripe':
      return (
        <>
          Auto-provisioned as a Stripe coupon on each partner's code. Customer types
          the code at your Stripe checkout → discount applies automatically.
        </>
      );
    case 'brand':
      return (
        <>
          You set up the discount: in your own Stripe, create a promotion code with
          the same string as each partner&rsquo;s code and the terms set here (or
          apply the discount in your own checkout). OpenPartner attributes the
          redemption when your checkout sends the code to <code>POST /coupons/redeem</code>.
          On OpenPartner Cloud, connect your Stripe account under Integrations instead: each
          code then gets its Stripe promotion code automatically, and redemptions attribute
          without that call.
        </>
      );
    case 'unconfigured':
      return (
        <>
          Not applied automatically: no Stripe key is configured. Set{' '}
          <code>STRIPE_SECRET_KEY</code> to your Stripe secret key and codes minted
          from then on get a matching Stripe coupon. Until then, apply the discount
          in your own checkout.
        </>
      );
    default:
      return null;
  }
}

function CustomerRewardEditor({
  reward,
  delivery,
  onChange,
}: {
  reward: CustomerReward | null;
  delivery: CustomerRewardDelivery | undefined;
  onChange: (reward: CustomerReward | null) => void;
}) {
  const enabled = reward != null;
  const update = (patch: Partial<CustomerReward>) => {
    onChange({ ...(reward as CustomerReward), ...patch });
  };
  const hint = rewardDeliveryHint(delivery);

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
      {hint && (
        <div style={{ fontSize: 12, color: theme.textDim, marginLeft: 24, marginBottom: 8 }}>
          {hint}
        </div>
      )}
      {enabled && reward && (
        <div
          className="op-grid-collapse"
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
              {delivery === 'stripe'
                ? 'Delivered as a 100% Stripe coupon for the configured number of months.'
                : 'In Stripe, that’s a 100% coupon repeating for the configured number of months.'}
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
/** Mirror of the API's destination check (z.string().url() plus the
 *  {click_id} macro rules) so the form explains the rule instead of
 *  bouncing a 400. Null = fine (empty is gated separately). */
/**
 * Destination URL + allowed deep-link domains, shared by the create and
 * edit forms so both run the same checks and hints.
 *
 * `editing` adds what changing a live program's destination means: share
 * links without their own deep link resolve the program's destination at
 * click time, so the change applies to every such link at once.
 */
function DestinationFields({
  destinationUrl,
  onDestinationChange,
  deepLinkDomains,
  onDeepLinkDomainsChange,
  editing = false,
}: {
  destinationUrl: string;
  onDestinationChange: (v: string) => void;
  deepLinkDomains: string;
  onDeepLinkDomainsChange: (v: string) => void;
  editing?: boolean;
}) {
  // The API requires a full URL (z.string().url()) — surface that next to
  // the field instead of a bare 400 after submit. First real-world trip-up:
  // typing "yourbrand.com" without the scheme, so offer the one-click fix.
  const urlProblem = destinationUrlProblem(destinationUrl);
  const schemeFix =
    urlProblem && /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(destinationUrl.trim())
      ? `https://${destinationUrl.trim()}`
      : null;
  // Saveable, but a Stripe Payment Link without client_reference_id={click_id}
  // never hands Stripe the click. Same check the API answers with `warnings`.
  const urlWarning = !urlProblem && destinationUrl.trim() ? clickDestinationWarning(destinationUrl.trim()) : null;
  const stripeFix = urlWarning ? withClientReferenceMacro(destinationUrl.trim()) : null;
  const fixButton = {
    background: 'none',
    border: 'none',
    color: theme.accentText,
    cursor: 'pointer',
    padding: 0,
    fontSize: 12,
    textDecoration: 'underline',
  } as const;

  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <Label>Destination URL</Label>
        <Input
          type="url"
          value={destinationUrl}
          onChange={(e) => onDestinationChange(e.target.value)}
          placeholder="https://yourbrand.com/landing-page"
        />
        {urlProblem ? (
          <div style={{ fontSize: 12, color: theme.danger, marginTop: 4 }}>
            {urlProblem}
            {schemeFix && (
              <>
                {' '}
                <button type="button" onClick={() => onDestinationChange(schemeFix)} style={fixButton}>
                  Use {schemeFix}
                </button>
              </>
            )}
          </div>
        ) : urlWarning ? (
          <div style={{ fontSize: 12, color: theme.warn, marginTop: 4 }}>
            {urlWarning}
            {stripeFix && (
              <>
                {' '}
                <button type="button" onClick={() => onDestinationChange(stripeFix)} style={fixButton}>
                  Add it
                </button>
              </>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
            Where partner share-links for this campaign land. Partners can&rsquo;t change this unless you allow deep links below.
            The click id is added as <code>?cref=</code>; to send it in your own parameter, put{' '}
            <code>{'{click_id}'}</code> where it goes, e.g. a Stripe Payment Link&rsquo;s{' '}
            <code>{'?client_reference_id={click_id}'}</code>.
            {editing && (
              <>
                {' '}A change applies at once to every share-link without its own deep link; links a
                partner deep-linked elsewhere keep their destination.
              </>
            )}
          </div>
        )}
      </div>
      <div style={{ marginBottom: 14 }}>
        <Label>Allowed deep-link domains (optional)</Label>
        <Input
          value={deepLinkDomains}
          onChange={(e) => onDeepLinkDomainsChange(e.target.value)}
          placeholder="yourbrand.com,docs.yourbrand.com"
        />
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
          Comma-separated host list. Partners can override the destination on share-links as long as their override matches one of these. Leave blank to lock destinations.
          {editing && <> Clearing it doesn&rsquo;t change share-links already deep-linked.</>}
        </div>
      </div>
    </>
  );
}

function destinationUrlProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const url = new URL(v);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return 'Must be an http(s) address.';
    }
    return clickDestinationProblem(v);
  } catch {
    return 'Must be a full URL starting with https:// — e.g. https://yourbrand.com/landing.';
  }
}

/** The one-click fix for a Stripe Payment Link with no client_reference_id:
 *  the macro appended as typed, braces unencoded. Null when the link already
 *  has the parameter (with the wrong value) or a fragment, where appending
 *  would land in the wrong place; the warning text says what to change. */
function withClientReferenceMacro(value: string): string | null {
  if (value.includes('#') || /[?&]client_reference_id=/.test(value)) return null;
  return `${value}${value.includes('?') ? '&' : '?'}client_reference_id={click_id}`;
}

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

function ProgramStatusPill({ campaign }: { campaign: Pick<Program, 'startsAt' | 'endsAt'> }) {
  const status = statusOf(campaign);
  const palette: Record<ProgramStatus, { bg: string; fg: string; label: string }> = {
    active: { bg: theme.successSoft, fg: theme.success, label: 'Active' },
    scheduled: { bg: `${theme.accentA15}`, fg: theme.accent, label: 'Scheduled' },
    ended: { bg: theme.surface2, fg: theme.textMuted, label: 'Ended' },
  };
  const { bg, fg, label } = palette[status];
  return (
    <span style={{ background: bg, color: fg, fontSize: 11, padding: '2px 8px', borderRadius: 12, fontWeight: 600 }}>
      {label}
    </span>
  );
}
