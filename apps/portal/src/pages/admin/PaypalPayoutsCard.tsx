import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw, Send, Unplug } from 'lucide-react';
import { api } from '../../api.js';
import { alpha, theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, formatDate } from '../../ui.js';

export type PaypalEnvironment = 'live' | 'sandbox';

/** GET /config/paypal */
export interface PaypalConnection {
  id: string;
  environment: PaypalEnvironment;
  clientIdPreview: string;
  appId: string | null;
  payoutsEnabled: boolean;
  webhook: { registered: boolean; error: string | null };
  active: boolean;
  connectedAt: string;
  verifiedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  openBatches: number;
}

export const PAYPAL_ENV_LABEL: Record<PaypalEnvironment, string> = { live: 'Live', sandbox: 'Sandbox' };

/** GET /config/paypal-payouts */
interface PaypalPayoutSettings {
  sendUnsupportedAs: 'USD' | null;
}

/** The brand's connected PayPal apps (shared with the Payouts page). */
export function usePaypalConnections() {
  return useQuery({
    queryKey: ['paypal-connections'],
    queryFn: () => api<{ connections: PaypalConnection[] }>('/config/paypal'),
  });
}

/**
 * Admin Settings: connect the brand's own PayPal REST app so the Payouts
 * page can send PayPal payouts in one click (docs/paypal-payouts.md). The
 * secret goes to the API once and is never shown again.
 */
