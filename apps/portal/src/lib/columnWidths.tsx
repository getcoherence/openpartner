import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

/**
 * Column widths a viewer dragged in a `Table` with a `resizeKey`, kept in
 * this browser per table and per viewer. Widths are keyed by column label,
 * so a table whose columns change with its view keeps the ones it shares.
 *
 * Every storage access is guarded: private windows, blocked site data and
 * jsdom must degrade to "nothing saved", never throw.
 */

export type ColumnWidths = Record<string, number>;

/** Narrowest a column can be dragged. */
export const MIN_COLUMN_WIDTH = 48;

const STORAGE_PREFIX = 'op:col-widths:';

const ViewerContext = createContext('');

/** Whose widths the tables below read and save, e.g. the signed-in
 *  operator. Without one, widths are per browser. */
export function ColumnWidthsViewer({ id, children }: { id: string; children: ReactNode }) {
  return <ViewerContext.Provider value={id}>{children}</ViewerContext.Provider>;
}

/** The viewer's id goes into the key as a short hash, not as written. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function columnWidthsKey(viewer: string, table: string): string {
  return `${STORAGE_PREFIX}${viewer ? `${hash(viewer.toLowerCase())}:` : ''}${table}`;
}

function read(key: string): ColumnWidths {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    const widths: ColumnWidths = {};
    for (const [id, w] of Object.entries(saved)) {
      if (typeof w === 'number' && Number.isFinite(w)) widths[id] = Math.max(MIN_COLUMN_WIDTH, Math.round(w));
    }
    return widths;
  } catch {
    return {};
  }
}

function write(key: string, widths: ColumnWidths) {
  try {
    if (Object.keys(widths).length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(widths));
  } catch {
    /* storage blocked: the widths last until the page is left */
  }
}

/** The saved widths for `table` (none without one), and a setter that saves. */
export function useColumnWidths(table: string | undefined): [ColumnWidths, (next: ColumnWidths) => void] {
  const viewer = useContext(ViewerContext);
  const key = table ? columnWidthsKey(viewer, table) : null;
  const [state, setState] = useState(() => ({ key, widths: key ? read(key) : {} }));
  // Another table or viewer: read its widths before this render uses them.
  let current = state;
  if (state.key !== key) {
    current = { key, widths: key ? read(key) : {} };
    setState(current);
  }
  const save = useCallback(
    (next: ColumnWidths) => {
      setState({ key, widths: next });
      if (key) write(key, next);
    },
    [key],
  );
  return [current.widths, save];
}
