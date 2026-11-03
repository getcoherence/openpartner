import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { Eye } from 'lucide-react';
import type { Principal } from '../api.js';
import { theme } from '../theme.js';

/**
 * View-only seats (docs/view-only-seats.md): an admin whose seat is a
 * viewer's sees the admin portal and changes nothing. The API refuses
 * their edits (403 read_only); these hide the controls so they aren't
 * offered.
 */
const ViewOnlyContext = createContext(false);

export function isViewOnly(principal: Principal | null | undefined): boolean {
  return principal?.role === 'admin' && principal.admin?.role === 'viewer';
}

export function ViewOnlyProvider({ principal, children }: { principal: Principal; children: ReactNode }) {
  return <ViewOnlyContext.Provider value={isViewOnly(principal)}>{children}</ViewOnlyContext.Provider>;
}

/** True on a view-only seat. */
export function useViewOnly(): boolean {
  return useContext(ViewOnlyContext);
}

/** Renders its children only for someone who can edit. */
export function EditOnly({ children }: { children: ReactNode }) {
  return useViewOnly() ? null : <>{children}</>;
}

/** A form area: its inputs and buttons are disabled on a view-only seat. */
export function ViewOnlyFieldset({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const viewOnly = useViewOnly();
  return (
    <fieldset
      disabled={viewOnly}
      className={viewOnly ? 'op-view-only' : undefined}
      style={{ border: 0, padding: 0, margin: 0, minWidth: 0, ...style }}
    >
      {children}
    </fieldset>
  );
}

export function ViewOnlyBadge({ style }: { style?: CSSProperties }) {
  return (
    <span
      title="You can see everything here but not change it."
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: theme.surface2,
        color: theme.textMuted,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      <Eye size={11} />
      View only
    </span>
  );
}
