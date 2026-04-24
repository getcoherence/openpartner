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
  Compass,
  Package2,
  Inbox,
  Handshake,
  Store,
  Megaphone,
  Mail,
  UserCog,
} from 'lucide-react';
import { clearApiKey, getApiKey, api, type Principal } from './api.js';
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
import { DiscoverPage } from './pages/network/Discover.js';
import { MyRequestsPage } from './pages/network/MyRequests.js';
import { MyPartnershipsPage } from './pages/network/MyPartnerships.js';
import { VendorOfferingsPage } from './pages/network/VendorOfferings.js';
import { VendorRequestsPage } from './pages/network/VendorRequests.js';
import { AdminNetworkVendors } from './pages/network/AdminNetworkVendors.js';
import { AdminNetworkCreators } from './pages/network/AdminNetworkCreators.js';
import { LoginPage } from './pages/auth/Login.js';
import { SignupPage } from './pages/auth/Signup.js';
import { VendorSignupPage } from './pages/auth/VendorSignup.js';
import { MagicLandingPage } from './pages/auth/MagicLanding.js';
import { DevMailboxPage } from './pages/admin/DevMailbox.js';
import { OfferingDetailPage } from './pages/network/OfferingDetail.js';
import { CreatorProfilePage } from './pages/network/CreatorProfile.js';

interface AuthState {
  loading: boolean;
  principal: Principal | null;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/signup/vendor" element={<VendorSignupPage />} />
        <Route path="/auth/magic" element={<MagicLandingPage />} />
        <Route path="/*" element={<Shell />} />
      </Routes>
    </BrowserRouter>
  );
}

function Shell() {
  const [auth, setAuth] = useState<AuthState>({ loading: true, principal: null });
  const location = useLocation();

  useEffect(() => {
    // Always attempt /auth/whoami — it'll accept either the API-key
    // Bearer token (if present in localStorage) or the op_session cookie
    // from a magic-link sign-in.
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

          {/* Vendor-side OpenPartner (core attribution) */}
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
              <Route path="admin/dev-mailbox" element={<DevMailboxPage />} />
              <Route path="network/vendors" element={<AdminNetworkVendors />} />
              <Route path="network/creators" element={<AdminNetworkCreators />} />
            </>
          )}

          {/* OpenPartner Network — creator-side */}
          <Route path="network/discover" element={<DiscoverPage principal={auth.principal} />} />
          <Route path="network/offerings/:id" element={<OfferingDetailPage principal={auth.principal} />} />
          <Route path="network/requests" element={<MyRequestsPage principal={auth.principal} />} />
          <Route path="network/partnerships" element={<MyPartnershipsPage principal={auth.principal} />} />
          <Route path="network/profile" element={<CreatorProfilePage />} />

          {/* OpenPartner Network — vendor-side */}
          <Route path="network/offerings" element={<VendorOfferingsPage />} />
          <Route path="network/incoming" element={<VendorRequestsPage />} />

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

      <PrincipalChip principal={principal} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        {/* Core attribution nav — shown to admin + partner */}
        {(principal.role === 'admin' || principal.role === 'partner') && (
          <NavSection title="Yours">
            <NavItem to="/" icon={<LayoutDashboard size={16} />}>Dashboard</NavItem>
            <NavItem to="/links" icon={<Link2 size={16} />}>Links</NavItem>
            <NavItem to="/commissions" icon={<Receipt size={16} />}>Commissions</NavItem>
            <NavItem to="/payouts" icon={<Banknote size={16} />}>Payouts</NavItem>
            {principal.role === 'partner' && <NavItem to="/connect" icon={<CreditCard size={16} />}>Stripe Connect</NavItem>}
          </NavSection>
        )}

        {principal.role === 'admin' && (
          <>
            <NavSection title="Admin">
              <NavItem to="/admin/partners" icon={<Users size={16} />}>Partners</NavItem>
              <NavItem to="/admin/campaigns" icon={<Tag size={16} />}>Campaigns</NavItem>
              <NavItem to="/admin/review" icon={<ShieldCheck size={16} />}>Review queue</NavItem>
              <NavItem to="/admin/export" icon={<Download size={16} />}>Export / import</NavItem>
              <NavItem to="/admin/dev-mailbox" icon={<Mail size={16} />}>Dev mailbox</NavItem>
            </NavSection>
            <NavSection title="Network">
              <NavItem to="/network/vendors" icon={<Store size={16} />}>Vendors</NavItem>
              <NavItem to="/network/creators" icon={<Megaphone size={16} />}>Creators</NavItem>
              <NavItem to="/network/discover" icon={<Compass size={16} />}>Discover</NavItem>
            </NavSection>
          </>
        )}

        {principal.role === 'network_vendor' && (
          <NavSection title="Vendor">
            <NavItem to="/network/offerings" icon={<Package2 size={16} />}>Offerings</NavItem>
            <NavItem to="/network/incoming" icon={<Inbox size={16} />}>Incoming requests</NavItem>
            <NavItem to="/network/partnerships" icon={<Handshake size={16} />}>Partnerships</NavItem>
            <NavItem to="/network/discover" icon={<Compass size={16} />}>Discover creators</NavItem>
          </NavSection>
        )}

        {principal.role === 'network_creator' && (
          <NavSection title="Creator">
            <NavItem to="/network/discover" icon={<Compass size={16} />}>Discover</NavItem>
            <NavItem to="/network/requests" icon={<Inbox size={16} />}>My requests</NavItem>
            <NavItem to="/network/partnerships" icon={<Handshake size={16} />}>Partnerships</NavItem>
            <NavItem to="/network/profile" icon={<UserCog size={16} />}>Profile</NavItem>
          </NavSection>
        )}
      </div>

      <button
        onClick={async () => {
          clearApiKey();
          // Fire-and-forget — server-side revokes the session if we have
          // one; if we're only signing out of an API-key session, the
          // server ignores the missing cookie and responds 200.
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
    return { label: 'Admin', sublabel: 'admin', initial: 'A', hue: { bg: theme.accentSoft, fg: theme.accent } };
  }
  if (p.role === 'partner') {
    return {
      label: p.partner?.name ?? 'Partner',
      sublabel: 'partner',
      initial: p.partner?.name?.[0]?.toUpperCase() ?? 'P',
      hue: { bg: '#1e2a3d', fg: theme.info },
    };
  }
  if (p.role === 'network_vendor') {
    return {
      label: p.vendor?.name ?? 'Vendor',
      sublabel: 'vendor',
      initial: p.vendor?.name?.[0]?.toUpperCase() ?? 'V',
      hue: { bg: '#2a2018', fg: theme.warn },
    };
  }
  return {
    label: p.creator?.name ?? 'Creator',
    sublabel: 'creator',
    initial: p.creator?.name?.[0]?.toUpperCase() ?? 'C',
    hue: { bg: '#2a1a2a', fg: '#e879f9' },
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
