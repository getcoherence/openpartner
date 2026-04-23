import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Link2,
  Receipt,
  Banknote,
  CreditCard,
  Users,
  Tag,
  ShieldCheck,
  Download,
  LogOut,
  KeyRound,
} from 'lucide-react';
import { clearApiKey, getApiKey, setApiKey, api, type Principal, ApiError } from './api.js';
import { theme } from './theme.js';
import { Dashboard } from './pages/Dashboard.js';
import { LinksPage } from './pages/Links.js';
import { CommissionsPage } from './pages/Commissions.js';
import { PayoutsPage } from './pages/Payouts.js';
import { ConnectPage } from './pages/Connect.js';
import { AdminPartners } from './pages/AdminPartners.js';
import { AdminCampaigns } from './pages/AdminCampaigns.js';
import { AdminReview } from './pages/AdminReview.js';
import { AdminExport } from './pages/AdminExport.js';

interface AuthState {
  loading: boolean;
  principal: Principal | null;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={<Shell />} />
      </Routes>
    </BrowserRouter>
  );
}

function Shell() {
  const [auth, setAuth] = useState<AuthState>({ loading: true, principal: null });
  const location = useLocation();

  useEffect(() => {
    if (!getApiKey()) {
      setAuth({ loading: false, principal: null });
      return;
    }
    api<Principal>('/auth/whoami')
      .then((p) => setAuth({ loading: false, principal: p }))
      .catch(() => setAuth({ loading: false, principal: null }));
  }, []);

  if (auth.loading) return <CenteredMessage>Loading…</CenteredMessage>;
  if (!auth.principal) return <Navigate to="/login" state={{ from: location }} replace />;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: theme.bg }}>
      <Sidebar principal={auth.principal} />
      <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        <Routes>
          <Route index element={<Dashboard principal={auth.principal} />} />
          <Route path="links" element={<LinksPage principal={auth.principal} />} />
          <Route path="commissions" element={<CommissionsPage principal={auth.principal} />} />
          <Route path="payouts" element={<PayoutsPage principal={auth.principal} />} />
          <Route path="connect" element={<ConnectPage principal={auth.principal} />} />
          {auth.principal.role === 'admin' && (
            <>
              <Route path="admin/partners" element={<AdminPartners />} />
              <Route path="admin/campaigns" element={<AdminCampaigns />} />
              <Route path="admin/review" element={<AdminReview />} />
              <Route path="admin/export" element={<AdminExport />} />
            </>
          )}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Sidebar({ principal }: { principal: Principal }) {
  const nav = useNavigate();
  return (
    <aside
      style={{
        width: 248,
        background: theme.sidebar,
        borderRight: `1px solid ${theme.borderSubtle}`,
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 14px',
      }}
    >
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', marginBottom: 20 }}>
        <Logo />
        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>OpenPartner</div>
      </div>

      {/* Principal chip */}
      <div
        style={{
          background: theme.surface,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: theme.radiusSm,
          padding: '10px 12px',
          marginBottom: 18,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: principal.role === 'admin' ? theme.accentSoft : '#1e2a3d',
            color: principal.role === 'admin' ? theme.accent : theme.info,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {principal.role === 'admin' ? 'A' : principal.partner?.name?.[0]?.toUpperCase() ?? 'P'}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {principal.partner?.name ?? (principal.role === 'admin' ? 'Admin' : 'Partner')}
          </div>
          <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {principal.role}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        <NavSection title="Yours">
          <NavItem to="/" icon={<LayoutDashboard size={16} />}>Dashboard</NavItem>
          <NavItem to="/links" icon={<Link2 size={16} />}>Links</NavItem>
          <NavItem to="/commissions" icon={<Receipt size={16} />}>Commissions</NavItem>
          <NavItem to="/payouts" icon={<Banknote size={16} />}>Payouts</NavItem>
          {principal.role === 'partner' && <NavItem to="/connect" icon={<CreditCard size={16} />}>Stripe Connect</NavItem>}
        </NavSection>

        {principal.role === 'admin' && (
          <NavSection title="Admin">
            <NavItem to="/admin/partners" icon={<Users size={16} />}>Partners</NavItem>
            <NavItem to="/admin/campaigns" icon={<Tag size={16} />}>Campaigns</NavItem>
            <NavItem to="/admin/review" icon={<ShieldCheck size={16} />}>Review queue</NavItem>
            <NavItem to="/admin/export" icon={<Download size={16} />}>Export / import</NavItem>
          </NavSection>
        )}
      </div>

      <button
        onClick={() => {
          clearApiKey();
          nav('/login');
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          marginTop: 14,
          background: 'transparent',
          color: theme.textMuted,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: theme.radiusSm,
          padding: '9px 12px',
          fontSize: 13,
          cursor: 'pointer',
          transition: 'all 120ms',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = theme.surface;
          e.currentTarget.style.color = theme.text;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = theme.textMuted;
        }}
      >
        <LogOut size={14} />
        Sign out
      </button>
    </aside>
  );
}

function NavSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: theme.textDim,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 600,
          padding: '0 8px 8px',
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{children}</div>
    </div>
  );
}

