import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { theme } from '../../theme.js';
import { PlatformFrame } from './components.js';
import { papi, friendlyPlatformError } from './lib.js';

/**
 * Operator magic-link landing. Reads ?token, POSTs the verify endpoint
 * (which sets an httpOnly operator cookie on success), then routes into the
 * console. Mirrors auth/PlatformMagicLanding.tsx.
 */
export function PlatformAuthPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [state, setState] = useState<'verifying' | 'ok' | 'failed'>('verifying');
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setState('failed');
      setDetail('No token in the link.');
      return;
    }
    papi<{ ok: boolean; email: string; role: string }>('/auth/platform-admin-verify', {
      method: 'POST',
      body: { token },
    })
      .then(() => {
        setState('ok');
        setTimeout(() => nav('/platform/brands', { replace: true }), 300);
      })
      .catch((err) => {
        setState('failed');
        setDetail(friendlyPlatformError(err));
      });
  }, [nav, params]);

  return (
    <PlatformFrame title="Signing you in" subtitle="One moment…">
      {state === 'verifying' && <div style={{ color: theme.textMuted, fontSize: 14 }}>Verifying your link…</div>}
      {state === 'ok' && <div style={{ color: theme.success, fontSize: 14 }}>Signed in. Opening the console…</div>}
      {state === 'failed' && (
        <div style={{ color: theme.danger, fontSize: 14 }}>
          {detail ?? 'Could not verify.'}
          <div style={{ color: theme.textDim, fontSize: 13, marginTop: 10 }}>
            Request a new link from{' '}
            <Link to="/platform/login" style={{ color: theme.accent }}>
              the operator sign-in page
            </Link>
            .
          </div>
        </div>
      )}
    </PlatformFrame>
  );
}
