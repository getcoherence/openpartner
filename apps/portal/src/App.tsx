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
  ChevronsUpDown,
  Check,
  Plus,
  X,
  Menu,
  Palette,
  AlertTriangle,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { clearApiKey, api, type Principal } from './api.js';
import { useTenantBase } from './tenant-base.js';
import { theme } from './theme.js';
import { useIsMobile } from './lib/useMediaQuery.js';
import { useBrand, usePublicBrand } from './lib/useBrand.js';
import { Dashboard } from './pages/Dashboard.js';
import { LinksPage } from './pages/Links.js';
import { CommissionsPage } from './pages/Commissions.js';
import { PayoutsPage } from './pages/Payouts.js';
import { ConnectPage } from './pages/Connect.js';
import { AdminPartners } from './pages/AdminPartners.js';
import { AdminPartnerPrograms } from './pages/AdminPartnerPrograms.js';
import { AdminPartnerCoupons } from './pages/AdminPartnerCoupons.js';
import { AdminPartnerCommission } from './pages/AdminPartnerCommission.js';
import { AdminPrograms } from './pages/AdminPrograms.js';
import { AdminReview } from './pages/AdminReview.js';
import { AdminExport } from './pages/AdminExport.js';
import { LoginPage } from './pages/auth/Login.js';
import { MagicLandingPage } from './pages/auth/MagicLanding.js';
import { WebhooksPage } from './pages/admin/Webhooks.js';
import { AdminIntegrations } from './pages/admin/Integrations.js';
import { AdminSettings } from './pages/admin/Settings.js';
import { AdminBilling } from './pages/admin/Billing.js';
import { AdminWhiteLabel } from './pages/admin/WhiteLabel.js';
import { AdminAdmins } from './pages/admin/Admins.js';
import { AdminNetwork } from './pages/admin/Network.js';
import { AdminNetworkComplete } from './pages/admin/NetworkComplete.js';
import { AdminNetworkRequests } from './pages/admin/NetworkRequests.js';
import { AdminNetworkCreators } from './pages/admin/NetworkCreators.js';
import { AdminNetworkBilling } from './pages/admin/NetworkBilling.js';
import { DiscoverPage } from './pages/partner/Discover.js';
import { OfferingDetailPage } from './pages/partner/OfferingDetail.js';
import { VendorDetailPage } from './pages/partner/VendorDetail.js';
import { MyAffiliationsPage } from './pages/partner/MyAffiliations.js';
import { MyRequestsPage } from './pages/partner/MyRequests.js';
import { MyProfilePage } from './pages/partner/MyProfile.js';
import { PartnerPostbacksPage } from './pages/partner/Postbacks.js';
import { InstallPage } from './pages/Install.js';
import { LandingPage } from './pages/Landing.js';
import { SignupPage } from './pages/Signup.js';
import { SigninPage } from './pages/Signin.js';
import { WorkspacesPage } from './pages/Workspaces.js';
import { AddBrandPage } from './pages/AddBrand.js';
import { PartnerJoinPage } from './pages/PartnerJoin.js';
import { BrandDocument } from './lib/BrandDocument.js';
import { PlatformMagicLandingPage } from './pages/auth/PlatformMagicLanding.js';
import { PlatformLoginPage } from './pages/platform/PlatformLogin.js';
import { PlatformAuthPage } from './pages/platform/PlatformAuth.js';
import { PlatformConsole } from './pages/platform/PlatformConsole.js';
import { CreatorSignupPage } from './pages/creator/CreatorSignup.js';
import { CreatorSigninPage } from './pages/creator/CreatorSignin.js';
import { CreatorMagicLandingPage } from './pages/creator/CreatorMagicLanding.js';
import { CreatorShell } from './pages/creator/CreatorShell.js';
import { CreatorPublicProfilePage } from './pages/creator/CreatorPublicProfile.js';
import { FraudReviewPage } from './pages/FraudReview.js';

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

  // White-label custom-domain probe. On portal.<tenant>.com the API
  // resolves the tenant from the Host header, so a PREFIX-LESS /api/branding
  // returns the tenant's slug — on the platform origin it returns null.
  // A host-resolved tenant means the whole origin belongs to that tenant:
  // mount the Shell at root (like single-tenant) instead of the platform
  // landing/signup table, so emailed links to /auth/magic and deep links
  // like /admin/billing work without a /t/<slug>/ prefix.
  const isMultiTenant = install.data?.reason === 'multi_tenant';
  const hostBrand = useQuery({
    queryKey: ['host-tenant-probe'],
    enabled: isMultiTenant,
    queryFn: async () => {
      const r = await fetch('/api/branding', { credentials: 'include' });
      if (!r.ok) return { tenantSlug: null };
      return (await r.json()) as { tenantSlug: string | null };
    },
    staleTime: Infinity,
  });

  if (install.isLoading) return null;
  if (isMultiTenant && hostBrand.isPending) return null;
  const needsSetup = install.data?.needsSetup ?? false;
  const hostTenantSlug = isMultiTenant ? (hostBrand.data?.tenantSlug ?? null) : null;

  return (
    <BrowserRouter>
      <BrandDocument />
      <Routes>
        {isMultiTenant && hostTenantSlug ? (
          <>
            {/* Custom-domain origin — the whole host is one tenant. */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/join" element={<PartnerJoinPage />} />
            <Route path="/auth/magic" element={<MagicLandingPage />} />
            <Route path="/*" element={<Shell />} />
          </>
        ) : isMultiTenant ? (
          <>
            <Route path="/" element={<LandingPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/signin" element={<SigninPage />} />
            <Route path="/workspaces" element={<WorkspacesPage />} />
            <Route path="/brands/new" element={<AddBrandPage />} />
            {/* Platform-identity magic link (one email regardless of how many brands you admin). */}
            <Route path="/auth/magic" element={<PlatformMagicLandingPage />} />
            {/* Platform-ops console — OpenPartner staff, separate operator session. */}
            <Route path="/platform/login" element={<PlatformLoginPage />} />
            <Route path="/platform/auth" element={<PlatformAuthPage />} />
            <Route path="/platform/*" element={<PlatformConsole />} />
            {/* Platform-level Creator surfaces — separate auth from vendor admins. */}
            <Route path="/creator/signup" element={<CreatorSignupPage />} />
            <Route path="/creator/login" element={<CreatorSigninPage />} />
            <Route path="/creator/auth/magic" element={<CreatorMagicLandingPage />} />
            <Route path="/creator/*" element={<CreatorShell />} />
            {/* Public creator profiles — no auth, browsable from anywhere. */}
            <Route path="/creators/:handle" element={<CreatorPublicProfilePage />} />
            <Route path="/t/:slug/login" element={<LoginPage />} />
            <Route path="/t/:slug/join" element={<PartnerJoinPage />} />
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
            <Route path="/join" element={<PartnerJoinPage />} />
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
  const isMobile = useIsMobile();
  // White-label tenants are isolated from the shared Network — gate the
  // Network/Discover routes on this so direct navigation can't reach them
  // even though the nav links are also hidden.
  const { whiteLabel } = useBrand();
  // Brand approval gate: /branding carries the tenant's approvalStatus.
  // usePublicBrand hits it through api() so it's tenant-scoped under the
  // /t/<slug>/ prefix (a prefix-less fetch would resolve to the platform
  // origin and never see the tenant's status).
  const { approvalStatus } = usePublicBrand();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reviewBannerDismissed, setReviewBannerDismissed] = useState(false);

  useEffect(() => {
    api<Principal>('/auth/whoami')
      .then((p) => setAuth({ loading: false, principal: p }))
      .catch(() => setAuth({ loading: false, principal: null }));
  }, []);

  // Close the drawer whenever the route changes — a NavItem tap navigates,
  // which should dismiss the overlay. Also covers backdrop/programmatic nav.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  if (auth.loading) return <CenteredMessage>Loading…</CenteredMessage>;
  if (!auth.principal) return <Navigate to={`${tenantBase}/login`} state={{ from: location }} replace />;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: theme.bg }}>
      {isMobile ? (
        <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
          <Sidebar principal={auth.principal} variant="drawer" />
        </MobileDrawer>
      ) : (
        <Sidebar principal={auth.principal} />
      )}
      <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        {isMobile && <MobileTopBar onMenu={() => setDrawerOpen(true)} />}
        {auth.principal.role === 'admin' && approvalStatus === 'pending' && !reviewBannerDismissed && (
          <PendingReviewBanner isMobile={isMobile} onDismiss={() => setReviewBannerDismissed(true)} />
        )}
        <Routes>
          <Route index element={<Dashboard principal={auth.principal} />} />

          <Route path="links" element={<LinksPage principal={auth.principal} />} />
          <Route path="commissions" element={<CommissionsPage principal={auth.principal} />} />
          <Route path="payouts" element={<PayoutsPage principal={auth.principal} />} />
          <Route path="connect" element={<ConnectPage principal={auth.principal} />} />

          {/* Network discovery — open to anyone signed in (vendor admin can
              browse too). Hidden entirely for white-label tenants. */}
          {!whiteLabel && (
            <>
              <Route path="network/discover" element={<DiscoverPage />} />
              <Route path="network/offerings/:id" element={<OfferingDetailPage principal={auth.principal} />} />
              <Route path="network/vendors/:id" element={<VendorDetailPage />} />
            </>
          )}

          {/* Partner-only Network surfaces. */}
          {auth.principal.role === 'partner' && (
            <>
              {!whiteLabel && (
                <>
                  <Route path="network/affiliations" element={<MyAffiliationsPage />} />
                  <Route path="network/requests" element={<MyRequestsPage />} />
                  <Route path="network/profile" element={<MyProfilePage />} />
                </>
              )}
              <Route path="postbacks" element={<PartnerPostbacksPage principal={auth.principal} />} />
            </>
          )}

          {auth.principal.role === 'admin' && (
            <>
              <Route path="admin/partners" element={<AdminPartners />} />
              <Route path="admin/partners/:id/programs" element={<AdminPartnerPrograms />} />
              <Route path="admin/partners/:id/coupons" element={<AdminPartnerCoupons />} />
              <Route path="admin/partners/:id/commission" element={<AdminPartnerCommission />} />
              <Route path="admin/programs" element={<AdminPrograms />} />
              <Route path="admin/review" element={<AdminReview />} />
              <Route path="admin/export" element={<AdminExport />} />
              <Route path="admin/fraud-review" element={<FraudReviewPage />} />
              <Route path="admin/webhooks" element={<WebhooksPage />} />
              <Route path="admin/integrations" element={<AdminIntegrations />} />
              <Route path="admin/admins" element={<AdminAdmins />} />
              <Route path="admin/settings" element={<AdminSettings />} />
              <Route path="admin/billing" element={<AdminBilling />} />
              <Route path="admin/white-label" element={<AdminWhiteLabel />} />
              {/* Brand-side Network management — isolated for white-label. */}
              {!whiteLabel && (
                <>
                  <Route path="admin/network" element={<AdminNetwork />} />
                  <Route path="admin/network/complete" element={<AdminNetworkComplete />} />
                  <Route path="admin/network/requests" element={<AdminNetworkRequests />} />
                  <Route path="admin/network/creators" element={<AdminNetworkCreators />} />
                  <Route path="admin/network/billing" element={<AdminNetworkBilling />} />
                </>
              )}
            </>
          )}

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** Mobile-only top bar: hamburger + brand. Sticky so it stays reachable
 *  while the page scrolls. Reuses the cached 'program-settings' query so
 *  the brand name/logo match the drawer without a second fetch. */
function MobileTopBar({ onMenu }: { onMenu: () => void }) {
  const { programName, logoUrl, whiteLabel } = useBrand();
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 56,
        padding: '0 16px',
        background: theme.sidebar,
        borderBottom: `1px solid ${theme.borderSubtle}`,
      }}
    >
      <button
        onClick={onMenu}
        aria-label="Open menu"
        style={{
          background: 'transparent',
          border: 'none',
          color: theme.text,
          cursor: 'pointer',
          display: 'inline-flex',
          padding: 6,
          marginLeft: -6,
        }}
      >
        <Menu size={22} />
      </button>
      <BrandMark logoUrl={logoUrl} programName={programName} whiteLabel={whiteLabel} size={24} />
      <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{programName}</div>
    </header>
  );
}

