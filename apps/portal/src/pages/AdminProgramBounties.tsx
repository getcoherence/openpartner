import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { ArrowLeft, Plus, Trophy, X } from 'lucide-react';
import { formatBountyAmount, formatBountyValue, renderBountySummary, type BountyLike } from '@openpartner/db';
import { api } from '../api.js';
import { useDefaultCurrency } from '../lib/useBrand.js';
import { useIsMobile } from '../lib/useMediaQuery.js';
import { useDebouncedSearch, usePartnerSearch } from '../lib/usePartnerSearch.js';
import { alpha, theme } from '../theme.js';
import { TenantLink } from '../tenant-link.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  Label,
  Page,
  ProgressBar,
  Select,
  StatusPill,
  Table,
  Textarea,
  formatDate,
} from '../ui.js';

type Metric = BountyLike['metric'];
type Status = 'draft' | 'active' | 'ended' | 'archived';

export interface Bounty extends BountyLike {
  id: string;
  programId: string;
  name: string;
  description: string | null;
  status: Status;
  partnerIds: string[] | null;
  summary: string;
  awardedCount: number;
  endedAt: string | null;
}

interface ProgressRow {
  partnerId: string;
  name: string;
  email: string;
  value: number;
  reached: boolean;
  award: { bonusId: string; commissionId: string; status: string; awardedAt: string } | null;
}

interface Progress {
  bounty: Bounty;
  totals: { eligible: number; reached: number; awarded: number };
  partners: ProgressRow[];
  truncated: boolean;
}

const METRIC_LABEL: Record<Metric, string> = {
  conversions: 'conversions',
  revenue: 'revenue',
  leads: 'leads',
  commissions: 'commissions',
};

const MONEY: ReadonlySet<Metric> = new Set(['revenue', 'commissions']);

/**
 * Admin → Programs → Bounties: goals on one program that pay a bonus once a
 * partner reaches them (docs/bounties.md §7). An hourly sweep measures
 * partners and pays the bonus, held for the program's holdback.
 */
