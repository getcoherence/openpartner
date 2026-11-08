// @vitest-environment jsdom
/**
 * Admin → Audit log (docs/audit-log.md): who did what, filtered by person.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminAuditLog, type AuditEntry } from '../pages/admin/AuditLog.js';

let requests: Array<{ path: string; search: URLSearchParams }> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const base: Omit<AuditEntry, 'id' | 'action' | 'label'> = {
  createdAt: '2026-11-08T10:00:00.000Z',
  actorKind: 'admin',
  actorId: 'adm_1',
  actorLabel: 'owner@example.com',
  targetId: null,
  targetName: null,
  fields: null,
  detail: null,
  status: 200,
  ip: '203.0.113.9',
};

const ENTRIES: AuditEntry[] = [
  {
    ...base,
    id: 'a3',
    action: 'PATCH /programs/:id',
    label: 'Updated a program',
    targetId: 'prog_1',
    targetName: 'Pro annual',
    fields: ['commissionRule'],
    detail: { changes: { holdbackDays: { from: 14, to: 30 } } },
  },
  { ...base, id: 'a2', action: 'POST /webhooks', label: 'Added a webhook', actorKind: 'api_key', actorId: 'key_1', actorLabel: 'crm-sync', fields: ['events', 'url'] },
  { ...base, id: 'a1', action: 'signin', label: 'Signed in', detail: { via: 'link' } },
];

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ path, search: url.searchParams });
    if (path === '/audit-log/actors') {
      return json(200, {
        actors: [
          { actorId: 'adm_1', actorKind: 'admin', actorLabel: 'owner@example.com' },
          { actorId: 'key_1', actorKind: 'api_key', actorLabel: 'crm-sync' },
        ],
      });
    }
    if (path === '/audit-log') {
      const actorId = url.searchParams.get('actorId');
      return json(200, { entries: actorId ? ENTRIES.filter((e) => e.actorId === actorId) : ENTRIES, nextCursor: null });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(cleanup);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AdminAuditLog />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Audit log page', () => {
  it('reads as who did what to which record, with what changed', async () => {
    const page = renderPage();
    await page.findByText('Updated a program');
    expect(page.getByText(/Pro annual/)).toBeTruthy();
    expect(page.getByText(/14 → 30/)).toBeTruthy();
    expect(page.getByText('events, url')).toBeTruthy();
    expect(page.getByText('crm-sync')).toBeTruthy();
    expect(page.getByText('with an email link or password')).toBeTruthy();
  });

  it('filters by person', async () => {
    const page = renderPage();
    await page.findByText('Updated a program');
    await page.findByRole('option', { name: 'API key: crm-sync' });
    fireEvent.change(page.getByLabelText('Who'), { target: { value: 'key_1' } });
    await page.findByText('Added a webhook');
    await waitFor(() => expect(page.queryByText('Updated a program')).toBeNull());
    expect(requests.at(-1)?.search.get('actorId')).toBe('key_1');
  });
});
