import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AtSign, User, Mail } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { theme } from '../../theme.js';
import { AuthFrame } from './Shared.js';

export function SignupPage() {
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/auth/creator/signup', {
        method: 'POST',
        body: { email, handle: handle.toLowerCase(), name },
      });
      setSent(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setErr('That email or handle is already in use.');
      else setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthFrame title="Almost there" subtitle={`We sent a verification link to ${email}.`}>
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
          Click the link within 15 minutes to finish setting up your account.
        </div>
        <div style={{ marginTop: 16, fontSize: 12, color: theme.textDim }}>
          Running locally? Admins can open the <Link to="/admin/dev-mailbox" style={{ color: theme.accent }}>Dev mailbox</Link> to copy the link.
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Create a creator account" subtitle="Promote offerings on the OpenPartner Network.">
      <form onSubmit={submit}>
        <IconInput icon={<User size={15} />} type="text" value={name} onChange={setName} placeholder="Your name" autoFocus />
        <IconInput
          icon={<AtSign size={15} />}
          type="text"
          value={handle}
          onChange={(v) => setHandle(v.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
          placeholder="handle"
          hint="Lowercase letters, digits, or _"
        />
        <IconInput icon={<Mail size={15} />} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
        {err && <div style={{ color: theme.danger, fontSize: 13, marginTop: 8 }}>{err}</div>}
        <button type="submit" disabled={busy || !name || !handle || !email} style={primaryBtnStyle(busy || !name || !handle || !email)}>
          {busy ? 'Sending…' : 'Send verification link'}
        </button>
      </form>
      <div
        style={{
          marginTop: 20,
          paddingTop: 20,
          borderTop: `1px solid ${theme.borderSubtle}`,
          fontSize: 13,
          color: theme.textDim,
        }}
      >
        Already have an account?{' '}
        <Link to="/login" style={{ color: theme.accent, fontWeight: 500 }}>
          Sign in
        </Link>
      </div>
    </AuthFrame>
  );
}

function IconInput({
  icon,
  value,
  onChange,
  placeholder,
  type = 'text',
  hint,
  autoFocus,
}: {
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 12, top: 12, color: theme.textDim, pointerEvents: 'none', display: 'inline-flex' }}>
          {icon}
        </span>
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          style={{
            width: '100%',
            padding: '10px 12px 10px 34px',
            fontSize: 14,
            background: theme.surface2,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            color: theme.text,
          }}
        />
      </div>
      {hint && <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

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
