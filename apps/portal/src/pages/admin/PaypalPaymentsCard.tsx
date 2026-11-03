import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Unplug } from 'lucide-react';
import { api } from '../../api.js';
import { alpha, theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, formatDate } from '../../ui.js';
import { PAYPAL_ENV_LABEL, type PaypalEnvironment } from './PaypalPayoutsCard.js';

/** GET /config/paypal-payments */
export interface PaypalPaymentApp {
  id: string;
  environment: PaypalEnvironment;
  purpose: 'payouts' | 'checkout';
  clientIdPreview: string;
  tracking: boolean;
  trackingSince: string | null;
  webhook: { registered: boolean; error: string | null };
  lastEventAt: string | null;
  transactionSearch: 'ok' | 'unavailable' | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

const DOCS_URL = 'https://github.com/getcoherence/openpartner/blob/main/docs/paypal-payments.md';

const CLIENT_SNIPPET = `// The page: your server creates and captures the order.
const post = (path, body) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    .then((r) => r.json());

paypal.Buttons({
  createOrder: () => post('/api/orders', { referral: openpartner.getReferral() }).then((order) => order.id),
  onApprove: (data) => post(\`/api/orders/\${data.orderID}/capture\`),
}).render('#paypal-button');

// Subscriptions
paypal.Buttons({
  createSubscription: (data, actions) =>
    actions.subscription.create({
      plan_id: 'P-YOUR-PLAN',
      custom_id: openpartner.getReferral() ?? undefined,
    }),
}).render('#paypal-subscribe');`;

const SERVER_SNIPPET = `// Your server. The referral comes from the page, or the op_ref cookie the script sets.
const paypal = (path, body) =>
  fetch(\`https://api-m.paypal.com\${path}\`, {
    method: 'POST',
    headers: { Authorization: \`Bearer \${accessToken}\`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

app.post('/api/orders', async (req, res) => {
  const referral = req.body.referral ?? req.cookies.op_ref;
  const order = await paypal('/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: 'USD', value: '49.00' },
      custom_id: referral || undefined,
    }],
  });
  res.json({ id: order.id });
});

app.post('/api/orders/:id/capture', async (req, res) => {
  res.json(await paypal(\`/v2/checkout/orders/\${encodeURIComponent(req.params.id)}/capture\`, {}));
});`;

const preBlock = {
  padding: 12,
  background: theme.surface2,
  border: `1px solid ${theme.borderSubtle}`,
  borderRadius: 6,
  fontSize: 12,
  overflow: 'auto',
  margin: '8px 0 0',
} as const;

/**
 * Admin → Integrations: PayPal payments as conversions
 * (docs/paypal-payments.md). Pay with PayPal's app can report the payments
 * it takes; a checkout on another PayPal app connects that app here.
 */
export function PaypalPaymentsCard() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['paypal-payment-apps'],
    queryFn: () => api<{ apps: PaypalPaymentApp[] }>('/config/paypal-payments'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['paypal-payment-apps'] });
  const track = useMutation({
    mutationFn: (v: { environment: PaypalEnvironment; tracking: boolean }) =>
      api(`/config/paypal/${v.environment}/payments`, { method: 'POST', body: { tracking: v.tracking } }),
    onSuccess: refresh,
  });
  const disconnect = useMutation({
    mutationFn: (env: PaypalEnvironment) => api(`/config/paypal-payments/${env}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const apps = data?.apps ?? [];
  const checkoutEnvs = new Set(apps.filter((a) => a.purpose === 'checkout').map((a) => a.environment));
  const freeEnvs = (['live', 'sandbox'] as const).filter((e) => !checkoutEnvs.has(e));
  const busy = track.isPending || disconnect.isPending;

  return (
    <Card>
      <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 15, fontWeight: 500 }}>PayPal</h3>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 12px', lineHeight: 1.55, maxWidth: 760 }}>
        Take payments with PayPal? Payments, renewals and refunds through your PayPal app credit the partner whose
        click the order carries in <code>custom_id</code>.
      </p>
      <ErrorBanner error={error ?? track.error ?? disconnect.error} />
      {isLoading ? (
        <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>Loading…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 760 }}>
          {apps.map((a) => (
            <AppRow
              key={a.id}
              app={a}
              busy={busy}
              onTrack={(tracking) => track.mutate({ environment: a.environment, tracking })}
              onDisconnect={() => {
                if (window.confirm(`Disconnect this ${PAYPAL_ENV_LABEL[a.environment].toLowerCase()} checkout app? Conversions it recorded stay.`)) {
                  disconnect.mutate(a.environment);
                }
              }}
            />
          ))}
          {!apps.some((a) => a.purpose === 'payouts') && (
            <div style={{ fontSize: 12.5, color: theme.textDim }}>
              The app you pay partners with (Settings → Pay with PayPal) can report its payments too.
            </div>
          )}
          {freeEnvs.length > 0 && <ConnectCheckout environments={freeEnvs} onConnected={refresh} />}
          {apps.some((a) => a.tracking) && (
            <details style={{ fontSize: 13 }}>
              <summary style={{ cursor: 'pointer', color: theme.accentText }}>Checkout code</summary>
              <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 8, lineHeight: 1.55 }}>
                With the OpenPartner script on the page, set <code>custom_id</code> from the visitor&rsquo;s referral.
                Already using <code>custom_id</code>? Put the referral after your own value and a <code>|</code>.{' '}
                <a href={DOCS_URL} target="_blank" rel="noreferrer" style={{ color: theme.accentText }}>
                  Guide
                </a>
              </div>
              <pre style={preBlock}>{CLIENT_SNIPPET}</pre>
              <pre style={preBlock}>{SERVER_SNIPPET}</pre>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

function AppRow({
  app,
  busy,
  onTrack,
  onDisconnect,
}: {
  app: PaypalPaymentApp;
  busy: boolean;
  onTrack: (tracking: boolean) => void;
  onDisconnect: () => void;
}) {
  const note = { fontSize: 12.5, color: theme.textMuted, marginTop: 6, lineHeight: 1.5 } as const;
  return (
    <div
      style={{
        padding: '12px 14px',
        background: app.tracking ? alpha(theme.success, 0.06) : theme.bg,
        border: `1px solid ${app.tracking ? alpha(theme.success, 0.35) : theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>{PAYPAL_ENV_LABEL[app.environment]}</span>
          <span style={{ color: theme.textMuted }}>
            {' '}
            · {app.purpose === 'payouts' ? 'Pay with PayPal app' : 'checkout app'} · client <code>{app.clientIdPreview}</code>
          </span>
          {app.tracking && (
            <span style={{ marginLeft: 8, color: theme.success, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <CheckCircle2 size={13} /> Recording payments
            </span>
          )}
        </div>
        {app.purpose === 'payouts' ? (
          <Button size="sm" variant={app.tracking ? 'ghost' : 'secondary'} onClick={() => onTrack(!app.tracking)} disabled={busy}>
            {app.tracking ? 'Stop recording' : 'Record its payments'}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon={<Unplug size={13} />} onClick={onDisconnect} disabled={busy}>
            Disconnect
          </Button>
        )}
      </div>
      {app.tracking && (
        <>
          <div style={note}>
            {app.lastEventAt ? `Last payment ${formatDate(app.lastEventAt, { relative: true })}` : 'No payments yet'}
            {app.environment === 'sandbox' && ' · Test money: never billed'}
          </div>
          {!app.webhook.registered && (
            // Pay with PayPal's app's error speaks of batches; a checkout
            // app's is about payments already.
            <div style={note}>
              {(app.purpose === 'checkout' && app.webhook.error) || 'No webhook: payments are read from PayPal every hour.'}
            </div>
          )}
          {app.webhook.registered && app.webhook.error && <div style={{ ...note, color: theme.warn }}>{app.webhook.error}</div>}
          {app.transactionSearch === 'unavailable' && (
            <div style={{ ...note, color: theme.warn }}>
              Turn on Transaction Search for this app in the PayPal developer dashboard, so missed payments are caught up.
            </div>
          )}
        </>
      )}
      {app.lastError && <div style={{ ...note, color: theme.danger }}>{app.lastError}</div>}
    </div>
  );
}

function ConnectCheckout({ environments, onConnected }: { environments: PaypalEnvironment[]; onConnected: () => void }) {
  const [open, setOpen] = useState(false);
  const [environment, setEnvironment] = useState<PaypalEnvironment>(environments[0]!);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const env = environments.includes(environment) ? environment : environments[0]!;
  const connect = useMutation({
    mutationFn: () =>
      api('/config/paypal-payments', { method: 'POST', body: { environment: env, clientId: clientId.trim(), clientSecret: clientSecret.trim() } }),
    onSuccess: () => {
      setClientId('');
      setClientSecret('');
      setOpen(false);
      onConnected();
    },
    // Never keep the secret around after a failed attempt either.
    onError: () => setClientSecret(''),
  });

  if (!open) {
    return (
      <div>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Connect your checkout&rsquo;s PayPal app
        </Button>
      </div>
    );
  }
  const field = { display: 'block', fontSize: 12, color: theme.textMuted, marginBottom: 6, fontWeight: 500 } as const;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        connect.mutate();
      }}
      style={{ padding: '12px 14px', border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm }}
    >
      <div style={{ fontSize: 12.5, color: theme.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
        PayPal tells only the app a payment went through, so connect the app your checkout uses (Apps &amp; Credentials
        in the PayPal developer dashboard). It reports payments and never sends any.
      </div>
      <ErrorBanner error={connect.error} />
      {environments.length > 1 && (
        <div style={{ display: 'flex', gap: 14, fontSize: 13, marginBottom: 10 }}>
          {environments.map((e) => (
            <label key={e} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="radio" name="paypal-checkout-env" checked={env === e} onChange={() => setEnvironment(e)} />
              {PAYPAL_ENV_LABEL[e]}
            </label>
          ))}
        </div>
      )}
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ display: 'block' }}>
          <span style={field}>Client ID</span>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <label style={{ display: 'block' }}>
          <span style={field}>Secret</span>
          <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password" spellCheck={false} />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button type="submit" size="sm" disabled={connect.isPending || !clientId.trim() || !clientSecret.trim()}>
          {connect.isPending ? 'Checking with PayPal…' : `Connect ${PAYPAL_ENV_LABEL[env].toLowerCase()} app`}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={connect.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
