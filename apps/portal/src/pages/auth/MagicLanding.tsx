import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, clearApiKey } from '../../api.js';
import { theme } from '../../theme.js';
import { AuthFrame } from './Shared.js';

export function MagicLandingPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setErr('Missing token.');
      return;
    }
    // Magic-link sign-in mints a session cookie — any previously stored
    // API key in localStorage would fight it, so clear it up front.
    clearApiKey();
    api<{ ok: boolean }>('/auth/magic/verify', { method: 'POST', body: { token } })
      .then(() => nav('/', { replace: true }))
      .catch((e) => {
        const code = (e?.detail as { error?: string } | undefined)?.error ?? 'unknown';
        const messages: Record<string, string> = {
          expired: 'That link has expired. Request a new one.',
          already_consumed: 'That link was already used.',
          not_found: "We couldn't find that link.",
          creator_not_active: 'Your account is suspended. Contact an admin.',
          email_or_handle_taken: 'Someone else claimed that email or handle in the meantime.',
          invalid_signup_claim: 'That sign-up link is malformed.',
        };
        setErr(messages[code] ?? (e instanceof Error ? e.message : 'Something went wrong.'));
      });
  }, [params, nav]);

  return (
    <AuthFrame title={err ? 'Sign-in failed' : 'Signing you in…'}>
      {err ? (
        <div
          style={{
            background: theme.dangerSoft,
            border: `1px solid ${theme.danger}55`,
            padding: 14,
            borderRadius: theme.radiusSm,
            fontSize: 13,
            color: theme.danger,
          }}
        >
          {err}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: theme.textMuted }}>One moment…</div>
      )}
    </AuthFrame>
  );
}
