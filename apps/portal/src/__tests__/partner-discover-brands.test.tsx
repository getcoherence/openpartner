// @vitest-environment jsdom
/**
 * A brand portal's Network Discover (/network/discover) lists one card per
 * brand, as creator Discover does (creator-discover-brands.test.tsx):
 *   - a brand with several programs takes one card that names them and
 *     summarises their terms (brand-summary.ts); one with a single program
 *     reads as that program;
 *   - search shows a brand when any program matches, and says how many do;
 *   - an older Network without the brand feed still lists, grouped here;
 *   - the brand's page (/network/vendors/:id) reads the Network's
 *     { vendor, offerings } and gives each program its terms and apply link.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiscoverPage } from '../pages/partner/Discover.js';
import { VendorDetailPage } from '../pages/partner/VendorDetail.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const pct = (value: number, recurring: boolean) => ({ trigger: 'every', type: 'percent', value, recurring });

function program(id: string, title: string, terms: Record<string, unknown>) {
  return {
    id,
    title,
    description: `${title} for teams.`,
    productUrl: `https://${id}.example`,
    terms,
    coverImageUrl: null,
    video: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    myStatus: 'none',
  };
}

function brand(vendorId: string, vendorName: string, offerings: ReturnType<typeof program>[]) {
  return {
    vendorId,
    vendorName,
    vendorLogoUrl: null,
    vendorPartnerCount: 0,
    featured: false,
    programCount: offerings.length,
    offerings,
  };
}

const mixed = brand('vnd_mixed', 'Mixed Media', [
  program('off_pod', 'Podcast Pro', { commissionRules: [pct(10, true)], attributionWindowDays: 30 }),
  program('off_vid', 'Video Kit', { commissionRules: [pct(25, false)], attributionWindowDays: 90 }),
  program('off_course', 'Course Bundle', {
    commissionRules: [{ trigger: 'every', type: 'fixed', value: 50, currency: 'usd' }],
    recruiterCommission: { percent: 10 },
  }),
]);
const solo = brand('vnd_solo', 'Solo Analytics', [
  program('off_solo', 'Solo program', { commissionRules: [pct(20, true)], attributionWindowDays: 45 }),
]);

/** Per-test answers, keyed by path under /api. */
let routes: Record<string, () => Response>;
let requested: string[];

