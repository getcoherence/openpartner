import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, clearApiKey } from '../../api.js';
import { theme } from '../../theme.js';
import { AuthFrame } from './Shared.js';

interface VerifyResponse {
  ok: boolean;
  role?: 'network_creator' | 'network_vendor';
  status?: 'pending' | 'active';
  vendor?: { id: string; name: string; slug: string };
}

export function MagicLandingPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<VerifyResponse | null>(null);

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setErr('Missing token.');
      return;
    }
    clearApiKey();
    api<VerifyResponse>('/auth/magic/verify', { method: 'POST', body: { token } })
      .then((resp) => {
        // Vendor signup gives no session — the vendor still needs admin
        // approval before they can sign in. Show a held state rather
        // than redirecting to /.
        if (resp.role === 'network_vendor' && resp.status === 'pending') {
          setPending(resp);
          return;
        }
        nav('/', { replace: true });
      })
      .catch((e) => {
        const code = (e?.detail as { error?: string } | undefined)?.error ?? 'unknown';
        const messages: Record<string, string> = {
          expired: 'That link has expired. Request a new one.',
          already_consumed: 'That link was already used.',
          not_found: "We couldn't find that link.",
          creator_not_active: 'Your account is suspended. Contact an admin.',
          vendor_not_active: 'Your vendor account is still pending admin approval.',
          email_or_handle_taken: 'Someone else claimed that email or handle in the meantime.',
          slug_taken: 'Someone else claimed that slug in the meantime.',
          invalid_signup_claim: 'That sign-up link is malformed.',
          unknown_purpose: 'That link is for an unsupported flow.',
        };
        setErr(messages[code] ?? (e instanceof Error ? e.message : 'Something went wrong.'));
      });
  }, [params, nav]);

  if (pending) {
    return (
      <AuthFrame title="Submitted for review" subtitle={`Welcome, ${pending.vendor?.name}.`}>
        <div
          style={{
            background: theme.successSoft,
            border: `1px solid ${theme.success}55`,
            padding: 14,
            borderRadius: theme.radiusSm,
            fontSize: 13,
            color: theme.success,
          }}
        >
          Your email is verified and your vendor record is pending admin review. We'll let you sign in once your account is active.
        </div>
        <div style={{ marginTop: 16, fontSize: 12, color: theme.textDim }}>
          Already active? <Link to="/login" style={{ color: theme.accent }}>Sign in</Link>
        </div>
      </AuthFrame>
    );
  }

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
