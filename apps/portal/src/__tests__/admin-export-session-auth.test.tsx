// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { AdminExport } from '../pages/AdminExport.js';

let requests: Array<{ url: URL; init?: RequestInit }> = [];
const stored = new Map<string, string>();
const storage: Storage = {
  get length() { return stored.size; },
  clear: () => stored.clear(),
  getItem: (key) => stored.get(key) ?? null,
  key: (index) => [...stored.keys()][index] ?? null,
  removeItem: (key) => { stored.delete(key); },
  setItem: (key, value) => { stored.set(key, String(value)); },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  localStorage.clear();
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: new URL(String(input), 'http://localhost'), init });
    return json(200, {
      dryRun: true,
      summary: { total: 1, created: 1, skipped: 0, invalid: 0 },
      report: [{ row: 2, email: 'qa@example.com', status: 'created' }],
    });
  }) as typeof fetch;
});

afterEach(cleanup);

describe('Admin export/import authentication', () => {
  it('uses the signed-in admin session for a CSV preview when no pasted API key exists', async () => {
    const page = render(<AdminExport />);
    fireEvent.change(page.getByPlaceholderText('…or paste CSV here'), {
      target: { value: 'email,name\nqa@example.com,QA' },
    });
    fireEvent.click(page.getByRole('button', { name: 'Preview (dry-run)' }));

    await waitFor(() => expect(requests).toHaveLength(1));
    const request = requests[0]!;
    expect(request.url.pathname).toBe('/api/import/partners-csv');
    expect(request.url.searchParams.get('dryRun')).toBe('true');
    expect(request.init?.credentials).toBe('include');
    expect(new Headers(request.init?.headers).has('authorization')).toBe(false);
    expect(await page.findByText('Preview', { selector: 'strong' })).toBeTruthy();
  });

  it('still authenticates a CSV preview with a pasted API key', async () => {
    localStorage.setItem('op:apiKey', 'op_test_key');
    const page = render(<AdminExport />);
    fireEvent.change(page.getByPlaceholderText('…or paste CSV here'), {
      target: { value: 'email,name\nqa@example.com,QA' },
    });
    fireEvent.click(page.getByRole('button', { name: 'Preview (dry-run)' }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(new Headers(requests[0]!.init?.headers).get('authorization')).toBe('Bearer op_test_key');
  });
});