/** Slide-in drawer shell for the mobile sidebar. Stays mounted so the
 *  panel can transition in/out; a tap on the backdrop or any nav link
 *  inside closes it (route-change in Shell also closes it). */
function MobileDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 180ms ease',
          zIndex: 49,
        }}
      />
      <div
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) onClose();
        }}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: 'min(280px, 84vw)',
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 200ms ease',
          boxShadow: open ? '0 0 40px rgba(0,0,0,0.5)' : 'none',
          display: 'flex',
          zIndex: 50,
        }}
      >
        {children}
      </div>
    </>
  );
}

export function Sidebar({ principal, variant = 'sidebar' }: { principal: Principal; variant?: 'sidebar' | 'drawer' }) {
  const nav = useNavigate();
  const tenantBase = useTenantBase();
  const { programName, supportEmail, logoUrl, whiteLabel } = useBrand();
  const isDrawer = variant === 'drawer';

  return (
    <aside
      style={{
        // Sidebar: sticky + 100vh pins the aside to the viewport so the
        // middle nav's overflow:auto actually scrolls. Without this, the
        // aside would grow with the main content and the inner overflow
        // would never trigger.
        // Drawer (mobile): the MobileDrawer wrapper owns positioning; the
        // aside just fills it as a normal flex column.
        width: isDrawer ? '100%' : 248,
        height: isDrawer ? '100%' : '100vh',
        ...(isDrawer ? {} : { position: 'sticky', top: 0 }),
        background: theme.sidebar,
        borderRight: isDrawer ? 'none' : `1px solid ${theme.borderSubtle}`,
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', marginBottom: 20 }}>
        <BrandMark logoUrl={logoUrl} programName={programName} whiteLabel={whiteLabel} size={26} />
        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{programName}</div>
      </div>

      {principal.role === 'admin' ? (
        <IdentitySwitcher principal={principal} />
      ) : (
        <PrincipalChip principal={principal} />
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        {/* Top-level nav — no header, always visible. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <NavItem to="/" icon={<LayoutDashboard size={16} />}>Dashboard</NavItem>
          <NavItem to="/links" icon={<Link2 size={16} />}>Links</NavItem>
          <NavItem to="/commissions" icon={<Receipt size={16} />}>Commissions</NavItem>
          <NavItem to="/payouts" icon={<Banknote size={16} />}>Payouts</NavItem>
          {principal.role === 'partner' && <NavItem to="/connect" icon={<CreditCard size={16} />}>Stripe Connect</NavItem>}
          {principal.role === 'partner' && <NavItem to="/postbacks" icon={<Webhook size={16} />}>Postbacks</NavItem>}
        </div>

        {principal.role === 'partner' && !whiteLabel && (
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
            <NavItem to="/admin/programs" icon={<Tag size={16} />}>Programs</NavItem>
            <NavItem to="/admin/review" icon={<ShieldCheck size={16} />}>Review queue</NavItem>
            <NavItem to="/admin/export" icon={<Download size={16} />}>Export / import</NavItem>
            <NavItem to="/admin/fraud-review" icon={<ShieldCheck size={16} />}>Fraud review</NavItem>
            <NavItem to="/admin/webhooks" icon={<Webhook size={16} />}>Webhooks</NavItem>
            <NavItem to="/admin/integrations" icon={<Link2 size={16} />}>CRM integration</NavItem>
            <NavItem to="/admin/admins" icon={<UserCog size={16} />}>Admins</NavItem>
            <NavItem to="/admin/settings" icon={<Settings size={16} />}>Settings</NavItem>
            <NavItem to="/admin/billing" icon={<CreditCard size={16} />}>Billing</NavItem>
            <NavItem to="/admin/white-label" icon={<Palette size={16} />}>White label</NavItem>
          </NavSection>
        )}

        {principal.role === 'admin' && !whiteLabel && <NetworkNav />}
      </div>

      <button
        onClick={async () => {
          clearApiKey();
          // Kill BOTH sessions: the workspace session (op_session)
          // and the platform-identity session (op_platform_session).
          // The latter outlives workspace logout otherwise — and
          // since the Workspaces page auto-enters when there's only
          // one workspace, the user gets silently re-signed-in on the
          // next navigation.
          //
          // /auth/platform-signout is a non-tenant route (mounted
          // before tenantMiddleware in the API), so it can't go
          // through api() which auto-prepends the /t/<slug> prefix.
          // Raw fetch directly at /api/auth/platform-signout.
          try {
            await Promise.all([
              api('/auth/signout', { method: 'POST' }).catch(() => {}),
              fetch('/api/auth/platform-signout', { method: 'POST', credentials: 'include' }).catch(() => {}),
            ]);
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

/**
 * Admin sidebar chip with a multi-identity switcher popover.
 *
 * Two layers of switching:
 *   - Identities: sibling platform sessions in the device-local bundle.
 *     Listed by email. The active identity (whichever the
 *     op_platform_session cookie names) sits at the top; clicking another
 *     rotates that session's token and lands the user on /workspaces to
 *     pick a brand for it.
 *   - Workspaces: for the ACTIVE identity, the popover surfaces the
 *     brands that email admins so the user can switch tenant without
 *     re-entering the picker.
 *
 * "Add another account" goes to /signin — magic-link verify attaches the
 * new platform session to the existing bundle cookie if present, so the
 * stacked identity shows up here on next render.
 *
 * Degrades when /me/identities returns an empty bundle (legacy session
 * predating multi-identity): falls back to workspace-only mode.
 */
interface WorkspaceRow {
  tenantSlug: string;
  tenantDisplayName: string;
  adminId: string;
  activated: boolean;
}

interface PlatformMe {
  email: string;
  workspaces: WorkspaceRow[];
}

interface IdentityRow {
  sessionId: string;
  email: string;
  lastSeenAt: string | null;
  createdAt: string;
  isActive: boolean;
}

interface IdentityList {
  bundleId: string | null;
  identities: IdentityRow[];
}

function IdentitySwitcher({ principal }: { principal: Principal }) {
  const [open, setOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const { label, initial, hue } = describePrincipal(principal);
  // On a white-label portal the multi-workspace machinery is platform UX
  // that must not leak: "Add another account" / "Create a new brand" talk
  // about OUR platform's accounts and plans, and their routes only exist
  // on the platform origin (dead links on a custom domain). The chip
  // itself (identity + sign out) stays.
  const { whiteLabel } = useBrand();

  // Best-effort: 401 just means no platform session (admin signed in via
  // api key or pre-platform-sessions session). We still render the chip;
  // the popover degrades to "current workspace only".
  const workspaces = useQuery({
    queryKey: ['platform-workspaces'],
    queryFn: async () => {
      const res = await fetch('/api/me/workspaces', { credentials: 'include' });
      if (res.status === 401) return { email: null, workspaces: [] as WorkspaceRow[] };
      if (!res.ok) throw new Error(`workspaces: ${res.status}`);
      return (await res.json()) as PlatformMe;
    },
    staleTime: 60_000,
    retry: false,
  });

  const identities = useQuery({
    queryKey: ['platform-identities'],
    queryFn: async () => {
      const res = await fetch('/api/me/identities', { credentials: 'include' });
      if (res.status === 401) return { bundleId: null, identities: [] as IdentityRow[] };
      if (!res.ok) throw new Error(`identities: ${res.status}`);
      return (await res.json()) as IdentityList;
    },
    staleTime: 60_000,
    retry: false,
  });

  // Resolve the current workspace by matching the slug in the URL (
  // /t/<slug>/...). Doing it from URL avoids passing slug through every
  // layer of the admin tree.
  const currentSlug = (() => {
    const m = window.location.pathname.match(/^\/t\/([^/]+)/);
    return m?.[1] ?? null;
  })();

  async function enter(slug: string): Promise<void> {
    if (slug === currentSlug) {
      setOpen(false);
      return;
    }
    setBusyAction(`enter:${slug}`);
    try {
      const res = await fetch('/api/workspaces/enter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ slug }),
      });
      const body = (await res.json()) as { ok?: boolean; home?: string; error?: string };
      if (!res.ok || !body.ok || !body.home) {
        throw new Error(body.error ?? `enter: ${res.status}`);
      }
      // Hard reload into the new workspace — the api key + react-query
      // caches are scoped per-tenant in subtle ways (links, partner ids,
      // etc.); reload keeps state honest instead of trying to invalidate
      // every cache.
      window.location.assign(body.home);
    } catch {
      setBusyAction(null);
    }
  }

  async function switchIdentity(sessionId: string): Promise<void> {
    setBusyAction(`switch:${sessionId}`);
    try {
      const res = await fetch('/api/identities/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) throw new Error(`switch: ${res.status}`);
      // Backend cleared the tenant cookie — land on the workspace picker
      // so the user chooses which brand to enter as this identity.
      window.location.assign('/workspaces');
    } catch {
      setBusyAction(null);
    }
  }

  async function removeIdentity(sessionId: string): Promise<void> {
    setBusyAction(`remove:${sessionId}`);
    try {
      const res = await fetch(`/api/identities/${sessionId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const body = (await res.json()) as { ok?: boolean; fellThroughTo?: string | null };
      if (!res.ok || !body.ok) throw new Error(`remove: ${res.status}`);
      if (body.fellThroughTo) {
        // Server promoted a sibling; land on workspaces for that identity.
        window.location.assign('/workspaces');
      } else {
        // Was the only identity, or removed a non-active one — refresh
        // the popover data either way.
        await identities.refetch();
        setBusyAction(null);
      }
    } catch {
      setBusyAction(null);
    }
  }

  async function signOut(all: boolean): Promise<void> {
    setBusyAction(all ? 'signout-all' : 'signout');
    try {
      const res = await fetch('/api/auth/platform-signout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ all }),
      });
      const body = (await res.json()) as { fellThroughTo?: string };
      if (res.ok && body.fellThroughTo) {
        // Auto-fall-through to the next bundled identity — land on the
        // picker so user enters a workspace as that identity.
        window.location.assign('/workspaces');
      } else {
        clearApiKey();
        window.location.assign('/signin');
      }
    } catch {
      setBusyAction(null);
    }
  }

  const allWorkspaces = workspaces.data?.workspaces ?? [];
  const hasMany = allWorkspaces.length > 1;
  const identityRows = identities.data?.identities ?? [];
  const activeIdentity = identityRows.find((i) => i.isActive) ?? null;
  const otherIdentities = identityRows.filter((i) => !i.isActive);

  return (
    <div style={{ position: 'relative', marginBottom: 18 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          background: theme.surface,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: theme.radiusSm,
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
          color: theme.text,
          textAlign: 'left',
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
            flexShrink: 0,
          }}
        >
          {initial}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {label}
          </div>
          <div
            style={{
              fontSize: 11,
              color: theme.textDim,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {activeIdentity?.email ?? workspaces.data?.email ?? (principal.role === 'admin' ? 'Admin' : '')}
          </div>
        </div>
        <ChevronsUpDown size={14} color={theme.textMuted} />
      </button>

      {open && (
        <>
          {/* Click-outside layer */}
          <div
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40,
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              right: 0,
              background: theme.surface,
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: theme.radiusSm,
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
              padding: 6,
              zIndex: 41,
              maxHeight: 360,
              overflow: 'auto',
            }}
          >
            {(workspaces.isLoading || identities.isLoading) && (
              <div style={{ padding: '8px 10px', fontSize: 12, color: theme.textMuted }}>
                Loading…
              </div>
            )}

            {!workspaces.isLoading && hasMany && (
              <SwitcherSectionLabel>Brands for this account</SwitcherSectionLabel>
            )}
            {allWorkspaces.map((w) => {
              const active = w.tenantSlug === currentSlug;
              const busy = busyAction === `enter:${w.tenantSlug}`;
              return (
                <SwitcherRow
                  key={w.tenantSlug}
                  active={active}
                  busy={busy}
                  disabled={busyAction !== null}
                  onClick={() => enter(w.tenantSlug)}
                  title={w.tenantDisplayName}
                  subtitle={`/t/${w.tenantSlug}/`}
                  right={busy ? <Spinner /> : active ? <Check size={14} color={theme.accent} /> : null}
                />
              );
            })}

            {otherIdentities.length > 0 && (
              <>
                <SwitcherSectionLabel>Other accounts</SwitcherSectionLabel>
                {otherIdentities.map((id) => {
                  const busy = busyAction === `switch:${id.sessionId}` || busyAction === `remove:${id.sessionId}`;
                  return (
                    <SwitcherRow
                      key={id.sessionId}
                      active={false}
                      busy={busy}
                      disabled={busyAction !== null}
                      onClick={() => switchIdentity(id.sessionId)}
                      title={id.email}
                      subtitle="Click to switch"
                      right={
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`Sign out ${id.email} from this device?`)) {
                              void removeIdentity(id.sessionId);
                            }
                          }}
                          disabled={busyAction !== null}
                          title="Remove account from this device"
                          style={{
                            background: 'transparent',
                            border: 'none',
                            cursor: busyAction === null ? 'pointer' : 'wait',
                            color: theme.textDim,
                            padding: 2,
                            display: 'flex',
                          }}
                        >
                          {busy ? <Spinner /> : <X size={14} />}
                        </button>
                      }
                    />
                  );
                })}
              </>
            )}

            <div
              style={{
                borderTop: `1px solid ${theme.borderSubtle}`,
                marginTop: 4,
                paddingTop: 4,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {!whiteLabel && (
                <>
                  <a
                    href="/signin?add=1"
                    style={switcherActionStyle}
                    onMouseEnter={switcherActionHoverOn}
                    onMouseLeave={switcherActionHoverOff}
                  >
                    <Plus size={14} />
                    Add another account
                  </a>
                  {/* Honest label (§13): a new brand is its own independently-
                      billed tenant that shares this sign-in — not a free
                      addition to the current bill. The authenticated flow
                      reuses the platform email so the brand can never be
                      orphaned from this switcher. */}
                  <a
                    href="/brands/new"
                    style={switcherActionStyle}
                    onMouseEnter={switcherActionHoverOn}
                    onMouseLeave={switcherActionHoverOff}
                  >
                    <Plus size={14} />
                    Create a new brand (own plan)
                  </a>
                </>
              )}
              <button
                onClick={() => void signOut(false)}
                disabled={busyAction !== null}
                style={{ ...switcherActionStyle, background: 'transparent', cursor: busyAction === null ? 'pointer' : 'wait' }}
                onMouseEnter={switcherActionHoverOn}
                onMouseLeave={switcherActionHoverOff}
              >
                <LogOut size={14} />
                Sign out {activeIdentity ? activeIdentity.email : ''}
              </button>
              {identityRows.length > 1 && (
                <button
                  onClick={() => void signOut(true)}
                  disabled={busyAction !== null}
                  style={{ ...switcherActionStyle, background: 'transparent', cursor: busyAction === null ? 'pointer' : 'wait', color: theme.danger }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = theme.surface2;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <LogOut size={14} />
                  Sign out all accounts
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- IdentitySwitcher small pieces ----------

function SwitcherSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: theme.textDim,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        padding: '8px 10px 4px',
      }}
    >
      {children}
    </div>
  );
}

function SwitcherRow({
  active,
  busy,
  disabled,
  onClick,
  title,
  subtitle,
  right,
}: {
  active: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  right: ReactNode;
}) {
  return (
    <div
      onClick={() => {
        if (!disabled) onClick();
      }}
      style={{
        background: active ? theme.surface2 : 'transparent',
        borderRadius: 6,
        padding: '8px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        cursor: disabled ? (busy ? 'wait' : 'not-allowed') : 'pointer',
        color: theme.text,
        opacity: disabled && !busy ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!active && !disabled) e.currentTarget.style.background = theme.surface2;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 11,
            color: theme.textMuted,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {subtitle}
        </div>
      </div>
      {right}
    </div>
  );
}

function Spinner() {
  return <span style={{ fontSize: 11, color: theme.accent }}>…</span>;
}

const switcherActionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 10px',
  borderRadius: 6,
  color: theme.textMuted,
  fontSize: 13,
  textDecoration: 'none',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  cursor: 'pointer',
  width: '100%',
};

function switcherActionHoverOn(e: React.MouseEvent<HTMLElement>): void {
  e.currentTarget.style.background = theme.surface2;
  e.currentTarget.style.color = theme.text;
}
function switcherActionHoverOff(e: React.MouseEvent<HTMLElement>): void {
  e.currentTarget.style.background = 'transparent';
  e.currentTarget.style.color = theme.textMuted;
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
      <NavItem to="/admin/network" icon={<Globe size={16} />} exact>{connected ? 'Connection' : 'Get connected'}</NavItem>
      {connected && (
        <>
          <NavItem to="/admin/network/requests" icon={<Inbox size={16} />}>Requests</NavItem>
          <NavItem to="/admin/network/creators" icon={<Users size={16} />}>Discover creators</NavItem>
          <NavItem to="/admin/network/billing" icon={<CreditCard size={16} />}>Billing</NavItem>
        </>
      )}
    </NavSection>
  );
}

function NavItem({
  to,
  icon,
  children,
  exact,
}: {
  to: string;
  icon: ReactNode;
  children: ReactNode;
  /** When true, this item only highlights on an exact pathname match.
   *  Use for parent routes whose children are also rendered as their
   *  own nav items — otherwise prefix-matching makes the parent stay
   *  highlighted alongside the active child. */
  exact?: boolean;
}) {
  const location = useLocation();
  const tenantBase = useTenantBase();
  const href = to.startsWith('/') ? `${tenantBase}${to === '/' ? '' : to}` || '/' : to;
  // Default prefix-match requires the next char to be '/' so that
  // '/admin/network' doesn't accidentally match '/admin/network-foo'
  // or '/admin/network-archive'. `exact` opts out of prefix matching
  // entirely for routes whose children have their own nav entries.
  const active =
    location.pathname === href ||
    (!exact && href !== '/' && location.pathname.startsWith(`${href}/`));
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

function Logo({ size = 26, alt = 'OpenPartner' }: { size?: number; alt?: string } = {}) {
  return (
    <img
      src="/logo-mark-green.svg"
      alt={alt}
      width={size}
      height={size}
      style={{ display: 'block' }}
    />
  );
}

/**
 * Brand mark for the portal header. Renders, in order of preference:
 *   1. the tenant's uploaded logo (`logoUrl`),
 *   2. for a white-label tenant with no logo, a neutral monogram from the
 *      brand name — NEVER the OpenPartner mark (that would leak platform
 *      branding into a white-label portal),
 *   3. otherwise the OpenPartner logo mark.
 */
function BrandMark({
  logoUrl,
  programName,
  whiteLabel,
  size = 26,
}: {
  logoUrl: string | null;
  programName: string;
  whiteLabel: boolean;
  size?: number;
}) {
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={programName}
        style={{ width: size, height: size, borderRadius: 6, objectFit: 'contain', background: theme.surface2 }}
      />
    );
  }
  if (whiteLabel) {
    const initial = (programName.trim()[0] ?? '?').toUpperCase();
    return (
      <div
        aria-label={programName}
        style={{
          width: size,
          height: size,
          borderRadius: 6,
          background: theme.surface2,
          color: 'inherit',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: Math.round(size * 0.55),
          fontWeight: 700,
        }}
      >
        {initial}
      </div>
    );
  }
  return <Logo size={size} alt={programName} />;
}

/**
 * Slim amber banner shown to a brand admin while their workspace is awaiting
 * platform-ops approval. They can build out the program, but partner links
 * won't redirect and they can't invite partners until an operator approves.
 * Only for approvalStatus === 'pending' (see Shell); never for partners.
 */
function PendingReviewBanner({ isMobile, onDismiss }: { isMobile: boolean; onDismiss: () => void }) {
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: isMobile ? '16px 16px 0' : '24px 40px 0' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          background: theme.warnSoft,
          border: `1px solid ${theme.warn}55`,
          borderRadius: theme.radiusMd,
          padding: '12px 14px',
        }}
      >
        <AlertTriangle size={18} color={theme.warn} style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5, color: theme.text }}>
          <strong style={{ color: theme.warn }}>Your brand is under review.</strong>{' '}
          You can set up your program now, but partner links won&rsquo;t redirect and you can&rsquo;t invite
          partners until an OpenPartner operator approves your account.
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.textMuted,
            cursor: 'pointer',
            padding: 2,
            display: 'inline-flex',
            flexShrink: 0,
          }}
        >
          <X size={16} />
        </button>
      </div>
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
