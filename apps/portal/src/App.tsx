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
  ChevronRight,
} from 'lucide-react';
import { clearApiKey, api, type Principal } from './api.js';
import { useTenantBase } from './tenant-base.js';
import { theme } from './theme.js';
import { Dashboard } from './pages/Dashboard.js';
import { LinksPage } from './pages/Links.js';
import { CommissionsPage } from './pages/Commissions.js';
import { PayoutsPage } from './pages/Payouts.js';
import { ConnectPage } from './pages/Connect.js';
import { AdminPartners } from './pages/AdminPartners.js';
import { AdminPartnerPrograms } from './pages/AdminPartnerPrograms.js';
import { AdminPartnerCoupons } from './pages/AdminPartnerCoupons.js';
import { AdminCampaigns } from './pages/AdminCampaigns.js';
import { AdminReview } from './pages/AdminReview.js';
import { AdminExport } from './pages/AdminExport.js';
import { LoginPage } from './pages/auth/Login.js';
import { MagicLandingPage } from './pages/auth/MagicLanding.js';
import { WebhooksPage } from './pages/admin/Webhooks.js';
import { AdminSettings } from './pages/admin/Settings.js';
import { AdminBilling } from './pages/admin/Billing.js';
import { AdminAdmins } from './pages/admin/Admins.js';
import { AdminNetwork } from './pages/admin/Network.js';
import { AdminNetworkComplete } from './pages/admin/NetworkComplete.js';
import { AdminNetworkOfferings } from './pages/admin/NetworkOfferings.js';
import { AdminNetworkRequests } from './pages/admin/NetworkRequests.js';
import { AdminNetworkCreators } from './pages/admin/NetworkCreators.js';
import { AdminNetworkBilling } from './pages/admin/NetworkBilling.js';
import { DiscoverPage } from './pages/partner/Discover.js';
import { OfferingDetailPage } from './pages/partner/OfferingDetail.js';
import { VendorDetailPage } from './pages/partner/VendorDetail.js';
import { MyAffiliationsPage } from './pages/partner/MyAffiliations.js';
import { MyRequestsPage } from './pages/partner/MyRequests.js';
import { MyProfilePage } from './pages/partner/MyProfile.js';
import { InstallPage } from './pages/Install.js';
import { LandingPage } from './pages/Landing.js';
import { SignupPage } from './pages/Signup.js';
import { SigninPage } from './pages/Signin.js';
import { WorkspacesPage } from './pages/Workspaces.js';
import { PlatformMagicLandingPage } from './pages/auth/PlatformMagicLanding.js';
import { CreatorSignupPage } from './pages/creator/CreatorSignup.js';
import { CreatorSigninPage } from './pages/creator/CreatorSignin.js';
import { CreatorMagicLandingPage } from './pages/creator/CreatorMagicLanding.js';
import { CreatorShell } from './pages/creator/CreatorShell.js';
import { CreatorPublicProfilePage } from './pages/creator/CreatorPublicProfile.js';
import { FraudReviewPage } from './pages/FraudReview.js';
import { useQuery } from '@tanstack/react-query';

interface AuthState {
  loading: boolean;
  principal: Principal | null;
}

interface InstallStatus {
  needsSetup: boolean;
  reason?: 'multi_tenant';
}

