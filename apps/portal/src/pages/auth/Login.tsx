import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { KeyRound, Mail } from 'lucide-react';
import { api, clearApiKey, setApiKey, ApiError, type Principal } from '../../api.js';
import { theme } from '../../theme.js';
import { Logo, AuthFrame } from './Shared.js';

type Tab = 'email' | 'key';

export function LoginPage() {
  const [tab, setTab] = useState<Tab>('email');

  return (
    <AuthFrame title="Sign in" subtitle="Choose how you want to sign in.">
      <div style={{ display: 'flex', gap: 4, background: theme.bg, padding: 4, borderRadius: theme.radiusSm, marginBottom: 20 }}>
        <TabButton active={tab === 'email'} onClick={() => setTab('email')} icon={<Mail size={14} />}>
          Email
        </TabButton>
        <TabButton active={tab === 'key'} onClick={() => setTab('key')} icon={<KeyRound size={14} />}>
          API key
        </TabButton>
      </div>
      {tab === 'email' ? <EmailTab /> : <KeyTab />}
      <div
        style={{
          marginTop: 20,
          paddingTop: 20,
          borderTop: `1px solid ${theme.borderSubtle}`,
          fontSize: 13,
          color: theme.textDim,
        }}
      >
        New to OpenPartner?{' '}
        <Link to="/signup" style={{ color: theme.accent, fontWeight: 500 }}>
          Sign up as a creator
        </Link>
      </div>
    </AuthFrame>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        padding: '7px 10px',
        background: active ? theme.surface : 'transparent',
        color: active ? theme.text : theme.textMuted,
        border: 'none',
        borderRadius: theme.radiusSm,
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        justifyContent: 'center',
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function EmailTab() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/auth/creator/signin', { method: 'POST', body: { email } });
      setSent(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
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
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Check your inbox</div>
        <div style={{ color: `${theme.success}cc` }}>
          If an account exists for <strong>{email}</strong>, we sent a sign-in link. It's good for 15 minutes.
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: theme.textDim }}>
          Running locally with no SMTP? Admins can peek at <Link to="/admin/dev-mailbox" style={{ color: theme.accent }}>Dev mailbox</Link>.
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <div style={{ position: 'relative' }}>
        <Mail size={15} style={{ position: 'absolute', left: 12, top: 12, color: theme.textDim, pointerEvents: 'none' }} />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoFocus
          required
          style={inputStyle}
        />
      </div>
      {err && <div style={{ color: theme.danger, fontSize: 13, marginTop: 8 }}>{err}</div>}
      <button type="submit" disabled={busy || !email} style={primaryBtnStyle(busy || !email)}>
        {busy ? 'Sending…' : 'Email me a sign-in link'}
      </button>
    </form>
  );
}

function KeyTab() {
  const nav = useNavigate();
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setApiKey(token.trim());
    try {
      await api<Principal>('/auth/whoami');
      nav('/');
    } catch (e) {
      clearApiKey();
      setErr(e instanceof ApiError && e.status === 401 ? "That key didn't work." : 'Could not reach the API.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div style={{ position: 'relative' }}>
        <KeyRound size={15} style={{ position: 'absolute', left: 12, top: 12, color: theme.textDim, pointerEvents: 'none' }} />
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="op_..."
          autoFocus
          style={{ ...inputStyle, fontFamily: theme.fontMono }}
        />
      </div>
      {err && <div style={{ color: theme.danger, fontSize: 13, marginTop: 8 }}>{err}</div>}
      <button type="submit" disabled={busy || !token} style={primaryBtnStyle(busy || !token)}>
        {busy ? 'Checking…' : 'Sign in with key'}
      </button>
      <div style={{ marginTop: 12, fontSize: 12, color: theme.textDim, lineHeight: 1.6 }}>
        Admin keys come from <code style={{ color: theme.textMuted }}>ADMIN_API_KEY</code>. Partner, vendor, and machine-to-machine keys are issued from the relevant admin view.
      </div>
    </form>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px 10px 34px',
  fontSize: 14,
  background: theme.surface2,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  color: theme.text,
};

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    marginTop: 14,
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

export { Logo };
