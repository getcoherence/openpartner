import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { alpha, theme } from './theme.js';
import { MIN_COLUMN_WIDTH, useColumnWidths, type ColumnWidths } from './lib/columnWidths.js';
import { useIsMobile } from './lib/useMediaQuery.js';
import { useViewOnly, ViewOnlyFieldset } from './lib/viewOnly.js';

// ---------------- Layout ----------------

export function Page({
  title,
  subtitle,
  back,
  actions,
  edits,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** A link back to the parent page, shown above the title. */
  back?: ReactNode;
  actions?: ReactNode;
  /** A page of edits (forms, connections): on a view-only seat its
   *  actions are hidden and its controls disabled (lib/viewOnly.tsx). */
  edits?: boolean;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const locked = useViewOnly() && !!edits;
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
        {actions && !locked && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
      </header>
      {locked ? <ViewOnlyFieldset>{children}</ViewOnlyFieldset> : children}
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
  dense,
  resizeKey,
}: {
  columns: (string | { label: string; align?: 'left' | 'right' })[];
  rows: ReactNode[][];
  empty?: string;
  /** Scrolls the rows within this height, both ways, with the header kept
   *  in view: the sideways scrollbar then never sits below the page fold. */
  maxHeight?: number;
  /** Under the rows, inside the scroll: a "load more", say. */
  footer?: ReactNode;
  /** Tighter cells, for a wide table to fit a laptop screen. */
  dense?: boolean;
  /** Lets the viewer drag column widths, saved under this key per viewer
   *  (lib/columnWidths.tsx). Not on phones, where rows are cards. */
  resizeKey?: string;
}) {
  const cols = columns.map((c) => (typeof c === 'string' ? { label: c, align: 'left' as const } : c));
  const isMobile = useIsMobile();
  const resizable = !!resizeKey && !isMobile;
  const ids = cols.map((c, i) => c.label || `#${i}`);
  const [saved, saveWidths] = useColumnWidths(resizeKey);
  // Every column's width while a drag is under way.
  const [dragging, setDragging] = useState<{ id: string; widths: ColumnWidths } | null>(null);
  // Content widths for columns with no saved width beside ones with one.
  const [fitted, setFitted] = useState<ColumnWidths>({});
  // The column whose edge has keyboard focus, lit in its header.
  const [focused, setFocused] = useState<string | null>(null);
  const headers = useRef<(HTMLTableCellElement | null)[]>([]);
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  const widths = dragging?.widths ?? saved;
  const hasSaved = resizable && ids.some((id) => widths[id] !== undefined);
  const colWidths = ids.map((id) => widths[id] ?? fitted[id]);
  // Laid out by width once the viewer has set one; until then by content.
  const fixed = hasSaved && colWidths.every((w) => w !== undefined);
  // A column with no width of its own (a view's new column, or one just
  // reset) is laid out by content for one pass, measured before paint.
  const measuring = hasSaved && !fixed && rows.length > 0;
  useLayoutEffect(() => {
    if (!measuring) return;
    const next: ColumnWidths = {};
    ids.forEach((id, i) => {
      if (widths[id] === undefined) next[id] = measureColumn(headers.current[i]);
    });
    setFitted((f) => ({ ...f, ...next }));
  });

  /** The widths on screen, as saved: what a drag or a key starts from. */
  const onScreen = (): ColumnWidths =>
    Object.fromEntries(ids.map((id, i) => [id, fixed ? colWidths[i]! : measureColumn(headers.current[i])]));

  function startDrag(i: number, e: ReactPointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const id = ids[i]!;
    const start = onScreen();
    const startX = e.clientX;
    let moved: ColumnWidths | null = null;
    const body = document.body.style;
    const before = { cursor: body.cursor, userSelect: body.userSelect };
    body.cursor = 'col-resize';
    body.userSelect = 'none';
    const move = (ev: PointerEvent) => {
      moved = { ...start, [id]: Math.max(MIN_COLUMN_WIDTH, Math.round(start[id]! + ev.clientX - startX)) };
      setDragging({ id, widths: { ...saved, ...moved } });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      endDrag.current = null;
      body.cursor = before.cursor;
      body.userSelect = before.userSelect;
      setDragging(null);
      if (moved) saveWidths({ ...saved, ...moved });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    endDrag.current = end;
  }

  function nudge(i: number, e: ReactKeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const id = ids[i]!;
    const now = onScreen();
    saveWidths({ ...saved, ...now, [id]: Math.max(MIN_COLUMN_WIDTH, now[id]! + (e.key === 'ArrowRight' ? 16 : -16)) });
  }

  /** Back to its content width. */
  function fit(i: number) {
    const id = ids[i]!;
    const { [id]: _, ...rest } = saved;
    setFitted(({ [id]: _f, ...f }) => f);
    saveWidths(rest);
  }

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
      {resizable && (
        // The edges for keyboards and screen readers, out of the headers so
        // their labels stay out of the headers' names. Focus lights the
        // edge in its header; the edges there are for pointers.
        <div style={visuallyHidden}>
          {cols.map((c, i) => (
            <div
              key={ids[i]}
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${c.label || `column ${i + 1}`}`}
              aria-valuemin={MIN_COLUMN_WIDTH}
              aria-valuenow={fixed ? colWidths[i] : undefined}
              tabIndex={0}
              onKeyDown={(e) => nudge(i, e)}
              onFocus={() => setFocused(ids[i]!)}
              onBlur={() => setFocused(null)}
            />
          ))}
        </div>
      )}
      {/* Horizontal scroll as a fallback for very wide content on tablet/
          desktop widths; phones use the stacked card layout above. */}
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', ...(maxHeight !== undefined && { maxHeight, overflowY: 'auto' }) }}>
      <table
        // Fixed layout: cells' own width caps give way (global.css), and an
        // empty last column takes whatever width the others leave.
        className={fixed ? 'op-table-fixed' : undefined}
        style={{
          width: measuring ? 'auto' : '100%',
          borderCollapse: 'collapse',
          fontSize: 14,
          ...(fixed ? { tableLayout: 'fixed', minWidth: colWidths.reduce<number>((sum, w) => sum + w!, 0) } : { minWidth: 'max-content' }),
        }}
      >
        {fixed && (
          <colgroup>
            {colWidths.map((w, i) => (
              <col key={ids[i]} style={{ width: w }} />
            ))}
            <col />
          </colgroup>
        )}
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th
                key={ids[i]}
                ref={(el) => {
                  headers.current[i] = el;
                }}
                style={{
                  textAlign: c.align ?? 'left',
                  padding: dense ? '10px 12px' : '12px 18px',
                  fontWeight: 500,
                  color: theme.textMuted,
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  borderBottom: `1px solid ${theme.border}`,
                  background: theme.surface2,
                  ...(resizable && { position: 'relative' }),
                  ...(maxHeight !== undefined && { position: 'sticky', top: 0, zIndex: 1 }),
                  ...(fixed && { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
                }}
              >
                {c.label}
                {resizable && (
                  <ColumnResizer
                    column={ids[i]!}
                    active={dragging?.id === ids[i] || focused === ids[i]}
                    onPointerDown={(e) => startDrag(i, e)}
                    onDoubleClick={() => fit(i)}
                  />
                )}
              </th>
            ))}
            {fixed && (
              <th
                aria-hidden
                style={{
                  padding: 0,
                  borderBottom: `1px solid ${theme.border}`,
                  background: theme.surface2,
                  ...(maxHeight !== undefined && { position: 'sticky', top: 0, zIndex: 1 }),
                }}
              />
            )}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={cols.length + (fixed ? 1 : 0)} style={{ padding: 32, textAlign: 'center', color: theme.textDim, fontSize: 14 }}>
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
                      padding: dense ? '10px 12px' : '14px 18px',
                      textAlign: cols[j]?.align ?? 'left',
                      fontVariantNumeric: 'tabular-nums',
                      ...(fixed && { overflow: 'hidden', overflowWrap: 'anywhere' }),
                    }}
                  >
                    {cell}
                  </td>
                ))}
                {fixed && <td aria-hidden style={{ padding: 0 }} />}
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

function measureColumn(th: HTMLTableCellElement | null | undefined): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.round(th?.getBoundingClientRect().width ?? 0));
}

const visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** A header's right edge, for pointers: drag it, or double-click to fit the
 *  column to its content again. Lit while dragged, hovered or focused. */
function ColumnResizer({
  column,
  active,
  onPointerDown,
  onDoubleClick,
}: {
  column: string;
  active: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onDoubleClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      aria-hidden
      data-resize-column={column}
      title="Drag to resize · double-click to fit"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 9,
        display: 'flex',
        justifyContent: 'center',
        cursor: 'col-resize',
        touchAction: 'none',
      }}
    >
      <div style={{ width: 2, background: hover || active ? theme.accent : theme.border }} />
    </div>
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

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
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