export function App() {
  // First-run gate. Three modes the probe can return:
  //   { needsSetup: true }                     — single-tenant, no admin yet
  //   { needsSetup: false }                    — single-tenant, ready
  //   { needsSetup: false, reason: 'multi_tenant' } — multi-tenant deploy
  //
  // Multi-tenant flips the routing entirely: root is the public landing,
  // /signup creates a tenant, and the Shell only mounts under /t/<slug>/.
  const install = useQuery({
    queryKey: ['install-status'],
    queryFn: async () => {
      const r = await fetch('/api/install/status');
      return (await r.json()) as InstallStatus;
    },
    staleTime: Infinity,
  });

  if (install.isLoading) return null;
  const needsSetup = install.data?.needsSetup ?? false;
  const isMultiTenant = install.data?.reason === 'multi_tenant';

  return (
    <BrowserRouter>
      <Routes>
        {isMultiTenant ? (
          <>
            <Route path="/" element={<LandingPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/signin" element={<SigninPage />} />
            <Route path="/workspaces" element={<WorkspacesPage />} />
            {/* Platform-identity magic link (one email regardless of how many brands you admin). */}
            <Route path="/auth/magic" element={<PlatformMagicLandingPage />} />
            {/* Platform-level Creator surfaces — separate auth from vendor admins. */}
            <Route path="/creator/signup" element={<CreatorSignupPage />} />
            <Route path="/creator/login" element={<CreatorSigninPage />} />
            <Route path="/creator/auth/magic" element={<CreatorMagicLandingPage />} />
            <Route path="/creator/*" element={<CreatorShell />} />
            {/* Public creator profiles — no auth, browsable from anywhere. */}
            <Route path="/creators/:handle" element={<CreatorPublicProfilePage />} />
            <Route path="/t/:slug/login" element={<LoginPage />} />
            <Route path="/t/:slug/auth/magic" element={<MagicLandingPage />} />
            <Route path="/t/:slug/*" element={<Shell />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        ) : needsSetup ? (
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
  const tenantBase = useTenantBase();

  useEffect(() => {
    api<Principal>('/auth/whoami')
      .then((p) => setAuth({ loading: false, principal: p }))
      .catch(() => setAuth({ loading: false, principal: null }));
  }, []);

  if (auth.loading) return <CenteredMessage>Loading…</CenteredMessage>;
  if (!auth.principal) return <Navigate to={`${tenantBase}/login`} state={{ from: location }} replace />;

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
              <Route path="admin/partners/:id/programs" element={<AdminPartnerPrograms />} />
              <Route path="admin/partners/:id/coupons" element={<AdminPartnerCoupons />} />
              <Route path="admin/campaigns" element={<AdminCampaigns />} />
              <Route path="admin/review" element={<AdminReview />} />
              <Route path="admin/export" element={<AdminExport />} />
              <Route path="admin/fraud-review" element={<FraudReviewPage />} />
              <Route path="admin/webhooks" element={<WebhooksPage />} />
              <Route path="admin/admins" element={<AdminAdmins />} />
              <Route path="admin/settings" element={<AdminSettings />} />
              <Route path="admin/billing" element={<AdminBilling />} />
              <Route path="admin/network" element={<AdminNetwork />} />
              <Route path="admin/network/complete" element={<AdminNetworkComplete />} />
              <Route path="admin/network/offerings" element={<AdminNetworkOfferings />} />
              <Route path="admin/network/requests" element={<AdminNetworkRequests />} />
              <Route path="admin/network/creators" element={<AdminNetworkCreators />} />
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
  logoUrl: string | null;
}

function Sidebar({ principal }: { principal: Principal }) {
  const nav = useNavigate();
  const tenantBase = useTenantBase();
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
        // Sticky + 100vh pins the aside to the viewport so the middle
        // nav's overflow:auto actually scrolls. Without this, the
        // aside would grow with the main content and the inner overflow
        // would never trigger.
        width: 248,
        height: '100vh',
        position: 'sticky',
        top: 0,
        background: theme.sidebar,
        borderRight: `1px solid ${theme.borderSubtle}`,
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', marginBottom: 20 }}>
        {settings.data?.logoUrl ? (
          <img
            src={settings.data.logoUrl}
            alt={programName}
            style={{ width: 26, height: 26, borderRadius: 6, objectFit: 'contain', background: theme.surface2 }}
          />
        ) : (
          <Logo />
        )}
        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{programName}</div>
      </div>

      <PrincipalChip principal={principal} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        {/* Top-level nav — no header, always visible. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <NavItem to="/" icon={<LayoutDashboard size={16} />}>Dashboard</NavItem>
          <NavItem to="/links" icon={<Link2 size={16} />}>Links</NavItem>
          <NavItem to="/commissions" icon={<Receipt size={16} />}>Commissions</NavItem>
          <NavItem to="/payouts" icon={<Banknote size={16} />}>Payouts</NavItem>
          {principal.role === 'partner' && <NavItem to="/connect" icon={<CreditCard size={16} />}>Stripe Connect</NavItem>}
        </div>

        {principal.role === 'partner' && (
          <NavSection title="Network" collapsible storageKey="partner-network">
            <NavItem to="/network/discover" icon={<Globe size={16} />}>Discover programs</NavItem>
            <NavItem to="/network/affiliations" icon={<Megaphone size={16} />}>My partnerships</NavItem>
            <NavItem to="/network/requests" icon={<Inbox size={16} />}>My applications</NavItem>
            <NavItem to="/network/profile" icon={<UserCog size={16} />}>Network profile</NavItem>
          </NavSection>
        )}

        {principal.role === 'admin' && (
          <NavSection title="Admin" collapsible storageKey="admin-admin">
            <NavItem to="/admin/partners" icon={<Users size={16} />}>Partners</NavItem>
            <NavItem to="/admin/campaigns" icon={<Tag size={16} />}>Campaigns</NavItem>
            <NavItem to="/admin/review" icon={<ShieldCheck size={16} />}>Review queue</NavItem>
            <NavItem to="/admin/export" icon={<Download size={16} />}>Export / import</NavItem>
            <NavItem to="/admin/fraud-review" icon={<ShieldCheck size={16} />}>Fraud review</NavItem>
            <NavItem to="/admin/webhooks" icon={<Webhook size={16} />}>Webhooks</NavItem>
            <NavItem to="/admin/admins" icon={<UserCog size={16} />}>Admins</NavItem>
            <NavItem to="/admin/settings" icon={<Settings size={16} />}>Settings</NavItem>
            <NavItem to="/admin/billing" icon={<CreditCard size={16} />}>Billing</NavItem>
          </NavSection>
        )}

        {principal.role === 'admin' && <NetworkNav />}
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
          nav(`${tenantBase}/login`);
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

function NavSection({
  title,
  collapsible,
  storageKey,
  children,
}: {
  title: string;
  collapsible?: boolean;
  /** Required when collapsible — disambiguates sections that share a
   *  title (e.g. partner-side vs brand-side "Network"). Persists the
   *  open/closed state across page reloads. */
  storageKey?: string;
  children: ReactNode;
}) {
  // Default closed when collapsible — matches the user's stated
  // preference. localStorage persists per storageKey across reloads.
  const lsKey = storageKey ? `op:nav-collapsed:${storageKey}` : null;
  const [collapsed, setCollapsed] = useState(() => {
    if (!collapsible) return false;
    if (typeof window === 'undefined' || !lsKey) return true;
    const raw = window.localStorage.getItem(lsKey);
    if (raw === '0') return false;
    if (raw === '1') return true;
    return true; // default-collapsed when no preference yet
  });
  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      if (lsKey && typeof window !== 'undefined') {
        window.localStorage.setItem(lsKey, next ? '1' : '0');
      }
      return next;
    });
  }

  const headerCommonStyle: React.CSSProperties = {
    fontSize: 11,
    color: theme.textDim,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 600,
    padding: '0 8px 8px',
  };

  return (
    <div>
      {collapsible ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          style={{
            ...headerCommonStyle,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            // Only inherit font-family — the `font` shorthand would
            // reset fontSize/letterSpacing/fontWeight back to the UA
            // defaults (16px) and undo the headerCommonStyle spread.
            fontFamily: 'inherit',
          }}
        >
          <ChevronRight
            size={11}
            style={{
              transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
              transition: 'transform 100ms ease',
            }}
          />
          {title}
        </button>
      ) : (
        <div style={headerCommonStyle}>{title}</div>
      )}
      {!collapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{children}</div>
      )}
    </div>
  );
}