export function PaypalPayoutsCard() {
  const qc = useQueryClient();
  const { data, error, isLoading } = usePaypalConnections();
  const byEnv = new Map((data?.connections ?? []).map((c) => [c.environment, c]));
  const refresh = () => qc.invalidateQueries({ queryKey: ['paypal-connections'] });

  const activate = useMutation({
    mutationFn: (env: PaypalEnvironment) => api(`/config/paypal/${env}/activate`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const verify = useMutation({
    mutationFn: (env: PaypalEnvironment) => api(`/config/paypal/${env}/verify`, { method: 'POST' }),
    onSuccess: refresh,
    onError: refresh,
  });
  const disconnect = useMutation({
    mutationFn: (env: PaypalEnvironment) => api(`/config/paypal/${env}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  if (isLoading) return <Card>Loading…</Card>;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Send size={18} style={{ color: theme.accentText }} />
        <div style={{ fontSize: 15, fontWeight: 500 }}>Pay with PayPal</div>
      </div>
      <ErrorBanner error={error ?? activate.error ?? verify.error ?? disconnect.error} />
      <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.55, maxWidth: 760 }}>
        Pay partners who use PayPal in one click from the Payouts page, instead of uploading a file. OpenPartner sends
        the batch through PayPal’s Payouts API as your own PayPal app. The money goes from your PayPal balance straight
        to your partners and never passes through OpenPartner.
      </div>
      <ol style={{ fontSize: 12.5, color: theme.textDim, lineHeight: 1.6, margin: '10px 0 16px', paddingLeft: 18, maxWidth: 760 }}>
        <li>PayPal has to enable Payouts on your PayPal Business account (Request access on PayPal’s Payouts page).</li>
        <li>
          In the PayPal developer dashboard, open Apps &amp; Credentials and create a REST app (one under Sandbox to test,
          one under Live).
        </li>
        <li>Paste its client id and secret below. The secret is stored encrypted and is never shown again.</li>
      </ol>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(['live', 'sandbox'] as const).map((env) => {
          const conn = byEnv.get(env);
          return conn ? (
            <ConnectedRow
              key={env}
              conn={conn}
              onActivate={() => activate.mutate(env)}
              onVerify={() => verify.mutate(env)}
              onDisconnect={() => {
                if (
                  window.confirm(
                    `Disconnect your ${PAYPAL_ENV_LABEL[env].toLowerCase()} PayPal app? OpenPartner forgets its secret and stops using it, including checking batches it already sent for late refunds. Connect the same app again to pick them back up.`,
                  )
                ) {
                  disconnect.mutate(env);
                }
              }}
              busy={activate.isPending || verify.isPending || disconnect.isPending}
            />
          ) : (
            <ConnectForm key={env} environment={env} onConnected={refresh} />
          );
        })}
      </div>
      <SendUnsupportedAs />
    </Card>
  );
}

/**
 * "Pay balances PayPal can't send in: USD" (docs/paypal-payouts.md).
 * PayPal has no INR; with this on, INR payouts to a PayPal email go out
 * through Pay with PayPal in USD, at an ECB rate the brand sees before
 * each batch. Off by default.
 */
function SendUnsupportedAs() {
  const qc = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['paypal-payout-settings'],
    queryFn: () => api<PaypalPayoutSettings>('/config/paypal-payouts'),
  });
  const save = useMutation({
    mutationFn: (sendUnsupportedAs: PaypalPayoutSettings['sendUnsupportedAs']) =>
      api<PaypalPayoutSettings>('/config/paypal-payouts', { method: 'POST', body: { sendUnsupportedAs } }),
    onSuccess: (next) => {
      qc.setQueryData(['paypal-payout-settings'], next);
      qc.invalidateQueries({ queryKey: ['manual-payout-run'] });
      qc.invalidateQueries({ queryKey: ['manual-payout-run-payouts'] });
    },
  });
  const on = data?.sendUnsupportedAs === 'USD';

  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${theme.borderSubtle}`, maxWidth: 760 }}>
      <ErrorBanner error={error ?? save.error} />
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => save.mutate(e.target.checked ? 'USD' : null)}
          disabled={!data || save.isPending}
          style={{ marginTop: 2 }}
        />
        <span>
          <strong>Pay INR balances with PayPal in USD</strong>
          <span style={{ color: theme.textMuted, display: 'block', lineHeight: 1.55, marginTop: 2 }}>
            PayPal can’t send INR: Indian PayPal accounts receive international payments in USD. With this on, INR payouts
            to partners with a PayPal email can go out with Pay with PayPal in USD, converted at the European Central Bank
            reference rate. You see the rate and both totals before each batch, the payouts stay in INR in your records,
            and your partners see both amounts. When a partner withdraws USD to an Indian bank, PayPal converts it at its
            own rate; that conversion is between them and PayPal.
          </span>
        </span>
      </label>
    </div>
  );
}

function Box({ children, highlight }: { children: React.ReactNode; highlight?: boolean }) {
  return (
    <div
      style={{
        padding: '12px 14px',
        background: highlight ? alpha(theme.success, 0.06) : theme.bg,
        border: `1px solid ${highlight ? alpha(theme.success, 0.35) : theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
      }}
    >
      {children}
    </div>
  );
}

function Note({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' | 'danger' }) {
  const color = tone === 'danger' ? theme.danger : tone === 'warn' ? theme.warn : theme.textMuted;
  return <div style={{ fontSize: 12.5, color, marginTop: 6, lineHeight: 1.5 }}>{children}</div>;
}

function ConnectedRow({
  conn,
  onActivate,
  onVerify,
  onDisconnect,
  busy,
}: {
  conn: PaypalConnection;
  onActivate: () => void;
  onVerify: () => void;
  onDisconnect: () => void;
  busy: boolean;
}) {
  return (
    <Box highlight={conn.active}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>{PAYPAL_ENV_LABEL[conn.environment]}</span>
          <span style={{ color: theme.textMuted }}>
            {' '}
            · client <code>{conn.clientIdPreview}</code> · checked {formatDate(conn.verifiedAt ?? conn.connectedAt, { relative: true })}
          </span>
          {conn.active && (
            <span style={{ marginLeft: 8, color: theme.success, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <CheckCircle2 size={13} /> Pay with PayPal sends from here
            </span>
          )}
        </div>
        {!conn.active && (
          <Button size="sm" variant="secondary" onClick={onActivate} disabled={busy}>
            Send from {PAYPAL_ENV_LABEL[conn.environment].toLowerCase()}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={onVerify} disabled={busy}>
          Check again
        </Button>
        <Button size="sm" variant="ghost" icon={<Unplug size={13} />} onClick={onDisconnect} disabled={busy || conn.openBatches > 0}>
          Disconnect
        </Button>
      </div>
      {!conn.payoutsEnabled && (
        <Note tone="warn">
          PayPal hasn’t given this app the Payouts permission yet, so PayPal will refuse batches. Ask PayPal to enable
          Payouts on your account, then Check again.
        </Note>
      )}
      {conn.lastError && <Note tone="danger">{conn.lastError}</Note>}
      {conn.webhook.registered ? (
        <Note>PayPal sends batch updates here as they happen.</Note>
      ) : (
        <Note>{conn.webhook.error ?? 'No webhook registered: batch status is checked every few minutes instead.'}</Note>
      )}
      {conn.openBatches > 0 && (
        <Note>
          {conn.openBatches === 1 ? '1 batch' : `${conn.openBatches} batches`} sent with this app {conn.openBatches === 1 ? 'is' : 'are'} still in
          progress, so it can’t be disconnected yet. You can still enter a new secret for the same app.
        </Note>
      )}
    </Box>
  );
}

/** A field's name inside its <label>, styled like ui.tsx Label. */
function FieldName({ children }: { children: React.ReactNode }) {
  return <span style={{ display: 'block', fontSize: 12, color: theme.textMuted, marginBottom: 6, fontWeight: 500 }}>{children}</span>;
}

function ConnectForm({ environment, onConnected }: { environment: PaypalEnvironment; onConnected: () => void }) {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const connect = useMutation({
    mutationFn: () => api('/config/paypal', { method: 'POST', body: { environment, clientId: clientId.trim(), clientSecret: clientSecret.trim() } }),
    onSuccess: () => {
      setClientId('');
      setClientSecret('');
      setOpen(false);
      onConnected();
    },
    // Never keep the secret around after a failed attempt either.
    onError: () => setClientSecret(''),
  });

  return (
    <Box>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>{PAYPAL_ENV_LABEL[environment]}</span>
          <span style={{ color: theme.textMuted }}> · not connected</span>
        </div>
        {!open && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Connect {PAYPAL_ENV_LABEL[environment].toLowerCase()} app
          </Button>
        )}
      </div>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate();
          }}
          style={{ marginTop: 12 }}
        >
          <ErrorBanner error={connect.error} />
          <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={{ display: 'block' }}>
              <FieldName>Client ID</FieldName>
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label style={{ display: 'block' }}>
              <FieldName>Secret</FieldName>
              <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password" spellCheck={false} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Button type="submit" size="sm" disabled={connect.isPending || !clientId.trim() || !clientSecret.trim()}>
              {connect.isPending ? 'Checking with PayPal…' : 'Connect'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={connect.isPending}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Box>
  );
}
