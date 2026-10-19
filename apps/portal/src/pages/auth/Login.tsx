import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Mail } from 'lucide-react';
import { api, clearApiKey, setApiKey, ApiError, type Principal } from '../../api.js';
import { useTenantBase } from '../../tenant-base.js';
import { theme } from '../../theme.js';
import { usePublicBrand } from '../../lib/useBrand.js';
import { Logo, AuthFrame } from './Shared.js';
import {
  AuthNotice,
  EmailPasswordForm,
  googleStartHref,
  useAuthProviders,
  type AuthLocationState,
} from './PasswordAuth.js';

type Tab = 'email' | 'key';

export function LoginPage() {
  const [tab, setTab] = useState<Tab>('email');
  const [params] = useSearchParams();
  const state = (useLocation().state ?? {}) as AuthLocationState;
  return (
    <AuthFrame title="Sign in" subtitle="Choose how you want to sign in.">
      <AuthNotice error={params.get('error')} reset={state.reset} />
      <div style={{ display: 'flex', gap: 4, background: theme.bg, padding: 4, borderRadius: theme.radiusSm, marginBottom: 20 }}>
        <TabButton active={tab === 'email'} onClick={() => setTab('email')} icon={<Mail size={14} />}>
          Email
        </TabButton>
        <TabButton active={tab === 'key'} onClick={() => setTab('key')} icon={<KeyRound size={14} />}>
          Admin / partner key
        </TabButton>
      </div>
      {tab === 'email' ? <EmailTab /> : <KeyTab />}
    </AuthFrame>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
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

/**
 * Email + password (admin or partner of this brand), Google, or an emailed
 * link. A correct password returns the token the sign-in email would have
 * carried; redeeming it here is the same POST /auth/magic/verify the
 * emailed link's landing page makes.
 */
function EmailTab() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const tenantBase = useTenantBase();
  const state = (useLocation().state ?? {}) as AuthLocationState;
  const providers = useAuthProviders();
  // Resolved from the /t/<slug>/ prefix or the custom-domain host.
  const { tenantSlug } = usePublicBrand();

  return (
    <EmailPasswordForm
      initialEmail={state.email}
      googleHref={providers.googleStartUrl ? googleStartHref(providers.googleStartUrl, 'portal', tenantSlug) : null}
      onPassword={async (email, password) => {
        clearApiKey();
        let token: string;
        try {
          ({ token } = await api<{ token: string }>('/auth/signin/password', { method: 'POST', body: { email, password } }));
        } catch (e) {
          // api() collapses every 401 to 'unauthorized'.
          throw new Error(e instanceof ApiError && e.status === 401 ? 'invalid_credentials' : e instanceof Error ? e.message : String(e));
        }
        await api('/auth/magic/verify', { method: 'POST', body: { token } });
        // Same as the magic-link landing: the install probe was cached
        // before this admin existed.
        qc.invalidateQueries({ queryKey: ['install-status'] });
        nav(tenantBase || '/', { replace: true });
      }}
      onLink={(email) => api('/auth/signin', { method: 'POST', body: { email } }).then(() => undefined)}
      onForgot={(email) => api('/auth/password/forgot', { method: 'POST', body: { email } }).then(() => undefined)}
      linkSentText={(email) => `If an account exists for ${email}, we sent a sign-in link. It’s good for 15 minutes.`}
      forgotSentText={(email) => `If an account exists for ${email}, we sent a link to choose a password. It’s good for 15 minutes.`}
    />
  );
}

function KeyTab() {
  const nav = useNavigate();
  const tenantBase = useTenantBase();
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
      // Land on the tenant root (admin dashboard for admin keys,
      // partner dashboard for partner keys) rather than '/' which
      // strips the tenant prefix and falls through to the marketing
      // landing page on multi-tenant deployments.
      nav(tenantBase || '/');
    } catch (e) {
      clearApiKey();
      if (e instanceof ApiError) {
        if (e.status === 401) {
          setErr("That key didn't work.");
        } else if (e.status === 403 && typeof e.message === 'string' && e.message.includes('scoped_key_not_for_portal')) {
          // Common confusion: pasting a scoped integration key
          // (CRM / Zapier / federation) into the portal sign-in.
          // Tell them what kind of key actually works here.
          setErr(
            "That's a scoped integration key — they can't sign into the portal. Sign in on the Email tab, or use an admin API key.",
          );
        } else {
          setErr(e.message || 'Could not reach the API.');
        }
      } else {
        setErr('Could not reach the API.');
      }
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div style={{ position: 'relative' }}>
        <KeyRound size={15} style={{ position: 'absolute', left: 12, top: 12, color: theme.textDim, pointerEvents: 'none' }} />
        <input
          type="password"
          name="apiKey"
          autoComplete="off"
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
        <br />
        <strong style={{ color: theme.textMuted }}>Not for integration keys</strong> — scoped
        keys minted under Admin → Integrations are server-to-server credentials and can&rsquo;t
        sign into the portal.
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
