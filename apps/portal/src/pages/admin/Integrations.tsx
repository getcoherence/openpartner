import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api, currentTenantSlug } from '../../api.js';
import { alpha, theme } from '../../theme.js';
import { useBrand } from '../../lib/useBrand.js';
import { Button, Card, ErrorBanner, Input, Label, Page } from '../../ui.js';

/**
 * Integration API key surface. Mints scoped keys covering the union
 * of what CRM webhooks (events:write), Zapier/ActivePieces triggers
 * (partners:read + commissions:read for performList), and Zapier/
 * ActivePieces actions (partners:write to create + revoke) need —
 * plus, opt-in, the per-partner reads + link minting a headless
 * in-app referral UI needs (links:read, links:write, payouts:read).
 *
 * Why scoped, not admin: brands shouldn't paste a full admin key into
 * a Zap or a CRM workflow. A leaked key with the default scope set can
 * fabricate conversion events + create/revoke partners on the tenant
 * — but can't touch billing, campaigns, payout runs, or admin surfaces
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

// Default scopes on every integration key. Covers the union of what
// CRM webhooks (events:write), Zapier/ActivePieces triggers
// (partners:read + commissions:read for performList), and Zapier/
// ActivePieces actions (partners:write to create + revoke) need.
// Keeping a single default bundle means admins don't have to pick
// the right combo per platform — and a leaked key still can't touch
// billing, payouts, or admin surfaces (those have no scope grants
// anywhere). Used to be just events:write, which broke everything
// beyond the CRM-event use case.
//
// IN_APP_SCOPES are opt-in: a headless in-app referral UI (the brand's
// backend showing each user their link + earnings) needs per-partner
// link and payout reads, and to mint a user's link on first visit.
// Off by default so a CRM/Zapier key doesn't carry them.
//
// The scope lists are what the dev sees in the UI and what the create
// mutation mints, so the displayed set never drifts from the key.
interface ScopeOption {
  scope: string;
  description: string;
}
const CORE_SCOPES: ScopeOption[] = [
  { scope: 'events:write', description: 'Record conversion events (the CRM webhook path).' },
  { scope: 'partners:write', description: 'Create + revoke partners (Zapier/ActivePieces actions).' },
  { scope: 'partners:read', description: 'List partners, look one up by id or email, and read a partner’s dashboard stats.' },
  { scope: 'commissions:read', description: 'List commissions — tenant-wide or per partner, paged with a cursor.' },
  { scope: 'webhooks:write', description: 'Subscribe + unsubscribe webhook endpoints (Zapier/ActivePieces triggers register their callback URLs through these).' },
];
const IN_APP_SCOPES: ScopeOption[] = [
  { scope: 'links:read', description: 'Read a partner’s referral links (show each user their share link).' },
  { scope: 'links:write', description: 'Create a referral link for a partner (mint a user’s link on first visit).' },
  { scope: 'payouts:read', description: 'Read a partner’s payout history. Read-only — can’t run or confirm payouts.' },
];
const ALL_SCOPES = [...CORE_SCOPES, ...IN_APP_SCOPES].map((s) => s.scope);
const DEFAULT_SCOPES = CORE_SCOPES.map((s) => s.scope);
// A key belongs on this page when every scope it carries is one this
// page mints. Excludes the Network federation key (clicks:write) and
// anything else minted for another purpose.
const isIntegrationKey = (k: ApiKeyRow) =>
  (k.scopes ?? []).length > 0 && (k.scopes ?? []).every((s) => ALL_SCOPES.includes(s));

export function AdminIntegrations() {
  const { programName } = useBrand();
  return (
    <Page
      title="CRM integration"
      subtitle={`Pipe your CRM's conversion events into ${programName} so partners get attributed for full-funnel deals, not just self-serve signups.`}
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
  const { programName } = useBrand();
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
        with the key as a Bearer token. {programName} ties the event to the
        originating click via the <code>userId</code> you assigned at
        signup, then accrues commission per the bound campaign&rsquo;s
        rule. Include an <code>externalEventId</code> (your CRM&rsquo;s id
        for that deal stage change) so a retried webhook is recognised
        instead of paying the commission twice.
      </p>
      <p style={{ fontSize: 13, color: theme.textMuted, marginTop: 0, marginBottom: 10, lineHeight: 1.55 }}>
        By default, keys carry five scopes (events:write, partners:write,
        partners:read, commissions:read, webhooks:write) — covers the
        full surface Zapier / ActivePieces / CRM workflows touch. A
        leak can fabricate conversion events, create/revoke partners,
        and register/remove webhook endpoints on your tenant — but
        can&rsquo;t touch billing, payouts, campaigns, or admin
        surfaces. Full per-scope breakdown sits under the Generate
        button below.
      </p>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: 0, lineHeight: 1.55 }}>
        Building your own in-app referral page instead of sending users
        to the partner portal? Add the in-app scopes (links:read,
        links:write, payouts:read) so your backend can show each user
        their link, earnings, and payouts. Keep that key on your server
        &mdash; it can read every partner&rsquo;s data on your tenant.
      </p>
    </Card>
  );
}

function KeysPanel() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['integration-keys'],
    queryFn: () => api<{ apiKeys: ApiKeyRow[] }>('/api-keys'),
  });
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);

  const create = useMutation({
    mutationFn: () =>
      api<CreatedKey>('/api-keys/scoped', {
        method: 'POST',
        // Canonical order, whatever order the boxes were ticked in.
        body: { scopes: ALL_SCOPES.filter((s) => scopes.includes(s)), label: label.trim() || 'CRM webhook' },
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

  const keys = (list.data?.apiKeys ?? []).filter((k) => !k.revokedAt && isIntegrationKey(k));

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
            background: alpha(theme.success, 0.063),
            border: `1px solid ${alpha(theme.success, 0.333)}`,
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
        <Button onClick={() => create.mutate()} disabled={create.isPending || scopes.length === 0}>
          {create.isPending ? 'Generating…' : 'Generate key'}
        </Button>
      </div>
      <ScopesPanel selected={scopes} onChange={setScopes} />
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
                <div style={{ fontSize: 11, color: theme.textDim, marginTop: 2, overflowWrap: 'anywhere' }}>
                  {(k.scopes ?? []).join(', ')}
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
                  border: `1px solid ${alpha(theme.danger, 0.333)}`,
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

/** Surfaces the scope set the next key will carry so devs can verify
 *  it before generating (and adjust it — the in-app scopes are opt-in).
 *  `selected` is the same state the create mutation reads, so what's
 *  shown is what's minted — they can't drift. Collapsible to keep the
 *  create flow visually quiet for admins who don't care. */
