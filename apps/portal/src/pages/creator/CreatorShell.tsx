import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { CalendarCheck, Globe, Inbox, Link2, LogOut, Megaphone, Menu, MessagesSquare, Network, Store, UserCog } from 'lucide-react';
import { theme } from '../../theme.js';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import { ProfileCompletionBanner } from '../../lib/ProfileCompletionBanner.js';
import type { ProfileCompleteness } from '../../lib/profile-incomplete.js';
import { Logo } from '../auth/Shared.js';
import { ThemeToggle } from '../../lib/ThemeToggle.js';
import { CookieSettingsButton } from '../../lib/ConsentBanner.js';
import { creatorApi } from './creator-api.js';
import { CreatorDiscoverPage } from './CreatorDiscover.js';
import { CreatorOfferingDetailPage } from './CreatorOfferingDetail.js';
import { CreatorVendorDetailPage } from './CreatorVendorDetail.js';
import { CreatorMyAffiliationsPage } from './CreatorMyAffiliations.js';
import { CreatorMyRequestsPage } from './CreatorMyRequests.js';
import { CreatorMyProfilePage } from './CreatorMyProfile.js';
import { CreatorShareLinksPage } from './CreatorShareLinks.js';
import { CreatorDomainsPage } from './CreatorDomains.js';
import { CreatorProgramDetailPage } from './CreatorProgramDetail.js';
import { CreatorStorefrontPage } from './CreatorStorefront.js';
import { CreatorStorefrontSetupPage } from './CreatorStorefrontSetup.js';
import { CreatorBookingsPage } from './CreatorBookings.js';
import { CreatorMessagesPage, CreatorThreadPage, useCreatorUnreadMessages } from './CreatorMessages.js';
import { UnreadDot } from './conversation-shared.js';
import { CreatorLocationPrompt, useCreatorLocationMissing } from './CreatorLocation.js';
import { CreatorReviewBanners } from './CreatorReview.js';

interface Whoami {
  creator: { id: string; name: string; email: string; handle: string | null; avatarUrl: string | null; bio: string | null } | null;
}

export function CreatorShell() {
  const [auth, setAuth] = useState<{ loading: boolean; creator: Whoami['creator'] | null }>({ loading: true, creator: null });
  const location = useLocation();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    creatorApi<Whoami>('/creators/whoami')
      .then((r) => setAuth({ loading: false, creator: r.creator }))
      .catch(() => setAuth({ loading: false, creator: null }));
  }, []);

  // Dismiss the drawer on navigation (tapping a nav link changes the route).
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  if (auth.loading) {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.bg, color: theme.textMuted }}>Loading…</div>;
  }
  if (!auth.creator) {
    return <Navigate to="/creator/login" state={{ from: location }} replace />;
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: theme.bg }}>
      {isMobile ? (
        <CreatorMobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
          <CreatorSidebar creator={auth.creator} variant="drawer" />
        </CreatorMobileDrawer>
      ) : (
        <CreatorSidebar creator={auth.creator} />
      )}
      <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        {isMobile && <CreatorMobileTopBar onMenu={() => setDrawerOpen(true)} />}
        <CreatorLocationGate isMobile={isMobile} />
        {!location.pathname.startsWith('/creator/profile') && <ProfileIncompleteBanner isMobile={isMobile} />}
        {/* Everywhere, the profile page included: a message usually asks
            for a profile change. */}
        <CreatorReviewBanners isMobile={isMobile} />
        {/* Redirects are absolute on purpose: this shell sits on a splat
            route (/creator/*), where React Router 7 resolves a relative
            "discover" against the whole URL — /creator/a/b → /creator/a/b/discover,
            which hits the catch-all again and loops forever. */}
        <Routes>
          <Route index element={<Navigate to="/creator/discover" replace />} />
          <Route path="discover" element={<CreatorDiscoverPage />} />
          <Route path="offerings/:id" element={<CreatorOfferingDetailPage />} />
          <Route path="vendors/:id" element={<CreatorVendorDetailPage />} />
          <Route path="affiliations" element={<CreatorMyAffiliationsPage />} />
          <Route path="programs/:partnershipId/*" element={<CreatorProgramDetailPage />} />
          <Route path="links" element={<CreatorShareLinksPage />} />
          <Route path="domains" element={<CreatorDomainsPage />} />
          <Route path="requests" element={<CreatorMyRequestsPage />} />
          <Route path="storefront" element={<CreatorStorefrontPage />} />
          <Route path="storefront/setup" element={<CreatorStorefrontSetupPage />} />
          <Route path="bookings" element={<CreatorBookingsPage />} />
          <Route path="messages" element={<CreatorMessagesPage />} />
          <Route path="messages/:id" element={<CreatorThreadPage />} />
          <Route path="profile" element={<CreatorMyProfilePage />} />
          <Route path="*" element={<Navigate to="/creator/discover" replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** The one-time "where are you based?" question, until it's answered
 *  (creators from before the Network asked at signup). Mounted only
 *  once the creator is signed in, so the lookup never runs logged out. */
function CreatorLocationGate({ isMobile }: { isMobile: boolean }) {
  const missing = useCreatorLocationMissing();
  return missing ? <CreatorLocationPrompt isMobile={isMobile} /> : null;
}

/**
 * Site-wide nudge while the creator's profile is incomplete: brands can't
 * find them and the Network refuses their applications. Shares the
 * ['creator-my-profile'] cache with the profile page (whose save
 * invalidates it), so it disappears as soon as they finish. Hidden on the
 * profile page itself, which carries the full checklist.
 */
function ProfileIncompleteBanner({ isMobile }: { isMobile: boolean }) {
  const { data } = useQuery({
    queryKey: ['creator-my-profile'],
    queryFn: () => creatorApi<ProfileCompleteness>('/creators/me'),
    retry: false,
    staleTime: 60_000,
  });
  return (
    <ProfileCompletionBanner
      profile={data}
      isMobile={isMobile}
      dismissKey="op:creator-profile-banner-dismissed"
      renderLink={(style, children) => <Link to="/creator/profile" style={style}>{children}</Link>}
    />
  );
}

/** Mobile-only top bar for the creator shell: hamburger + brand. */
function CreatorMobileTopBar({ onMenu }: { onMenu: () => void }) {
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
      <Logo size={24} />
      <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>OpenPartner</div>
    </header>
  );
}

