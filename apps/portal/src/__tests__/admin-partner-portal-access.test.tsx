// @vitest-environment jsdom
/**
 * Admin control over partner portal access (Partner.portalAccess): a
 * headless program's customers shouldn't be able to sign in to the hosted
 * portal. Admin → Partners shows and flips it per partner, "Add partner"
 * can create one silently, and Admin → Settings holds the default for
 * partners added without an invite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { AdminPartners } from '../pages/AdminPartners.js';
import { PartnerPortalAccessSection } from '../pages/admin/Settings.js';

const base = { stripeConnectAccountId: null, revokedAt: null, createdAt: '2026-10-01T10:00:00.000Z', metadata: {} };
const PARTNERS = [
  { ...base, id: 'p_on', name: 'Open Partner', email: 'open@example.com', activatedAt: '2026-10-02T00:00:00.000Z', portalAccess: true },
  { ...base, id: 'p_off', name: 'Headless Customer', email: 'customer@example.com', activatedAt: '2026-10-02T00:00:00.000Z', portalAccess: false },
  // Never accepted their invite, and access was turned off since.
  { ...base, id: 'p_pending_off', name: 'Pending Off', email: 'pending@example.com', activatedAt: null, portalAccess: false },
];

let requests: Array<{ method: string; path: string; body: unknown }> = [];
let accessSetting = { uninvitedPortalAccess: true };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  requests = [];
  accessSetting = { uninvitedPortalAccess: true };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, body });
    if (path === '/partners' && method === 'GET') return json(200, { partners: PARTNERS, nextCursor: null });
    if (path === '/partners' && method === 'POST') return json(201, { id: 'p_new', ...body });
    const patch = /^\/partners\/([^/]+)$/.exec(path);
    if (patch && method === 'PATCH') {
      const p = PARTNERS.find((x) => x.id === patch[1]);
      return json(200, { ...p, ...body });
    }
    if (path === '/me/programs') return json(200, { programs: [] });
    if (path === '/config/partner-access' && method === 'GET') return json(200, accessSetting);
    if (path === '/config/partner-access' && method === 'POST') {
      accessSetting = { ...accessSetting, ...body };
      return json(200, accessSetting);
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const rowOf = async (page: ReturnType<typeof render>, name: string) =>
  within((await page.findByText(name)).closest('tr') as HTMLElement);

describe('admin partners: portal access', () => {
  it('shows each partner\'s access, and turning it off asks first', async () => {
    const page = renderWithClient(<AdminPartners />);
    const open = await rowOf(page, 'Open Partner');
    const toggle = open.getByRole('button', { name: /Portal access for Open Partner: on/ });

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(toggle);
    expect(confirm).toHaveBeenCalledOnce();
    expect(requests.filter((r) => r.method === 'PATCH')).toEqual([]);

    confirm.mockReturnValueOnce(true);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'PATCH')).toEqual([{ method: 'PATCH', path: '/partners/p_on', body: { portalAccess: false } }]),
    );

    // Turning it on doesn't sign anyone out, so it doesn't ask.
    const off = await rowOf(page, 'Headless Customer');
    confirm.mockClear();
    fireEvent.click(off.getByRole('button', { name: /Portal access for Headless Customer: off/ }));
    await waitFor(() => expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(2));
    expect(confirm).not.toHaveBeenCalled();
    expect(requests.filter((r) => r.method === 'PATCH')[1]!.body).toEqual({ portalAccess: true });
  });

  it("offers no invite to a partner who can't sign in", async () => {
    const page = renderWithClient(<AdminPartners />);
    const pending = await rowOf(page, 'Pending Off');
    expect(pending.queryByRole('button', { name: 'Resend invite' })).toBeNull();
  });

  it('adds a partner without an invite, and without portal access unless ticked', async () => {
    const page = renderWithClient(<AdminPartners />);
    fireEvent.click(await page.findByRole('button', { name: 'Invite partner' }));
    fireEvent.change(page.getByPlaceholderText('Ada Lovelace'), { target: { value: 'Quiet Customer' } });
    fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: 'quiet@example.com' } });
    fireEvent.click(page.getByLabelText('Email them an invite to the partner portal'));
    fireEvent.click(page.getByRole('button', { name: 'Add partner' }));

    await waitFor(() => expect(requests.find((r) => r.method === 'POST' && r.path === '/partners')).toBeDefined());
    expect(requests.find((r) => r.method === 'POST' && r.path === '/partners')!.body).toEqual({
      name: 'Quiet Customer',
      email: 'quiet@example.com',
      sendInvite: false,
      portalAccess: false,
    });
  });

  it('still invites by default', async () => {
    const page = renderWithClient(<AdminPartners />);
    fireEvent.click(await page.findByRole('button', { name: 'Invite partner' }));
    fireEvent.change(page.getByPlaceholderText('Ada Lovelace'), { target: { value: 'New Partner' } });
    fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: 'new@example.com' } });
    fireEvent.click(page.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(requests.find((r) => r.method === 'POST' && r.path === '/partners')).toBeDefined());
    expect(requests.find((r) => r.method === 'POST' && r.path === '/partners')!.body).toEqual({ name: 'New Partner', email: 'new@example.com' });
  });
});

describe('admin settings: portal access default', () => {
  it('saves the default for partners added without an invite', async () => {
    const page = renderWithClient(<PartnerPortalAccessSection />);
    const box = (await page.findByRole('checkbox', { name: /Partners added without an invite can sign in/ })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'POST')).toEqual([
        { method: 'POST', path: '/config/partner-access', body: { uninvitedPortalAccess: false } },
      ]),
    );
    await waitFor(() => expect(box.checked).toBe(false));
  });
});
