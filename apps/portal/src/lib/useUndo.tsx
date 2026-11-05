/**
 * An action ops can take back instead of confirming it first. The caller
 * shows its effect at once (hides the row); the action itself runs when the
 * toast goes after UNDO_MS, when another one starts, or when the page goes.
 * Undo drops it. One is pending at a time, the latest.
 *
 * A tab closed while one is pending may lose it, which leaves things as
 * they were.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { theme } from '../theme.js';
import { Button } from '../ui.js';

export const UNDO_MS = 6_000;

export interface Undoable {
  /** What the toast says, e.g. "Rejected Acme Notes". */
  message: string;
  /** Does it. */
  commit: () => void;
  /** Puts back what the caller showed. */
  undo: () => void;
}

export function useUndo(): { later: (action: Undoable) => void; toast: ReactNode } {
  const pending = useRef<Undoable | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);

  const take = useCallback(() => {
    clearTimeout(timer.current);
    const action = pending.current;
    pending.current = null;
    setMessage(null);
    return action;
  }, []);
  const flush = useCallback(() => take()?.commit(), [take]);

  const later = useCallback(
    (action: Undoable) => {
      flush();
      pending.current = action;
      setMessage(action.message);
      timer.current = setTimeout(flush, UNDO_MS);
    },
    [flush],
  );

  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  const toast = message && (
    <div
      role="status"
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        maxWidth: 'calc(100vw - 32px)',
        padding: '8px 8px 8px 16px',
        background: theme.surface2,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusMd,
        boxShadow: theme.shadowPopover,
        color: theme.text,
        fontSize: 14,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{message}</span>
      <Button size="sm" variant="secondary" onClick={() => take()?.undo()}>
        Undo
      </Button>
    </div>
  );
  return { later, toast };
}
