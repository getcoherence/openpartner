import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { api, ApiError } from '../../api.js';
import { useTenantBase } from '../../tenant-base.js';
import { Button, Card, ErrorBanner, Input, Label, Page } from '../../ui.js';
import { theme } from '../../theme.js';
import { isNetworkConnected, type NetworkMembership } from './NetworkSettingsSection.js';

/**
 * Network → Get connected. Only for a brand that isn't connected yet: once
 * it is, its Network settings live on Admin → Settings, and this route
 * (where the Network's links and the connect callback land) sends it there.
 */
export function AdminNetwork() {
  const tenantBase = useTenantBase();
  const { data: membership, isLoading, error } = useQuery({
    queryKey: ['network-membership'],
    queryFn: () => api<NetworkMembership>('/config/network'),
  });

  if (isNetworkConnected(membership)) return <Navigate to={`${tenantBase}/admin/settings#network`} replace />;

  return (
    <Page
      title="Network"
      subtitle="List your brand on the OpenPartner Network so creators can find and apply to your programs."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <ErrorBanner error={"Couldn't load Network settings."} />}
        {isLoading && <Card><p style={{ fontSize: 13, margin: 0, color: theme.textMuted }}>Loading…</p></Card>}
        {membership && <ConnectForm membership={membership} />}
      </div>
    </Page>
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
      <h3 style={{ marginTop: 0, fontSize: 15, fontWeight: 500 }}>Not connected</h3>
      <p style={{ fontSize: 13, color: theme.textMuted, marginTop: 0 }}>
        Get matched with creators on the OpenPartner Network. Once connected, your published offerings
        show up in creator discovery and applications come into your Requests queue.
      </p>
      {membership.networkUrl && (
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px' }}>
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
          <p style={{ marginTop: 10, fontSize: 12, color: theme.textDim }}>
            Self-host?{' '}
            <button type="button" onClick={() => setShowManual(true)} style={{ background: 'transparent', border: 'none', color: theme.accentText, cursor: 'pointer', padding: 0, font: 'inherit' }}>
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
            <p style={{ marginTop: 12, fontSize: 13, color: theme.success }}>
              Confirmation email sent. Click the link to finish connecting.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
