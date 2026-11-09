// @vitest-environment jsdom
/**
 * Admin → Export / import: a download that fails says so next to the
 * button that asked for it, instead of nothing happening.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { AdminExport } from '../pages/AdminExport.js';

let requests: string[] = [];
let respond: () => Response;
let saved: string[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const FAILURE = () => json(500, { error: 'export_failed', detail: 'the database went away' });
const MESSAGE = 'export_failed: the database went away';

beforeEach(() => {
  requests = [];
  saved = [];
  respond = FAILURE;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(new URL(String(input), 'http://localhost').pathname);
    return respond();
  }) as typeof fetch;
  // jsdom has no object URLs or downloads: record the file name instead.
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function tableRow(page: ReturnType<typeof render>, table: string): HTMLTableRowElement {
  return page.getByText(table, { selector: 'code' }).closest('tr') as HTMLTableRowElement;
}

describe('Admin export download errors', () => {
  it('shows a failed table download in the row under that table', async () => {
    const page = render(<AdminExport />);
    const row = tableRow(page, 'Click');
    fireEvent.click(within(row).getByRole('button', { name: 'CSV' }));

    const banner = await page.findByText(MESSAGE);
    expect(requests).toEqual(['/api/export/Click.csv']);
    expect(banner.closest('tr')?.previousElementSibling).toBe(row);
    expect(page.getAllByText(MESSAGE)).toHaveLength(1);
    expect(saved).toEqual([]);
  });

  it('shows a failed full-bundle download in the bundle card', async () => {
    const page = render(<AdminExport />);
    const bundleJson = page.getAllByRole('button', { name: 'JSON' })[0]!;
    fireEvent.click(bundleJson);

    const banner = await page.findByText(MESSAGE);
    expect(requests).toEqual(['/api/export.json']);
    expect(banner.closest('tr')).toBeNull();
    expect(banner.parentElement?.textContent).toContain('Full bundle');
  });

  it('clears the error when a retry works, and saves the file', async () => {
    const page = render(<AdminExport />);
    const csv = () => within(tableRow(page, 'Partner')).getByRole('button', { name: 'CSV' });
    fireEvent.click(csv());
    await page.findByText(MESSAGE);

    respond = () => new Response('id,name\n', { status: 200, headers: { 'content-type': 'text/csv' } });
    fireEvent.click(csv());

    await waitFor(() => expect(saved).toEqual(['Partner.csv']));
    expect(page.queryByText(MESSAGE)).toBeNull();
  });
});
