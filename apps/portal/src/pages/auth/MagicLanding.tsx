import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, clearApiKey } from '../../api.js';
import { theme } from '../../theme.js';
import { AuthFrame } from './Shared.js';

/**
 * Terminal page for an emailed magic link. URL is `/auth/magic?token=...`.
 * We POST the token to /auth/magic/verify — server sets the op_session
 * cookie on success — then redirect to the dashboard. Any leftover API
 * key in localStorage is cleared so the new session takes precedence.
 */
export function MagicLandingPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [state, setState] = useState<'verifying' | 'ok' | 'failed'>('verifying');
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setState('failed');
      setDetail('No token in URL.');
      return;
    }
    clearApiKey();
    api<{ ok: boolean }>('/auth/magic/verify', { method: 'POST', body: { token } })
      .then(() => {
        // After a successful first-run activation the install-status
        // probe was cached (staleTime: Infinity) with needsSetup=true
        // from app boot, so / would redirect right back to /install.
        // Invalidate so the Shell re-reads and admits the newly
        // activated admin into the dashboard.
        qc.invalidateQueries({ queryKey: ['install-status'] });
        setState('ok');
        setTimeout(() => nav('/', { replace: true }), 400);
      })
      .catch((err) => {
        setState('failed');
        setDetail(
          err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : 'Link is invalid or expired.',
        );
      });
  }, [nav, params, qc]);

  return (
    <AuthFrame title="Signing you in" subtitle="One moment…">
      {state === 'verifying' && <div style={{ color: theme.textMuted, fontSize: 14 }}>Verifying your link…</div>}
      {state === 'ok' && <div style={{ color: theme.success, fontSize: 14 }}>Signed in. Redirecting…</div>}
      {state === 'failed' && (
        <div style={{ color: theme.danger, fontSize: 14 }}>
          {detail ?? 'Could not verify.'}
          <div style={{ color: theme.textDim, fontSize: 13, marginTop: 10 }}>
            Ask for a new link from the sign-in page.
          </div>
        </div>
      )}
    </AuthFrame>
  );
}
