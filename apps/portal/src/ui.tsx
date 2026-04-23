import type { CSSProperties, ReactNode } from 'react';
import { theme } from './theme.js';

// ---------------- Layout ----------------

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={{ padding: '32px 40px', maxWidth: 1280, margin: '0 auto' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          marginBottom: 28,
          gap: 16,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</h1>
          {subtitle && (
            <div style={{ color: theme.textMuted, fontSize: 14, marginTop: 4 }}>{subtitle}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>{actions}</div>
      </header>
      {children}
    </div>
  );
}

// ---------------- Card ----------------

export function Card({
  children,
  style,
  padded = true,
  onClick,
}: {
  children: ReactNode;
  style?: CSSProperties;
  padded?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusMd,
        padding: padded ? 20 : 0,
        cursor: onClick ? 'pointer' : 'default',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function SectionHeading({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '28px 0 12px' }}>
      <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {children}
      </h2>
      <div>{actions}</div>
    </div>
  );
}

// ---------------- Stat ----------------

export function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: number | string;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {label}
        </div>
        {icon && <div style={{ color: theme.textDim }}>{icon}</div>}
      </div>
      <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>{hint}</div>}
    </Card>
  );
}

// ---------------- Table ----------------

export function Table({
  columns,
  rows,
  empty = 'No rows yet.',
}: {
  columns: (string | { label: string; align?: 'left' | 'right' })[];
  rows: ReactNode[][];
  empty?: string;
}) {
  const cols = columns.map((c) => (typeof c === 'string' ? { label: c, align: 'left' as const } : c));
  return (
    <Card padded={false} style={{ overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.label}
                style={{
                  textAlign: c.align ?? 'left',
                  padding: '12px 18px',
                  fontWeight: 500,
                  color: theme.textMuted,
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  borderBottom: `1px solid ${theme.border}`,
                  background: theme.surface2,
                }}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={cols.length} style={{ padding: 32, textAlign: 'center', color: theme.textDim, fontSize: 14 }}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${theme.borderSubtle}` : 'none' }}>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    style={{
                      padding: '14px 18px',
                      textAlign: cols[j]?.align ?? 'left',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------- Button ----------------

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  size = 'md',
  type,
  style,
  icon,
}: {
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  type?: 'button' | 'submit';
  style?: CSSProperties;
  icon?: ReactNode;
}) {
  const palettes = {
    primary: { bg: theme.accent, color: theme.accentInk, border: theme.accent, hoverBg: theme.accentHover },
    secondary: { bg: theme.surface2, color: theme.text, border: theme.border, hoverBg: '#252a33' },
    ghost: { bg: 'transparent', color: theme.text, border: 'transparent', hoverBg: theme.surface2 },
    danger: { bg: theme.dangerSoft, color: theme.danger, border: theme.dangerSoft, hoverBg: '#3d1818' },
  } as const;
  const p = palettes[variant];
  const padY = size === 'sm' ? 6 : 8;
  const padX = size === 'sm' ? 10 : 14;
  const fontSize = size === 'sm' ? 13 : 14;

  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: p.bg,
        color: p.color,
        border: `1px solid ${p.border}`,
        borderRadius: theme.radiusSm,
        padding: `${padY}px ${padX}px`,
        fontSize,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 120ms ease, transform 60ms ease',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = p.hoverBg;
      }}
      onMouseLeave={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = p.bg;
      }}
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------- Input / Label ----------------

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        padding: '10px 12px',
        fontSize: 14,
        background: theme.surface2,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusSm,
        color: theme.text,
        width: '100%',
        fontFamily: theme.fontSans,
        ...props.style,
      }}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select
      {...props}
      style={{
        padding: '10px 12px',
        fontSize: 14,
        background: theme.surface2,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusSm,
        color: theme.text,
        width: '100%',
        fontFamily: theme.fontSans,
        ...props.style,
      }}
    >
      {props.children}
    </select>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <label
      style={{
        display: 'block',
        fontSize: 12,
        color: theme.textMuted,
        marginBottom: 6,
        fontWeight: 500,
      }}
    >
      {children}
    </label>
  );
}

// ---------------- Badge / StatusPill ----------------

export function StatusPill({ status }: { status: string }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    accrued: { bg: theme.warnSoft, fg: theme.warn },
    approved: { bg: theme.infoSoft, fg: theme.info },
    paid: { bg: theme.successSoft, fg: theme.success },
    reversed: { bg: theme.dangerSoft, fg: theme.danger },
    pending: { bg: theme.surface2, fg: theme.textMuted },
    failed: { bg: theme.dangerSoft, fg: theme.danger },
    connected: { bg: theme.successSoft, fg: theme.success },
  };
  const c = palette[status] ?? { bg: theme.surface2, fg: theme.textMuted };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: c.bg,
        color: c.fg,
        padding: '3px 9px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'lowercase',
        letterSpacing: '0.02em',
      }}
    >
      {status}
    </span>
  );
}

// ---------------- Avatar ----------------

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .slice(0, 2)
    .join('');
  const hue = hashHue(name);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `hsl(${hue}, 30%, 22%)`,
        color: `hsl(${hue}, 70%, 70%)`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.4,
        fontWeight: 600,
        letterSpacing: '0.02em',
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

// ---------------- Feedback ----------------

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div
      style={{
        background: theme.dangerSoft,
        color: theme.danger,
        padding: '10px 14px',
        borderRadius: theme.radiusSm,
        marginBottom: 16,
        fontSize: 13,
        border: `1px solid ${theme.danger}33`,
      }}
    >
      {msg}
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <Card style={{ textAlign: 'center', padding: '48px 24px' }}>
      {icon && <div style={{ color: theme.textDim, marginBottom: 12, display: 'inline-flex' }}>{icon}</div>}
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 13, color: theme.textMuted }}>{hint}</div>}
    </Card>
  );
}

// ---------------- Formatters ----------------

export function money(amount: number | string | null, currency: string = 'USD'): string {
  const n = typeof amount === 'number' ? amount : amount == null ? 0 : Number(amount);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
}

export function formatDate(d: string | Date | null, opts: { relative?: boolean } = {}): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (opts.relative) {
    const diff = Date.now() - date.getTime();
    const min = 60_000;
    if (diff < min) return 'just now';
    if (diff < 60 * min) return `${Math.floor(diff / min)}m ago`;
    if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))}h ago`;
    if (diff < 30 * 24 * 60 * min) return `${Math.floor(diff / (24 * 60 * min))}d ago`;
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function shortId(id: string, chars: number = 8): string {
  return id.slice(0, chars);
}
