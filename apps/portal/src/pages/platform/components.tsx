import type { ReactNode } from 'react';
import { theme } from '../../theme.js';
import { Logo } from '../auth/Shared.js';
import type { ApprovalStatus } from './lib.js';

/**
 * Centered card frame for the operator-facing pre-console pages (sign-in +
 * magic-link landing). Deliberately shows the OpenPartner mark — this is a
 * staff surface on the platform origin, never a tenant-branded page.
 */
export function PlatformFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
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
          maxWidth: '100%',
          boxShadow: '0 30px 80px -30px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <Logo />
          <div style={{ fontSize: 16, fontWeight: 600 }}>OpenPartner</div>
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', marginBottom: 4 }}>{title}</div>
        {subtitle && <div style={{ color: theme.textMuted, fontSize: 13, marginBottom: 20 }}>{subtitle}</div>}
        {children}
        <div
          style={{
            marginTop: 22,
            paddingTop: 14,
            borderTop: `1px solid ${theme.borderSubtle}`,
            fontSize: 11,
            color: theme.textDim,
            textAlign: 'center',
          }}
        >
          Platform operations console — OpenPartner staff only.
        </div>
      </div>
    </div>
  );
}

function Pill({ label, tone }: { label: string; tone: { bg: string; fg: string } }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: tone.bg,
        color: tone.fg,
        padding: '3px 9px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'lowercase',
        letterSpacing: '0.02em',
      }}
    >
      {label}
    </span>
  );
}

export function ApprovalBadge({ status }: { status: ApprovalStatus }) {
  const tones: Record<ApprovalStatus, { bg: string; fg: string }> = {
    pending: { bg: theme.warnSoft, fg: theme.warn },
    approved: { bg: theme.successSoft, fg: theme.success },
    rejected: { bg: theme.dangerSoft, fg: theme.danger },
  };
  return <Pill label={status} tone={tones[status]} />;
}

export function StatusBadge({ status }: { status: string }) {
  const tones: Record<string, { bg: string; fg: string }> = {
    active: { bg: theme.successSoft, fg: theme.success },
    suspended: { bg: theme.warnSoft, fg: theme.warn },
    cancelled: { bg: theme.dangerSoft, fg: theme.danger },
  };
  return <Pill label={status} tone={tones[status] ?? { bg: theme.surface2, fg: theme.textMuted }} />;
}

/** Compact, monospace rendering of an audit event's `detail` blob. */
export function JsonPreview({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span style={{ color: theme.textDim }}>—</span>;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === '{}' || text === '') return <span style={{ color: theme.textDim }}>—</span>;
  return (
    <code
      style={{
        fontFamily: theme.fontMono,
        fontSize: 12,
        color: theme.textMuted,
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </code>
  );
}