/** Network sidebar section. We only surface Offerings / Requests /
 *  Billing once the brand is connected — those pages all error out if
 *  there's no vendorToken, and showing dead nav entries is just noise.
 *  Connection itself stays visible so the admin can come back to wire
 *  it up. */
function NetworkNav() {
  const { data } = useQuery({
    queryKey: ['network-membership'],
    queryFn: () => api<{ enabled: boolean; hasVendorToken: boolean }>('/config/network'),
    staleTime: 60_000,
    retry: false,
  });
  const connected = !!(data?.enabled && data.hasVendorToken);
  return (
    <NavSection title="Network" collapsible storageKey="admin-network">
      <NavItem to="/admin/network" icon={<Globe size={16} />}>{connected ? 'Connection' : 'Get connected'}</NavItem>
      {connected && (
        <>
          <NavItem to="/admin/network/offerings" icon={<Megaphone size={16} />}>Offerings</NavItem>
          <NavItem to="/admin/network/requests" icon={<Inbox size={16} />}>Requests</NavItem>
          <NavItem to="/admin/network/creators" icon={<Users size={16} />}>Discover creators</NavItem>
          <NavItem to="/admin/network/billing" icon={<CreditCard size={16} />}>Billing</NavItem>
        </>
      )}
    </NavSection>
  );
}

function NavItem({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  const location = useLocation();
  const tenantBase = useTenantBase();
  const href = to.startsWith('/') ? `${tenantBase}${to === '/' ? '' : to}` || '/' : to;
  const active = location.pathname === href || (href !== '/' && location.pathname.startsWith(href));
  return (
    <Link
      to={href}
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

function Logo({ size = 26 }: { size?: number } = {}) {
  return (
    <img
      src="/logo-mark-green.svg"
      alt="OpenPartner"
      width={size}
      height={size}
      style={{ display: 'block' }}
    />
  );
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: theme.textMuted }}>
      {children}
    </div>
  );
}
