import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { theme } from '../../theme.js';
import { AuthFrame } from '../auth/Shared.js';
import { creatorApi } from './creator-api.js';

export function CreatorMagicLandingPage() {
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
    creatorApi<{ ok: boolean }>('/creators/verify', { method: 'POST', body: { token } })
      .then(() => {
        setState('ok');
        setTimeout(() => nav('/creator', { replace: true }), 400);
      })
      .catch((err) => {
        setState('failed');
        setDetail(err?.message ?? 'Link is invalid or expired.');
      });
  }, [nav, params]);

  return (
    <AuthFrame title="Signing you in" subtitle="One moment…">
      {state === 'verifying' && <div style={{ color: theme.textMuted, fontSize: 14 }}>Verifying your link…</div>}
      {state === 'ok' && <div style={{ color: theme.success, fontSize: 14 }}>Signed in. Redirecting…</div>}
      {state === 'failed' && (
        <div style={{ color: theme.danger, fontSize: 14 }}>
          {detail ?? 'Could not verify.'}
          <div style={{ color: theme.textDim, fontSize: 13, marginTop: 10 }}>
            Ask for a new link from <a href="/creator/login" style={{ color: theme.accent }}>the sign-in page</a>.
          </div>
        </div>
      )}
    </AuthFrame>
  );
}