/** Slide-in drawer shell for the creator mobile sidebar. */
function CreatorMobileDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
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

function CreatorSidebar({ creator, variant = 'sidebar' }: { creator: NonNullable<Whoami['creator']>; variant?: 'sidebar' | 'drawer' }) {
  const nav = useNavigate();
  const isDrawer = variant === 'drawer';
  const unread = useCreatorUnreadMessages();
  return (
    <aside
      style={{
        // Sidebar: sticky + 100vh pins the aside to the viewport so the
        // middle nav's overflow:auto actually scrolls. Drawer: the
        // wrapper owns positioning; the aside just fills it.
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
        <Logo />
        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>OpenPartner</div>
      </div>

      <CreatorChip creator={creator} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        <NavSection title="Network">
          <CreatorNavItem to="/creator/discover" icon={<Globe size={16} />}>Discover programs</CreatorNavItem>
          <CreatorNavItem to="/creator/affiliations" icon={<Megaphone size={16} />}>My partnerships</CreatorNavItem>
          <CreatorNavItem to="/creator/links" icon={<Link2 size={16} />}>Share links</CreatorNavItem>
          <CreatorNavItem to="/creator/requests" icon={<Inbox size={16} />}>My applications</CreatorNavItem>
        </NavSection>
        <NavSection title="Storefront">
          <CreatorNavItem to="/creator/storefront" icon={<Store size={16} />}>Packages</CreatorNavItem>
          <CreatorNavItem to="/creator/messages" icon={<MessagesSquare size={16} />}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Messages <UnreadDot count={unread} />
            </span>
          </CreatorNavItem>
          <CreatorNavItem to="/creator/bookings" icon={<CalendarCheck size={16} />}>Bookings</CreatorNavItem>
        </NavSection>
        <NavSection title="Settings">
          <CreatorNavItem to="/creator/domains" icon={<Network size={16} />}>Custom domains</CreatorNavItem>
          <CreatorNavItem to="/creator/profile" icon={<UserCog size={16} />}>Profile</CreatorNavItem>
        </NavSection>
      </div>

      <ThemeToggle labels style={{ marginTop: 14 }} />

      <button
        onClick={async () => {
          try {
            await creatorApi('/creators/signout', { method: 'POST' });
          } catch {
            /* ignore */
          }
          nav('/');
        }}
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
      >
        <LogOut size={14} />
        Sign out
      </button>

      <CookieSettingsButton style={{ marginTop: 10, alignSelf: 'center' }} />
    </aside>
  );
}

function CreatorChip({ creator }: { creator: NonNullable<Whoami['creator']> }) {
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
          background: creator.avatarUrl ? theme.surface : theme.accent,
          color: theme.accentInk,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 600,
          fontSize: 12,
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {creator.avatarUrl ? (
          <img src={creator.avatarUrl} alt={creator.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          creator.name.charAt(0).toUpperCase()
        )}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{creator.name}</div>
        <div style={{ fontSize: 11, color: theme.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{creator.email}</div>
      </div>
    </div>
  );
}

function NavSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 8px', marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
    </div>
  );
}

function CreatorNavItem({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  const location = useLocation();
  const active = location.pathname === to || (to !== '/creator' && location.pathname.startsWith(to));
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
      }}
    >
      {icon}
      <span>{children}</span>
    </Link>
  );
}
