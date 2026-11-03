// @vitest-environment jsdom
/**
 * Two-tier commissions on the creator side (docs/two-tier-commissions.md):
 *   - Discover marks a program that pays for recruits, and filters on it;
 *   - the program page says what it pays for recruits;
 *   - a creator's own program page gives their recruit link and recruits,
 *     from the Network (GET /creators/me/partnerships/:id/recruits), and
 *     shows nothing while the program pays nothing and nobody joined.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorDiscoverPage } from '../pages/creator/CreatorDiscover.js';
import { CreatorOfferingDetailPage } from '../pages/creator/CreatorOfferingDetail.js';
import { CreatorProgramDetailPage } from '../pages/creator/CreatorProgramDetail.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function offering(id: string, title: string, terms: Record<string, unknown>) {
  return {
    id,
    title,
    description: `${title} for teams.`,
    productUrl: `https://${id}.example`,
    vendorId: `vnd_${id}`,
    vendorName: title,
    vendorLogoUrl: null,
    vendorPartnerCount: 3,
    terms: { commissionDescription: '20% recurring', ...terms },
    coverImageUrl: null,
    video: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    myStatus: 'none',
  };
}

/** Per-test answers, keyed by path under /api/creator-api. */
let routes: Record<string, () => Response>;

beforeEach(() => {
  routes = {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://portal.test');
    const handler = routes[url.pathname.replace(/^\/api\/creator-api/, '')];
    return handler ? handler() : json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('Discover', () => {
  it('marks a program that pays for recruits, and filters on it', async () => {
    routes['/offerings'] = () =>
      json(200, {
        offerings: [
          offering('acme', 'Acme', { recruiterCommission: { percent: 10, months: 12 } }),
          offering('globex', 'Globex', {}),
        ],
      });
    const page = render(
      <MemoryRouter initialEntries={['/creator/discover']}>
        <QueryClientProvider client={client()}>
          <CreatorDiscoverPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await page.findByText('Pays for recruits: 10%');
    expect(page.getByText('Globex')).toBeTruthy();

    fireEvent.click(page.getByRole('button', { name: /Filters/ }));
    fireEvent.click(page.getByLabelText(/Pays for recruits/));
    await waitFor(() => expect(page.queryByText('Globex')).toBeNull());
    expect(page.getByText('Acme')).toBeTruthy();
  });
});

describe('program page', () => {
  it('says what the program pays for recruits', () => {
    const qc = client();
    qc.setQueryData(['creator-offering', 'acme'], offering('acme', 'Acme', { recruiterCommission: { percent: 7.5, months: null } }));
    qc.setQueryData(['creator-whoami'], { creator: { id: 'crt_1', handle: 'ada' } });
    qc.setQueryData(['creator-my-profile'], { profileComplete: true, profileChecklist: [] });
    const page = render(
      <MemoryRouter initialEntries={['/creator/offerings/acme']}>
        <QueryClientProvider client={qc}>
          <Routes>
            <Route path="/creator/offerings/:id" element={<CreatorOfferingDetailPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(page.getByText('Recruit other partners: 7.5% of your recruits’ commissions')).toBeTruthy();
  });
});

describe('a creator’s own program page', () => {
  beforeEach(() => {
    routes['/creators/me/partnerships'] = () =>
      json(200, {
        partnerships: [
          {
            id: 'pt_ada',
            vendorId: 'ven_1',
            offeringId: 'off_1',
            creatorSlug: 'notewise',
            publicShareUrl: 'https://notewise.test/r/ada',
            status: 'active',
            createdAt: '2026-09-01T00:00:00.000Z',
            vendorName: 'Notewise',
            offeringTitle: 'Notewise Pro',
            shareUrl: 'https://notewise.test/r/ada',
            customDomain: null,
            coupons: [],
          },
        ],
      });
  });

  function renderOverview() {
    return render(
      <MemoryRouter initialEntries={['/creator/programs/pt_ada']}>
        <QueryClientProvider client={client()}>
          <Routes>
            <Route path="/creator/programs/:partnershipId/*" element={<CreatorProgramDetailPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('gives the recruit link, what it pays and who joined', async () => {
    routes['/creators/me/partnerships/pt_ada/recruits'] = () =>
      json(200, {
        share: { percent: 10, months: 12 },
        recruitUrl: 'https://partners.notewise.test/join?ref=ada7',
        signupOpen: true,
        recruits: [{ name: 'Bo Chen', recruitedAt: '2026-10-20T00:00:00.000Z', status: 'active', earned: { USD: '12.50' } }],
        total: 1,
      });
    const page = renderOverview();
    await page.findByText('Recruit partners');
    expect(page.getByText('You earn 10% of your recruits’ commissions, for 12 months after each one joins.')).toBeTruthy();
    expect((page.getByLabelText('Recruit link') as HTMLInputElement).value).toBe('https://partners.notewise.test/join?ref=ada7');
    expect(page.getByText('Bo Chen')).toBeTruthy();
    expect(page.getByText('$12.50')).toBeTruthy();
  });

  it('shows nothing while the program pays nothing for recruiting and nobody joined', async () => {
    let asked = false;
    routes['/creators/me/partnerships/pt_ada/recruits'] = () => {
      asked = true;
      return json(200, { share: null, recruitUrl: null, signupOpen: false, recruits: [], total: 0 });
    };
    const page = renderOverview();
    await page.findByText('Recent earnings');
    await waitFor(() => expect(asked).toBe(true));
    expect(page.queryByText('Recruit partners')).toBeNull();
  });
});
