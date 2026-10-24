import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ListOrdered, X } from 'lucide-react';
import { api } from '../../api.js';
import { eventTypeLabel } from '../../lib/commission-source.js';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label } from '../../ui.js';

interface Stage {
  eventType: string;
  label: string;
}

interface ReferralSettings {
  stages: Stage[];
  showCustomerLabels: boolean;
  defaultStages: Stage[];
  recentEventTypes: string[];
}

/** Mirrors the API's limits (routes/referrals.ts). */
const MAX_STAGES = 20;
const MAX_LABEL = 60;
const MAX_EVENT_TYPE = 100;
const CORRECTIVE_TYPES = ['refund', 'chargeback', 'dispute_created', 'invoice_payment_failed'];

/**
 * Which event types partners see as stages on their Referrals page, what
 * each is called, and in what order; and whether partners see the
 * customer label the brand sends (`metadata.customerLabel`). Event types
 * not listed stay hidden from partners.
 */
export function ReferralStagesSection() {
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const { data, error, isLoading } = useQuery({
    queryKey: ['referral-settings'],
    queryFn: () => api<ReferralSettings>('/config/referrals'),
  });
  const [draft, setDraft] = useState<Stage[] | null>(null);
  const [newType, setNewType] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [saved, setSaved] = useState(false);

  // Start editing from what's saved; keep unsaved edits across refetches.
  useEffect(() => {
    if (data && draft === null) setDraft(data.stages);
  }, [data, draft]);

  const mut = useMutation({
    mutationFn: (patch: Partial<Pick<ReferralSettings, 'stages' | 'showCustomerLabels'>>) =>
      api<ReferralSettings>('/config/referrals', { method: 'POST', body: patch }),
    onSuccess: (next, patch) => {
      qc.setQueryData(['referral-settings'], next);
      // Take the saved list only if nothing changed while it was saving,
      // so an edit made meanwhile isn't thrown away.
      if (patch.stages) setDraft((d) => (JSON.stringify(d) === JSON.stringify(patch.stages) ? next.stages : d));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  if (isLoading || !data || !draft) return <Card>{error ? <ErrorBanner error={error} /> : 'Loading…'}</Card>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.stages);
  const listed = new Set(draft.map((s) => s.eventType));
  const suggestions = data.recentEventTypes.filter((t) => !listed.has(t));
  const type = newType.trim();
  const addError = !type
    ? null
    : listed.has(type)
      ? 'Already a stage.'
      : CORRECTIVE_TYPES.includes(type)
        ? 'Refunds and other corrections are never credited to a partner, so they can’t be stages.'
        : null;
  const canAdd = !!type && !addError && draft.length < MAX_STAGES;
  const blankLabel = draft.some((s) => !s.label.trim());

  const move = (i: number, by: -1 | 1) =>
    setDraft((d) => {
      const next = [...(d ?? [])];
      const [stage] = next.splice(i, 1);
      next.splice(i + by, 0, stage!);
      return next;
    });
  const add = () => {
    if (!canAdd) return;
    setDraft((d) => [...(d ?? []), { eventType: type, label: (newLabel.trim() || eventTypeLabel(type)).slice(0, MAX_LABEL) }]);
    setNewType('');
    setNewLabel('');
  };

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <ListOrdered size={18} style={{ color: theme.accentText }} />
        <div style={{ fontSize: 15, fontWeight: 500 }}>Referral stages</div>
      </div>
      <ErrorBanner error={error ?? mut.error} />
      <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6, marginBottom: 14, maxWidth: 620 }}>
        Partners see each customer they referred move through these stages, in this order, on their Referrals page
        (and in <code>GET /partners/&#123;id&#125;/referrals</code>). Use the event types you send to{' '}
        <code>POST /attribution/events</code>, such as your CRM&rsquo;s <code>demo_booked</code>. Types you don&rsquo;t
        list stay hidden from partners&rsquo; referrals, though commissions on them still count, and a commission
        line still names the event it paid on.
      </div>

      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 620 }}>
        {draft.map((stage, i) => (
          <li
            key={stage.eventType}
            style={{
              display: 'flex',
              flexWrap: isMobile ? 'wrap' : 'nowrap',
              alignItems: 'center',
              gap: 8,
              padding: '8px 10px',
              background: theme.surface2,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radiusSm,
            }}
          >
            <span style={{ width: 18, fontSize: 12, color: theme.textDim, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
            <code style={{ fontSize: 12, color: theme.textMuted, flex: isMobile ? '1 1 60%' : '0 0 180px', overflowWrap: 'anywhere' }}>
              {stage.eventType}
            </code>
            <div style={{ flex: '1 1 160px', minWidth: 0 }}>
              <Input
                aria-label={`Label for ${stage.eventType}`}
                value={stage.label}
                maxLength={MAX_LABEL}
                onChange={(e) => {
                  const label = e.target.value;
                  setDraft((d) => (d ?? []).map((s, j) => (j === i ? { ...s, label } : s)));
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              <IconButton label={`Move ${stage.label} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </IconButton>
              <IconButton label={`Move ${stage.label} down`} disabled={i === draft.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </IconButton>
              <IconButton label={`Remove ${stage.label}`} onClick={() => setDraft((d) => (d ?? []).filter((_, j) => j !== i))}>
                <X size={14} />
              </IconButton>
            </div>
          </li>
        ))}
        {draft.length === 0 && (
          <li style={{ fontSize: 13, color: theme.textDim, padding: '8px 0' }}>
            No stages: partners see each referral and what it earned them, but no steps.
          </li>
        )}
      </ol>

      {draft.length < MAX_STAGES && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, marginTop: 12, maxWidth: 620 }}>
          <div style={{ flex: '1 1 180px' }}>
            <Label>Event type</Label>
            <Input
              list="referral-stage-types"
              placeholder="demo_booked"
              maxLength={MAX_EVENT_TYPE}
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <datalist id="referral-stage-types">
              {suggestions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <div style={{ flex: '1 1 180px' }}>
            <Label>Label partners see</Label>
            <Input
              placeholder={type ? eventTypeLabel(type) : 'Demo booked'}
              value={newLabel}
              maxLength={MAX_LABEL}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
          </div>
          <Button variant="secondary" onClick={add} disabled={!canAdd}>
            Add stage
          </Button>
        </div>
      )}
      {addError && <div style={{ fontSize: 12, color: theme.danger, marginTop: 6 }}>{addError}</div>}
      {suggestions.length > 0 && (
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
          Recently recorded: {suggestions.slice(0, 8).join(', ')}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 14 }}>
        <Button onClick={() => mut.mutate({ stages: draft })} disabled={!dirty || blankLabel || mut.isPending}>
          {mut.isPending ? 'Saving…' : 'Save stages'}
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(data.stages)}>
            Discard changes
          </Button>
        )}
        {JSON.stringify(draft) !== JSON.stringify(data.defaultStages) && (
          <Button variant="ghost" onClick={() => setDraft(data.defaultStages)}>
            Use the default stages
          </Button>
        )}
        {blankLabel && <span style={{ fontSize: 12, color: theme.danger }}>Every stage needs a label.</span>}
        {saved && <span style={{ color: theme.success, fontSize: 13 }}>Saved.</span>}
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, cursor: 'pointer', marginTop: 20, maxWidth: 620 }}>
        <input
          type="checkbox"
          checked={data.showCustomerLabels}
          onChange={(e) => mut.mutate({ showCustomerLabels: e.target.checked })}
          disabled={mut.isPending}
          style={{ marginTop: 2 }}
        />
        <span>
          <strong>Show partners the customer label you send</strong>
          <span style={{ color: theme.textMuted, display: 'block', lineHeight: 1.6 }}>
            Send <code>metadata.customerLabel</code> on your events (a company name, say) and partners see it in place of
            &ldquo;Referral #12&rdquo;. OpenPartner only stores your user ID for a customer. A label is personal data you
            choose to share with your partners, as its controller, so it&rsquo;s off until you turn it on.
          </span>
        </span>
      </label>
    </Card>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        background: 'transparent',
        border: 'none',
        borderRadius: theme.radiusSm,
        color: disabled ? theme.textDim : theme.textMuted,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}
