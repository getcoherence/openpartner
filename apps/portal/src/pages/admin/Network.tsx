import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api.js';
import { Button, Card, ErrorBanner, Input, Label, Page } from '../../ui.js';

interface NetworkMembership {
  enabled: boolean;
  networkUrl: string;
  hasVendorToken: boolean;
  scopedKeyId: string | null;
  autoEnroll: boolean;
}

interface NetworkSelf {
  id: string;
  displayName: string;
  status: string;
  partnerCount: number;
}

interface BackfillResult {
  total: number;
  pushed: number;
  queued: number;
}

export function AdminNetwork() {
  return (
    <Page
      title="Network"
      subtitle="List your brand on the OpenPartner Network so creators can find and apply to your programs."
    >
      <NetworkConnection />
    </Page>
  );
}

function NetworkConnection() {
  const qc = useQueryClient();
  const { data: membership, isLoading, error } = useQuery({
    queryKey: ['network-membership'],
    queryFn: () => api<NetworkMembership>('/config/network'),
  });

  // Connected once enabled=true AND vendor token saved.
  const connected = !!(membership?.enabled && membership.hasVendorToken);

  return (
    <>
      {error && <ErrorBanner error={"Couldn't load Network settings."} />}
      {isLoading && <Card><p>Loading…</p></Card>}
      {membership && (
        <>
          {!connected ? <ConnectForm membership={membership} /> : <ConnectedPanel membership={membership} />}
          {connected && <AutoEnrollPanel membership={membership} onChange={() => qc.invalidateQueries({ queryKey: ['network-membership'] })} />}
          {connected && <BackfillPanel />}
        </>
      )}
    </>
  );
}

function ConnectForm({ membership }: { membership: NetworkMembership }) {
  const qc = useQueryClient();
  const [contactEmail, setContactEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);

  // One-click path: backend uses NETWORK_ADMIN_API_KEY to skip the
  // email-verify round trip. Available on the hosted deployment; not
  // on self-host (where the operator doesn't have the Network's admin
  // key).
  const auto = useMutation({
    mutationFn: () => api('/config/network/auto-enroll', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-membership'] }),
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : 'failed';
      // If admin token isn't configured, fall back to the manual form.
      if (msg.includes('admin_token_not_configured')) setShowManual(true);
      setError(msg);
    },
  });

  const manual = useMutation({
    mutationFn: () => api('/config/network/start-connect', {
      method: 'POST',
      body: { contactEmail: contactEmail || undefined, displayName: displayName || undefined },
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-membership'] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  });

  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Not connected</h3>
      <p>
        Get matched with creators on the OpenPartner Network. Once connected, your published offerings
        show up in creator discovery and applications come into your Requests queue.
      </p>
      {membership.networkUrl && (
        <p style={{ fontSize: 13, color: '#6b7280' }}>
          Network: <code>{membership.networkUrl}</code>
        </p>
      )}
      {error && (
        <ErrorBanner error={error === 'network_url_not_configured' ? 'NETWORK_URL env not set on this instance.' : error} />
      )}
      {!showManual ? (
        <>
          <Button onClick={() => auto.mutate()} disabled={auto.isPending}>
            {auto.isPending ? 'Connecting…' : 'List my brand on the Network'}
          </Button>
          <p style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>
            Self-host?{' '}
            <button type="button" onClick={() => setShowManual(true)} style={{ background: 'transparent', border: 'none', color: '#0d9488', cursor: 'pointer', padding: 0 }}>
              Use the email-verify flow instead
            </button>
          </p>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <Label>Contact email (where the confirmation link goes)</Label>
            <Input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="admin@yourbrand.com" />
          </div>
          <div style={{ marginBottom: 12 }}>
            <Label>Display name (shown to creators)</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your brand" />
          </div>
          <Button onClick={() => manual.mutate()} disabled={manual.isPending || !contactEmail}>
            {manual.isPending ? 'Sending…' : 'Send verification email'}
          </Button>
          {manual.isSuccess && (
            <p style={{ marginTop: 12, color: '#1a6b1a' }}>
              Confirmation email sent. Click the link to finish connecting.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function ConnectedPanel({ membership }: { membership: NetworkMembership }) {
  const { data: self } = useQuery({
    queryKey: ['network-self'],
    queryFn: () => api<NetworkSelf>('/admin/network/me'),
    retry: false,
  });
  return (
    <Card>
      <h3 style={{ marginTop: 0, color: '#1a6b1a' }}>Connected ✓</h3>
      <p>
        Network: <code>{membership.networkUrl}</code><br />
        {self ? (
          <>
            Listed as <strong>{self.displayName}</strong> · status: {self.status} · {self.partnerCount} active partners
          </>
        ) : (
          <em>Loading vendor profile…</em>
        )}
      </p>
    </Card>
  );
}

function AutoEnrollPanel({ membership, onChange }: { membership: NetworkMembership; onChange: () => void }) {
  const m = useMutation({
    mutationFn: (autoEnroll: boolean) =>
      api('/config/network', { method: 'POST', body: { autoEnroll } }),
    onSuccess: onChange,
  });
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Auto-enroll new partners</h3>
      <p>
        When ON, every partner created on this instance is automatically pushed to the Network. The Network
        dedups creators by email — the same person joining you and another vendor gets a single Network
        identity.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={membership.autoEnroll}
          disabled={m.isPending}
          onChange={(e) => m.mutate(e.target.checked)}
        />
        <span>Auto-enroll on partner create + signup</span>
      </label>
    </Card>
  );
}

function BackfillPanel() {
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api<BackfillResult>('/config/network/backfill', { method: 'POST', body: {} }),
    onSuccess: (r) => { setResult(r); setError(null); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  });
  useEffect(() => { setResult(null); }, []);
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Backfill existing partners</h3>
      <p>
        If you turned the Network on after onboarding partners, run this once to push the existing roster
        through email-keyed dedup. Pre-existing creators (already on the Network from another vendor) come
        back with a flag so you can see their cross-vendor presence.
      </p>
      {error && <ErrorBanner error={error} />}
      <Button onClick={() => m.mutate()} disabled={m.isPending}>
        {m.isPending ? 'Backfilling…' : 'Backfill now'}
      </Button>
      {result && (
        <p style={{ marginTop: 12 }}>
          Pushed <strong>{result.pushed}</strong> of <strong>{result.total}</strong>.
          {result.queued > 0 && <> {result.queued} queued for retry.</>}
        </p>
      )}
    </Card>
  );
}
