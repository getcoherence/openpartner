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
          <Link to="/signup">
            <span
              style={{
                background: theme.accent,
                color: theme.accentInk,
                padding: '8px 14px',
                borderRadius: theme.radiusSm,
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Create a program
            </span>
          </Link>
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

          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 28, flexWrap: 'wrap' }}>
            <Link to="/signup">
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  background: theme.accent,
                  color: theme.accentInk,
                  padding: '12px 18px',
                  borderRadius: theme.radiusSm,
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                Create your program <ArrowRight size={15} />
              </span>
            </Link>
            <a href="https://openpartner.dev/docs" style={{ display: 'inline-flex', alignItems: 'center', padding: '12px 18px', color: theme.textMuted, fontSize: 14 }}>
              Read the docs →
            </a>
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
