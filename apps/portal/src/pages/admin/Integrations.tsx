import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api, currentTenantSlug } from '../../api.js';
import { alpha, theme } from '../../theme.js';
import { useBrand } from '../../lib/useBrand.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Textarea } from '../../ui.js';

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
// link and payout reads, to mint a user's link on first visit, and to
// create the user's partner (partners:create, which can't email anyone,
// in place of partners:write). Off by default so a CRM/Zapier key
// doesn't carry them.
//
// The scope lists are what the dev sees in the UI and what the create
// mutation mints, so the displayed set never drifts from the key.
interface ScopeOption {
  scope: string;
  description: string;
}
const CORE_SCOPES: ScopeOption[] = [
  { scope: 'events:write', description: 'Record conversion events (the CRM webhook path).' },
  { scope: 'partners:write', description: 'Create, invite and revoke partners (Zapier/ActivePieces actions). Revoking emails the partner unless told not to.' },
  { scope: 'partners:read', description: 'List partners, look one up by id or email, and read a partner’s dashboard stats.' },
  { scope: 'commissions:read', description: 'List commissions — tenant-wide or per partner, paged with a cursor.' },
  { scope: 'webhooks:write', description: 'Subscribe + unsubscribe webhook endpoints (Zapier/ActivePieces triggers register their callback URLs through these).' },
];
const IN_APP_SCOPES: ScopeOption[] = [
  { scope: 'partners:create', description: 'Create partners without an invite, and nothing else: no invites, revokes or commission terms. Use it instead of partners:write on an in-app key.' },
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
      title="Integrations"
      subtitle={`Pipe conversions from your CRM, lender systems or affiliate networks into ${programName} so partners get attributed for full-funnel deals, not just self-serve signups.`}
    >
      <UnmatchedEventTypes />
      <StripeAppCard />
      <WhyCard />
      <div style={{ height: 18 }} />
      <KeysPanel />
      <div style={{ height: 18 }} />
      <PayloadGuide />
      <div style={{ height: 18 }} />
      <ClickIdGuide />
      <div style={{ height: 18 }} />
      <PostbackPanel />
    </Page>
  );
}

interface UnmatchedEventType {
  type: string;
  events: number;
  lastSeenAt: string;
  programs: Array<{ id: string; name: string }>;
}

const STRIPE_GUIDE_URL =
  'https://github.com/getcoherence/openpartner/blob/main/docs/headless-referral.md#stripe-payment-links-on-openpartner-cloud';

/** Conversions a sender reported under a type no commission rule takes,
 *  e.g. `funded` for `loan_funded`. They're recorded and credited, and pay
 *  nothing, so the sender never hears an error. Renders nothing when the
 *  list is empty (or the API predates it). */
