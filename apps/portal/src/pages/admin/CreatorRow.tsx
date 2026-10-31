/**
 * One creator in Discover creators' list, OpenPartner's or external: who
 * they are, their channels as logos with followers, their topics, their
 * reach, and the actions that fit them.
 *
 * On a wide screen the list sits beside the selected creator
 * (NetworkCreators.tsx), so a click selects (`onSelect`). Otherwise it
 * opens the creator's page (`to`).
 */

import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { theme } from '../../theme.js';
import { TenantLink } from '../../tenant-link.js';
import { useTenantBase } from '../../tenant-base.js';
import { ChannelCounts } from '../../lib/PlatformMark.js';

/** Clicks on these keep their own meaning instead of picking the row. */
const OWN_CLICK = 'a, button, input, select, textarea, label, [role="dialog"]';

export function CreatorRow({
  name,
  to,
  selected = false,
  onSelect,
  avatar,
  meta,
  line,
  channels,
  tags = [],
  side,
  note,
  actions,
}: {
  name: string;
  /** The creator's own page. */
  to: string;
  selected?: boolean;
  onSelect?: () => void;
  avatar: ReactNode;
  /** Beside the name: handle, badges, where they are. */
  meta?: ReactNode;
  /** Under the name: a headline. */
  line?: string | null;
  channels?: ReactNode;
  tags?: string[];
  /** Right-hand column: reach and the like. */
  side?: ReactNode;
  /** Above the actions: an invite already sent, why one can't be. */
  note?: ReactNode;
  actions?: ReactNode;
}) {
  const navigate = useNavigate();
  const tenantBase = useTenantBase();
  const nameStyle = { fontSize: 15, fontWeight: 600, color: theme.text, textDecoration: 'none' } as const;
  return (
    <div
      data-testid="creator-row"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(OWN_CLICK)) return;
        if (onSelect) onSelect();
        else navigate(`${tenantBase}${to}`);
      }}
      style={{
        display: 'flex',
        gap: 12,
        padding: '14px 16px',
        // The picked one: a faint wash of the accent (opaque, since the
        // list's rules show through gaps), marked down its left edge.
        background: selected ? `color-mix(in srgb, ${theme.accent} 6%, ${theme.surface})` : theme.surface,
        boxShadow: selected ? `inset 3px 0 0 ${theme.accent}` : undefined,
        cursor: 'pointer',
      }}
    >
      {avatar}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {onSelect ? (
                <button
                  type="button"
                  onClick={onSelect}
                  aria-current={selected || undefined}
                  style={{ ...nameStyle, background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                >
                  {name}
                </button>
              ) : (
                <TenantLink to={to} style={nameStyle}>
                  {name}
                </TenantLink>
              )}
              {meta}
            </div>
            {line && (
              <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line}</div>
            )}
            {channels && <ChannelCounts style={{ marginTop: 6 }}>{channels}</ChannelCounts>}
          </div>
          {side && <div style={{ textAlign: 'right', flexShrink: 0 }}>{side}</div>}
        </div>
        {note && <div style={{ fontSize: 12, marginTop: 8 }}>{note}</div>}
        {(tags.length > 0 || actions) && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {tags.slice(0, 5).map((t) => (
                <span key={t} style={{ background: theme.surface2, color: theme.textMuted, fontSize: 11, padding: '2px 8px', borderRadius: 10, border: `1px solid ${theme.borderSubtle}` }}>
                  {t}
                </span>
              ))}
              {tags.length > 5 && <span style={{ color: theme.textDim, fontSize: 11, padding: '2px 4px' }}>+{tags.length - 5}</span>}
            </div>
            {actions && <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>{actions}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Rows as one list, ruled between, rather than a stack of cards. */
export function CreatorList({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 1,
        background: theme.borderSubtle,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
}

/** The side panel's top bar: a word about the creator (`note`), its own
 *  actions, and the creator's full page. */
export function PanelBar({ to, note, children }: { to: string; note?: ReactNode; children?: ReactNode }) {
  return (
    // Stays at the top while the panel scrolls.
    <div style={{ position: 'sticky', top: 0, zIndex: 2, background: theme.surface, display: 'flex', gap: 12, alignItems: 'center', padding: '10px 16px' }}>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: theme.textMuted }}>{note}</div>
      {children}
      <TenantLink to={to} style={{ fontSize: 13, color: theme.accentText, textDecoration: 'none' }}>
        Open full page →
      </TenantLink>
    </div>
  );
}

/** The big number on the right of a row, with what it counts under it. */
export function RowFigure({ value, caption, accent }: { value: string; caption?: string | null; accent?: boolean }) {
  return (
    <>
      <div style={{ fontSize: 18, fontWeight: 600, color: theme.text, lineHeight: 1.2 }}>{value}</div>
      {caption && <div style={{ fontSize: 12, color: accent ? theme.success : theme.textMuted, marginTop: 2, whiteSpace: 'nowrap' }}>{caption}</div>}
    </>
  );
}
