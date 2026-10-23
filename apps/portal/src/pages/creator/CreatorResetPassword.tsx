import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { theme } from '../../theme.js';
import { AuthFrame } from '../auth/Shared.js';
import { authErrorMessage, primaryButtonStyle, useNewPassword, type AuthLocationState } from '../auth/PasswordAuth.js';
import { stripQueryParamsFromAddressBar } from '../../lib/sensitive-url.js';
import { creatorApi } from './creator-api.js';
import { creatorErrorCode } from './CreatorSignin.js';

/**
 * /creator/reset-password — the link the Network's "forgot password" mails
 * (POST /creators/password/forgot). Saving redeems it at POST
 * /creators/password/reset, which signs out every session, then sends the
 * creator to /creator/login with the address filled in (router state, so it
 * stays out of the URL).
 */
export function CreatorResetPasswordPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  // Read once: the token is taken out of the address bar (history, Referer,
  // analytics) as soon as the page loads.
  const [token] = useState(() => params.get('token'));
  const { password, fields, problem } = useNewPassword();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    stripQueryParamsFromAddressBar(['token']);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || problem) return;
    setBusy(true);
    setErr(null);
    try {
      const { email } = await creatorApi<{ email: string }>('/creators/password/reset', {
        method: 'POST',
        body: { token, password },
      });
      const state: AuthLocationState = { email, reset: true };
      nav('/creator/login', { replace: true, state });
    } catch (e) {
      setErr(authErrorMessage(creatorErrorCode(e).message));
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Choose a password" subtitle="You’ll sign in with your email and this password.">
      {!token ? (
        <div style={{ color: theme.danger, fontSize: 14 }}>
          This link is missing its token. Ask for a new one from{' '}
          <Link to="/creator/login" style={{ color: theme.accentText }}>
            the sign-in page
          </Link>
          .
        </div>
      ) : (
        <form onSubmit={submit}>
          {fields}
          {err && <div style={{ color: theme.danger, fontSize: 13, marginBottom: 8 }}>{err}</div>}
          <button type="submit" disabled={busy || !!problem} style={primaryButtonStyle(busy || !!problem)}>
            {busy ? 'Saving…' : 'Save password'}
          </button>
          <div style={{ marginTop: 12, fontSize: 12, color: theme.textDim, lineHeight: 1.5 }}>
            Saving signs you out everywhere, this browser included. Emailed sign-in links keep working too.
          </div>
        </form>
      )}
    </AuthFrame>
  );
}