function UnmatchedEventTypes() {
  const list = useQuery({
    queryKey: ['unmatched-event-types'],
    queryFn: () => api<{ since: string; eventTypes: UnmatchedEventType[] }>('/attribution/unmatched-event-types'),
  });
  const types = list.data?.eventTypes ?? [];
  if (types.length === 0) return null;
  return (
    <>
      <div
        role="alert"
        style={{
          background: theme.warnSoft,
          border: `1px solid ${alpha(theme.warn, 0.4)}`,
          borderRadius: theme.radiusMd,
          padding: 16,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 500, color: theme.warn, marginBottom: 6 }}>
          {types.length === 1 ? 'An event type' : `${types.length} event types`} matched no commission rule
        </div>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 10px', lineHeight: 1.55 }}>
          In the last 30 days, these conversions were credited to a partner but paid nothing,
          because no rule on the partner&rsquo;s terms takes their type. A typo in a stage name
          (<code>funded</code> for <code>loan_funded</code>) lands here. Fix the sender, or add a
          rule for the type on the program.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {types.map((t) => (
            <div key={t.type} style={{ fontSize: 13, lineHeight: 1.45 }}>
              <code style={codeInline}>{t.type}</code>{' '}
              <span style={{ color: theme.textMuted }}>
                {t.events} {t.events === 1 ? 'conversion' : 'conversions'} · last {new Date(t.lastSeenAt).toLocaleString()} ·{' '}
                {t.programs.map((p) => p.name).join(', ')}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ height: 18 }} />
    </>
  );
}

/** Full API base URL an external system should call: `<origin>/api`, plus
 *  `/t/<slug>` on multi-tenant installs. The slug goes after /api; see
 *  PayloadGuide. */
function useApiBase(): { apiBase: string; slug: string | null } {
  const origin = typeof window === 'undefined' ? 'https://your-instance' : window.location.origin;
  const slug = currentTenantSlug();
  return { apiBase: slug ? `${origin}/api/t/${slug}` : `${origin}/api`, slug };
}

const codeInline = { background: theme.surface2, padding: '2px 6px', borderRadius: 4, fontSize: 12 } as const;
const preBlock = {
  padding: 14,
  background: theme.surface2,
  border: `1px solid ${theme.borderSubtle}`,
  borderRadius: 6,
  fontSize: 12,
  overflow: 'auto',
  margin: 0,
} as const;

type StripeAppMode = 'live' | 'test' | 'sandbox';

interface StripeAppStatus {
  available: boolean;
  reason?: 'selfhost' | 'not_configured';
  modes: StripeAppMode[];
  connection: {
    stripeAccountId: string;
    livemode: boolean;
    connectedAt: string;
    lastEventAt: string | null;
    needsReconnect: boolean;
    refreshError: string | null;
    permissionsOutdated: boolean;
    rewards: boolean;
  } | null;
}

/**
 * Connect Stripe — hosted brands install the OpenPartner Stripe App on
 * their own Stripe account, and its checkouts, invoices, refunds and promo
 * codes then attribute with no forwarding from their server. Hidden on a
 * self-host (its own Stripe webhook already does this) and on hosted
 * deployments where the app isn't configured yet.
 *
 * The install leaves for Stripe and comes back here with
 * ?stripe_app_grant=… (encrypted code + state) or ?stripe_app_error=…;
 * the grant is POSTed under this admin's session and stripped from the URL.
 */
function StripeAppCard() {
  const qc = useQueryClient();
  const { programName } = useBrand();
  const status = useQuery({
    queryKey: ['stripe-app'],
    queryFn: () => api<StripeAppStatus>('/stripe-app/connection'),
  });
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['stripe-app'] });

  const complete = useMutation({
    mutationFn: (grant: string) =>
      api<{ replaced: boolean }>('/stripe-app/connection/complete', { method: 'POST', body: { grant } }),
    onSuccess: (res) => {
      setNotice(
        res.replaced
          ? 'Stripe connected. The account connected before it was disconnected.'
          : 'Stripe connected. New checkouts, invoices and refunds now reach your program automatically.',
      );
      refresh();
    },
  });
  const start = useMutation({
    mutationFn: (mode: StripeAppMode) =>
      api<{ url: string }>('/stripe-app/connection/start', {
        method: 'POST',
        body: { mode, returnUrl: `${window.location.origin}${window.location.pathname}` },
      }),
    onSuccess: (res) => {
      window.location.href = res.url;
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api<{ detail: string }>('/stripe-app/connection', { method: 'DELETE' }),
    onSuccess: (res) => {
      setNotice(res.detail);
      refresh();
    },
  });

  // Return leg of the Stripe install.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const grant = params.get('stripe_app_grant');
    const error = params.get('stripe_app_error');
    if (!grant && !error) return;
    params.delete('stripe_app_grant');
    params.delete('stripe_app_error');
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    if (grant) complete.mutate(grant);
    else setNotice(error === 'access_denied' ? 'Stripe connection cancelled.' : `Stripe didn’t finish the install (${error}).`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!status.data?.available && !complete.isPending && !notice) return null;
  const conn = status.data?.connection ?? null;
  const modes = status.data?.modes ?? [];
  const busy = start.isPending || complete.isPending || disconnect.isPending;
  const mutedButton = {
    background: 'transparent',
    border: `1px solid ${theme.borderSubtle}`,
    borderRadius: 6,
    padding: '5px 10px',
    fontSize: 12,
    color: theme.textMuted,
    cursor: 'pointer',
  } as const;

  return (
    <>
      <Card>
        <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 15, fontWeight: 500 }}>Stripe</h3>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 12px', lineHeight: 1.55 }}>
          Bill with Stripe? Connect your Stripe account and {programName} reads it directly: Checkout and
          Payment Link purchases, invoices, refunds and disputes credit the partner who referred the customer,
          with nothing forwarded from your server. Partner codes with a customer discount get their promotion
          code created in your Stripe. {programName} can read your payments but never move money.
        </p>
        <ErrorBanner error={status.error ?? complete.error ?? start.error ?? disconnect.error} />
        {notice && (
          <div
            style={{
              background: alpha(theme.success, 0.063),
              border: `1px solid ${alpha(theme.success, 0.333)}`,
              borderRadius: theme.radiusSm,
              padding: '8px 12px',
              marginBottom: 12,
              fontSize: 13,
              color: theme.text,
            }}
          >
            {notice}
          </div>
        )}

        {complete.isPending ? (
          <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>Finishing the connection…</p>
        ) : status.isLoading ? (
          <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>Loading…</p>
        ) : !conn ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {modes.includes('live') && (
              <Button onClick={() => start.mutate('live')} disabled={busy}>
                {start.isPending ? 'Opening Stripe…' : 'Connect Stripe'}
              </Button>
            )}
            {modes.includes('test') && (
              <button type="button" style={mutedButton} disabled={busy} onClick={() => start.mutate('test')}>
                Connect a test-mode account
              </button>
            )}
          </div>
        ) : (
          <>
            {conn.needsReconnect && (
              <div
                style={{
                  background: alpha(theme.danger, 0.063),
                  border: `1px solid ${alpha(theme.danger, 0.333)}`,
                  borderRadius: theme.radiusSm,
                  padding: '8px 12px',
                  marginBottom: 12,
                  fontSize: 13,
                  color: theme.text,
                  lineHeight: 1.5,
                }}
              >
                <strong>Reconnect needed.</strong> Stripe stopped accepting {programName}&rsquo;s access
                {conn.refreshError ? <> ({conn.refreshError})</> : null}, so new Stripe payments aren&rsquo;t
                being recorded. Reconnect to pick up from here.
              </div>
            )}
            {!conn.needsReconnect && conn.permissionsOutdated && (
              <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 12 }}>
                The app asks for a little more access than when you connected. Reconnect to grant it.
              </div>
            )}
            <div
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                flexWrap: 'wrap',
                padding: '10px 12px',
                background: theme.surface2,
                border: `1px solid ${theme.borderSubtle}`,
                borderRadius: theme.radiusSm,
              }}
            >
              <div style={{ flex: 1, minWidth: 200, fontSize: 12, color: theme.textMuted, lineHeight: 1.6 }}>
                <div style={{ fontSize: 14, color: theme.text }}>
                  <code>{conn.stripeAccountId}</code>{' '}
                  <span
                    style={{
                      fontSize: 11,
                      padding: '1px 6px',
                      borderRadius: 4,
                      background: conn.livemode ? alpha(theme.success, 0.12) : alpha(theme.warn, 0.15),
                      color: conn.livemode ? theme.success : theme.warn,
                    }}
                  >
                    {conn.livemode ? 'Live' : 'Test mode'}
                  </span>
                </div>
                Connected {new Date(conn.connectedAt).toLocaleDateString()}
                {' · '}
                {conn.lastEventAt ? `last event ${new Date(conn.lastEventAt).toLocaleString()}` : 'no events yet'}
                {' · '}
                {conn.rewards ? 'customer discounts created in Stripe' : 'customer discounts set up by you'}
              </div>
              {(conn.needsReconnect || conn.permissionsOutdated) && (
                <Button onClick={() => start.mutate(conn.livemode ? 'live' : 'test')} disabled={busy}>
                  Reconnect
                </Button>
              )}
              <button
                type="button"
                style={{ ...mutedButton, border: `1px solid ${alpha(theme.danger, 0.333)}`, color: theme.danger }}
                disabled={busy}
                onClick={() => {
                  if (confirm(`Disconnect Stripe? ${programName} stops reading your Stripe account. Payments already recorded stay.`)) {
                    disconnect.mutate();
                  }
                }}
              >
                Disconnect
              </button>
            </div>
            <p style={{ fontSize: 12, color: theme.textMuted, margin: '12px 0 0', lineHeight: 1.55 }}>
              Stop forwarding Stripe payments to <code>/attribution/events</code>,{' '}
              <code>/attribution/conversions</code> or <code>/coupons/redeem</code>: one keyed on a Stripe invoice
              or Checkout Session id now returns <code>409 recorded_from_stripe</code>. To credit a customer,
              pass the click id as <code>client_reference_id</code> at Checkout, or set{' '}
              <code>metadata.openpartner_user_id</code> on the Stripe Customer to the user id you identify.
            </p>
          </>
        )}
      </Card>
      <div style={{ height: 18 }} />
    </>
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
        to the partner portal? Add the in-app scopes (partners:create,
        links:read, links:write, payouts:read) and untick partners:write,
        so your backend can create each user&rsquo;s partner and show them
        their link, earnings, and payouts without being able to invite or
        revoke anyone. Keep that key on your server &mdash; it can read
        every partner&rsquo;s data on your tenant.
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
  // the tenant slug — leaving it out 400s with tenant_slug_missing and
  // is the single most common configuration mistake. Render the real
  // URL so admins copy-paste it correctly without thinking. The slug
  // goes AFTER /api: the ingress routes /api/* to the API, so
  // /t/<slug>/api/* lands on the static portal and never reaches us.
  const { apiBase, slug } = useApiBase();
  const { programName } = useBrand();
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
          (<code>/t/{slug}</code>) right after <code>/api</code>. Use the full URL below
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
      >{`curl -X POST ${apiBase}/attribution/events \\
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

/** The click id path: no identify(), no userId. The id leaves on the
 *  partner link's destination and comes back with the conversion. */
function ClickIdGuide() {
  const { apiBase } = useApiBase();
  const { programName } = useBrand();
  return (
    <Card>
      <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 15, fontWeight: 500 }}>
        Report a conversion with the click id
      </h3>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 10px', lineHeight: 1.55 }}>
        Every partner-link click gets a click id. By default it reaches your destination as{' '}
        <code style={codeInline}>?cref=&lt;click id&gt;</code>. To pass it in the parameter your
        destination reads instead, put <code style={codeInline}>{'{click_id}'}</code> in the
        campaign&rsquo;s destination URL (or a partner&rsquo;s deep link). For a Stripe Payment Link:
      </p>
      <pre style={{ ...preBlock, marginBottom: 10 }}>{'https://buy.stripe.com/abc123?client_reference_id={click_id}'}</pre>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 10px', lineHeight: 1.55 }}>
        Write the macro exactly like that: single braces, lower case. Stripe drops a{' '}
        <code>client_reference_id</code> it can&rsquo;t read without telling anyone, so{' '}
        <code>{'{{click_id}}'}</code> (Zapier and Make syntax) is refused when you save.
      </p>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 10px', lineHeight: 1.55 }}>
        With your Stripe account connected (above), or on a self-hosted install whose Stripe
        webhook points at {programName}, that purchase is then recorded automatically: a signup,
        plus its amount as <code>invoice_paid</code>. Don&rsquo;t also report it here. Without a
        connection, forward Stripe&rsquo;s checkout events to the call below from a small handler of
        your own:{' '}
        <a href={STRIPE_GUIDE_URL} target="_blank" rel="noreferrer" style={{ color: theme.accentText }}>
          Stripe Payment Links on OpenPartner Cloud <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
        </a>
        .
      </p>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 10px', lineHeight: 1.55 }}>
        For anything that isn&rsquo;t a Stripe payment, whatever holds the click id (your lender
        system, your CRM, that handler) reports the conversion in one call. No{' '}
        <code>identify()</code> or <code>userId</code> needed. It needs a key with{' '}
        <code>events:write</code>:
      </p>
      <pre style={preBlock}>{`curl -X POST ${apiBase}/attribution/conversions \\
  -H "Authorization: Bearer <your-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "clickId": "01K7ZQ3M5X8V2N4P6R8T0W2Y4A",
    "type": "loan_funded",
    "value": 5000.00,
    "currency": "USD",
    "externalEventId": "loan-881:funded"
  }'`}</pre>
      <p style={{ fontSize: 12, color: theme.textMuted, margin: '12px 0 0', lineHeight: 1.55 }}>
        <code>externalEventId</code> is required: a retry returns the original result with{' '}
        <code>&quot;replayed&quot;: true</code>. It must be unique across your whole account and
        differ per stage (<code>loan-881:approved</code>, <code>loan-881:funded</code>): a reused id
        returns <code>409</code> and that conversion is lost. Add <code>userId</code> if you also
        identify this user elsewhere. A click from any of your programs is accepted; unknown
        clicks return <code>404</code>, and clicks flagged as fraud return <code>422</code>. The
        response&rsquo;s <code>outcome</code> says whether a partner was credited and paid:{' '}
        <code>attributed</code>, <code>no_matching_rule</code> or <code>not_attributed</code>.
      </p>
    </Card>
  );
}

