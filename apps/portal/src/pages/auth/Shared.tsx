import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { theme } from '../../theme.js';
import { usePublicBrand } from '../../lib/useBrand.js';

export function AuthFrame({
  title,
  subtitle,
  brand,
  children,
}: {
  title: string;
  subtitle?: string;
  brand?: string;
  children: ReactNode;
}) {
  // Pre-auth brand bootstrap: the public /branding endpoint resolves the
  // tenant from the custom-domain host or the /t/<slug>/ prefix, so a
  // white-label tenant's sign-in page never shows platform branding. On
  // platform pages it returns nulls and we keep the OpenPartner default.
  const publicBrand = usePublicBrand();
  const name = brand ?? (publicBrand.isLoading ? '' : publicBrand.programName);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: `radial-gradient(1200px 800px at 50% -20%, ${theme.accentSoftA40}, transparent), ${theme.bg}`,
        padding: 24,
      }}
    >
      <div
        style={{
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          padding: 32,
          borderRadius: theme.radiusLg,
          width: 420,
          boxShadow: '0 30px 80px -30px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <AuthBrandMark
            logoUrl={publicBrand.logoUrl}
            programName={name || '?'}
            whiteLabel={publicBrand.whiteLabel}
            pending={publicBrand.isLoading}
          />
          <div style={{ fontSize: 18, fontWeight: 600 }}>{name}</div>
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', marginBottom: 4 }}>{title}</div>
        {subtitle && <div style={{ color: theme.textMuted, fontSize: 13, marginBottom: 20 }}>{subtitle}</div>}
        {children}
      </div>
    </div>
  );
}

export function Logo({ size = 26 }: { size?: number } = {}) {
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

/**
 * Pre-auth brand mark. Preference order mirrors the shell's BrandMark:
 * uploaded logo → neutral monogram for white-label (NEVER the OpenPartner
 * mark) → OpenPartner logo. While the /branding query is in flight render
 * a neutral placeholder so a white-label page never flashes the platform
 * mark.
 */
function AuthBrandMark({
  logoUrl,
  programName,
  whiteLabel,
  pending,
  size = 26,
}: {
  logoUrl: string | null;
  programName: string;
  whiteLabel: boolean;
  pending: boolean;
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
  if (whiteLabel || pending) {
    const initial = pending ? '' : (programName.trim()[0] ?? '?').toUpperCase();
    return (
      <div
        aria-label={programName}
        style={{
          width: size,
          height: size,
          borderRadius: 6,
          background: theme.surface2,
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
  return <Logo size={size} />;
}

/**
 * Tab strip for switching between brand and creator signup. Renders
 * above the form on both /signup and /creator/signup. Active tab
 * shows in the accent color; clicking the inactive tab navigates to
 * the other signup route, preserving the query string so plan-aware
 * marketing CTAs (?plan=flex) survive the switch.
 */
export function SignupTabs({ active }: { active: 'brand' | 'creator' }) {
  const location = useLocation();
  // Preserve search params (?plan=flex etc.) so a brand-side query
  // stays meaningful if the user toggles to creator and back.
  const qs = location.search;
  const tabs = [
    { key: 'brand' as const, label: 'Brand', href: `/signup${qs}` },
    { key: 'creator' as const, label: 'Creator', href: `/creator/signup${qs}` },
  ];
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: 4,
        background: theme.surface2,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusSm,
        marginBottom: 16,
      }}
    >
      {tabs.map((t) => {
        const isActive = active === t.key;
        return (
          <Link
            key={t.key}
            to={t.href}
            style={{
              flex: 1,
              textAlign: 'center',
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              color: isActive ? theme.accentInk : theme.textMuted,
              background: isActive ? theme.accent : 'transparent',
              transition: 'background 120ms, color 120ms',
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
