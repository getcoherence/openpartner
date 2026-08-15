import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { theme } from '../../theme.js';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import { Logo } from '../auth/Shared.js';
import { papi, type PlatformOperator } from './lib.js';
import { BrandsPage } from './Brands.js';
import { CreatorsPage } from './Creators.js';
import { BlocklistPage } from './Blocklist.js';
import { AuditPage } from './Audit.js';

const TABS = [
  { to: '/platform/brands', label: 'Brands' },
  { to: '/platform/creators', label: 'Creators' },
  { to: '/platform/blocklist', label: 'Blocklist' },
  { to: '/platform/audit', label: 'Audit' },
] as const;

/**
 * Platform operations console shell. Guards on the operator session
 * (GET /platform-admin/me → 401 bounces to login), renders a top nav, and
 * mounts the Brands / Blocklist / Audit sub-pages. Mounted at /platform/*.
 */
export function PlatformConsole() {
  const nav = useNavigate();
  const me = useQuery({
    queryKey: ['platform-me'],
    queryFn: () => papi<PlatformOperator>('/platform-admin/me'),
    retry: false,
    staleTime: 30_000,
  });

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
    <div style={{ minHeight: '100vh', background: theme.bg, color: theme.text }}>
      <TopNav operator={operator} onSignOut={signOut} />
      <Routes>
        <Route index element={<Navigate to="/platform/brands" replace />} />
        <Route path="brands" element={<BrandsPage operator={operator} />} />
        <Route path="creators" element={<CreatorsPage operator={operator} />} />
        <Route path="blocklist" element={<BlocklistPage operator={operator} />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/platform/brands" replace />} />
      </Routes>
    </div>
  );
}

function TopNav({ operator, onSignOut }: { operator: PlatformOperator; onSignOut: () => void }) {
  const location = useLocation();
  const isMobile = useIsMobile();
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        background: theme.sidebar,
        borderBottom: `1px solid ${theme.borderSubtle}`,
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: '0 auto',
          padding: isMobile ? '10px 16px' : '12px 40px',
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? 12 : 20,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Logo size={22} />
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            OpenPartner <span style={{ color: theme.textDim, fontWeight: 500 }}>ops</span>
          </div>
        </div>

        <nav style={{ display: 'flex', gap: 2, flex: 1, minWidth: 0 }}>
          {TABS.map((t) => {
            const active = location.pathname === t.to || location.pathname.startsWith(`${t.to}/`);
            return (
              <Link
                key={t.to}
                to={t.to}
                style={{
                  padding: '7px 12px',
                  borderRadius: theme.radiusSm,
                  fontSize: 13.5,
                  fontWeight: active ? 600 : 500,
                  color: active ? theme.text : theme.textMuted,
                  background: active ? theme.surface : 'transparent',
                }}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ textAlign: 'right', lineHeight: 1.3 }}>
            <div style={{ fontSize: 12.5, color: theme.text, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {operator.email}
            </div>
            <div style={{ fontSize: 10.5, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {operator.role === 'admin' ? 'operator · admin' : 'operator · read-only'}
            </div>
          </div>
          <button
            onClick={onSignOut}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'transparent',
              color: theme.textMuted,
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: theme.radiusSm,
              padding: '7px 11px',
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
        </div>
      </div>
    </header>
  );
}
