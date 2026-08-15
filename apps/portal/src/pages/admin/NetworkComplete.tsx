import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api.js';
import { Card, ErrorBanner, Page } from '../../ui.js';

/**
 * Callback page for the Network self-serve onboarding magic link.
 *
 * Network sends the admin to {portal}/admin/network/complete?ntoken=...
 * after they click the email confirmation link. This page consumes the
 * ntoken via POST /config/network/complete-connect on this instance —
 * which round-trips it to Network /vendors/verify-and-issue-token,
 * receives the long-lived vendorToken, and saves it to network_membership
 * Config. After success we bounce to /admin/network where the
 * "Connected" state shows.
 */
export function AdminNetworkComplete() {
  const [params] = useSearchParams();
  const ntoken = params.get('ntoken');
  const [state, setState] = useState<'pending' | 'ok' | 'error'>('pending');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  // React StrictMode runs effects twice in dev; guard so we only burn
  // the one-shot ntoken on the first mount.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    if (!ntoken) {
      setState('error');
      setError('Missing ntoken in URL.');
      return;
    }
    api('/config/network/complete-connect', { method: 'POST', body: { ntoken } })
      .then(() => {
        setState('ok');
        qc.invalidateQueries({ queryKey: ['network-membership'] });
        setTimeout(() => navigate('/admin/network', { replace: true }), 800);
      })
      .catch((err) => {
        setState('error');
        setError(err instanceof ApiError ? err.message : 'Verification failed.');
      });
  }, [ntoken, navigate, qc]);

  return (
    <Page title="Connecting to Network">
      <Card>
        {state === 'pending' && <p>Finishing connection…</p>}
        {state === 'ok' && (
          <p style={{ color: '#1a6b1a' }}>
            Connected. Redirecting back to Network settings…
          </p>
        )}
        {state === 'error' && (
          <>
            <ErrorBanner error={error} />
            <p>
              Magic links expire after 24 hours. Open Settings → Network and click "Connect to Network"
              again to receive a fresh link.
            </p>
          </>
        )}
      </Card>
    </Page>
  );
}