beforeEach(() => {
  routes = {};
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://portal.test');
    const path = url.pathname.replace(/^\/api/, '');
    requested.push(path + url.search);
    const handler = routes[path];
    return handler ? handler() : json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderAt(path: string, routePath: string, element: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const renderDiscover = () => renderAt('/t/acme/network/discover', '/t/:slug/network/discover', <DiscoverPage />);

/** The card holding `text`. */
function cardOf(page: ReturnType<typeof render>, text: string) {
  return page.getByText(text).closest('div[style*="border-radius"]') as HTMLElement;
}

describe('partner Discover', () => {
  it('gives a brand with several programs one card; a one-program brand reads as that program', async () => {
    routes['/network/discover/brands'] = () => json(200, { brands: [mixed, solo] });
    const page = renderDiscover();

    await page.findByText('Mixed Media');
    const card = cardOf(page, 'Mixed Media');
    expect(within(card).getByText(/3 programs/)).toBeTruthy();
    expect(within(card).getByText('Podcast Pro, Video Kit, Course Bundle')).toBeTruthy();
    expect(within(card).getByText('10–25% or $50 flat on some programs')).toBeTruthy();
    expect(within(card).getByText('Pays for recruits · 30–90d window')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'View programs' }).getAttribute('href')).toBe('/t/acme/network/vendors/vnd_mixed');

    const soloCard = cardOf(page, 'Solo program');
    expect(within(soloCard).getByText('Solo program for teams.')).toBeTruthy();
    expect(within(soloCard).getByText('45d window')).toBeTruthy();
    expect(within(soloCard).getByRole('link', { name: 'View & apply' }).getAttribute('href')).toBe('/t/acme/network/offerings/off_solo');

    expect(page.getAllByText(/Podcast Pro|Video Kit|Course Bundle/)).toHaveLength(1);
    expect(requested).toEqual(['/network/discover/brands?limit=100']);
  });

  it('shows a brand when any program matches the search, and says how many do', async () => {
    routes['/network/discover/brands'] = () => json(200, { brands: [mixed, solo] });
    const page = renderDiscover();
    await page.findByText('Mixed Media');
    const search = page.getByPlaceholderText('Brand, program or description…');

    fireEvent.change(search, { target: { value: 'video' } });
    await waitFor(() => expect(page.queryByText('Solo Analytics')).toBeNull());
    expect(within(cardOf(page, 'Mixed Media')).getByText('1 of 3 match')).toBeTruthy();

    // The brand's own name matches every program.
    fireEvent.change(search, { target: { value: 'mixed' } });
    await waitFor(() => expect(within(cardOf(page, 'Mixed Media')).queryByText(/of 3 match/)).toBeNull());

    fireEvent.change(search, { target: { value: 'nothing like it' } });
    await page.findByText('No matches for "nothing like it"');
  });

  it('asks for the sort it shows', async () => {
    routes['/network/discover/brands'] = () => json(200, { brands: [solo] });
    const page = renderDiscover();
    await page.findByText('Solo Analytics');
    fireEvent.change(page.getByDisplayValue('Newest'), { target: { value: 'popular' } });
    await waitFor(() => expect(requested).toContain('/network/discover/brands?limit=100&sort=popular'));
  });

  it('groups the /offerings feed of a Network without the brand feed', async () => {
    const legacy = (id: string, title: string) => ({
      ...program(id, title, { commissionDescription: '20% recurring' }),
      vendorId: 'vnd_old',
      vendorName: 'Old Network Brand',
      vendorLogoUrl: null,
      vendorPartnerCount: 2,
    });
    routes['/network/discover'] = () => json(200, { offerings: [legacy('off_1', 'One'), legacy('off_2', 'Two')] });
    const page = renderDiscover();
    await page.findByText('Old Network Brand');
    const card = cardOf(page, 'Old Network Brand');
    expect(within(card).getByText(/2 programs · 2 partners/)).toBeTruthy();
    expect(within(card).getByText('One, Two')).toBeTruthy();
    expect(within(card).getByText('20% recurring')).toBeTruthy();
    expect(requested).toEqual(['/network/discover/brands?limit=100', '/network/discover?limit=100']);
  });

  it('falls back only on a 404, not when the brand feed fails otherwise', async () => {
    routes['/network/discover/brands'] = () => json(503, { error: 'network_call_failed' });
    const page = renderDiscover();
    await page.findByText('No programs yet');
    expect(requested).toEqual(['/network/discover/brands?limit=100']);
  });
});

describe('partner brand page', () => {
  const renderBrand = (id: string) =>
    renderAt(`/t/acme/network/vendors/${id}`, '/t/:slug/network/vendors/:id', <VendorDetailPage />);

  const vendor = (id: string, displayName: string) => ({
    id,
    displayName,
    logoUrl: null,
    tier: 'hosted',
    partnerCount: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    featured: false,
  });

  it('reads the Network’s { vendor, offerings } and gives each program its terms and apply link', async () => {
    routes['/network/vendors/vnd_mixed'] = () => json(200, { vendor: vendor('vnd_mixed', 'Mixed Media'), offerings: mixed.offerings });
    const page = renderBrand('vnd_mixed');

    await page.findByText('Programs from Mixed Media');
    expect(page.getByText(/3 partners · Member since/)).toBeTruthy();
    const video = cardOf(page, 'Video Kit');
    expect(within(video).getByText(/^25%/)).toBeTruthy();
    expect(within(video).getByText('90d window')).toBeTruthy();
    expect(within(video).getByRole('link', { name: 'View & apply' }).getAttribute('href')).toBe('/t/acme/network/offerings/off_vid');
    expect(within(cardOf(page, 'Course Bundle')).getByText('Pays for recruits: 10%')).toBeTruthy();
    expect(page.queryByLabelText('Search programs')).toBeNull();
  });

  it('offers a search past a handful of programs', async () => {
    const titles = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
    routes['/network/vendors/vnd_many'] = () =>
      json(200, {
        vendor: vendor('vnd_many', 'Many Programs'),
        offerings: titles.map((t, i) => program(`off_${i}`, t, { commissionRules: [pct(10 + i, true)] })),
      });
    const page = renderBrand('vnd_many');
    await page.findByText('Alpha');

    fireEvent.change(page.getByLabelText('Search programs'), { target: { value: 'golf' } });
    expect(page.queryByText('Alpha')).toBeNull();
    expect(page.getByText('Golf')).toBeTruthy();
  });
});
