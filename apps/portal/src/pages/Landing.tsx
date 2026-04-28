import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { theme } from '../theme.js';
import { Logo } from './auth/Shared.js';

/**
 * Public landing for the multi-tenant deployment. Voice mirrors the
 * marketing site at openpartner.dev — plain English, brand+creator
 * parity, no engineering jargon. The marketing site sells; this
 * landing is the door into the app.
 *
 * Auto-redirect: on mount, probe the brand session (op_session) and the
 * creator session (op_network_creator_session via the proxy) in parallel.
 * If either matches, navigate the visitor straight into their portal —
 * no point showing them the marketing splash if they're already signed in.
 */
export function LandingPage() {
  const nav = useNavigate();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function go(home: string) {
      if (!cancelled) nav(home, { replace: true });
    }
    Promise.all([
      fetch('/api/session/home', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : { home: null }))
        .catch(() => ({ home: null })),
      fetch('/api/creator-api/creators/whoami', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : { creator: null }))
        .catch(() => ({ creator: null })),
    ]).then(([brand, creator]: [{ home?: string | null }, { creator: unknown }]) => {
      if (cancelled) return;
      if (brand?.home) return go(brand.home);
      if (creator?.creator) return go('/creator');
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [nav]);

  if (checking) {
    return (
      <div style={{ minHeight: '100vh', background: theme.bg }} />
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: theme.bg, color: theme.text, display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          padding: '20px 32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${theme.borderSubtle}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Logo />
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>OpenPartner</div>
        </div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', fontSize: 13 }}>
          <a href="https://openpartner.dev" style={{ color: theme.textMuted }}>About</a>
          <a href="https://openpartner.dev/pricing" style={{ color: theme.textMuted }}>Pricing</a>
          <Link to="/signin" style={{ color: theme.textMuted }}>Sign in</Link>
        </div>
      </header>

      <main style={{ flex: 1, padding: '64px 24px 32px' }}>
        <div style={{ maxWidth: 880, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: theme.accent, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 16 }}>
            Partner program software with a built-in network
          </div>
          <h1 style={{ fontSize: 48, lineHeight: 1.1, margin: 0, letterSpacing: '-0.02em', fontWeight: 700 }}>
            Launch a partner program.<br />Grow it with the Network.
          </h1>
          <p style={{ marginTop: 24, fontSize: 17, color: theme.textMuted, lineHeight: 1.55, maxWidth: 720, marginInline: 'auto' }}>
            Brands launch affiliate, referral, and creator programs with visible commission terms and
            direct Stripe payouts. Creators browse real offers and keep what they earn.
          </p>
        </div>

        <div style={{ maxWidth: 1040, margin: '56px auto 0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 20 }}>
          <AudienceCard
            eyebrow="For brands"
            title="Partner program software for brands that want more than tracking."
            bullets={[
              'Track every conversion back to the partner who drove it',
              'Set flat, percentage, or recurring commission terms',
              'Recruit creators from the Network when you want more reach',
              'Pay partners directly through Stripe without a middleman cut',
            ]}
            ctaLabel="Sign up as a brand"
            to="/signup"
          />
          <AudienceCard
            eyebrow="For creators"
            title="A creator marketplace with real terms and direct payouts."
            bullets={[
              'See commission rates before you apply to any program',
              'Browse partner offers across affiliate, referral, and creator programs',
              'Get paid directly by brands through Stripe',
              'No exclusivity and no platform cut on your earnings',
            ]}
            ctaLabel="Sign up as a creator"
            to="/creator/signup"
          />
        </div>

        <div style={{ marginTop: 48, textAlign: 'center', color: theme.textDim, fontSize: 13 }}>
          Already have an account? <Link to="/signin" style={{ color: theme.accent }}>Sign in</Link>
        </div>
      </main>

      <footer style={{ padding: '20px 32px', borderTop: `1px solid ${theme.borderSubtle}`, color: theme.textDim, fontSize: 12, textAlign: 'center' }}>
        OpenPartner is open source. <a href="https://openpartner.dev" style={{ color: theme.textMuted }}>Learn more</a>
      </footer>
    </div>
  );
}

function AudienceCard({ eyebrow, title, bullets, ctaLabel, to }: { eyebrow: string; title: string; bullets: string[]; ctaLabel: string; to: string }) {
  return (
    <Link
      to={to}
      style={{
        display: 'block',
        background: theme.surface,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: 18,
        padding: 28,
        color: theme.text,
        transition: 'border-color 0.18s, transform 0.18s',
        textDecoration: 'none',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = theme.accent;
        e.currentTarget.style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = theme.borderSubtle;
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <div style={{ fontSize: 11, color: theme.accent, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>{eyebrow}</div>
      <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3, marginBottom: 16, letterSpacing: '-0.01em' }}>{title}</div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 24px' }}>
        {bullets.map((b) => (
          <li key={b} style={{ color: theme.textMuted, fontSize: 14, padding: '6px 0 6px 20px', position: 'relative', lineHeight: 1.55 }}>
            <span style={{ position: 'absolute', left: 0, color: theme.accent, fontWeight: 700 }}>›</span>
            {b}
          </li>
        ))}
      </ul>
      <span style={{ color: theme.accent, fontWeight: 600, fontSize: 14 }}>{ctaLabel} →</span>
    </Link>
  );
}
