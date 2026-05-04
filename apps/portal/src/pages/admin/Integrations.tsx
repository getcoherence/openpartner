import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api, currentTenantSlug } from '../../api.js';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page } from '../../ui.js';

/**
 * Integration API key surface. Mints scoped keys covering the union
 * of what CRM webhooks (events:write), Zapier/ActivePieces triggers
 * (partners:read + commissions:read for performList), and Zapier/
 * ActivePieces actions (partners:write to create + revoke) need.
 *
 * Why scoped, not admin: brands shouldn't paste a full admin key into
 * a Zap or a CRM workflow. A leaked key with this scope set can
 * fabricate conversion events + create/revoke partners on the tenant
 * — but can't touch billing, payouts, campaigns, or admin surfaces
 * (those have no scope grants anywhere in the API).
 */

interface ApiKeyRow {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  scopes?: string[] | null;
}

interface CreatedKey {
  id: string;
  plaintext: string;
  scopes: string[];
}

// Scopes minted on every integration key. Covers the union of what
// CRM webhooks (events:write), Zapier/ActivePieces triggers
// (partners:read + commissions:read for performList), and Zapier/
// ActivePieces actions (partners:write to create + revoke) need.
// Keeping a single bundled scope set means admins don't have to
// pick the right combo per platform — and a leaked key still can't
// touch billing, payouts, or admin surfaces (those have no scope
// grants anywhere). Used to be just events:write, which broke
// everything beyond the CRM-event use case.
//
// SCOPE_DESCRIPTIONS is what the dev sees in the UI, sourced from
// the same constant so the displayed list never drifts from what
// the create mutation actually mints.
const SCOPE_DESCRIPTIONS: Array<{ scope: string; description: string }> = [
  { scope: 'events:write', description: 'Record conversion events (the CRM webhook path).' },
  { scope: 'partners:write', description: 'Create + revoke partners (Zapier/ActivePieces actions).' },
  { scope: 'partners:read', description: 'List partners + look up by email.' },
  { scope: 'commissions:read', description: 'List commissions for trigger sample data.' },
  { scope: 'webhooks:write', description: 'Subscribe + unsubscribe webhook endpoints (Zapier/ActivePieces triggers register their callback URLs through these).' },
];
const INTEGRATION_SCOPES = SCOPE_DESCRIPTIONS.map((s) => s.scope);
const EVENTS_SCOPE = 'events:write'; // legacy filter on the keys list query

export function AdminIntegrations() {
  return (
    <Page
      title="CRM integration"
      subtitle="Pipe your CRM's conversion events into OpenPartner so partners get attributed for full-funnel deals, not just self-serve signups."
    >
      <WhyCard />
      <div style={{ height: 18 }} />
      <KeysPanel />
      <div style={{ height: 18 }} />
      <PayloadGuide />
    </Page>
  );
}

function WhyCard() {
  return (
    <Card>
      <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 15, fontWeight: 500 }}>
        How this works
      </h3>
      <p style={{ fontSize: 13, color: theme.textMuted, marginTop: 0, marginBottom: 10, lineHeight: 1.55 }}>
        Conversion events that drive partner commissions don&rsquo;t always
        happen in your billing system. For B2B / SaaS programs, the
        meaningful state changes — &ldquo;lead qualified&rdquo;,
        &ldquo;opportunity won&rdquo;, &ldquo;trial converted&rdquo; — live
        in your CRM. Without a CRM signal, partners only get paid on the
        trivial cases.
      </p>
      <p style={{ fontSize: 13, color: theme.textMuted, marginTop: 0, marginBottom: 10, lineHeight: 1.55 }}>
        Mint a scoped API key here, then have your CRM (or a Zapier /
        Make workflow in front of it) POST conversion events to{' '}
        <code style={{ background: theme.surface2, padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>
          /attribution/events
        </code>{' '}
        with the key as a Bearer token. OpenPartner ties the event to the
        originating click via the <code>userId</code> you assigned at
        signup, then accrues commission per the bound campaign&rsquo;s
        rule.
      </p>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: 0, lineHeight: 1.55 }}>
        Keys here carry five scopes (events:write, partners:write,
        partners:read, commissions:read, webhooks:write) — covers the
        full surface Zapier / ActivePieces / CRM workflows touch. A
        leak can fabricate conversion events, create/revoke partners,
        and register/remove webhook endpoints on your tenant — but
        can&rsquo;t touch billing, payouts, campaigns, or admin
        surfaces. Full per-scope breakdown sits under the Generate
        button below.
      </p>
    </Card>
  );
}

