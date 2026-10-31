import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Ban,
  Bell,
  Building2,
  FileText,
  Globe,
  Handshake,
  LayoutGrid,
  LogOut,
  Menu,
  Percent,
  ScrollText,
  ShieldCheck,
  Store,
  UserSearch,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { theme } from '../../theme.js';
import { ThemeToggle } from '../../lib/ThemeToggle.js';
import { CookieSettingsButton } from '../../lib/ConsentBanner.js';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import { Logo } from '../auth/Shared.js';
import { papi, type PlatformOperator } from './lib.js';
import { BrandsPage } from './Brands.js';
import { CreatorsPage } from './Creators.js';
import { MarketplacePage } from './Marketplace.js';
import { VendorsPage } from './Vendors.js';
import { BlocklistPage } from './Blocklist.js';
import { AuditPage } from './Audit.js';
import { NotificationsPage } from './Notifications.js';
import { FeesPage } from './Fees.js';
import { InvoicingPage } from './Invoicing.js';
import { CountriesPage } from './Countries.js';
import { ScreeningPage } from './Screening.js';
import { OwnProgramPage } from './OwnProgram.js';
import { CreatorIndexPage } from './CreatorIndex.js';
import { MailboxCallbackPage } from './Mailboxes.js';

const NAV: ReadonlyArray<{ title: string; items: ReadonlyArray<{ to: string; label: string; icon: LucideIcon }> }> = [
  {
    title: 'Review',
    items: [
      { to: '/platform/brands', label: 'Brands', icon: Building2 },
      { to: '/platform/creators', label: 'Creators', icon: Users },
      { to: '/platform/vendors', label: 'Vendors', icon: Store },
    ],
  },
  {
    title: 'Network',
    items: [
      { to: '/platform/creator-index', label: 'Creator index', icon: UserSearch },
      { to: '/platform/marketplace', label: 'Marketplace', icon: LayoutGrid },
    ],
  },
  {
    title: 'Billing',
    items: [
      { to: '/platform/fees', label: 'Fees', icon: Percent },
      { to: '/platform/invoicing', label: 'Invoicing', icon: FileText },
    ],
  },
  {
    title: 'Compliance',
    items: [
      { to: '/platform/screening', label: 'Screening', icon: ShieldCheck },
      { to: '/platform/countries', label: 'Countries', icon: Globe },
      { to: '/platform/blocklist', label: 'Blocklist', icon: Ban },
    ],
  },
  {
    title: 'Platform',
    items: [
      { to: '/platform/notifications', label: 'Notifications', icon: Bell },
      { to: '/platform/own-program', label: 'Own program', icon: Handshake },
      { to: '/platform/audit', label: 'Audit', icon: ScrollText },
    ],
  },
];

/**
 * Platform operations console shell. Guards on the operator session
 * (GET /platform-admin/me → 401 bounces to login), renders a left sidebar
 * (a slide-in drawer on a phone), and mounts the sub-pages. Mounted at
 * /platform/*.
 */
