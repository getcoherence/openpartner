// @vitest-environment jsdom
/**
 * The Network answers a brand acting for its partner with that brand's own
 * rows only (openpartner-network#28). So the partner's Network pages in a
 * brand's portal speak for this brand and send the partner to their own
 * Network portal for everything across brands:
 *   - My partnership and My applications say they're this brand's, and link
 *     to the Network portal;
 *   - applying to an offering confirms in place instead of redirecting to
 *     My applications, where another brand's application never shows;
 *   - an application that already exists points at the Network portal too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Principal } from '../api.js';
import { MyAffiliationsPage } from '../pages/partner/MyAffiliations.js';
import { MyRequestsPage } from '../pages/partner/MyRequests.js';
import { OfferingDetailPage } from '../pages/partner/OfferingDetail.js';

const BRAND = {
  programName: 'Acme',
  supportEmail: null,
  logoUrl: null,
  brandColor: null,
  programTermsUrl: null,
  whiteLabel: false,
  partnerNetworkVisible: true,
};

const OFFERING = {
  id: 'off_1',
  title: 'Globex Creators',
  description: null,
  productUrl: 'https://globex.example',
  vendorId: 'vnd_globex',
  vendorName: 'Globex',
  terms: {},
  createdAt: '2026-10-01T00:00:00.000Z',
};

const partner: Principal = {
  role: 'partner',
  partnerId: 'p1',
  partner: { id: 'p1', name: 'Ada', email: 'ada@example.com', stripeConnected: false },
};

let applyResponse: () => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  applyResponse = () => json(201, { id: 'req_1', status: 'pending' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/network/offerings/off_1/apply') && method === 'POST') return applyResponse();
    if (url.endsWith('/network/offerings/off_1')) return json(200, OFFERING);
    if (url.endsWith('/network/me/profile')) return json(200, { profileComplete: true });
    if (url.endsWith('/network/me/affiliations')) {
      return json(200, {
        affiliations: [
          {
            id: 'aff_1',
            vendorId: 'vnd_acme',
            vendorPartnerId: 'p1',
            status: 'pending',
            joinedVendorAt: '2026-10-01T00:00:00.000Z',
            vendorName: 'Acme',
            vendorInstanceUrl: 'https://acme.example',
          },
        ],
      });
    }
    if (url.endsWith('/network/me/requests')) return json(200, { requests: [] });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderAt(path: string, element: React.ReactElement, routePath = path) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['program-settings'], BRAND);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path={routePath} element={element} />
          <Route path="/network/requests" element={<div>My applications page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function portalLink(page: ReturnType<typeof render>) {
  return page.getByRole('link', { name: 'Open your Network portal ↗' });
}

describe('My partnership', () => {
  it("is this brand's partnership, with the Network portal for every other brand", async () => {
    const page = renderAt('/network/affiliations', <MyAffiliationsPage />);
    await page.findByRole('link', { name: 'Acme' });
    const text = page.container.textContent ?? '';
    expect(text).toContain('Your Acme partnership on the OpenPartner Network.');
    expect(text).toContain('Your partnerships with other brands are in your Network portal.');
    expect(text).not.toMatch(/across the Network/);
    const link = portalLink(page);
    expect(link.getAttribute('href')).toBe('https://app.openpartner.dev/creator/affiliations');
    expect(link.getAttribute('target')).toBe('_blank');
  });
});

describe('My applications', () => {
  it("lists this brand's applications and sends the rest to the Network portal", async () => {
    const page = renderAt('/network/my-requests', <MyRequestsPage />);
    await page.findByText('No applications yet');
    const text = page.container.textContent ?? '';
    expect(text).toContain('Your applications to Acme on the OpenPartner Network.');
    expect(text).toContain('Applications to other brands, including ones you send from Discover, are tracked in your Network portal.');
    expect(text).not.toMatch(/across the Network/);
    expect(portalLink(page).getAttribute('href')).toBe('https://app.openpartner.dev/creator/requests');
  });
});

describe('applying from a brand portal', () => {
  function renderOffering() {
    return renderAt('/network/offerings/off_1', <OfferingDetailPage principal={partner} />, '/network/offerings/:id');
  }

  it('confirms in place, naming the brand, instead of redirecting to My applications', async () => {
    const page = renderOffering();
    fireEvent.click(await page.findByRole('button', { name: 'Submit application' }));
    await page.findByRole('heading', { name: 'Application sent to Globex' });
    expect(page.queryByText('My applications page')).toBeNull();
    expect(page.queryByRole('button', { name: 'Submit application' })).toBeNull();
    expect(portalLink(page).getAttribute('href')).toBe('https://app.openpartner.dev/creator/requests');
  });

  it('an application that already exists points at the Network portal, not a raw error', async () => {
    // Another brand's 409 carries no requestId or status (network#28); the
    // partner proxy wraps the Network body as JSON text.
    applyResponse = () =>
      json(409, { error: 'network_call_failed', detail: JSON.stringify({ error: 'request_already_exists' }) });
    const page = renderOffering();
    fireEvent.click(await page.findByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(page.container.textContent).toMatch(/You’ve already applied to this program/));
    expect(page.container.textContent).not.toMatch(/network_call_failed|request_already_exists/);
    expect(portalLink(page).getAttribute('href')).toBe('https://app.openpartner.dev/creator/requests');
  });
});
