import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Globe, Inbox, Link2, LogOut, Megaphone, Network, UserCog } from 'lucide-react';
import { theme } from '../../theme.js';
import { Logo } from '../auth/Shared.js';
import { creatorApi } from './creator-api.js';
import { CreatorDiscoverPage } from './CreatorDiscover.js';
import { CreatorOfferingDetailPage } from './CreatorOfferingDetail.js';
import { CreatorVendorDetailPage } from './CreatorVendorDetail.js';
import { CreatorMyAffiliationsPage } from './CreatorMyAffiliations.js';
import { CreatorMyRequestsPage } from './CreatorMyRequests.js';
import { CreatorMyProfilePage } from './CreatorMyProfile.js';
import { CreatorShareLinksPage } from './CreatorShareLinks.js';
import { CreatorDomainsPage } from './CreatorDomains.js';

interface Whoami {
  creator: { id: string; name: string; email: string; handle: string | null; avatarUrl: string | null; bio: string | null } | null;
}

export function CreatorShell() {
  const [auth, setAuth] = useState<{ loading: boolean; creator: Whoami['creator'] | null }>({ loading: true, creator: null });
  const location = useLocation();

  useEffect(() => {
    creatorApi<Whoami>('/creators/whoami')
      .then((r) => setAuth({ loading: false, creator: r.creator }))
      .catch(() => setAuth({ loading: false, creator: null }));
  }, []);

  if (auth.loading) {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.bg, color: theme.textMuted }}>Loading…</div>;
  }
  if (!auth.creator) {
    return <Navigate to="/creator/login" state={{ from: location }} replace />;
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: theme.bg }}>
      <CreatorSidebar creator={auth.creator} />
      <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        <Routes>
          <Route index element={<Navigate to="discover" replace />} />
          <Route path="discover" element={<CreatorDiscoverPage />} />
          <Route path="offerings/:id" element={<CreatorOfferingDetailPage />} />
          <Route path="vendors/:id" element={<CreatorVendorDetailPage />} />
          <Route path="affiliations" element={<CreatorMyAffiliationsPage />} />
          <Route path="links" element={<CreatorShareLinksPage />} />
          <Route path="domains" element={<CreatorDomainsPage />} />
          <Route path="requests" element={<CreatorMyRequestsPage />} />
          <Route path="profile" element={<CreatorMyProfilePage />} />
          <Route path="*" element={<Navigate to="discover" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function CreatorSidebar({ creator }: { creator: NonNullable<Whoami['creator']> }) {
  const nav = useNavigate();
  return (
    <aside
      style={{
        // Sticky + 100vh pins the aside to the viewport so the middle
        // nav's overflow:auto actually scrolls (otherwise the aside
        // grows with the main content and the inner overflow never
        // triggers).
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
        <NavSection title="Settings">
          <CreatorNavItem to="/creator/domains" icon={<Network size={16} />}>Custom domains</CreatorNavItem>
          <CreatorNavItem to="/creator/profile" icon={<UserCog size={16} />}>Profile</CreatorNavItem>
        </NavSection>
      </div>

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
          marginTop: 14,
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