export function PlatformConsole() {
  const nav = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const me = useQuery({
    queryKey: ['platform-me'],
    queryFn: () => papi<PlatformOperator>('/platform-admin/me'),
    retry: false,
    staleTime: 30_000,
  });

  // Dismiss the drawer on navigation (tapping a nav link changes the route).
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  if (me.isLoading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: theme.bg,
          color: theme.textMuted,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        Loading…
      </div>
    );
  }
  // Any failure (401 not signed in, or network) → back to the operator login.
  if (me.isError || !me.data) return <Navigate to="/platform/login" replace />;
  const operator = me.data;

  async function signOut() {
    try {
      await papi('/platform-admin/signout', { method: 'POST' });
    } catch {
      /* sign out locally regardless */
    }
    nav('/platform/login', { replace: true });
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: theme.bg, color: theme.text }}>
      {isMobile ? (
        <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
          <Sidebar operator={operator} onSignOut={signOut} variant="drawer" />
        </MobileDrawer>
      ) : (
        <Sidebar operator={operator} onSignOut={signOut} />
      )}
      {/* The window scrolls, not main: overflow-x: clip (unlike auto) isn't
          a scroll container, so the mobile top bar sticks to the viewport. */}
      <main style={{ flex: 1, minWidth: 0, overflowX: 'clip' }}>
        {isMobile && <MobileTopBar onMenu={() => setDrawerOpen(true)} />}
        <Routes>
          <Route index element={<Navigate to="/platform/brands" replace />} />
          <Route path="brands" element={<BrandsPage operator={operator} />} />
          <Route path="creators" element={<CreatorsPage operator={operator} />} />
          <Route path="creator-index" element={<CreatorIndexPage operator={operator} />} />
          <Route path="mailboxes/callback" element={<MailboxCallbackPage />} />
          <Route path="vendors" element={<VendorsPage operator={operator} />} />
          <Route path="marketplace" element={<MarketplacePage operator={operator} />} />
          <Route path="notifications" element={<NotificationsPage operator={operator} />} />
          <Route path="fees" element={<FeesPage operator={operator} />} />
          <Route path="invoicing" element={<InvoicingPage operator={operator} />} />
          <Route path="blocklist" element={<BlocklistPage operator={operator} />} />
          <Route path="countries" element={<CountriesPage operator={operator} />} />
          <Route path="screening" element={<ScreeningPage operator={operator} />} />
          <Route path="own-program" element={<OwnProgramPage operator={operator} />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/platform/brands" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function OpsMark({ size }: { size: number }) {
  return (
    <>
      <Logo size={size} />
      <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>
        OpenPartner <span style={{ color: theme.textDim, fontWeight: 500 }}>ops</span>
      </div>
    </>
  );
}

/** Mobile-only top bar: hamburger + mark. Sticky so the menu stays
 *  reachable while the page scrolls. */
function MobileTopBar({ onMenu }: { onMenu: () => void }) {
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
      <OpsMark size={24} />
    </header>
  );
}

/** Slide-in drawer shell for the mobile sidebar. A tap on the backdrop or
 *  any nav link inside closes it (the route change also closes it). */
function MobileDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: theme.overlay,
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
          boxShadow: open ? theme.shadowDrawer : 'none',
          display: 'flex',
          zIndex: 50,
        }}
      >
        {children}
      </div>
    </>
  );
}

function Sidebar({
  operator,
  onSignOut,
  variant = 'sidebar',
}: {
  operator: PlatformOperator;
  onSignOut: () => void;
  variant?: 'sidebar' | 'drawer';
}) {
  const isDrawer = variant === 'drawer';
  return (
    <aside
      style={{
        // Sidebar: sticky + 100vh pins the aside to the viewport so the
        // middle nav's overflow:auto actually scrolls. Drawer: the
        // wrapper owns positioning; the aside just fills it.
        width: isDrawer ? '100%' : 232,
        flexShrink: 0,
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
        <OpsMark size={26} />
      </div>

      <OperatorChip operator={operator} />

      <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        {NAV.map((section) => (
          <div key={section.title}>
            <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 8px', marginBottom: 6 }}>
              {section.title}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {section.items.map((item) => (
                <NavItem key={item.to} to={item.to} icon={item.icon}>
                  {item.label}
                </NavItem>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <ThemeToggle labels style={{ marginTop: 14 }} />

      <button
        onClick={onSignOut}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          marginTop: 8,
          background: 'transparent',
          color: theme.textMuted,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: theme.radiusSm,
          padding: '9px 12px',
          fontSize: 13,
          cursor: 'pointer',
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

      <CookieSettingsButton style={{ marginTop: 10, alignSelf: 'center' }} />
    </aside>
  );
}

function OperatorChip({ operator }: { operator: PlatformOperator }) {
  return (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: '10px 12px',
        marginBottom: 18,
        lineHeight: 1.35,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{operator.email}</div>
      <div style={{ fontSize: 10.5, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {operator.role === 'admin' ? 'operator · admin' : 'operator · read-only'}
      </div>
    </div>
  );
}

function NavItem({ to, icon: Icon, children }: { to: string; icon: LucideIcon; children: ReactNode }) {
  const location = useLocation();
  const active = location.pathname === to || location.pathname.startsWith(`${to}/`);
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
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
      <span style={{ display: 'inline-flex', color: active ? theme.accentText : 'inherit' }}>
        <Icon size={16} />
      </span>
      {children}
    </Link>
  );
}
