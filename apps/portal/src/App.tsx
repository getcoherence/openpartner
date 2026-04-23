import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { clearApiKey, getApiKey, setApiKey, api, type Principal, ApiError } from './api.js';
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
    <div style={{ fontFamily: 'system-ui', display: 'flex', minHeight: '100vh' }}>
      <Sidebar principal={auth.principal} />
      <main style={{ flex: 1, padding: 24, maxWidth: 1100 }}>
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
    <aside style={{ width: 220, background: '#111', color: '#eee', padding: '24px 16px' }}>
      <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 24 }}>OpenPartner</div>
      <div style={{ fontSize: 12, color: '#aaa', marginBottom: 16 }}>
        Signed in as <strong style={{ color: '#eee' }}>{principal.role}</strong>
        {principal.partner ? ` — ${principal.partner.name}` : ''}
      </div>
      <NavSection title="Yours">
        <NavItem to="/">Dashboard</NavItem>
        <NavItem to="/links">Links</NavItem>
        <NavItem to="/commissions">Commissions</NavItem>
        <NavItem to="/payouts">Payouts</NavItem>
        {principal.role === 'partner' && <NavItem to="/connect">Stripe Connect</NavItem>}
      </NavSection>
      {principal.role === 'admin' && (
        <NavSection title="Admin">
          <NavItem to="/admin/partners">Partners</NavItem>
          <NavItem to="/admin/campaigns">Campaigns</NavItem>
          <NavItem to="/admin/review">Review queue</NavItem>
          <NavItem to="/admin/export">Export / import</NavItem>
        </NavSection>
      )}
      <button
        onClick={() => {
          clearApiKey();
          nav('/login');
        }}
        style={{
          marginTop: 32,
          background: 'transparent',
          border: '1px solid #444',
          color: '#eee',
          padding: '8px 12px',
          borderRadius: 4,
          cursor: 'pointer',
          width: '100%',
        }}
      >
        Sign out
      </button>
    </aside>
  );
}

function NavSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  const location = useLocation();
  const active = location.pathname === to || (to !== '/' && location.pathname.startsWith(to));
  return (
    <Link
      to={to}
      style={{
        display: 'block',
        padding: '6px 10px',
        margin: '2px 0',
        borderRadius: 4,
        background: active ? '#333' : 'transparent',
        color: '#eee',
        textDecoration: 'none',
        fontSize: 14,
      }}
    >
      {children}
    </Link>
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
      setErr(e instanceof ApiError && e.status === 401 ? 'Invalid token' : 'Could not reach the API');
      setBusy(false);
    }
  }

  return (
    <div style={{ fontFamily: 'system-ui', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f5f5f5' }}>
      <form onSubmit={submit} style={{ background: 'white', padding: 32, borderRadius: 8, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', width: 380 }}>
        <h1 style={{ fontSize: 20, marginTop: 0, marginBottom: 4 }}>OpenPartner</h1>
        <p style={{ color: '#666', fontSize: 14, marginTop: 0, marginBottom: 20 }}>Sign in with your API key</p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="op_…"
          autoFocus
          style={{ width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid #ddd', borderRadius: 4, marginBottom: 12, fontFamily: 'ui-monospace, Menlo, monospace' }}
        />
        {err && <div style={{ color: 'crimson', fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <button
          type="submit"
          disabled={busy || !token}
          style={{ width: '100%', padding: '10px 12px', fontSize: 14, background: '#111', color: 'white', border: 'none', borderRadius: 4, cursor: busy ? 'wait' : 'pointer' }}
        >
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        <p style={{ color: '#999', fontSize: 12, marginTop: 16, marginBottom: 0 }}>
          Admin keys come from the <code>ADMIN_API_KEY</code> env var. Partner keys are issued via <code>POST /partners/:id/api-keys</code>.
        </p>
      </form>
    </div>
  );
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'system-ui', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: '#666' }}>
      {children}
    </div>
  );
}
