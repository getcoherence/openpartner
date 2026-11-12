import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { theme } from '../../theme.js';
import { currentTenantSlug } from '../../api.js';
import { usePublicBrand } from '../../lib/useBrand.js';
import { useMediaQuery } from '../../lib/useMediaQuery.js';
import { ThemeToggle } from '../../lib/ThemeToggle.js';
import { CookieSettingsButton } from '../../lib/ConsentBanner.js';

/** Width from which a page that asked for the side panel gets two columns. */
export const AUTH_SPLIT_MIN_WIDTH = 900;

export function AuthFrame({
  title,
  subtitle,
  brand,
  panel,
  children,
}: {
  title: string;
  subtitle?: string;
  brand?: string;
  /** OpenPartner's own pitch, shown beside the form on wide screens. Only
   *  the platform's own sign-up and sign-in pages pass it, and it is still
   *  dropped whenever the page resolves to a tenant (see below). */
  panel?: ReactNode;
  children: ReactNode;
}) {
  // Pre-auth brand bootstrap: the public /branding endpoint resolves the
  // tenant from the custom-domain host or the /t/<slug>/ prefix, so a
  // white-label tenant's sign-in page never shows platform branding. On
  // platform pages it returns nulls and we keep the OpenPartner default.
  const publicBrand = usePublicBrand();
  const name = brand ?? (publicBrand.isLoading ? '' : publicBrand.programName);
  const wide = useMediaQuery(`(min-width: ${AUTH_SPLIT_MIN_WIDTH}px)`);
  // The panel is OpenPartner talking about itself, so a page that belongs
  // to a tenant never gets it, whatever the caller passed: a /t/<slug>/
  // URL, a host that resolved to a tenant (custom domain, or 'default' on
  // a single-tenant install), a white-label brand, or a brand's own logo.
  const tenantPage =
    brand !== undefined ||
    currentTenantSlug() !== null ||
    publicBrand.tenantSlug !== null ||
    publicBrand.whiteLabel ||
    publicBrand.logoUrl !== null;
  // While /branding is in flight the column is held open but empty, so a
  // platform page doesn't jump from centred to split and a tenant page
  // never flashes the pitch.
  const split = Boolean(panel) && wide && (publicBrand.isLoading || !tenantPage);
  const showPanel = split && !publicBrand.isLoading;

  const form = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 0,
        ...(split ? { padding: '24px 8px' } : { minHeight: '100vh', background: theme.bg, padding: 24 }),
      }}
    >
      <div
        style={{
          width: 420,
          // Column flex doesn't shrink widths the way the old row layout
          // did, so cap it explicitly for phones.
          maxWidth: '100%',
          // Beside the panel the form sits straight on the page; on its
          // own it keeps the card.
          ...(split
            ? { padding: '8px 0' }
            : {
                background: theme.surface,
                border: `1px solid ${theme.border}`,
                padding: 32,
                borderRadius: theme.radiusLg,
                boxShadow: theme.shadowRaised,
              }),
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
      {/* Footer-style, below the card: reachable on every public page
          without competing with the form. */}
      <ThemeToggle style={{ marginTop: 16 }} />
      <CookieSettingsButton style={{ marginTop: 8 }} />
    </div>
  );

  if (!split) return form;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        gap: 16,
        minHeight: '100vh',
        boxSizing: 'border-box',
        background: theme.bg,
        padding: 16,
      }}
    >
      {form}
      {/* Stays in view while a long form scrolls. */}
      <div style={{ position: 'sticky', top: 16, alignSelf: 'start', height: 'calc(100vh - 32px)', minHeight: 480 }}>
        {showPanel && panel}
      </div>
    </div>
  );
}

// The marketing site's ink green. Fixed, not theme tokens: the panel is
// dark in both themes, and the hairline keeps its edge on the dark page.
const PANEL_BG = '#0a1a12';
const PANEL_RULE = '#1f3a2c';
const PANEL_TEXT = '#f1f6f3';
const PANEL_MUTED = '#a3b8ac';
const PANEL_MARK = '#34d399';