export function AdminProgramBounties() {
  const { id } = useParams<{ id: string }>();
  const programId = id ?? '';
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const programs = useQuery({
    queryKey: ['me-campaigns-for-invite'],
    queryFn: () => api<{ programs: Array<{ id: string; name: string }> }>('/me/programs'),
  });
  const programName = programs.data?.programs.find((p) => p.id === programId)?.name ?? '…';

  const bounties = useQuery({
    queryKey: ['bounties', programId],
    queryFn: () => api<{ bounties: Bounty[] }>(`/bounties?programId=${encodeURIComponent(programId)}`),
    enabled: !!programId,
  });
  const rows = bounties.data?.bounties ?? [];

  return (
    <Page
      title={`Bounties · ${programName}`}
      subtitle="Goals that pay a partner a bonus once they reach them. Checked every hour; the bonus waits out the program's holdback before it's approved."
      actions={
        !creating && (
          <Button icon={<Plus size={14} />} onClick={() => setCreating(true)}>
            New bounty
          </Button>
        )
      }
    >
      <div style={{ marginBottom: 14 }}>
        <TenantLink to="/admin/programs" style={{ color: theme.textMuted, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={14} /> Back to Programs
        </TenantLink>
      </div>
      {creating && <CreateBounty programId={programId} onDone={() => setCreating(false)} />}
      <ErrorBanner error={bounties.error} />
      {bounties.isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        !creating && (
          <EmptyState
            title="No bounties yet"
            hint='Reward a goal, like "10 new conversions by Dec 31 earns $500".'
            icon={<Trophy size={28} strokeWidth={1.25} />}
          />
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((b) => (
            <BountyCard key={b.id} bounty={b} open={open === b.id} onToggle={() => setOpen(open === b.id ? null : b.id)} />
          ))}
        </div>
      )}
    </Page>
  );
}

function BountyCard({ bounty: b, open, onToggle }: { bounty: Bounty; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [extending, setExtending] = useState(false);
  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<{ bounty: Bounty }>(`/bounties/${b.id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      setExtending(false);
      qc.invalidateQueries({ queryKey: ['bounties', b.programId] });
      qc.invalidateQueries({ queryKey: ['bounty-progress', b.id] });
    },
  });
  const action = (label: string, patch: Record<string, unknown>, confirmText?: string, danger = false) => (
    <Button
      size="sm"
      variant={danger ? 'danger' : 'secondary'}
      disabled={update.isPending}
      onClick={() => {
        if (confirmText && !window.confirm(confirmText)) return;
        update.mutate(patch);
      }}
    >
      {label}
    </Button>
  );

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 12, justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{b.name}</span>
            <StatusPill status={b.status} />
            {b.partnerIds && (
              <span style={{ fontSize: 12, color: theme.textDim }}>
                {b.partnerIds.length} {b.partnerIds.length === 1 ? 'partner' : 'partners'} only
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: theme.text, marginBottom: 4 }}>{b.summary}</div>
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            {b.awardedCount} {b.awardedCount === 1 ? 'partner has' : 'partners have'} earned it
            {b.endsAt ? ` · ends ${formatDate(b.endsAt)}` : ' · no end date'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start', flexShrink: 0 }}>
          <Button size="sm" variant="secondary" onClick={onToggle} aria-expanded={open}>
            {open ? 'Hide progress' : 'Progress'}
          </Button>
          {b.status === 'draft' && action('Launch', { status: 'active' })}
          {(b.status === 'active' || b.status === 'ended') && !extending && (
            <Button size="sm" variant="secondary" onClick={() => setExtending(true)}>
              {b.endsAt ? 'Change end date' : 'Set end date'}
            </Button>
          )}
          {b.status === 'active' &&
            action('End now', { status: 'ended' }, `End "${b.name}" now? Nobody else can earn it; bonuses already paid stand.`)}
          {b.status !== 'archived' &&
            action('Archive', { status: 'archived' }, `Archive "${b.name}"? Partners stop seeing it.`, true)}
        </div>
      </div>
      <ErrorBanner error={update.error} />
      {extending && (
        <EndDateEditor
          bounty={b}
          pending={update.isPending}
          onCancel={() => setExtending(false)}
          onSave={(endsAt) => update.mutate(b.status === 'ended' && endsAt ? { endsAt, status: 'active' } : { endsAt })}
        />
      )}
      {b.description && (
        <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 10, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {b.description}
        </div>
      )}
      {open && <BountyProgress bounty={b} />}
    </Card>
  );
}

function EndDateEditor({
  bounty,
  pending,
  onCancel,
  onSave,
}: {
  bounty: Bounty;
  pending: boolean;
  onCancel: () => void;
  onSave: (endsAt: string | null) => void;
}) {
  const [date, setDate] = useState(bounty.endsAt ? new Date(bounty.endsAt).toISOString().slice(0, 10) : '');
  const locked = bounty.awardedCount > 0;
  return (
    <div style={{ marginTop: 12, padding: 12, background: theme.surface2, borderRadius: theme.radiusSm, display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <div>
        <Label>Ends (UTC, end of day excluded)</Label>
        <Input type="date" aria-label="Bounty end date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <Button size="sm" disabled={pending} onClick={() => onSave(date ? new Date(`${date}T00:00:00Z`).toISOString() : null)}>
        Save
      </Button>
      <Button size="sm" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      {locked && (
        <div style={{ fontSize: 12, color: theme.textDim, flexBasis: '100%' }}>
          Partners have earned this bounty, so its end can only move later.
        </div>
      )}
    </div>
  );
}

function BountyProgress({ bounty }: { bounty: Bounty }) {
  const progress = useQuery({
    queryKey: ['bounty-progress', bounty.id],
    queryFn: () => api<Progress>(`/bounties/${bounty.id}/progress`),
  });
  const threshold = Number(bounty.threshold);
  if (progress.isLoading) return <div style={{ marginTop: 12, fontSize: 13, color: theme.textMuted }}>Loading progress…</div>;
  if (progress.error) return <ErrorBanner error={progress.error} />;
  const data = progress.data!;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 8 }}>
        {data.totals.eligible} eligible · {data.totals.reached} reached · {data.totals.awarded} paid
        {data.truncated && ' · showing the top 500'}
      </div>
      <Table
        columns={['Partner', 'Progress', 'Bonus']}
        empty="No partners can earn this yet. Grant partners the program first."
        rows={data.partners.map((r) => [
          <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
            <span style={{ fontWeight: 500 }}>{r.name}</span>
            <span style={{ fontSize: 12, color: theme.textDim }}>{r.email}</span>
          </span>,
          <ProgressBar value={r.value} threshold={threshold} label={`${formatBountyValue(bounty, r.value)} of ${formatBountyValue(bounty, threshold)}`} />,
          r.award ? <StatusPill status={r.award.status} /> : <span style={{ color: theme.textDim }}>{r.reached ? 'next check' : '—'}</span>,
        ])}
      />
    </div>
  );
}

// ---------- Create: the sentence form ----------

function CreateBounty({ programId, onDone }: { programId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const defaultCurrency = useDefaultCurrency();
  const today = new Date().toISOString().slice(0, 10);
  const [scope, setScope] = useState<'new' | 'lifetime'>('new');
  const [metric, setMetric] = useState<Metric>('conversions');
  const [eventType, setEventType] = useState('');
  const [threshold, setThreshold] = useState('10');
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState('');
  const [reward, setReward] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [onlySome, setOnlySome] = useState(false);
  const [picked, setPicked] = useState<Map<string, string>>(new Map());

  const code = (currency ?? defaultCurrency).trim().toUpperCase();
  const money = MONEY.has(metric);
  const thresholdOk = money ? /^\d+(\.\d{1,2})?$/.test(threshold) && Number(threshold) > 0 : /^\d+$/.test(threshold) && Number(threshold) > 0;
  const rewardOk = /^\d+(\.\d{1,2})?$/.test(reward.trim()) && Number(reward) > 0;
  const datesOk = !endsOn || endsOn > startsOn;
  const ready = thresholdOk && rewardOk && datesOk && /^[A-Z]{3}$/.test(code) && name.trim() !== '' && (!onlySome || picked.size > 0);

  const draft = {
    metric,
    eventType: eventType.trim() || null,
    threshold: Number(threshold) || 0,
    scope,
    startsAt: `${startsOn}T00:00:00Z`,
    endsAt: endsOn ? `${endsOn}T00:00:00Z` : null,
    rewardAmount: Number(reward) || 0,
    currency: code,
  };

  const create = useMutation({
    mutationFn: (status: 'active' | 'draft') =>
      api<{ bounty: Bounty }>('/bounties', {
        method: 'POST',
        body: {
          programId,
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...draft,
          eventType: draft.eventType ?? undefined,
          ...(onlySome ? { partnerIds: [...picked.keys()] } : {}),
          status,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bounties', programId] });
      onDone();
    },
  });

  const inline: React.CSSProperties = { width: 'auto', display: 'inline-block', margin: '0 4px', verticalAlign: 'middle' };

  return (
    <Card style={{ marginBottom: 14 }}>
      <div role="region" aria-label="New bounty">
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 12 }}>New bounty</div>
        <ErrorBanner error={create.error} />
        <div style={{ fontSize: 14, lineHeight: 2.6, color: theme.text, marginBottom: 6 }}>
          When a partner&rsquo;s
          <Select aria-label="Count" value={scope} onChange={(e) => setScope(e.target.value as 'new' | 'lifetime')} style={inline}>
            <option value="new">new</option>
            <option value="lifetime">all-time</option>
          </Select>
          <Select aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value as Metric)} style={inline}>
            {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
              <option key={m} value={m}>
                {METRIC_LABEL[m]}
              </option>
            ))}
          </Select>
          reach
          <Input
            aria-label="Threshold"
            inputMode="decimal"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            style={{ ...inline, width: 110 }}
          />
          {money && code}
          {scope === 'new' ? ' between' : ' by'}
          {scope === 'new' && (
            <>
              <Input aria-label="Starts" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} style={inline} />
              and
            </>
          )}
          <Input aria-label="Ends" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} style={inline} />
          , pay
          <Input
            aria-label="Reward"
            inputMode="decimal"
            placeholder="500"
            value={reward}
            onChange={(e) => setReward(e.target.value)}
            style={{ ...inline, width: 110 }}
          />
          <Input
            aria-label="Currency"
            value={currency ?? defaultCurrency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            style={{ ...inline, width: 70 }}
          />
          .
        </div>
        <div style={{ fontSize: 12, color: theme.textDim, marginBottom: 14 }}>
          {!endsOn && 'Leave the end date empty for no end. '}
          Dates are UTC; the end date itself is not included.
          {!thresholdOk && threshold !== '' && (
            <span style={{ color: theme.danger }}> {money ? 'The amount has at most two decimals.' : 'Count in whole numbers.'}</span>
          )}
          {!datesOk && <span style={{ color: theme.danger }}> The end must be after the start.</span>}
        </div>

        {(metric === 'conversions' || metric === 'revenue') && (
          <div style={{ marginBottom: 14, maxWidth: 420 }}>
            <Label>Only this event type (optional)</Label>
            <Input
              aria-label="Event type"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder={metric === 'conversions' ? 'Any sale (an event with a value)' : 'invoice_paid'}
            />
          </div>
        )}

        <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
          <div>
            <Label>Name</Label>
            <Input aria-label="Bounty name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Holiday push" />
          </div>
          <div>
            <Label>Who can earn it</Label>
            <Select aria-label="Who can earn it" value={onlySome ? 'some' : 'all'} onChange={(e) => setOnlySome(e.target.value === 'some')}>
              <option value="all">Every partner in this program</option>
              <option value="some">Only partners I choose</option>
            </Select>
          </div>
        </div>
        {onlySome && <PartnerPicker picked={picked} onChange={setPicked} />}
        <div style={{ marginBottom: 14 }}>
          <Label>Description for partners (optional, plain text)</Label>
          <Textarea
            aria-label="Bounty description"
            rows={3}
            maxLength={5000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What counts, and any rules partners should know."
          />
        </div>

        {thresholdOk && rewardOk && datesOk && (
          <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14, padding: '8px 12px', background: alpha(theme.accent, 0.08), borderRadius: theme.radiusSm }}>
            Partners will see: <span style={{ color: theme.text }}>{renderBountySummary(draft)}</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button disabled={!ready || create.isPending} onClick={() => create.mutate('active')}>
            {create.isPending ? 'Saving…' : `Launch · pays ${rewardOk ? formatBountyAmount(Number(reward), code) : '…'}`}
          </Button>
          <Button variant="secondary" disabled={!ready || create.isPending} onClick={() => create.mutate('draft')}>
            Save as draft
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PartnerPicker({ picked, onChange }: { picked: Map<string, string>; onChange: (next: Map<string, string>) => void }) {
  const [search, setSearch] = useState('');
  const q = useDebouncedSearch(search);
  const list = usePartnerSearch<{ id: string; name: string; email: string }>(q, 20);
  const results = list.data?.pages.flatMap((p) => p.partners) ?? [];
  const toggle = (id: string, name: string) => {
    const next = new Map(picked);
    if (next.has(id)) next.delete(id);
    else next.set(id, name);
    onChange(next);
  };
  return (
    <div style={{ marginBottom: 14, padding: 12, background: theme.surface2, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm }}>
      {picked.size > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {[...picked].map(([id, name]) => (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id, name)}
              aria-label={`Remove ${name}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                background: theme.accentA15,
                color: theme.accentText,
                border: 'none',
                borderRadius: 999,
                padding: '3px 10px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {name} <X size={12} />
            </button>
          ))}
        </div>
      )}
      <Input aria-label="Search partners" type="search" placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, maxHeight: 200, overflowY: 'auto' }}>
        {results.map((p) => (
          <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.text }}>
            <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id, p.name)} />
            {p.name} <span style={{ color: theme.textDim }}>{p.email}</span>
          </label>
        ))}
      </div>
      <div style={{ fontSize: 12, color: theme.textDim, marginTop: 8 }}>
        Only partners granted this program can earn it, whoever you pick.
      </div>
    </div>
  );
}