function NavItem({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  const location = useLocation();
  const active = location.pathname === to || (to !== '/' && location.pathname.startsWith(to));
  return (
    <Link
      to={to}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 6,
        background: active ? theme.surface : 'transparent',
        color: active ? theme.text : theme.textMuted,
        fontSize: 13.5,
        fontWeight: active ? 500 : 400,
        transition: 'all 120ms',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = theme.surface;
          e.currentTarget.style.color = theme.text;
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = theme.textMuted;
        }
      }}
    >
      <span style={{ display: 'inline-flex', color: active ? theme.accent : 'inherit' }}>{icon}</span>
      {children}
    </Link>
  );
}

function Logo() {
  return (
    <div
      style={{
        width: 26,
        height: 26,
        borderRadius: 8,
        background: `linear-gradient(135deg, ${theme.accent}, #0891b2)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: theme.accentInk,
        fontWeight: 700,
        fontSize: 14,
      }}
    >
      O
    </div>
  );
}

function LoginPage() {
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
      setErr(e instanceof ApiError && e.status === 401 ? 'That key didn\'t work.' : 'Could not reach the API.');
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: `radial-gradient(1200px 800px at 50% -20%, ${theme.accentSoft}40, transparent), ${theme.bg}`,
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          padding: 32,
          borderRadius: theme.radiusLg,
          width: 400,
          boxShadow: '0 30px 80px -30px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <Logo />
          <div style={{ fontSize: 18, fontWeight: 600 }}>OpenPartner</div>
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', marginBottom: 6 }}>Sign in</div>
        <div style={{ color: theme.textMuted, fontSize: 13, marginBottom: 24 }}>
          Paste your API key to continue.
        </div>
        <div style={{ position: 'relative' }}>
          <KeyRound
            size={15}
            style={{ position: 'absolute', left: 12, top: 12, color: theme.textDim, pointerEvents: 'none' }}
          />
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="op_..."
            autoFocus
            style={{
              width: '100%',
              padding: '10px 12px 10px 34px',
              fontSize: 14,
              background: theme.surface2,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radiusSm,
              color: theme.text,
              fontFamily: theme.fontMono,
            }}
          />
        </div>
        {err && (
          <div style={{ color: theme.danger, fontSize: 13, marginTop: 10 }}>{err}</div>
        )}
        <button
          type="submit"
          disabled={busy || !token}
          style={{
            marginTop: 16,
            width: '100%',
            padding: '10px 14px',
            background: theme.accent,
            color: theme.accentInk,
            border: 'none',
            borderRadius: theme.radiusSm,
            fontSize: 14,
            fontWeight: 600,
            cursor: busy || !token ? 'not-allowed' : 'pointer',
            opacity: busy || !token ? 0.5 : 1,
          }}
        >
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${theme.borderSubtle}`, color: theme.textDim, fontSize: 12, lineHeight: 1.6 }}>
          Admin keys come from <code style={{ color: theme.textMuted }}>ADMIN_API_KEY</code> in your env.
          <br />
          Partner keys are issued from <code style={{ color: theme.textMuted }}>Admin → Partners → Issue key</code>.
        </div>
      </form>
    </div>
  );
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        color: theme.textMuted,
      }}
    >
      {children}
    </div>
  );
}