function ScopesPanel({ selected, onChange }: { selected: string[]; onChange: (scopes: string[]) => void }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = (scope: string) =>
    onChange(selected.includes(scope) ? selected.filter((s) => s !== scope) : [...selected, scope]);
  const ordered = ALL_SCOPES.filter((s) => selected.includes(s));
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
        <span>
          The new key will carry{' '}
          <strong style={{ color: theme.text }}>
            {ordered.length} scope{ordered.length === 1 ? '' : 's'}
          </strong>
          {!expanded && (
            <span style={{ color: theme.textDim, marginLeft: 4, overflowWrap: 'anywhere' }}>
              ({ordered.length > 0 ? ordered.join(', ') : 'none — pick at least one'}) · customize
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <ScopeGroup title="CRM + Zapier / ActivePieces (default)" options={CORE_SCOPES} selected={selected} onToggle={toggle} />
          <ScopeGroup title="In-app referral UI (headless)" options={IN_APP_SCOPES} selected={selected} onToggle={toggle} />
          <div style={{ marginTop: 4, color: theme.textDim, fontSize: 11, lineHeight: 1.5 }}>
            None of these touch billing, campaigns, payout runs, or admin surfaces — those have
            no scope grants. Scopes are tenant-wide: a key that can read links or payouts reads
            them for every partner on this tenant, so keep it server-side.
          </div>
        </div>
      )}
    </div>
  );
}

function ScopeGroup({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string;
  options: ScopeOption[];
  selected: string[];
  onToggle: (scope: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>
      <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</div>
      {options.map(({ scope, description }) => (
        <label key={scope} style={{ display: 'flex', gap: 8, alignItems: 'baseline', cursor: 'pointer', flexWrap: 'wrap' }}>
          <input
            type="checkbox"
            checked={selected.includes(scope)}
            onChange={() => onToggle(scope)}
            style={{ accentColor: theme.accent, margin: 0, alignSelf: 'center' }}
          />
          <code style={{ color: theme.accentText, fontSize: 12, minWidth: 130, fontWeight: 500 }}>{scope}</code>
          <span style={{ color: theme.textMuted, fontSize: 12, flex: '1 1 200px' }}>{description}</span>
        </label>
      ))}
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
  const { programName } = useBrand();
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
            background: `${theme.accentA10}`,
            border: `1px solid ${theme.accentA55}`,
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
        you assign at signup time so {programName} can stitch the event to a click. <code>type</code>{' '}
        can be any string — use <code>opportunity_won</code> for B2B sales,{' '}
        <code>trial_converted</code> for trial→paid, or your own conventions.
      </p>
      <p style={{ fontSize: 12, color: theme.textMuted, margin: '0 0 12px' }}>
        Always send <code>externalEventId</code>, a stable id for this one event (deal id plus
        stage works). Zapier, Make and CRM webhooks retry on timeouts. A retry with the same key
        returns the original result with <code>&quot;replayed&quot;: true</code> and records
        nothing new, so the commission is paid once. Reusing a key for a different event returns
        a <code>409</code>.
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
    "externalEventId": "0061k00000ABC:closed_won",
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
          style={{ color: theme.accentText, display: 'inline-flex', alignItems: 'center', gap: 3 }}
        >
          CRM integration docs
          <ExternalLink size={12} />
        </a>{' '}
        for HubSpot, Salesforce, Pipedrive, and Zapier walkthroughs.
      </p>
    </Card>
  );
}

