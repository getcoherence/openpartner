import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Webhook as WebhookIcon, Copy, Check, Trash2, Play } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  Label,
  Page,
  SectionHeading,
  StatusPill,
  Table,
  formatDate,
} from '../../ui.js';

const KNOWN_EVENTS = [
  'attribution.created',
  'commission.accrued',
  'commission.approved',
  'commission.paid',
  'commission.reversed',
  'partner.created',
  'partner.activated',
  'partnership.approved',
  'payout.created',
] as const;

interface Endpoint {
  id: string;
  url: string;
  secretPrefix: string;
  events: string[];
  active: boolean;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Delivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'delivered' | 'failed';
  httpStatus: number | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  deliveredAt: string | null;
  lastAttemptAt: string | null;
  payload?: unknown;
}

export function WebhooksPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newSecret, setNewSecret] = useState<{ endpointId: string; plaintext: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const endpoints = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api<{ endpoints: Endpoint[] }>('/webhooks'),
  });

  return (
    <Page
      title="Webhooks"
      subtitle="Subscribe to attribution, commission, payout, and partnership events."
      actions={<Button icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>New endpoint</Button>}
    >
      <ErrorBanner error={endpoints.error} />

      {newSecret && (
        <Card style={{ marginBottom: 14, borderColor: `${theme.warn}55` }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Signing secret</div>
          <div style={{ color: theme.textMuted, fontSize: 13, marginBottom: 10 }}>
            Save this now — it's the HMAC key you'll verify incoming deliveries with. It won't be shown again.
          </div>
          <SecretReveal plaintext={newSecret.plaintext} />
          <Button variant="secondary" size="sm" style={{ marginTop: 10 }} onClick={() => setNewSecret(null)}>
            Dismiss
          </Button>
        </Card>
      )}

      {showCreate && (
        <CreateEndpoint
          onClose={() => setShowCreate(false)}
          onCreated={(endpoint, secret) => {
            setShowCreate(false);
            setNewSecret({ endpointId: endpoint.id, plaintext: secret });
            qc.invalidateQueries({ queryKey: ['webhooks'] });
          }}
        />
      )}

      {endpoints.isLoading ? (
        <Card>Loading…</Card>
      ) : (endpoints.data?.endpoints ?? []).length === 0 ? (
        <EmptyState
          title="No webhook endpoints yet"
          hint="Add one to receive HMAC-signed POSTs when events fire."
          icon={<WebhookIcon size={28} strokeWidth={1.25} />}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(endpoints.data?.endpoints ?? []).map((e) => (
            <EndpointCard
              key={e.id}
              endpoint={e}
              expanded={selectedId === e.id}
              onToggle={() => setSelectedId(selectedId === e.id ? null : e.id)}
            />
          ))}
        </div>
      )}

      <SectionHeading>Signature format</SectionHeading>
      <Card>
        <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6 }}>
          Every POST carries three headers:
          <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
            <li>
              <code style={{ color: theme.accent }}>x-openpartner-event</code> — event type
            </li>
            <li>
              <code style={{ color: theme.accent }}>x-openpartner-delivery</code> — unique delivery id
            </li>
            <li>
              <code style={{ color: theme.accent }}>x-openpartner-timestamp</code> + <code style={{ color: theme.accent }}>x-openpartner-signature</code>
            </li>
          </ul>
          Verify:
          <code
            style={{
              display: 'block',
              marginTop: 8,
              background: theme.bg,
              border: `1px solid ${theme.borderSubtle}`,
              padding: 10,
              borderRadius: theme.radiusSm,
              fontSize: 12,
              color: theme.text,
              whiteSpace: 'pre',
            }}
          >
{`const expected = crypto
  .createHmac('sha256', secret)
  .update(\`\${timestamp}.\${rawBody}\`)
  .digest('hex');`}
          </code>
          <div style={{ marginTop: 8 }}>
            Reject if the timestamp is more than 5 minutes off your clock (replay protection).
          </div>
        </div>
      </Card>
    </Page>
  );
}

