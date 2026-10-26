// @vitest-environment jsdom
/**
 * The Network's settings live on Admin → Settings, which has a section
 * menu. The Network sidebar section holds "Get connected" until the brand
 * connects, then only the pages brands work in; Billing shows for
 * self-hosted instances only, since hosted plans include the Network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Sidebar } from '../App.js';
import { AdminNetwork } from '../pages/admin/Network.js';
import { NetworkSettingsSection, type NetworkMembership } from '../pages/admin/NetworkSettingsSection.js';
import { SettingsSections } from '../pages/admin/SettingsSections.js';
import type { Principal } from '../api.js';

const admin: Principal = { role: 'admin', admin: { id: 'a1', name: 'Ada Admin', email: 'ada@acme.example' } };

const CONNECTED: NetworkMembership = {
  enabled: true,
  networkUrl: 'https://network.example/api',
  hasVendorToken: true,
  scopedKeyId: 'key_1',
  autoEnroll: true,
  bonusesAuthorized: true,
  tier: 'hosted',
};
const NOT_CONNECTED: NetworkMembership = { ...CONNECTED, enabled: false, hasVendorToken: false, scopedKeyId: null };

let membership: NetworkMembership = CONNECTED;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  membership = CONNECTED;
  // Sidebar sections start collapsed; open the brand's Network section.
  window.localStorage.setItem('op:nav-collapsed:admin-network', '0');
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
    if (path === '/config/network') return json(200, membership);
    if (path === '/admin/network/me') {
      return json(200, { id: 'v1', displayName: 'Acme', status: 'active', partnerCount: 5, reviewStatus: 'approved' });
    }
    if (path === '/config/network/partner-consent') return json(200, { partners: 5, granted: 5, withdrawn: 0, declined: 0 });
    return json(401, { error: 'unauthorized' });
  }) as typeof fetch;
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function renderAt(ui: ReactElement, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(['program-settings'], { programName: 'Acme Partners', whiteLabel: false });
  qc.setQueryData(['public-branding', null], { programName: 'Acme Partners', whiteLabel: false, tenantSlug: 'acme' });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Network sidebar section', () => {
  it('before connecting: only Get connected', async () => {
    membership = NOT_CONNECTED;
    renderAt(<Sidebar principal={admin} />);
    expect(await screen.findByRole('link', { name: 'Get connected' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Requests' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Billing' })).toBeNull();
  });

  it('hosted and connected: the working pages, no Connection, no Network billing', async () => {
    renderAt(<Sidebar principal={admin} />);
    expect(await screen.findByRole('link', { name: 'Requests' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Bookings' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Get connected' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Connection' })).toBeNull();
    const hrefs = screen.queryAllByRole('link', { name: 'Billing' }).map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('/admin/network/billing');
  });

  it('self-hosted and connected: Network billing is there', async () => {
    membership = { ...CONNECTED, tier: 'self_hosted' };
    renderAt(<Sidebar principal={admin} />);
    await screen.findByRole('link', { name: 'Requests' });
    const hrefs = screen.getAllByRole('link', { name: 'Billing' }).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/admin/network/billing');
  });
});

describe('Network → Get connected', () => {
  function Where() {
    const loc = useLocation();
    return <div data-testid="where">{loc.pathname + loc.hash}</div>;
  }

  it('sends a connected brand to its Network settings', async () => {
    renderAt(
      <Routes>
        <Route path="/admin/network" element={<AdminNetwork />} />
        <Route path="*" element={<Where />} />
      </Routes>,
      '/admin/network',
    );
    expect((await screen.findByTestId('where')).textContent).toBe('/admin/settings#network');
  });

  it('shows the connect flow to a brand that isn\'t connected', async () => {
    membership = NOT_CONNECTED;
    renderAt(<AdminNetwork />, '/admin/network');
    expect(await screen.findByRole('button', { name: 'List my brand on the Network' })).toBeTruthy();
  });
});

describe('Settings → OpenPartner Network', () => {
  it('hosted: listing, partner offer; no Network address or re-sync', async () => {
    renderAt(<NetworkSettingsSection />);
    expect(await screen.findByText('Acme')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Offer the Network to partners/ })).toBeTruthy();
    await screen.findByText(/active partners have/);
    expect(screen.queryByText('https://network.example/api')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-sync now' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Push update/ })).toBeNull();
  });

  it('self-hosted: also the Network address and a re-sync', async () => {
    membership = { ...CONNECTED, tier: 'self_hosted' };
    renderAt(<NetworkSettingsSection />);
    expect(await screen.findByText('https://network.example/api')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-sync now' })).toBeTruthy();
  });

  it('not connected: points to Get connected', async () => {
    membership = NOT_CONNECTED;
    renderAt(<NetworkSettingsSection />);
    expect(await screen.findByRole('button', { name: 'Get connected' })).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('Settings section menu', () => {
  const SECTIONS = [
    { id: 'brand', group: 'Brand', label: 'Brand info', content: <div>brand body</div> },
    { id: 'signups', group: 'Partners', label: 'Signups', content: <div>signups body</div> },
    { id: 'network', group: 'Network', label: 'OpenPartner Network', content: <div>network body</div> },
  ];

  it('lists every section under its group and jumps to one on click', async () => {
    renderAt(<SettingsSections sections={SECTIONS} />, '/admin/settings');
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav.textContent).toBe('BrandBrand infoPartnersSignupsNetworkOpenPartner Network');
    const link = screen.getByRole('link', { name: 'OpenPartner Network' });
    expect(link.getAttribute('href')).toBe('#network');
    fireEvent.click(link);
    expect(link.getAttribute('aria-current')).toBe('location');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    const target = vi.mocked(Element.prototype.scrollIntoView).mock.contexts.at(-1) as Element;
    expect(target.id).toBe('settings-network');
  });

  it('opens at the section in the URL hash', async () => {
    renderAt(<SettingsSections sections={SECTIONS} />, '/admin/settings#network');
    await waitFor(() => {
      const target = vi.mocked(Element.prototype.scrollIntoView).mock.contexts.at(-1) as Element | undefined;
      expect(target?.id).toBe('settings-network');
    });
    expect(screen.getByRole('link', { name: 'OpenPartner Network' }).getAttribute('aria-current')).toBe('location');
  });
});
