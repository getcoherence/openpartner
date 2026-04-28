import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { theme } from '../../theme.js';
import { AuthFrame } from '../auth/Shared.js';
import { creatorApi, ApiError } from './creator-api.js';

export function CreatorSignupPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await creatorApi('/creators/signup', {
        method: 'POST',
        body: { email: email.trim(), name: name.trim(), handle: handle.trim() || undefined },
      });
      setSent(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthFrame title="Check your inbox" subtitle={`We just emailed ${email} a sign-in link.`}>
        <div style={{ background: theme.successSoft, border: `1px solid ${theme.success}55`, padding: 14, borderRadius: theme.radiusSm, fontSize: 13, color: theme.success }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>Account created.</div>
          <div style={{ color: `${theme.success}cc` }}>
            Click the link in the email to finish signing in. It&rsquo;s good for 15 minutes.
          </div>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Sign up as a creator" subtitle="Browse and apply to partner programs across the OpenPartner Network.">
      <form onSubmit={submit}>
        <Field label="Your name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" required style={inputStyle} />
        </Field>
        <Field label="Email" hint="We'll send your sign-in link here.">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" required style={inputStyle} />
        </Field>
        <Field label="Handle (optional)" hint="Letters, numbers, hyphens. Used as your default share-link slug.">
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
            placeholder="ada"
            pattern="[a-zA-Z0-9_-]{2,40}"
            style={{ ...inputStyle, fontFamily: theme.fontMono }}
          />
        </Field>
        {err && <div style={{ color: theme.danger, fontSize: 13, marginTop: 4, marginBottom: 8 }}>{err}</div>}
        <button type="submit" disabled={busy} style={primaryBtnStyle(busy)}>
          {busy ? 'Sending…' : 'Send me a sign-in link'}
        </button>
        <div style={{ marginTop: 12, fontSize: 12, color: theme.textDim, textAlign: 'center' }}>
          Already have an account? <Link to="/creator/login" style={{ color: theme.accent }}>Sign in</Link> · <Link to="/" style={{ color: theme.accent }}>Home</Link>
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: theme.textDim, textAlign: 'center' }}>
          Running a program instead? <button type="button" onClick={() => nav('/signup')} style={linkBtnStyle}>Vendor signup →</button>
        </div>
      </form>
    </AuthFrame>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4 }}>{hint}</div>}
    </div>
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

const linkBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: theme.accent,
  cursor: 'pointer',
  font: 'inherit',
  padding: 0,
};