function KeysPanel() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['integration-keys'],
    queryFn: () => api<{ apiKeys: ApiKeyRow[] }>('/api-keys?scope=events:write'),
  });
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<CreatedKey | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<CreatedKey>('/api-keys/scoped', {
        method: 'POST',
        body: { scopes: [...INTEGRATION_SCOPES], label: label.trim() || 'CRM webhook' },
      }),
    onSuccess: (res) => {
      setCreated(res);
      setLabel('');
      qc.invalidateQueries({ queryKey: ['integration-keys'] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integration-keys'] }),
  });

  const keys = (list.data?.apiKeys ?? []).filter((k) => !k.revokedAt && (k.scopes ?? []).includes(EVENTS_SCOPE));

  return (
    <Card>
      <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 15, fontWeight: 500 }}>API keys for CRM</h3>
      <p style={{ fontSize: 12, color: theme.textMuted, margin: '0 0 14px' }}>
        One key per integration — a separate key for HubSpot vs. Zapier vs. internal scripts
        makes leak attribution easy and revocation clean.
      </p>
      <ErrorBanner error={create.error ?? revoke.error ?? list.error} />

      {created && (
        <div
          style={{
            background: `${theme.success}10`,
            border: `1px solid ${theme.success}55`,
            borderRadius: theme.radiusSm,
            padding: 12,
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 500, color: theme.success, marginBottom: 6 }}>
            New key created — copy it now
          </div>
          <p style={{ fontSize: 12, color: theme.textMuted, margin: '0 0 8px' }}>
            We don&rsquo;t store the plaintext anywhere. After you leave this page you&rsquo;ll
            never see it again — generate a new one if you lose it.
          </p>
          <code
            style={{
              display: 'block',
              padding: '10px 12px',
              background: theme.surface2,
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: 6,
              fontSize: 13,
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {created.plaintext}
          </code>
          <Button
            variant="secondary"
            onClick={() => {
              navigator.clipboard.writeText(created.plaintext).catch(() => {});
            }}
            style={{ marginTop: 10 }}
          >
            Copy to clipboard
          </Button>
          <button
            type="button"
            onClick={() => setCreated(null)}
            style={{
              marginLeft: 8,
              background: 'transparent',
              border: 'none',
              color: theme.textMuted,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <Label>Label</Label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="HubSpot prod"
            maxLength={120}
          />
        </div>
        <Button onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? 'Generating…' : 'Generate key'}
        </Button>
      </div>
      <ScopesPanel />
      <div style={{ height: 14 }} />

      {list.isLoading ? (
        <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>Loading…</p>
      ) : keys.length === 0 ? (
        <p style={{ fontSize: 13, color: theme.textDim, margin: 0 }}>
          No CRM keys yet. Generate one above to start receiving events.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {keys.map((k) => (
            <div
              key={k.id}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                padding: '10px 12px',
                background: theme.surface2,
                border: `1px solid ${theme.borderSubtle}`,
                borderRadius: theme.radiusSm,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: theme.text }}>{k.label ?? 'CRM webhook'}</div>
                <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>
                  <code>{k.prefix}…</code> · created {new Date(k.createdAt).toLocaleDateString()}
                  {k.lastUsedAt && <> · last used {new Date(k.lastUsedAt).toLocaleDateString()}</>}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Revoke "${k.label ?? 'CRM webhook'}"? Any CRM using this key will stop receiving events.`)) {
                    revoke.mutate(k.id);
                  }
                }}
                disabled={revoke.isPending}
                style={{
                  background: 'transparent',
                  border: `1px solid ${theme.danger}55`,
                  borderRadius: 6,
                  padding: '5px 10px',
                  fontSize: 12,
                  color: theme.danger,
                  cursor: 'pointer',
                }}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Surfaces the scope set this page mints so devs can verify what
 *  the key carries before generating it (and after, when auditing).
 *  Sourced from the same SCOPE_DESCRIPTIONS constant the create
 *  mutation reads, so what's shown is what's minted — they can't
 *  drift. Collapsible to keep the create flow visually quiet for
 *  admins who don't care. */
function ScopesPanel() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      style={{
        padding: '8px 12px',
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        fontSize: 12,
        color: theme.textMuted,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((s) => !s)}
        style={{
          background: 'transparent',
          border: 'none',
          color: theme.textMuted,
          cursor: 'pointer',
          padding: 0,
          fontSize: 12,
          fontFamily: 'inherit',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          textAlign: 'left',
        }}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        Generated keys carry <strong style={{ color: theme.text }}>{INTEGRATION_SCOPES.length} scopes</strong>
        {!expanded && (
          <span style={{ color: theme.textDim, marginLeft: 4 }}>
            ({INTEGRATION_SCOPES.join(', ')})
          </span>
        )}
      </button>
      {expanded && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {SCOPE_DESCRIPTIONS.map(({ scope, description }) => (
            <div key={scope} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <code style={{ color: theme.accent, fontSize: 12, minWidth: 130, fontWeight: 500 }}>{scope}</code>
              <span style={{ color: theme.textMuted, fontSize: 12 }}>{description}</span>
            </div>
          ))}
          <div style={{ marginTop: 4, color: theme.textDim, fontSize: 11, lineHeight: 1.5 }}>
            None of these touch billing, payouts, campaigns, or admin surfaces — those have no
            scope grants. A leaked key can fabricate conversion events + create/revoke
            partners on this tenant only.
          </div>
        </div>
      )}
    </div>
  );
}

function PayloadGuide() {
  // Build the actual full URL the admin should paste into their CRM /
  // Zapier / Make / curl. On multi-tenant installs the path includes
  // the tenant slug — leaving it out 500s with a generic error and
  // is the single most common configuration mistake. Render the real
  // URL so admins copy-paste it correctly without thinking.
  const origin = typeof window === 'undefined' ? 'https://your-instance' : window.location.origin;
  const slug = currentTenantSlug();
  const apiBase = slug ? `${origin}/t/${slug}` : origin;
  return (
    <Card>
      <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 15, fontWeight: 500 }}>
        Payload contract
      </h3>
      {slug && (
        <div
          style={{
            margin: '0 0 12px',
            padding: 10,
            background: `${theme.accent}10`,
            border: `1px solid ${theme.accent}55`,
            borderRadius: 6,
            fontSize: 12,
            color: theme.text,
            lineHeight: 1.55,
          }}
        >
          <strong>Multi-tenant URL:</strong> the path includes your tenant slug{' '}
          (<code>/t/{slug}</code>) before <code>/api/...</code>. Use the full base URL below
          as-is — leaving the slug out returns a <code>tenant_slug_missing</code> 400 error.
        </div>
      )}
      <p style={{ fontSize: 12, color: theme.textMuted, margin: '0 0 12px' }}>
        Send a POST with the key as a Bearer token. <code>userId</code> is the same identifier
        you assign at signup time so OpenPartner can stitch the event to a click. <code>type</code>{' '}
        can be any string — use <code>opportunity_won</code> for B2B sales,{' '}
        <code>trial_converted</code> for trial→paid, or your own conventions.
      </p>
      <pre
        style={{
          padding: 14,
          background: theme.surface2,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: 6,
          fontSize: 12,
          overflow: 'auto',
          margin: 0,
        }}
      >{`curl -X POST ${apiBase}/api/attribution/events \\
  -H "Authorization: Bearer <your-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "userId": "user_or_email_from_your_system",
    "type": "opportunity_won",
    "value": 4500.00,
    "currency": "USD",
    "metadata": {
      "deal_id": "0061k00000ABC",
      "stage": "Closed Won"
    }
  }'`}</pre>
      <p style={{ fontSize: 12, color: theme.textMuted, margin: '12px 0 0' }}>
        See the{' '}
        <a
          href="https://openpartner.dev/docs/integrations/crm"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: theme.accent, display: 'inline-flex', alignItems: 'center', gap: 3 }}
        >
          CRM integration docs
          <ExternalLink size={12} />
        </a>{' '}
        for HubSpot, Salesforce, Pipedrive, and Zapier walkthroughs.
      </p>
    </Card>
  );
}

