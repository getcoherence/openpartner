// @vitest-environment jsdom
/**
 * A Table with a resizeKey (every ops list) lets the viewer drag its
 * column widths. They're saved in this browser per table and per viewer;
 * cells stay React, and phones keep the stacked cards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Table } from '../ui.js';
import { ColumnWidthsViewer, columnWidthsKey } from '../lib/columnWidths.js';

const COLUMNS = ['Company', 'Launch', { label: 'Owed', align: 'right' as const }, ''];
const approve = vi.fn();
const ROWS = [
  [
    <a key="c" href="https://acme.test">
      Acme
    </a>,
    'Oct 3',
    '$10',
    <button key="b" type="button" onClick={approve}>
      Approve
    </button>,
  ],
];
const KEY = columnWidthsKey('ops@example.com', 'ops.test');

function table(viewer = 'ops@example.com', columns: typeof COLUMNS = COLUMNS) {
  return (
    <ColumnWidthsViewer id={viewer}>
      <Table resizeKey="ops.test" columns={columns} rows={ROWS} />
    </ColumnWidthsViewer>
  );
}

const colWidths = () => [...document.querySelectorAll('col')].map((c) => c.style.width);
const saved = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as Record<string, number> | null;

/** A header's edge for pointers (hidden from screen readers, who get the separators). */
const edge = (column: string) => document.querySelector(`[data-resize-column="${column}"]`) as HTMLElement;

function drag(column: string, from: number, to: number) {
  fireEvent.pointerDown(edge(column), { clientX: from, button: 0 });
  fireEvent.pointerMove(window, { clientX: to });
  fireEvent.pointerUp(window, { clientX: to });
}

beforeEach(() => {
  localStorage.clear();
  approve.mockClear();
  // jsdom lays nothing out: every header measures 100px wide.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100 } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resizable table columns', () => {
  it('without a resizeKey, a table is laid out by its content as before', () => {
    render(<Table columns={COLUMNS} rows={ROWS} />);
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
    expect(document.querySelector('colgroup')).toBeNull();
    expect(screen.getByRole('table').style.minWidth).toBe('max-content');
  });

  it('until a width is set, columns fit their content, each header with a handle', () => {
    render(table());
    expect(screen.getAllByRole('separator').map((s) => s.getAttribute('aria-label'))).toEqual([
      'Resize Company',
      'Resize Launch',
      'Resize Owed',
      'Resize column 4',
    ]);
    // The handle's label stays out of the header's name.
    expect(screen.getByRole('columnheader', { name: 'Company' })).toBeTruthy();
    expect(document.querySelector('colgroup')).toBeNull();
    expect(screen.getByRole('table').style.tableLayout).toBe('');
  });

  it("dragging a header's edge sets that column's width and saves every column's, per viewer", () => {
    render(table());
    fireEvent.pointerDown(edge('Company'), { clientX: 200, button: 0 });
    fireEvent.pointerMove(window, { clientX: 260 });
    // Live while dragging; the last, empty column takes what's left.
    expect(colWidths()).toEqual(['160px', '100px', '100px', '100px', '']);
    expect(saved()).toBeNull();
    fireEvent.pointerUp(window, { clientX: 260 });

    expect(saved()).toEqual({ Company: 160, Launch: 100, Owed: 100, '#3': 100 });
    expect(screen.getByRole('table').style.tableLayout).toBe('fixed');
    expect(screen.getByRole('separator', { name: 'Resize Company' }).getAttribute('aria-valuenow')).toBe('160');
    // The key holds a hash of the viewer, not their address.
    expect(KEY).not.toContain('ops@example.com');
    expect(KEY).not.toBe(columnWidthsKey('other@example.com', 'ops.test'));
  });

  it('a column stops at 48px however far it is dragged', () => {
    render(table());
    drag('Launch', 300, -500);
    expect(saved()?.Launch).toBe(48);
  });

  it('a click on the edge without a drag changes nothing', () => {
    render(table());
    fireEvent.pointerDown(edge('Company'), { clientX: 200, button: 0 });
    fireEvent.pointerUp(window, { clientX: 200 });
    expect(saved()).toBeNull();
    expect(document.querySelector('colgroup')).toBeNull();
  });

  it('saved widths come back on the next visit, and another viewer keeps their own', () => {
    localStorage.setItem(KEY, JSON.stringify({ Company: 240, Launch: 120, Owed: 90, '#3': 110 }));
    render(table());
    expect(colWidths()).toEqual(['240px', '120px', '90px', '110px', '']);
    cleanup();

    render(table('other@example.com'));
    expect(document.querySelector('colgroup')).toBeNull();
  });

  it('arrow keys move a focused edge, lit in its header; a double-click fits the column to its content again', () => {
    render(table());
    const separator = screen.getByRole('separator', { name: 'Resize Company' });
    const bar = edge('Company').firstElementChild as HTMLElement;
    const resting = bar.style.background;
    fireEvent.focus(separator);
    expect(bar.style.background).not.toBe(resting);
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(saved()?.Company).toBe(116);
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(saved()?.Company).toBe(84);
    fireEvent.blur(separator);
    expect(bar.style.background).toBe(resting);

    fireEvent.doubleClick(edge('Company'));
    expect(saved()).toEqual({ Launch: 100, Owed: 100, '#3': 100 });
    // Measured at its content width again (100px here), the rest as saved.
    expect(colWidths()).toEqual(['100px', '100px', '100px', '100px', '']);
  });

  it('a view with a new column keeps the widths of the columns it shares', () => {
    localStorage.setItem(KEY, JSON.stringify({ Company: 240, Launch: 120 }));
    render(table('ops@example.com', ['Company', 'Launch', 'Held for']));
    // "Held for" has no width yet: it's measured at its content width.
    expect(colWidths()).toEqual(['240px', '120px', '100px', '']);
  });

  it("cells keep their links and buttons once widths are set", () => {
    localStorage.setItem(KEY, JSON.stringify({ Company: 240, Launch: 120, Owed: 90, '#3': 110 }));
    render(table());
    expect(screen.getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe('https://acme.test');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(approve).toHaveBeenCalledOnce();
    // The empty last column is hidden from screen readers.
    expect(screen.getAllByRole('columnheader')).toHaveLength(4);
  });

  it('with site storage blocked, widths still change for the visit', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(table());
    drag('Company', 200, 230);
    expect(colWidths()).toEqual(['130px', '100px', '100px', '100px', '']);
  });

  it('a malformed saved value is ignored', () => {
    localStorage.setItem(KEY, '["nope"]');
    render(table());
    expect(document.querySelector('colgroup')).toBeNull();
  });

  it('on a phone, rows are cards with no handles', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 768px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    localStorage.setItem(KEY, JSON.stringify({ Company: 240 }));
    render(table());
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Acme' })).toBeTruthy();
  });
});