interface PostbackToken {
  prefix: string;
  ipAllowlist: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * The inbound postback URL, for affiliate networks and lenders that can
 * only fire a URL. Its token can record conversions and nothing else, so a
 * URL sitting in a network's dashboard is a contained risk; still, it's
 * shown in full only once, at mint/rotate time.
 */
function PostbackPanel() {
  const qc = useQueryClient();
  const { apiBase } = useApiBase();
  const current = useQuery({
    queryKey: ['conversion-postback'],
    queryFn: () => api<{ token: PostbackToken | null }>('/conversion-postback'),
  });
  const [minted, setMinted] = useState<string | null>(null);
  const [allowlistDraft, setAllowlistDraft] = useState<string | null>(null);

  const token = current.data?.token ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['conversion-postback'] });

  const mint = useMutation({
    mutationFn: () =>
      api<{ plaintext: string; token: PostbackToken }>('/conversion-postback/token', { method: 'POST', body: {} }),
    onSuccess: (res) => {
      setMinted(res.plaintext);
      refresh();
    },
  });
  const turnOff = useMutation({
    mutationFn: () => api('/conversion-postback/token', { method: 'DELETE' }),
    onSuccess: () => {
      setMinted(null);
      refresh();
    },
  });
  const saveAllowlist = useMutation({
    mutationFn: (ipAllowlist: string[]) =>
      api<{ token: PostbackToken }>('/conversion-postback', { method: 'PATCH', body: { ipAllowlist } }),
    onSuccess: () => {
      setAllowlistDraft(null);
      refresh();
    },
  });

  const urlFor = (tokenText: string) =>
    `${apiBase}/postback?click_id=CLICK_ID&type=sale&amount=AMOUNT&currency=USD&txn_id=TRANSACTION_ID&token=${tokenText}`;
  const allowlistText = allowlistDraft ?? (token?.ipAllowlist ?? []).join('\n');
  const mutedButton = {
    background: 'transparent',
    border: `1px solid ${theme.borderSubtle}`,
    borderRadius: 6,
    padding: '5px 10px',
    fontSize: 12,
    color: theme.textMuted,
    cursor: 'pointer',
  } as const;

  return (
    <Card>
      <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 15, fontWeight: 500 }}>Postback URL</h3>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 12px', lineHeight: 1.55 }}>
        For affiliate networks and lenders that can only fire a URL when a conversion happens.
        The URL carries its own token, which can record conversions and nothing else. It
        isn&rsquo;t an API key and doesn&rsquo;t work as one. It answers <code>ok</code> and what the
        conversion came to: <code>ok attributed</code>, <code>ok no_matching_rule</code> (no
        commission rule takes that <code>type</code>), or <code>ok not_attributed outside_window</code>.
        With <code>&amp;pixel=1</code> it answers a 1×1 GIF.
      </p>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 12px', lineHeight: 1.55 }}>
        One token covers every program, so any sender holding it can report any click. Give each
        sender its own <code>txn_id</code> prefix (<code>acme:loan-881:funded</code>), and limit the
        token to your senders&rsquo; IPs below.
      </p>
      <ErrorBanner error={current.error ?? mint.error ?? turnOff.error ?? saveAllowlist.error} />

      {minted && (
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
            Your postback URL — copy it now
          </div>
          <p style={{ fontSize: 12, color: theme.textMuted, margin: '0 0 8px' }}>
            The token is shown only this once. Replace <code>CLICK_ID</code>, <code>AMOUNT</code> and{' '}
            <code>TRANSACTION_ID</code> with your network&rsquo;s macros, and <code>type</code> with your
            conversion name.
          </p>
          <code
            style={{
              display: 'block',
              padding: '10px 12px',
              background: theme.surface2,
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: 6,
              fontSize: 12,
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {urlFor(minted)}
          </code>
          <Button
            variant="secondary"
            onClick={() => {
              navigator.clipboard.writeText(urlFor(minted)).catch(() => {});
            }}
            style={{ marginTop: 10 }}
          >
            Copy URL
          </Button>
        </div>
      )}

      {current.isLoading ? (
        <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>Loading…</p>
      ) : !token ? (
        <Button onClick={() => mint.mutate()} disabled={mint.isPending}>
          {mint.isPending ? 'Generating…' : 'Generate postback URL'}
        </Button>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
              padding: '10px 12px',
              background: theme.surface2,
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: theme.radiusSm,
              marginBottom: 14,
            }}
          >
            <div style={{ flex: 1, minWidth: 200, fontSize: 12, color: theme.textMuted }}>
              Token <code>{token.prefix}…</code> · created {new Date(token.createdAt).toLocaleDateString()}
              {' · '}
              {token.lastUsedAt ? `last used ${new Date(token.lastUsedAt).toLocaleString()}` : 'not used yet'}
            </div>
            <button
              type="button"
              style={mutedButton}
              disabled={mint.isPending}
              onClick={() => {
                if (confirm('Rotate the postback token? The current URL stops working immediately — update it at every network that fires it.')) {
                  mint.mutate();
                }
              }}
            >
              Rotate token
            </button>
            <button
              type="button"
              style={{ ...mutedButton, border: `1px solid ${alpha(theme.danger, 0.333)}`, color: theme.danger }}
              disabled={turnOff.isPending}
              onClick={() => {
                if (confirm('Turn off postbacks? The current URL stops working immediately.')) turnOff.mutate();
              }}
            >
              Turn off
            </button>
          </div>

          <Label>Allowed source IPs (optional)</Label>
          <Textarea
            value={allowlistText}
            onChange={(e) => setAllowlistDraft(e.target.value)}
            rows={3}
            placeholder={'203.0.113.0/24\n2001:db8::1'}
            style={{ fontFamily: theme.fontMono, fontSize: 12, boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              disabled={allowlistDraft === null || saveAllowlist.isPending}
              onClick={() =>
                saveAllowlist.mutate(
                  allowlistText
                    .split(/[\s,]+/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            >
              {saveAllowlist.isPending ? 'Saving…' : 'Save allowlist'}
            </Button>
            <span style={{ fontSize: 12, color: theme.textDim, flex: '1 1 240px', lineHeight: 1.5 }}>
              One IP or CIDR range per line. Empty accepts postbacks from anywhere. Ask your network
              for its postback IPs. The check uses the address the API sees, so on a self-hosted
              install point networks at your API host directly, not through another proxy.
            </span>
          </div>
        </>
      )}

      <div style={{ marginTop: 16, fontSize: 12, color: theme.textMuted, lineHeight: 1.7 }}>
        <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
          Parameters
        </div>
        <div><code>click_id</code> (required) — the click id (<code>cref</code> also works)</div>
        <div><code>type</code> (required) — the conversion, e.g. <code>sale</code>, <code>loan_funded</code></div>
        <div><code>txn_id</code> (required) — the network&rsquo;s transaction id. A repeat records nothing new (<code>transaction_id</code> also works)</div>
        <div><code>amount</code>, <code>currency</code> — the conversion value, for percent commissions (<code>value</code> also works)</div>
        <div><code>user_id</code> — optional, your id for the user</div>
        <div><code>token</code> (required) — never written to the API&rsquo;s request log</div>
      </div>
    </Card>
  );
}

