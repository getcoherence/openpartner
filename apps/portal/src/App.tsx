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
  Webhook,
  Settings,
  Mail,
  UserCog,
  Globe,
  Megaphone,
  Inbox,
} from 'lucide-react';
import { clearApiKey, api, type Principal } from './api.js';
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
import { LoginPage } from './pages/auth/Login.js';
import { MagicLandingPage } from './pages/auth/MagicLanding.js';
import { WebhooksPage } from './pages/admin/Webhooks.js';
import { AdminSettings } from './pages/admin/Settings.js';
import { AdminAdmins } from './pages/admin/Admins.js';
import { AdminNetwork } from './pages/admin/Network.js';
import { AdminNetworkComplete } from './pages/admin/NetworkComplete.js';
import { AdminNetworkOfferings } from './pages/admin/NetworkOfferings.js';
import { AdminNetworkRequests } from './pages/admin/NetworkRequests.js';
import { AdminNetworkBilling } from './pages/admin/NetworkBilling.js';
import { DiscoverPage } from './pages/partner/Discover.js';
import { OfferingDetailPage } from './pages/partner/OfferingDetail.js';
import { VendorDetailPage } from './pages/partner/VendorDetail.js';
import { MyAffiliationsPage } from './pages/partner/MyAffiliations.js';
import { MyRequestsPage } from './pages/partner/MyRequests.js';
import { MyProfilePage } from './pages/partner/MyProfile.js';
import { InstallPage } from './pages/Install.js';
import { FraudReviewPage } from './pages/FraudReview.js';
import { useQuery } from '@tanstack/react-query';

interface AuthState {
  loading: boolean;
  principal: Principal | null;
}

interface InstallStatus {
  needsSetup: boolean;
}

