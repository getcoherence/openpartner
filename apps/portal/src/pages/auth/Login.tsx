import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { api, clearApiKey, setApiKey, ApiError, type Principal } from '../../api.js';
import { theme } from '../../theme.js';
import { Logo, AuthFrame } from './Shared.js';

export function LoginPage() {
  return (
    <AuthFrame title="Sign in" subtitle="Paste your API key to continue.">
      <KeyTab />
    </AuthFrame>
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
        {busy ? 'Checking…' : 'Sign in'}
      </button>
      <div style={{ marginTop: 12, fontSize: 12, color: theme.textDim, lineHeight: 1.6 }}>
        Admin keys come from <code style={{ color: theme.textMuted }}>ADMIN_API_KEY</code>.
        Partner keys are issued from the Partners admin view.
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