interface PanelCopy {
  headline: ReactNode;
  points: { title: string; body?: string }[];
}

const PANEL_COPY: Record<'brand' | 'creator' | 'signin', PanelCopy> = {
  brand: {
    headline: (
      <>
        Every sale credited. <span style={{ display: 'block', color: PANEL_MARK }}>Every partner paid.</span>
      </>
    ),
    points: [
      {
        title: 'Creators find your program',
        body: 'It is listed on the built-in marketplace, where creators browse and apply.',
      },
      {
        title: 'Followed from click to paid invoice',
        body: 'A referral keeps its credit across devices and the weeks between the click and the purchase.',
      },
      {
        title: 'What each partner is owed, worked out',
        body: 'OpenPartner does the commission maths and never holds the money.',
      },
      {
        title: 'Free for creators',
        body: 'Creators join and earn without paying anything.',
      },
    ],
  },
  creator: {
    headline: (
      <>
        Recommend what you love. <span style={{ display: 'block', color: PANEL_MARK }}>Keep every dollar.</span>
      </>
    ),
    points: [
      {
        title: 'Free for creators',
        body: 'You never pay to join, and OpenPartner never takes a cut of a commission.',
      },
      {
        title: 'Programs in one marketplace',
        body: 'Browse brands and apply to the ones you already recommend.',
      },
      {
        title: 'Credit from click to paid invoice',
        body: 'Your referral is followed across devices, so a sale that takes weeks still counts.',
      },
    ],
  },
  signin: {
    headline: (
      <>
        Every sale credited. <span style={{ display: 'block', color: PANEL_MARK }}>Every partner paid.</span>
      </>
    ),
    points: [
      { title: 'Referrals followed from click to paid invoice, across devices.' },
      { title: 'What each partner is owed, worked out for you.' },
      { title: 'OpenPartner never holds the money.' },
    ],
  },
};

/**
 * OpenPartner's pitch for the right-hand side of its own sign-up and
 * sign-in pages. Pass it as AuthFrame's `panel`; never render it on a page
 * a tenant owns.
 */
export function AuthPanel({ variant }: { variant: keyof typeof PANEL_COPY }) {
  const copy = PANEL_COPY[variant];
  return (
    <aside
      data-testid="auth-panel"
      style={{
        height: '100%',
        boxSizing: 'border-box',
        background: PANEL_BG,
        border: `1px solid ${PANEL_RULE}`,
        borderRadius: 20,
        color: PANEL_TEXT,
        padding: 'clamp(32px, 5vw, 72px)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <div style={{ maxWidth: 460 }}>
        <h2 style={{ margin: 0, fontSize: 'clamp(28px, 3vw, 40px)', lineHeight: 1.12, fontWeight: 600, letterSpacing: '-0.025em' }}>
          {copy.headline}
        </h2>
        <ul style={{ listStyle: 'none', margin: '36px 0 0', padding: 0 }}>
          {copy.points.map((p) => (
            <li key={p.title} style={{ borderTop: `1px solid ${PANEL_RULE}`, padding: '16px 0' }}>
              <div style={{ fontSize: 15, fontWeight: p.body ? 600 : 400, lineHeight: 1.4 }}>{p.title}</div>
              {p.body && <div style={{ marginTop: 4, fontSize: 14, lineHeight: 1.5, color: PANEL_MUTED }}>{p.body}</div>}
            </li>
          ))}
        </ul>
      </div>
    </aside>
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
 * "Approval required" note for signup pages whose new accounts wait for
 * operator review: brands (every public signup lands pending, see
 * routes/signup.ts) and Network creators (Creator.reviewStatus starts
 * pending). Shown above the form so nobody first learns it after signing up.
 */
export function ReviewNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      style={{
        background: theme.surface2,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusSm,
        padding: '10px 12px',
        marginBottom: 14,
        fontSize: 12,
        lineHeight: 1.5,
        color: theme.textMuted,
      }}
    >
      <strong style={{ color: theme.text, fontWeight: 600 }}>Approval required.</strong> {children}
    </div>
  );
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
