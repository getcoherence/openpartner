// @vitest-environment jsdom
/**
 * Sanctions screening in the portal (docs/sanctions-screening.md):
 *   - the brand admin's Payouts page lists partners on a compliance hold,
 *     and says when a hold is only a warning (the brand pays them itself);
 *   - the ops Screening page lists possible matches and held partners, and
 *     clearing a match needs a note before it posts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { PayoutsPage } from '../pages/Payouts.js';
import { ScreeningPage } from '../pages/platform/Screening.js';

let requests: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MATCH = {
  id: 'scr_1',
  subjectKind: 'partner',
  subjectId: 'p_ivan',
  tenantId: 't_1',
  screenedName: 'Ivan Listed',
  country: 'GB',
  result: 'possible_match',
  matches: [
    {
      source: 'Specially Designated Nationals (SDN) - Treasury Department',
      name: 'IVAN LISTED',
      score: 96,
      entryId: 'sdn-1',
      type: 'Individual',
      programs: ['SDGT'],
      countries: ['IR'],
    },
  ],
  errorDetail: null,
  trigger: 'first_payable',
  screenedAt: '2026-10-19T10:00:00.000Z',
  decision: null,
  reviewedByEmail: null,
  reviewedAt: null,
  reviewNote: null,
  decisionCarried: false,
  brandName: 'Acme',
  brandSlug: 'acme',
  partnerName: 'Ivan Listed',
  partnerEmail: 'ivan@example.com',
};

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, body });
    if (path === '/payouts/holds') {
      return json(200, {
        holds: [
          {
            partnerId: 'p_ivan',
            partnerName: 'Ivan Listed',
            partnerEmail: 'ivan@example.com',
            reason: 'screening_review',
            effect: 'held',
            owed: [{ currency: 'USD', amount: 42.5 }],
          },
          {
            partnerId: 'p_cu',
            partnerName: 'Havana Reviews',
            partnerEmail: 'cu@example.com',
            reason: 'country_not_supported',
            effect: 'warning',
            owed: [{ currency: 'USD', amount: 10 }],
          },
        ],
      });
    }
    if (path === '/platform-admin/screening') {
      return json(200, {
        cslConfigured: true,
        matchScoreThreshold: 85,
        reviews: [MATCH],
        held: [
          {
            tenantId: 't_1',
            brandName: 'Acme',
            brandSlug: 'acme',
            partnerId: 'p_ivan',
            partnerName: 'Ivan Listed',
            partnerEmail: 'ivan@example.com',
            reason: 'screening_review',
            country: null,
            effect: 'held',
            owed: [{ currency: 'USD', amount: 42.5 }],
          },
        ],
      });
    }
    if (path === '/platform-admin/screenings/scr_1/review' && method === 'POST') {
      return json(200, { ok: true, screening: { ...MATCH, decision: body?.decision }, brandRejected: false });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('brand Payouts page', () => {
  it('lists partners on a compliance hold, and flags the ones the brand pays itself', async () => {
    const view = renderWithClient(<PayoutsPage principal={{ role: 'admin' }} />);

    await view.findByText('2 partners are on a compliance hold');
    expect(view.getByText('Ivan Listed')).toBeTruthy();
    expect(view.getByText(/Sanctions screening found a possible match/)).toBeTruthy();
    expect(view.getByText(/owed \$42\.50/)).toBeTruthy();
    expect(view.getByText(/Based in a country OpenPartner can’t send payouts to/)).toBeTruthy();
    // Only the manual-rail partner gets the "check before you pay" warning.
    expect(view.getAllByText(/You pay this partner yourself/)).toHaveLength(1);
  });

  it("doesn't ask a partner's portal for holds", async () => {
    renderWithClient(<PayoutsPage principal={{ role: 'partner', partnerId: 'p_ivan' }} />);
    await waitFor(() => expect(requests.some((r) => r.path.endsWith('/payouts'))).toBe(true));
    expect(requests.some((r) => r.path === '/payouts/holds')).toBe(false);
  });
});

describe('ops Screening page', () => {
  it('shows the possible match and the held partner, and clears only with a note', async () => {
    const view = renderWithClient(<ScreeningPage operator={{ email: 'ops@example.com', role: 'admin' }} />);

    await view.findByText('Needs review (1)');
    expect(view.getByText('IVAN LISTED')).toBeTruthy();
    expect(view.getByText(/Specially Designated Nationals/)).toBeTruthy();
    expect(view.getByText('Held partners (1)')).toBeTruthy();
    expect(view.getByText('Stripe payouts held')).toBeTruthy();

    const clear = view.getByRole('button', { name: 'Clear: not them' }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    fireEvent.change(view.getByPlaceholderText(/Listed entry is an individual/), {
      target: { value: 'Different person: the SDN entry was born 1958' },
    });
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);

    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST')).toEqual({
        method: 'POST',
        path: '/platform-admin/screenings/scr_1/review',
        body: { decision: 'cleared', note: 'Different person: the SDN entry was born 1958' },
      }),
    );
  });

  it('asks before confirming a match', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = renderWithClient(<ScreeningPage operator={{ email: 'ops@example.com', role: 'admin' }} />);
    fireEvent.click(await view.findByRole('button', { name: 'Confirm match' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Their Stripe payouts stay on hold.'));
    expect(requests.some((r) => r.method === 'POST')).toBe(false);

    confirm.mockReturnValue(true);
    fireEvent.click(view.getByRole('button', { name: 'Confirm match' }));
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ decision: 'confirmed_match' }),
    );
  });

  it('gives a read-only operator no review buttons', async () => {
    const view = renderWithClient(<ScreeningPage operator={{ email: 'support@example.com', role: 'support' }} />);
    await view.findByText('Needs review (1)');
    expect(view.queryByRole('button', { name: 'Confirm match' })).toBeNull();
  });
});
