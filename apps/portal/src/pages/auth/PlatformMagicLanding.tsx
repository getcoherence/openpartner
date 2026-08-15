import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { theme } from '../../theme.js';
import { AuthFrame } from './Shared.js';

/**
 * Multi-tenant magic-link landing for platform-identity tokens (the
 * tokens issued by the unified /signin). Verify creates a
 * PlatformSession; we then push the user to /workspaces, which decides
 * whether to show the picker or auto-enter their single workspace.
 */
export function PlatformMagicLandingPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [state, setState] = useState<'verifying' | 'ok' | 'failed'>('verifying');
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setState('failed');
      setDetail('No token in URL.');
      return;
    }
    fetch('/api/auth/platform-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error((j as { error?: string }).error ?? `${r.status}`);
        }
        setState('ok');
        setTimeout(() => nav('/workspaces', { replace: true }), 300);
      })
      .catch((err) => {
        setState('failed');
        setDetail(err instanceof Error ? err.message : 'Link is invalid or expired.');
      });
  }, [nav, params]);

  return (
    <AuthFrame title="Signing you in" subtitle="One moment…">
      {state === 'verifying' && <div style={{ color: theme.textMuted, fontSize: 14 }}>Verifying your link…</div>}
      {state === 'ok' && <div style={{ color: theme.success, fontSize: 14 }}>Signed in. Picking your workspace…</div>}
      {state === 'failed' && (
        <div style={{ color: theme.danger, fontSize: 14 }}>
          {detail ?? 'Could not verify.'}
          <div style={{ color: theme.textDim, fontSize: 13, marginTop: 10 }}>
            Ask for a new link from <a href="/signin" style={{ color: theme.accent }}>the sign-in page</a>.
          </div>
        </div>
      )}
    </AuthFrame>
  );
}
