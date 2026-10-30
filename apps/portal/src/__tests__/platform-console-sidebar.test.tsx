// @vitest-environment jsdom
/**
 * The ops console menu is a left sidebar, grouped by area, so every page
 * is reachable without scrolling sideways; on a phone it's a drawer behind
 * a menu button that closes once a page is picked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlatformConsole } from '../pages/platform/PlatformConsole.js';

const OPERATOR = { id: 'pa_1', email: 'ops@example.com', role: 'admin' };

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith('/platform-admin/me') ? OPERATOR : url.endsWith('/platform-admin/audit') ? { events: [] } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

function renderConsole(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/platform/*" element={<PlatformConsole />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const PAGES = [
  'Brands',
  'Creators',
  'Vendors',
  'Creator index',
  'Marketplace',
  'Fees',
  'Invoicing',
  'Screening',
  'Countries',
  'Blocklist',
  'Notifications',
  'Own program',
  'Audit',
];

describe('ops console sidebar', () => {
  it('lists every page in a vertical nav and marks the current one', async () => {
    renderConsole('/platform/audit');
    await screen.findByRole('heading', { name: 'Audit log' });
    const nav = screen.getByRole('navigation');
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(PAGES);
    expect(within(nav).getByRole('link', { name: 'Audit' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Brands' }).getAttribute('aria-current')).toBeNull();
    for (const section of ['Review', 'Network', 'Billing', 'Compliance', 'Platform']) {
      expect(within(nav).getByText(section)).toBeTruthy();
    }
    expect(screen.getByText('ops@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Sign out/ })).toBeTruthy();
    // The desktop sidebar has no menu button.
    expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull();
  });

  it('opens as a drawer on a phone and closes once a page is picked', async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    renderConsole('/platform/audit');
    await screen.findByRole('heading', { name: 'Audit log' });
    const drawer = screen.getByRole('navigation').closest('aside')!.parentElement!;
    expect(drawer.style.transform).toBe('translateX(-100%)');

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(drawer.style.transform).toBe('translateX(0)');

    fireEvent.click(within(screen.getByRole('navigation')).getByRole('link', { name: 'Blocklist' }));
    await screen.findByRole('heading', { name: 'Blocklist' });
    await waitFor(() => expect(drawer.style.transform).toBe('translateX(-100%)'));
  });
});
