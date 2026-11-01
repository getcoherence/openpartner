import type { CSSProperties, ReactNode } from 'react';
import { alpha, theme } from './theme.js';
import { useIsMobile } from './lib/useMediaQuery.js';

// ---------------- Layout ----------------

export function Page({
  title,
  subtitle,
  back,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** A link back to the parent page, shown above the title. */
  back?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  return (
    <div style={{ padding: isMobile ? '20px 16px' : '32px 40px', maxWidth: 1280, margin: '0 auto' }}>
      <header
        style={{
          display: 'flex',
          // On mobile the title + actions stack so wide action buttons
          // don't squeeze the heading into an unreadable column.
          flexDirection: isMobile ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: isMobile ? 'stretch' : 'flex-end',
          marginBottom: isMobile ? 20 : 28,
          gap: isMobile ? 14 : 16,
        }}
      >
        <div>
          {back && <div style={{ fontSize: 13, marginBottom: 8 }}>{back}</div>}
          <h1 style={{ margin: 0, fontSize: isMobile ? 21 : 24, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</h1>
          {subtitle && (
            <div style={{ color: theme.textMuted, fontSize: 14, marginTop: 4 }}>{subtitle}</div>
          )}
        </div>
        {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
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
  maxHeight,
  footer,
}: {
  columns: (string | { label: string; align?: 'left' | 'right' })[];
  rows: ReactNode[][];
  empty?: string;
  /** Scrolls the rows within this height, both ways, with the header kept
   *  in view: the sideways scrollbar then never sits below the page fold. */
  maxHeight?: number;
  /** Under the rows, inside the scroll: a "load more", say. */
  footer?: ReactNode;
}) {
  const cols = columns.map((c) => (typeof c === 'string' ? { label: c, align: 'left' as const } : c));
  const isMobile = useIsMobile();

  // On phones, a multi-column table forces horizontal scrolling and hides
  // data off-screen. Reflow each row into a stacked "label: value" card so
  // every field is visible without scrolling sideways. The first column is
  // treated as the row's title (rendered full-width, larger).
  if (isMobile) {
    if (rows.length === 0) {
      return (
        <Card style={{ textAlign: 'center', color: theme.textDim, fontSize: 14 }}>{empty}</Card>
      );
    }
    return (
      <Card padded={false} style={{ overflow: 'hidden' }}>
        {rows.map((row, i) => (
          <div
            key={i}
            style={{
              padding: '14px 16px',
              borderBottom: i < rows.length - 1 ? `1px solid ${theme.borderSubtle}` : 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {row.map((cell, j) => {
              const isTitle = j === 0;
              return (
                <div
                  key={j}
                  style={
                    isTitle
                      ? { fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }
                      : {
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                          gap: 12,
                        }
                  }
                >
                  {!isTitle && (
                    <span
                      style={{
                        flexShrink: 0,
                        color: theme.textMuted,
                        fontSize: 11,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      {cols[j]?.label}
                    </span>
                  )}
                  <span
                    style={{
                      minWidth: 0,
                      textAlign: isTitle ? 'left' : 'right',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {cell}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {footer}
      </Card>
    );
  }

  return (
    <Card padded={false} style={{ overflow: 'hidden' }}>
      {/* Horizontal scroll as a fallback for very wide content on tablet/
          desktop widths; phones use the stacked card layout above. */}
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', ...(maxHeight !== undefined && { maxHeight, overflowY: 'auto' }) }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 'max-content' }}>
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
                  ...(maxHeight !== undefined && { position: 'sticky', top: 0, zIndex: 1 }),
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
      {footer}
      </div>
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
    secondary: { bg: theme.surface2, color: theme.text, border: theme.border, hoverBg: theme.surface3 },
    ghost: { bg: 'transparent', color: theme.text, border: 'transparent', hoverBg: theme.surface2 },
    danger: { bg: theme.dangerSoft, color: theme.danger, border: theme.dangerSoft, hoverBg: theme.dangerSoftHover },
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
        // A button wider than its label (width: 100%, flex: 1) keeps it centred.
        justifyContent: 'center',
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

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      style={{
        padding: '10px 12px',
        fontSize: 14,
        background: theme.surface2,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusSm,
        color: theme.text,
        width: '100%',
        fontFamily: 'inherit',
        resize: 'vertical',
        ...props.style,
      }}
    />
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
    invited: { bg: theme.warnSoft, fg: theme.warn },
    'pending review': { bg: theme.infoSoft, fg: theme.info },
    active: { bg: theme.successSoft, fg: theme.success },
    revoked: { bg: theme.dangerSoft, fg: theme.danger },
    // Performance bounties.
    draft: { bg: theme.surface2, fg: theme.textMuted },
    ended: { bg: theme.infoSoft, fg: theme.info },
    archived: { bg: theme.surface2, fg: theme.textDim },
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

/** Progress toward a goal (a performance bounty), with its label under the
 *  bar. Turns success-green once `value` reaches `threshold`. */
export function ProgressBar({ value, threshold, label }: { value: number; threshold: number; label: string }) {
  const pct = threshold > 0 ? Math.min(100, Math.round((value / threshold) * 100)) : 0;
  const done = value >= threshold;
  return (
    <div style={{ minWidth: 160 }}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={threshold}
        aria-valuenow={value}
        aria-label={label}
        style={{ height: 8, borderRadius: 999, background: theme.surface3, overflow: 'hidden' }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: done ? theme.success : theme.accent, transition: 'width 200ms ease' }} />
      </div>
      <div style={{ fontSize: 12, color: done ? theme.success : theme.textMuted, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{label}</div>
    </div>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .slice(0, 2)
    .join('');
  const hue = hashHue(name);
  // Saturation/lightness come from global.css (--op-avatar-*) so the disc
  // is dark-with-bright-ink on dark and pale-with-deep-ink on light; the
  // fallbacks are the dark values.
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `hsl(${hue}, var(--op-avatar-bg-s, 30%), var(--op-avatar-bg-l, 22%))`,
        color: `hsl(${hue}, var(--op-avatar-fg-s, 70%), var(--op-avatar-fg-l, 70%))`,
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
        border: `1px solid ${alpha(theme.danger, 0.2)}`,
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

/**
 * Amounts in several currencies, never added together: "₹1,023,377.00 +
 * $85,000.00". `primary` (the tenant's default currency) leads; with
 * nothing to show it formats a zero in it.
 */
export function moneyByCurrency(amounts: Record<string, number> | undefined, primary: string): string {
  const parts = Object.entries(amounts ?? {})
    .filter(([, n]) => n !== 0)
    .sort(([a], [b]) => (a === primary ? -1 : b === primary ? 1 : a.localeCompare(b)))
    .map(([currency, n]) => money(n, currency));
  return parts.length > 0 ? parts.join(' + ') : money(0, primary);
}

/** One status's amounts out of a `{ [currency]: { [status]: amount } }` map. */
export function statusAmounts(
  byCurrency: Record<string, Record<string, number>> | undefined,
  ...statuses: string[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [currency, byStatus] of Object.entries(byCurrency ?? {})) {
    const n = statuses.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
    if (n !== 0) out[currency] = n;
  }
  return out;
}

export function formatDate(d: string | Date | null, opts: { relative?: boolean } = {}): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (opts.relative) {
    // Future dates (a commission's matureAt) read "in 3d", past "3d ago".
    const diff = Date.now() - date.getTime();
    const abs = Math.abs(diff);
    const rel = (n: number, unit: string) => (diff < 0 ? `in ${n}${unit}` : `${n}${unit} ago`);
    const min = 60_000;
    if (abs < min) return 'just now';
    if (abs < 60 * min) return rel(Math.floor(abs / min), 'm');
    if (abs < 24 * 60 * min) return rel(Math.floor(abs / (60 * min)), 'h');
    if (abs < 30 * 24 * 60 * min) return rel(Math.floor(abs / (24 * 60 * min)), 'd');
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function shortId(id: string, chars: number = 8): string {
  return id.slice(0, chars);
}
