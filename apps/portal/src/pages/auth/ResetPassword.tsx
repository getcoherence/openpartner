import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { AuthFrame } from './Shared.js';
import { PlatformFrame } from '../platform/components.js';
import { authErrorMessage, postPlatform, primaryButtonStyle, useNewPassword, type AuthLocationState } from './PasswordAuth.js';

/**
 * Landing for a "forgot password" link. Two kinds arrive here:
 *   ?scope=account — a brand admin's / operator's platform password,
 *                    redeemed at POST /password/reset (no tenant prefix);
 *   otherwise      — a partner's password on this brand, redeemed at the
 *                    tenant's POST /auth/password/reset.
 * Then on to `loginPath` with the address filled in (router state, so it
 * stays out of the URL).
 */
export function ResetPasswordPage({ loginPath, variant = 'portal' }: { loginPath: string; variant?: 'portal' | 'ops' }) {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token');
  const account = variant === 'ops' || params.get('scope') === 'account';
  const { password, fields, problem } = useNewPassword();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || problem) return;
    setBusy(true);
    setErr(null);
    try {
      const body = { token, password };
      const { email } = account
        ? await postPlatform<{ email: string }>('/password/reset', body)
        : await api<{ email: string }>('/auth/password/reset', { method: 'POST', body });
      const state: AuthLocationState = { email, reset: true };
      nav(loginPath, { replace: true, state });
    } catch (e) {
      setErr(authErrorMessage(e instanceof Error ? e.message : String(e)));
      setBusy(false);
    }
  }

  const content = !token ? (
    <div style={{ color: theme.danger, fontSize: 14 }}>
      This link is missing its token. Ask for a new one from{' '}
      <Link to={loginPath} style={{ color: theme.accentText }}>
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
        {account
          ? 'Saving signs this account out everywhere else. The same password works for every brand you admin.'
          : 'Saving signs you out on your other devices.'}
      </div>
    </form>
  );

  return variant === 'ops' ? (
    <PlatformFrame title="Choose a password" subtitle="For your operator account.">
      {content}
    </PlatformFrame>
  ) : (
    <AuthFrame title="Choose a password" subtitle="You’ll sign in with your email and this password.">
      {content}
    </AuthFrame>
  );
}

/** /t/<slug>/reset-password on the path-based multi-tenant portal. */
export function TenantResetPasswordPage() {
  const { slug } = useParams();
  return <ResetPasswordPage loginPath={`/t/${slug}/login`} />;
}