export function App() {
  // First-run gate: hit the install-status probe once at app boot. While
  // zero admins are activated we route everything (except the magic
  // landing, which is how the installer's own link works) to /install.
  const install = useQuery({
    queryKey: ['install-status'],
    // Public endpoint — no auth required. Hand-rolled fetch so we don't
    // drag the api() function through auth-cleanup on 401.
    queryFn: async () => {
      const r = await fetch('/api/install/status');
      return (await r.json()) as InstallStatus;
    },
    staleTime: Infinity,
  });

  if (install.isLoading) return null;
  const needsSetup = install.data?.needsSetup ?? false;

  return (
    <BrowserRouter>
      <Routes>
        {needsSetup ? (
          <>
            <Route path="/install" element={<InstallPage />} />
            <Route path="/auth/magic" element={<MagicLandingPage />} />
            <Route path="*" element={<Navigate to="/install" replace />} />
          </>
        ) : (
          <>
            <Route path="/install" element={<Navigate to="/" replace />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/magic" element={<MagicLandingPage />} />
            <Route path="/*" element={<Shell />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
  );
}

function Shell() {
  const [auth, setAuth] = useState<AuthState>({ loading: true, principal: null });
  const location = useLocation();

  useEffect(() => {
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

          {/* Network discovery — open to anyone signed in (vendor admin can browse too). */}
          <Route path="network/discover" element={<DiscoverPage />} />
          <Route path="network/offerings/:id" element={<OfferingDetailPage principal={auth.principal} />} />
          <Route path="network/vendors/:id" element={<VendorDetailPage />} />

          {/* Partner-only Network surfaces. */}
          {auth.principal.role === 'partner' && (
            <>
              <Route path="network/affiliations" element={<MyAffiliationsPage />} />
              <Route path="network/requests" element={<MyRequestsPage />} />
              <Route path="network/profile" element={<MyProfilePage />} />
            </>
          )}

          {auth.principal.role === 'admin' && (
            <>
              <Route path="admin/partners" element={<AdminPartners />} />
              <Route path="admin/campaigns" element={<AdminCampaigns />} />
              <Route path="admin/review" element={<AdminReview />} />
              <Route path="admin/export" element={<AdminExport />} />
              <Route path="admin/fraud-review" element={<FraudReviewPage />} />
              <Route path="admin/webhooks" element={<WebhooksPage />} />
              <Route path="admin/admins" element={<AdminAdmins />} />
              <Route path="admin/settings" element={<AdminSettings />} />
              <Route path="admin/network" element={<AdminNetwork />} />
              <Route path="admin/network/complete" element={<AdminNetworkComplete />} />
              <Route path="admin/network/offerings" element={<AdminNetworkOfferings />} />
              <Route path="admin/network/requests" element={<AdminNetworkRequests />} />
              <Route path="admin/network/billing" element={<AdminNetworkBilling />} />
            </>
          )}

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

interface ProgramSettings {
  programName: string | null;
  supportEmail: string | null;
}

function Sidebar({ principal }: { principal: Principal }) {
  const nav = useNavigate();
  const settings = useQuery({
    queryKey: ['program-settings'],
    queryFn: () => api<ProgramSettings>('/config/program'),
    // Refetch infrequently — admin rarely changes this.
    staleTime: 60_000,
  });
  const programName = settings.data?.programName || 'OpenPartner';
  const supportEmail = settings.data?.supportEmail || null;

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', marginBottom: 20 }}>
        <Logo />
        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{programName}</div>
      </div>

      <PrincipalChip principal={principal} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        <NavSection title="Yours">
          <NavItem to="/" icon={<LayoutDashboard size={16} />}>Dashboard</NavItem>
          <NavItem to="/links" icon={<Link2 size={16} />}>Links</NavItem>
          <NavItem to="/commissions" icon={<Receipt size={16} />}>Commissions</NavItem>
          <NavItem to="/payouts" icon={<Banknote size={16} />}>Payouts</NavItem>
          {principal.role === 'partner' && <NavItem to="/connect" icon={<CreditCard size={16} />}>Stripe Connect</NavItem>}
        </NavSection>

        {principal.role === 'partner' && (
          <NavSection title="Network">
            <NavItem to="/network/discover" icon={<Globe size={16} />}>Discover programs</NavItem>
            <NavItem to="/network/affiliations" icon={<Megaphone size={16} />}>My partnerships</NavItem>
            <NavItem to="/network/requests" icon={<Inbox size={16} />}>My applications</NavItem>
            <NavItem to="/network/profile" icon={<UserCog size={16} />}>Network profile</NavItem>
          </NavSection>
        )}

        {principal.role === 'admin' && (
          <NavSection title="Admin">
            <NavItem to="/admin/partners" icon={<Users size={16} />}>Partners</NavItem>
            <NavItem to="/admin/campaigns" icon={<Tag size={16} />}>Campaigns</NavItem>
            <NavItem to="/admin/review" icon={<ShieldCheck size={16} />}>Review queue</NavItem>
            <NavItem to="/admin/export" icon={<Download size={16} />}>Export / import</NavItem>
            <NavItem to="/admin/fraud-review" icon={<ShieldCheck size={16} />}>Fraud review</NavItem>
            <NavItem to="/admin/webhooks" icon={<Webhook size={16} />}>Webhooks</NavItem>
            <NavItem to="/admin/admins" icon={<UserCog size={16} />}>Admins</NavItem>
            <NavItem to="/admin/settings" icon={<Settings size={16} />}>Settings</NavItem>
          </NavSection>
        )}

        {principal.role === 'admin' && (
          <NavSection title="Network">
            <NavItem to="/admin/network" icon={<Globe size={16} />}>Connection</NavItem>
            <NavItem to="/admin/network/offerings" icon={<Megaphone size={16} />}>Offerings</NavItem>
            <NavItem to="/admin/network/requests" icon={<Inbox size={16} />}>Requests</NavItem>
            <NavItem to="/admin/network/billing" icon={<CreditCard size={16} />}>Billing</NavItem>
          </NavSection>
        )}
      </div>

      <button
        onClick={async () => {
          clearApiKey();
          // Fire-and-forget — server-side revokes the session. If we're
          // signed in via API key only, the server sees no cookie and
          // just returns 200.
          try {
            await api('/auth/signout', { method: 'POST' });
          } catch {
            /* ignore */
          }
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

      {supportEmail && (
        <a
          href={`mailto:${supportEmail}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            justifyContent: 'center',
            marginTop: 10,
            color: theme.textDim,
            fontSize: 12,
            textDecoration: 'none',
          }}
        >
          <Mail size={11} />
          {supportEmail}
        </a>
      )}
    </aside>
  );
}

function PrincipalChip({ principal }: { principal: Principal }) {
  const { label, sublabel, initial, hue } = describePrincipal(principal);
  return (
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
          background: hue.bg,
          color: hue.fg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {initial}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
        <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{sublabel}</div>
      </div>
    </div>
  );
}

function describePrincipal(p: Principal): { label: string; sublabel: string; initial: string; hue: { bg: string; fg: string } } {
  if (p.role === 'admin') {
    const name = p.admin?.name ?? 'Admin';
    return {
      label: name,
      sublabel: p.source === 'env' ? 'admin (env)' : 'admin',
      initial: name[0]?.toUpperCase() ?? 'A',
      hue: { bg: theme.accentSoft, fg: theme.accent },
    };
  }
  return {
    label: p.partner?.name ?? 'Partner',
    sublabel: 'partner',
    initial: p.partner?.name?.[0]?.toUpperCase() ?? 'P',
    hue: { bg: '#1e2a3d', fg: theme.info },
  };
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

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: theme.textMuted }}>
      {children}
    </div>
  );
}
