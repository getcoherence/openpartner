// @vitest-environment jsdom
/**
 * Discover lists one card per brand (the Network's GET /marketplace/brands):
 *   - a brand with several programs takes one card that names them and
 *     summarises their commission; one with a single program reads as that
 *     program, as before;
 *   - search and filters show a brand when any program matches, and say how
 *     many do;
 *   - an older Network without the brand feed still lists, grouped here;
 *   - the brand's page gives each program its own terms and status.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorDiscoverPage } from '../pages/creator/CreatorDiscover.js';
import { CreatorVendorDetailPage } from '../pages/creator/CreatorVendorDetail.js';
import { brandCommissionLine } from '../pages/creator/brand-summary.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const pct = (value: number, recurring: boolean) => ({ trigger: 'every', type: 'percent', value, recurring });

function program(id: string, title: string, terms: Record<string, unknown>, myStatus = 'none') {
  return {
    id,
    title,
    description: `${title} for teams.`,
    productUrl: `https://${id}.example`,
    terms,
    coverImageUrl: null,
    video: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    myStatus,
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

/** Per-test answers, keyed by path under /api/creator-api. */
let routes: Record<string, () => Response>;
let requested: string[];

beforeEach(() => {
  routes = {};
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://portal.test');
    const path = url.pathname.replace(/^\/api\/creator-api/, '');
    requested.push(path + url.search);
    const handler = routes[path];
    return handler ? handler() : json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderDiscover() {
  return render(
    <MemoryRouter initialEntries={['/creator/discover']}>
      <QueryClientProvider client={client()}>
        <CreatorDiscoverPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** The card holding `name`. */
function cardOf(page: ReturnType<typeof render>, name: string) {
  return page.getByText(name).closest('div[style*="flex-direction: column"]') as HTMLElement;
}

describe('brandCommissionLine', () => {
  it('reads as one program when every program pays the same', () => {
    const same = { commissionRules: [pct(30, true)] as never };
    expect(brandCommissionLine([same, same, same])).toBe(brandCommissionLine([same]));
  });

  it('gives the range when programs differ, never only the top rate', () => {
    expect(brandCommissionLine([{ commissionRules: [pct(10, true)] as never }, { commissionRules: [pct(30, true)] as never }])).toBe(
      '10–30% recurring, varies by program',
    );
    expect(brandCommissionLine([{ commissionRules: [pct(10, true)] as never }, { commissionRules: [pct(30, false)] as never }])).toBe(
      '10–30% varies by program',
    );
  });

  it('names flat fees beside a percent range, and says nothing exact across currencies', () => {
    const fixed = (value: number, currency: string) => ({
      commissionRules: [{ trigger: 'every', type: 'fixed', value, currency }] as never,
    });
    expect(brandCommissionLine([{ commissionRules: [pct(15, false)] as never }, fixed(50, 'usd')])).toBe(
      '15% or $50 flat on some programs',
    );
    expect(brandCommissionLine([fixed(20, 'eur'), fixed(40, 'eur')])).toBe('$20–40 EUR varies by program');
    expect(brandCommissionLine([fixed(20, 'eur'), fixed(40, 'usd')])).toBe('Varies by program');
  });
});

describe('Discover', () => {
  it('gives a brand with several programs one card; a one-program brand reads as before', async () => {
    routes['/marketplace/brands'] = () => json(200, { brands: [mixed, solo] });
    const page = renderDiscover();

    await page.findByText('Mixed Media');
    const card = cardOf(page, 'Mixed Media');
    expect(within(card).getByText('3 programs')).toBeTruthy();
    expect(within(card).getByText('Podcast Pro, Video Kit, Course Bundle')).toBeTruthy();
    expect(within(card).getByText('10–25% or $50 flat on some programs')).toBeTruthy();
    expect(within(card).getByText('Pays for recruits')).toBeTruthy();
    expect(within(card).getByText('30–90d window')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'View programs' }).getAttribute('href')).toBe('/creator/vendors/vnd_mixed');

    expect(page.getByText('Solo program for teams.')).toBeTruthy();
    expect(page.getAllByText(/Podcast Pro|Video Kit|Course Bundle/)).toHaveLength(1);
    expect(requested).toContain('/marketplace/brands?limit=100');
  });

  it('shows a brand when any program matches, and says how many do', async () => {
    routes['/marketplace/brands'] = () => json(200, { brands: [mixed, solo] });
    const page = renderDiscover();
    await page.findByText('Mixed Media');

    fireEvent.click(page.getByRole('button', { name: /Filters/ }));
    fireEvent.click(page.getByLabelText(/Pays for recruits/));
    await waitFor(() => expect(page.queryByText('Solo Analytics')).toBeNull());
    expect(within(cardOf(page, 'Mixed Media')).getByText('1 of 3 match')).toBeTruthy();
    fireEvent.click(page.getByLabelText(/Pays for recruits/));

    fireEvent.change(page.getByPlaceholderText('Brand, program or description…'), { target: { value: 'video' } });
    await waitFor(() => expect(page.queryByText('Solo Analytics')).toBeNull());
    expect(within(cardOf(page, 'Mixed Media')).getByText('1 of 3 match')).toBeTruthy();

    fireEvent.change(page.getByPlaceholderText('Brand, program or description…'), { target: { value: 'mixed' } });
    await waitFor(() => expect(within(cardOf(page, 'Mixed Media')).queryByText(/of 3 match/)).toBeNull());
  });

  it('says which of a brand’s programs the creator is already on', async () => {
    const joined = brand('vnd_j', 'Joined Co', [
      program('off_a', 'A', { commissionRules: [pct(20, true)] }, 'approved'),
      program('off_b', 'B', { commissionRules: [pct(20, true)] }),
    ]);
    routes['/marketplace/brands'] = () => json(200, { brands: [joined] });
    const page = renderDiscover();
    await page.findByText('✓ Active on 1');
  });

  it('groups the /offerings feed of a Network without the brand feed', async () => {
    const legacy = (id: string, title: string) => ({
      ...program(id, title, { commissionDescription: '20% recurring' }),
      vendorId: 'vnd_old',
      vendorName: 'Old Network Brand',
      vendorLogoUrl: null,
      vendorPartnerCount: 2,
    });
    routes['/offerings'] = () => json(200, { offerings: [legacy('off_1', 'One'), legacy('off_2', 'Two')] });
    const page = renderDiscover();
    await page.findByText('Old Network Brand');
    expect(page.getByText(/2 programs/)).toBeTruthy();
    expect(page.getByText('One, Two')).toBeTruthy();
    expect(requested).toEqual(expect.arrayContaining(['/marketplace/brands?limit=100', '/offerings?limit=100']));
  });
});

describe('brand page', () => {
  function renderBrand(id: string) {
    return render(
      <MemoryRouter initialEntries={[`/creator/vendors/${id}`]}>
        <QueryClientProvider client={client()}>
          <Routes>
            <Route path="/creator/vendors/:id" element={<CreatorVendorDetailPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('gives each program its own terms and the creator’s status, with a search past a handful', async () => {
    const titles = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
    routes['/vendors/vnd_many'] = () =>
      json(200, {
        vendor: { id: 'vnd_many', displayName: 'Many Programs', logoUrl: null, tier: 'hosted', partnerCount: 0, createdAt: '2026-10-01T00:00:00.000Z', featured: false },
        offerings: titles.map((t, i) =>
          program(`off_${i}`, t, { commissionRules: [pct(10 + i, true)] }, i === 0 ? 'approved' : 'none'),
        ),
      });
    const page = renderBrand('vnd_many');
    await page.findByText('Alpha');
    expect(page.getByText('✓ Active')).toBeTruthy();
    expect(page.getByText(/^16%/)).toBeTruthy();

    fireEvent.change(page.getByLabelText('Search programs'), { target: { value: 'golf' } });
    expect(page.queryByText('Alpha')).toBeNull();
    expect(page.getByText('Golf')).toBeTruthy();
  });

  it('offers no search for a few programs', async () => {
    routes['/vendors/vnd_mixed'] = () =>
      json(200, {
        vendor: { id: 'vnd_mixed', displayName: 'Mixed Media', logoUrl: null, tier: 'hosted', partnerCount: 0, createdAt: '2026-10-01T00:00:00.000Z' },
        offerings: mixed.offerings,
      });
    const page = renderBrand('vnd_mixed');
    await page.findByText('Video Kit');
    expect(page.queryByLabelText('Search programs')).toBeNull();
  });
});
