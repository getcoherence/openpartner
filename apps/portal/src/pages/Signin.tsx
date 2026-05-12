import { useState } from 'react';
import { Link } from 'react-router-dom';
import { theme } from '../theme.js';
import { AuthFrame } from './auth/Shared.js';

/**
 * Email-only sign-in for the multi-tenant deployment. We don't make the
 * user pick "brand vs creator" up front — the backend looks up which
 * accounts they have and emails the right link(s). One email if they're
 * just one or the other; two if they're both. Always 200 silently to
 * avoid email enumeration.
 */
export function SigninPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // ?add=1 — user clicked "Add another account" from the identity switcher.
  // Surfaces a banner so they know they're adding, not replacing.
  const addMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('add') === '1';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/signin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `${res.status}`);
      }
      setSent(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthFrame title="Check your inbox" subtitle={`If we found accounts for ${email}, we just emailed sign-in links.`}>
        <div style={{ background: theme.successSoft, border: `1px solid ${theme.success}55`, padding: 14, borderRadius: theme.radiusSm, fontSize: 13, color: theme.success }}>
          The link is good for 15 minutes. If you have both a brand and a creator account, you&rsquo;ll get one email for each.
        </div>
        <div style={{ marginTop: 12, textAlign: 'center', fontSize: 12, color: theme.textDim }}>
          <Link to="/" style={{ color: theme.accent }}>Back to home</Link>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title={addMode ? 'Add another account' : 'Sign in'} subtitle={addMode ? 'Enter the email for the account you want to add to this browser.' : 'Enter your email — we’ll send you a sign-in link.'}>
      {addMode && (
        <div style={{ background: theme.accent + '15', border: `1px solid ${theme.accent}55`, padding: 12, borderRadius: theme.radiusSm, fontSize: 12, color: theme.textMuted, marginBottom: 14 }}>
          You&rsquo;re adding a second account. Your current account stays signed in &mdash; you&rsquo;ll be able to switch between them from the sidebar.
        </div>
      )}
      <form onSubmit={submit}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 4 }}>Email</div>
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoFocus
            style={inputStyle}
          />
        </div>
        {err && <div style={{ color: theme.danger, fontSize: 13, marginBottom: 8 }}>{err}</div>}
        <button type="submit" disabled={busy || !email} style={primaryBtnStyle(busy || !email)}>
          {busy ? 'Sending…' : 'Email me a sign-in link'}
        </button>
        <div style={{ marginTop: 12, fontSize: 12, color: theme.textDim, textAlign: 'center' }}>
          New here? <Link to="/signup" style={{ color: theme.accent }}>Sign up as a brand</Link> · <Link to="/creator/signup" style={{ color: theme.accent }}>Sign up as a creator</Link>
        </div>
      </form>
    </AuthFrame>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 14,
  background: theme.surface2,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  color: theme.text,
};

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    marginTop: 6,
    width: '100%',
    padding: '10px 14px',
    background: theme.accent,
    color: theme.accentInk,
    border: 'none',
    borderRadius: theme.radiusSm,
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
