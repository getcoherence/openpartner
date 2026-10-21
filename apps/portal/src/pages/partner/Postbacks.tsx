import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Webhook as WebhookIcon, Trash2 } from 'lucide-react';
import { ApiError, api, type Principal } from '../../api.js';
import { theme } from '../../theme.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  Label,
  Page,
  StatusPill,
  formatDate,
} from '../../ui.js';

const POSTBACK_EVENTS = [
  'commission.accrued',
  'commission.approved',
  'commission.paid',
  'commission.reversed',
  'bonus.awarded',
  'bonus.paid',
] as const;

type PostbackEvent = (typeof POSTBACK_EVENTS)[number];

/** As the API lists it: the URL itself never comes back here, only
 *  `urlPreview` (path and query values masked), because it may hold the
 *  tracker's secret. The edit form fetches the URL on its own. */
interface PostbackRow {
  id: string;
  partnerId: string;
  urlPreview: string | null;
  events: PostbackEvent[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastFiredAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  successCount: number;
  failureCount: number;
}

export function PartnerPostbacksPage({ principal }: { principal: Principal }) {
  const qc = useQueryClient();
  const partnerId = principal.role === 'partner' ? principal.partnerId : null;
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['partner-postbacks', partnerId],
    queryFn: () =>
      api<{ postbacks: PostbackRow[]; supportedEvents: string[] }>(
        `/partners/${partnerId}/postbacks`,
      ),
    enabled: !!partnerId,
  });

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<PostbackRow>(`/partners/${partnerId}/postbacks/${id}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner-postbacks', partnerId] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/partners/${partnerId}/postbacks/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner-postbacks', partnerId] }),
  });

  if (!partnerId) {
    return (
      <Page title="Postback URLs">
        <EmptyState
          title="Partners only"
          hint="Postback URLs are a partner-side integration."
          icon={<WebhookIcon size={28} strokeWidth={1.25} />}
        />
      </Page>
    );
  }

  const rows = list.data?.postbacks ?? [];

  return (
    <Page
      title="Postback URLs"
      subtitle="Forward conversion events to your tracker (Voluum, RedTrack, Bemob, or your own)."
      actions={
        <Button icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
          Add postback
        </Button>
      }
    >
      <ErrorBanner error={list.error ?? toggleEnabled.error ?? remove.error} />

      {showCreate && <CreatePostback partnerId={partnerId} onDone={() => setShowCreate(false)} />}

      {list.isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No postbacks yet"
          hint="Add one to fire a GET to your tracker every time a commission accrues / approves / pays out."
          icon={<WebhookIcon size={28} strokeWidth={1.25} />}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((p) =>
            editingId === p.id ? (
              <EditPostback key={p.id} partnerId={partnerId} row={p} onDone={() => setEditingId(null)} />
            ) : (
              <PostbackCard
                key={p.id}
                row={p}
                onEdit={() => setEditingId(p.id)}
                onToggle={() => toggleEnabled.mutate({ id: p.id, enabled: !p.enabled })}
                onDelete={() => remove.mutate(p.id)}
              />
            ),
          )}
        </div>
      )}

      <MacroReference />
    </Page>
  );
}

function PostbackCard({
  row,
  onEdit,
  onToggle,
  onDelete,
}: {
  row: PostbackRow;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const totalFires = row.successCount + row.failureCount;
  return (
    <Card>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
        {/* Below ~240px of room for the URL, the buttons wrap under it. */}
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <StatusPill status={row.enabled ? 'active' : 'paused'} />
            <code
              style={{ fontSize: 12, color: theme.textMuted, wordBreak: 'break-all' }}
              title="The path and query values are hidden. Edit to see the full URL."
            >
              {row.urlPreview ?? "This URL can't be read here. Edit it to enter it again."}
            </code>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {row.events.map((e) => (
              <span
                key={e}
                style={{
                  fontSize: 11,
                  padding: '2px 7px',
                  borderRadius: 4,
                  background: theme.surface2,
                  color: theme.textMuted,
                }}
              >
                {e}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant="secondary" icon={<Pencil size={13} />} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="secondary" onClick={onToggle}>
            {row.enabled ? 'Pause' : 'Resume'}
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={onDelete} />
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 10,
          paddingTop: 10,
          borderTop: `1px solid ${theme.borderSubtle}`,
          fontSize: 12,
          color: theme.textMuted,
        }}
      >
        <Stat label="Fired" value={String(totalFires)} />
        <Stat label="Success" value={String(row.successCount)} />
        <Stat label="Failed" value={String(row.failureCount)} />
        <Stat label="Last fired" value={row.lastFiredAt ? formatDate(row.lastFiredAt) : '—'} />
        <Stat
          label="Last status"
          value={
            row.lastStatus
              ? `HTTP ${row.lastStatus}`
              : row.lastError
                ? row.lastError.slice(0, 30)
                : '—'
          }
        />
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 13, color: theme.text, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

/**
 * Add a postback. The mutation lives here, not on the page, so the URL in
 * its variables goes when the form closes: gcTime 0 only drops a mutation
 * nothing observes any more.
 */
function CreatePostback({ partnerId, onDone }: { partnerId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (body: { url: string; events: PostbackEvent[] }) =>
      api<PostbackRow>(`/partners/${partnerId}/postbacks`, { method: 'POST', body }),
    gcTime: 0,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['partner-postbacks', partnerId] });
      onDone();
    },
  });
  return (
    <PostbackForm
      title="New postback URL"
      submitLabel="Create"
      pendingLabel="Creating…"
      error={create.error}
      onCancel={onDone}
      onSubmit={(body) => create.mutate(body)}
      pending={create.isPending}
    />
  );
}

/**
 * Edit one postback. The URL comes from the one route that returns it,
 * which answers this partner only. Neither it nor the URL a save sends is
 * kept once the form closes (gcTime 0 on both). Saving sends `url` only
 * when it changed.
 */
function EditPostback({
  partnerId,
  row,
  onDone,
}: {
  partnerId: string;
  row: PostbackRow;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ['partner-postback-url', partnerId, row.id],
    queryFn: () => api<{ url: string }>(`/partners/${partnerId}/postbacks/${row.id}/url`),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (body: { url?: string; events: PostbackEvent[] }) =>
      api<PostbackRow>(`/partners/${partnerId}/postbacks/${row.id}`, { method: 'PATCH', body }),
    gcTime: 0,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['partner-postbacks', partnerId] });
      onDone();
    },
  });

  if (current.isLoading) return <Card>Loading…</Card>;
  // Sealed under another deployment's key: the partner types it again.
  const unreadable = current.error instanceof ApiError && current.error.status === 409;
  if (current.error && !unreadable) {
    return (
      <Card>
        <ErrorBanner error={current.error} />
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </Card>
    );
  }
  const original = current.data?.url ?? '';
  return (
    <PostbackForm
      title="Edit postback URL"
      submitLabel="Save"
      pendingLabel="Saving…"
      initialUrl={original}
      initialEvents={row.events}
      hint={unreadable ? "This URL can't be read on this deployment. Enter it again." : undefined}
      error={save.error}
      onCancel={onDone}
      onSubmit={({ url, events }) => save.mutate(url === original ? { events } : { url, events })}
      pending={save.isPending}
    />
  );
}

function PostbackForm({
  title,
  submitLabel,
  pendingLabel,
  initialUrl = '',
  initialEvents = ['commission.accrued'],
  hint,
  error,
  onCancel,
  onSubmit,
  pending,
}: {
  title: string;
  submitLabel: string;
  pendingLabel: string;
  initialUrl?: string;
  initialEvents?: PostbackEvent[];
  hint?: string;
  error?: unknown;
  onCancel: () => void;
  onSubmit: (body: { url: string; events: PostbackEvent[] }) => void;
  pending: boolean;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [events, setEvents] = useState<PostbackEvent[]>(initialEvents);

  const submit = () => {
    if (!url || events.length === 0) return;
    onSubmit({ url, events });
  };

  return (
    <Card style={{ marginBottom: 14, borderColor: theme.accent }}>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 10 }}>{title}</div>
      <ErrorBanner error={error} />
      {hint && <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 8 }}>{hint}</div>}
      <Label>URL with macros</Label>
      <Input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://tracker.example.com/postback?cid={click_id}&payout={commission_amount}"
      />
      <div style={{ marginTop: 12 }}>
        <Label>Events to forward</Label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {POSTBACK_EVENTS.map((ev) => (
            <label
              key={ev}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                padding: '4px 8px',
                borderRadius: 4,
                background: events.includes(ev) ? theme.accentSoft : theme.surface2,
                color: events.includes(ev) ? theme.accentText : theme.textMuted,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={events.includes(ev)}
                onChange={(e) =>
                  setEvents((prev) =>
                    e.target.checked ? [...prev, ev] : prev.filter((x) => x !== ev),
                  )
                }
              />
              {ev}
            </label>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Button onClick={submit} disabled={pending || !url || events.length === 0}>
          {pending ? pendingLabel : submitLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function MacroReference() {
  const macros: Array<[string, string]> = [
    ['{click_id}', 'Originating click — present on every commission event'],
    [
      '{sub_id}',
      'Your own sub-ID from the link (…?sub_id=abc123), so your tracker can match its click. Empty when the link had none',
    ],
    [
      '{status}',
      'pending / approved / reversed / paid — which change fired it (accrued = pending). bonus.awarded: approved, or pending during a holdback',
    ],
    ['{partner_id}', 'Your partner ID'],
    ['{commission_id}', 'The Commission row id'],
    ['{commission_amount}', 'Decimal amount in major units (e.g. 12.50)'],
    ['{sale_amount}', "The sale's value in major units (e.g. 60.00). Empty when the event has no value"],
    ['{currency}', '3-letter ISO currency code (USD, EUR, …)'],
    ['{event_id}', 'The Event row that drove the commission'],
    ['{transaction_id}', 'Alias for {event_id} — many trackers use this name'],
    ['{event_type}', 'invoice_paid / signup / your custom event'],
    ['{program_id}', ' Program id'],
    ['{payout_id}', 'Only present on commission.paid and bonus.paid'],
    ['{bonus_id}', 'bonus.* only: the bonus. A bonus has no click or event, so those macros stay literal'],
    ['{bonus_amount}', 'bonus.* only: the bonus amount in major units'],
    ['{bounty_id}', 'bonus.* only: the bounty you reached, when a bounty paid it'],
  ];
  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Available macros</div>
      <Card>
        <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 10 }}>
          Macro values are URL-encoded at fire time. Unknown macros stay literal so you notice
          typos. Postbacks are unsigned by design — if you want verification, add a shared
          secret as a query param yourself: <code style={{ color: theme.text }}>?secret=…</code>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '6px 14px', fontSize: 12 }}>
          {macros.map(([macro, desc]) => (
            <FragmentRow key={macro} macro={macro} desc={desc} />
          ))}
        </div>
      </Card>
    </div>
  );
}

function FragmentRow({ macro, desc }: { macro: string; desc: string }) {
  return (
    <>
      <code style={{ color: theme.accentText }}>{macro}</code>
      <div style={{ color: theme.textMuted }}>{desc}</div>
    </>
  );
}
