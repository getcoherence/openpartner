import { Link } from 'react-router-dom';
import { ArrowRight, Globe, Receipt, ShieldCheck } from 'lucide-react';
import { theme } from '../theme.js';
import { Logo } from './auth/Shared.js';

/**
 * Public landing for multi-tenant deployments. The single-tenant build
 * never mounts this — its root goes straight to the Shell. Two CTAs:
 * create a program (signup) or sign in (you'll need a tenant slug, but
 * if the link the operator emailed you was the magic link, you went to
 * /t/<slug>/auth/magic and never see this page).
 */
export function LandingPage() {
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
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 13 }}>
          <a href="https://openpartner.dev" style={{ color: theme.textMuted }}>About</a>
          <Link to="/creator/login" style={{ color: theme.textMuted }}>Creator sign in</Link>
        </div>
      </header>

      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' }}>
        <div style={{ maxWidth: 720, textAlign: 'center' }}>
          <h1 style={{ fontSize: 44, lineHeight: 1.1, margin: 0, letterSpacing: '-0.02em' }}>
            The partner program your data outlives.
          </h1>
          <p style={{ marginTop: 20, fontSize: 17, color: theme.textMuted, lineHeight: 1.5 }}>
            Click → identity → revenue, surviving Safari ITP and 30-day cookie windows.
            Your raw attribution log is exportable to CSV/JSON/SQL — leave anytime, your history comes with you.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 32, textAlign: 'left' }}>
            <CtaCard
              eyebrow="For vendors"
              title="Run your own partner program"
              body="Create a tenant, invite partners, track every click → signup → revenue, run payouts via Stripe Connect."
              ctaLabel="Create your program"
              to="/signup"
            />
            <CtaCard
              eyebrow="For creators"
              title="Browse and apply to programs"
              body="One profile, many programs. Discover vendors across the OpenPartner Network and apply with one click."
              ctaLabel="Sign up as a creator"
              to="/creator/signup"
            />
          </div>

          <div style={{ marginTop: 24, fontSize: 13, color: theme.textDim }}>
            Already have an account? <Link to="/creator/login" style={{ color: theme.accent }}>Creator sign in</Link>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginTop: 56, textAlign: 'left' }}>
            <Pill icon={<Globe size={16} />} title="Federation built in">
              List on the OpenPartner Network and creators across other vendors can discover and apply to your program.
            </Pill>
            <Pill icon={<Receipt size={16} />} title="Three-tier pricing">
              Self-host (free), flat fee, or 3% rev share. Pick at signup. No cookie-cutter contracts.
            </Pill>
            <Pill icon={<ShieldCheck size={16} />} title="Your data, exportable">
              CSV/JSON/SQL export of every raw row. The self-hosted build re-imports it cleanly.
            </Pill>
          </div>
        </div>
      </main>

      <footer style={{ padding: '20px 32px', borderTop: `1px solid ${theme.borderSubtle}`, color: theme.textDim, fontSize: 12, textAlign: 'center' }}>
        Already have a program? Open the link the operator emailed you, or visit <code>/t/&lt;your-slug&gt;/login</code>.
      </footer>
    </div>
  );
}

function CtaCard({ eyebrow, title, body, ctaLabel, to }: { eyebrow: string; title: string; body: string; ctaLabel: string; to: string }) {
  return (
    <div style={{ background: theme.surface, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: 20 }}>
      <div style={{ fontSize: 11, color: theme.accent, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>{eyebrow}</div>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <p style={{ color: theme.textMuted, fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>{body}</p>
      <Link to={to}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: theme.accent,
            color: theme.accentInk,
            padding: '10px 14px',
            borderRadius: theme.radiusSm,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {ctaLabel} <ArrowRight size={14} />
        </span>
      </Link>
    </div>
  );
}

function Pill({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: theme.surface, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: theme.accent, fontSize: 13, marginBottom: 6 }}>
        {icon}
        <span style={{ color: theme.text, fontWeight: 600 }}>{title}</span>
      </div>
      <div style={{ color: theme.textMuted, fontSize: 13, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}