function EndpointCard({
  endpoint,
  expanded,
  onToggle,
}: {
  endpoint: Endpoint;
  expanded: boolean;
  onToggle: () => void;
}) {
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const toggleActive = useMutation({
    mutationFn: () => api(`/webhooks/${endpoint.id}`, { method: 'PATCH', body: { active: !endpoint.active } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });
  const del = useMutation({
    mutationFn: () => api(`/webhooks/${endpoint.id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });
  // Synthetic test fire — sends a realistic-looking sample payload
  // for the chosen event type to this endpoint, bypassing
  // subscription filters. Lets admins end-to-end test integrations
  // (Zapier triggers filter by event type) without seeding fake
  // conversion data in the brand's DB.
  const [testEvent, setTestEvent] = useState<string>(
    endpoint.events.length > 0 && endpoint.events[0] !== '*' ? endpoint.events[0]! : KNOWN_EVENTS[0],
  );
  const [testResult, setTestResult] = useState<{ status: string; httpStatus: number | null; error: string | null } | null>(null);
  const sendTest = useMutation({
    mutationFn: (event: string) =>
      api<{ delivery: { status: string; httpStatus: number | null; error: string | null }; event: string }>(
        `/webhooks/${endpoint.id}/test?event=${encodeURIComponent(event)}`,
        { method: 'POST' },
      ),
    onSuccess: (res) => {
      setTestResult(res.delivery);
      qc.invalidateQueries({ queryKey: ['webhook-deliveries', endpoint.id] });
    },
  });

  return (
    <Card>
      <div
        style={{
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: isMobile ? 'stretch' : 'flex-start',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
            <WebhookIcon size={14} color={endpoint.active ? theme.accent : theme.textDim} />
            <code style={{ fontSize: 13, color: theme.text, fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{endpoint.url}</code>
            <StatusPill status={endpoint.active ? 'connected' : 'pending'} />
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            {endpoint.label ? <span>{endpoint.label} · </span> : null}
            <code style={{ color: theme.textDim }}>{endpoint.secretPrefix}…</code>
            {' · '}
            {endpoint.events.length === 1 && endpoint.events[0] === '*'
              ? 'all events'
              : `${endpoint.events.length} event${endpoint.events.length === 1 ? '' : 's'}`}
            {' · created '}
            {formatDate(endpoint.createdAt, { relative: true })}
          </div>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {endpoint.events.map((ev) => (
              <span
                key={ev}
                style={{
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: theme.bg,
                  border: `1px solid ${theme.borderSubtle}`,
                  fontSize: 11,
                  color: theme.textMuted,
                  fontFamily: theme.fontMono,
                }}
              >
                {ev}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
          <Button size="sm" variant="secondary" onClick={onToggle}>
            {expanded ? 'Hide' : 'Deliveries'}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => toggleActive.mutate()} disabled={toggleActive.isPending}>
            {endpoint.active ? 'Disable' : 'Enable'}
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => del.mutate()} disabled={del.isPending} />
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: `1px solid ${theme.borderSubtle}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 12, color: theme.textMuted }}>Send test event:</span>
        <select
          value={testEvent}
          onChange={(e) => setTestEvent(e.target.value)}
          disabled={!endpoint.active || sendTest.isPending}
          style={{
            padding: '4px 8px',
            background: theme.surface2,
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: 6,
            color: theme.text,
            fontSize: 12,
            fontFamily: theme.fontMono,
          }}
        >
          {KNOWN_EVENTS.map((ev) => (
            <option key={ev} value={ev}>
              {ev}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="secondary"
          icon={<Play size={11} />}
          onClick={() => sendTest.mutate(testEvent)}
          disabled={!endpoint.active || sendTest.isPending}
        >
          {sendTest.isPending ? 'Sending…' : 'Fire'}
        </Button>
        {!endpoint.active && (
          <span style={{ fontSize: 11, color: theme.textDim }}>Endpoint disabled — enable to test</span>
        )}
        {testResult && (
          <span
            style={{
              fontSize: 12,
              color:
                testResult.status === 'delivered'
                  ? theme.success
                  : testResult.status === 'failed'
                    ? theme.danger
                    : theme.textMuted,
            }}
          >
            {testResult.status === 'delivered'
              ? `✓ Delivered (HTTP ${testResult.httpStatus})`
              : `✗ ${testResult.status}${testResult.httpStatus ? ` (HTTP ${testResult.httpStatus})` : ''}: ${testResult.error ?? 'unknown'}`}
          </span>
        )}
        {sendTest.error && (
          <span style={{ fontSize: 12, color: theme.danger }}>
            {sendTest.error instanceof Error ? sendTest.error.message : String(sendTest.error)}
          </span>
        )}
      </div>

      {expanded && <DeliveryList endpointId={endpoint.id} />}
    </Card>
  );
}

function DeliveryList({ endpointId }: { endpointId: string }) {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['webhook-deliveries', endpointId],
    queryFn: () => api<{ deliveries: Delivery[] }>(`/webhooks/${endpointId}/deliveries`),
  });
  const retry = useMutation({
    mutationFn: (deliveryId: string) =>
      api(`/webhooks/${endpointId}/deliveries/${deliveryId}/retry`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhook-deliveries', endpointId] }),
  });

  const rows = data?.deliveries ?? [];

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${theme.borderSubtle}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
        Recent deliveries
      </div>
      <ErrorBanner error={error ?? retry.error} />
      {isLoading ? (
        <div style={{ color: theme.textMuted, fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: theme.textDim, fontSize: 13 }}>No deliveries yet.</div>
      ) : (
        <Table
          columns={['Event', 'Status', { label: 'Attempts', align: 'right' }, 'HTTP', 'Created', 'Actions']}
          rows={rows.map((d) => [
            <code style={{ fontSize: 12, color: theme.accent }}>{d.eventType}</code>,
            <StatusPill status={d.status === 'pending' ? 'pending' : d.status === 'delivered' ? 'paid' : 'failed'} />,
            d.attempts,
            d.httpStatus != null ? (
              <code
                style={{
                  color: d.httpStatus >= 200 && d.httpStatus < 300 ? theme.success : theme.danger,
                  fontSize: 12,
                }}
              >
                {d.httpStatus}
              </code>
            ) : (
              <span style={{ color: theme.textDim }}>—</span>
            ),
            <span style={{ color: theme.textMuted }}>{formatDate(d.createdAt, { relative: true })}</span>,
            <Button
              size="sm"
              variant="secondary"
              icon={<Play size={11} />}
              onClick={() => retry.mutate(d.id)}
              disabled={retry.isPending}
            >
              Retry
            </Button>,
          ])}
        />
      )}
    </div>
  );
}

function CreateEndpoint({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (endpoint: Endpoint, plaintext: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [events, setEvents] = useState<string[]>([...KNOWN_EVENTS]);

  const toggle = (ev: string) =>
    setEvents((prev) => (prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]));

  const mut = useMutation({
    mutationFn: () =>
      api<{ endpoint: Endpoint; secret: string }>('/webhooks', {
        method: 'POST',
        body: { url, label: label || undefined, events },
      }),
    onSuccess: (data) => onCreated(data.endpoint, data.secret),
  });

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 14 }}>New endpoint</div>
      <ErrorBanner error={mut.error} />
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <Label>URL</Label>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-server.example/webhooks/openpartner" />
        </div>
        <div>
          <Label>Label (optional)</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="slack alerts" />
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <Label>Events</Label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {KNOWN_EVENTS.map((ev) => {
            const on = events.includes(ev);
            return (
              <button
                key={ev}
                type="button"
                onClick={() => toggle(ev)}
                style={{
                  padding: '5px 12px',
                  background: on ? theme.accentSoft : theme.bg,
                  border: `1px solid ${on ? theme.accent : theme.borderSubtle}`,
                  color: on ? theme.accent : theme.textMuted,
                  borderRadius: 999,
                  fontSize: 12,
                  fontFamily: theme.fontMono,
                  cursor: 'pointer',
                }}
              >
                {ev}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => mut.mutate()} disabled={!url || events.length === 0 || mut.isPending}>
          {mut.isPending ? 'Creating…' : 'Create endpoint'}
        </Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}

function SecretReveal({ plaintext }: { plaintext: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: theme.warnSoft,
        border: `1px solid ${theme.warn}55`,
        padding: '10px 12px',
        borderRadius: theme.radiusSm,
      }}
    >
      <code style={{ flex: 1, fontSize: 12, wordBreak: 'break-all', color: theme.text }}>{plaintext}</code>
      <Button
        size="sm"
        variant="secondary"
        icon={copied ? <Check size={12} /> : <Copy size={12} />}
        onClick={() => {
          navigator.clipboard.writeText(plaintext);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

