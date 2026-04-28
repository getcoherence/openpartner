import type { ReactNode } from 'react';
import { theme } from '../../theme.js';

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
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: `radial-gradient(1200px 800px at 50% -20%, ${theme.accentSoft}40, transparent), ${theme.bg}`,
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
          <Logo />
          <div style={{ fontSize: 18, fontWeight: 600 }}>{brand ?? 'OpenPartner'}</div>
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
