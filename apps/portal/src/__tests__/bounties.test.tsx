// @vitest-environment jsdom
/**
 * Performance bounties in the portal (docs/bounties.md §7): the admin
 * Bounties page's sentence form and progress view, and the partner's
 * Bounties tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderBountySummary } from '@openpartner/db';
import { AdminProgramBounties } from '../pages/AdminProgramBounties.js';
import { PartnerBountiesPage } from '../pages/partner/Bounties.js';
import { CommissionsPage } from '../pages/Commissions.js';

let requests: Array<{ method: string; path: string; search: string; body: Record<string, unknown> | undefined }> = [];

const BOUNTY = {
  id: 'bty_1',
  programId: 'prog_1',
  name: 'Holiday push',
  description: 'Ten sales before New Year.\nRefunds come off.',
  metric: 'conversions',
  eventType: null,
  threshold: 10,
  scope: 'new',
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2026-12-31T00:00:00.000Z',
  rewardAmount: '500.00',
  currency: 'USD',
  partnerIds: null,
  status: 'active',
  summary: 'Reach 10 new sales between Nov 1, 2026 and Dec 31, 2026 to earn $500.',
  awardedCount: 1,
  endedAt: null,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, search: url.search, body });
    if (path === '/me/programs') return json(200, { programs: [{ id: 'prog_1', name: 'Holiday program' }] });
    if (path === '/config/program') return json(200, { defaultCurrency: 'EUR' });
    if (path === '/bounties' && method === 'GET') return json(200, { bounties: [BOUNTY] });
    if (path === '/bounties' && method === 'POST') return json(201, { bounty: { ...BOUNTY, id: 'bty_2', ...body } });
    if (path === '/bounties/bty_1/progress') {
      return json(200, {
        bounty: BOUNTY,
        totals: { eligible: 2, reached: 1, awarded: 1 },
        partners: [
          { partnerId: 'p1', name: 'Ada', email: 'ada@x.test', value: 10, reached: true, award: { bonusId: 'b1', commissionId: 'c1', status: 'accrued', awardedAt: '2026-12-01T00:00:00Z' } },
          { partnerId: 'p2', name: 'Bea', email: 'bea@x.test', value: 4, reached: false, award: null },
        ],
        truncated: false,
      });
    }
    if (path === '/bounties/bty_1' && method === 'PATCH') return json(200, { bounty: { ...BOUNTY, ...body } });
    if (path === '/me/bounties') {
      return json(200, {
        bounties: [
          { ...BOUNTY, programName: 'Holiday program', progress: 7, reached: false, award: null },
          {
            ...BOUNTY,
            id: 'bty_3',
            name: 'First sale',
            metric: 'revenue',
            threshold: 1000,
            summary: 'Reach $1,000 in new revenue to earn $50.',
            rewardAmount: '50.00',
            programName: 'Holiday program',
            progress: 1250.5,
            reached: true,
            award: { bonusId: 'b9', status: 'approved', awardedAt: '2026-12-02T00:00:00Z' },
          },
        ],
      });
    }
    if (path === '/commissions') {
      return json(200, {
        commissions: [
          {
            id: 'c_bounty', partnerId: 'p1', amount: '500.00', currency: 'USD', status: 'accrued',
            accruedAt: '2026-12-01T00:00:00.000Z', paidAt: null, campaignName: 'Holiday program', source: 'bonus',
            bonus: { id: 'b1', source: 'performance_bounty', note: 'Holiday push', bountyId: 'bty_1', bountyName: 'Holiday push' },
          },
        ],
        nextCursor: null,
      });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderAt(path: string, routePath: string, element: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const adminPage = () => renderAt('/admin/programs/prog_1/bounties', '/admin/programs/:id/bounties', <AdminProgramBounties />);

describe('admin: a program’s bounties', () => {
  it('lists bounties with their goal in words and shows each partner’s progress', async () => {
    const page = adminPage();
    expect(await page.findByText(BOUNTY.summary)).toBeTruthy();
    expect(page.getByText(/1 partner has earned it/)).toBeTruthy();
    expect(requests.find((r) => r.path === '/bounties' && r.method === 'GET')?.search).toBe('?programId=prog_1');

    fireEvent.click(page.getByRole('button', { name: 'Progress' }));
    const ada = await page.findByRole('progressbar', { name: '10 of 10' });
    expect(ada.getAttribute('aria-valuenow')).toBe('10');
    expect(page.getByRole('progressbar', { name: '4 of 10' })).toBeTruthy();
    expect(page.getByText('2 eligible · 1 reached · 1 paid')).toBeTruthy();
  });

  it('creates a bounty from the sentence form, previewing what partners will see', async () => {
    const page = adminPage();
    fireEvent.click(await page.findByRole('button', { name: 'New bounty' }));
    const form = within(await page.findByRole('region', { name: 'New bounty' }));

    fireEvent.change(form.getByLabelText('Metric'), { target: { value: 'revenue' } });
    fireEvent.change(form.getByLabelText('Threshold'), { target: { value: '2500' } });
    fireEvent.change(form.getByLabelText('Starts'), { target: { value: '2026-11-01' } });
    fireEvent.change(form.getByLabelText('Ends'), { target: { value: '2026-12-31' } });
    fireEvent.change(form.getByLabelText('Reward'), { target: { value: '250' } });
    fireEvent.change(form.getByLabelText('Event type'), { target: { value: 'invoice_paid' } });
    fireEvent.change(form.getByLabelText('Bounty name'), { target: { value: 'Q4 revenue' } });
    fireEvent.change(form.getByLabelText('Bounty description'), { target: { value: 'Invoices only.' } });

    await waitFor(() => expect((form.getByLabelText('Currency') as HTMLInputElement).value).toBe('EUR'));
    const preview = renderBountySummary({
      metric: 'revenue',
      eventType: 'invoice_paid',
      threshold: 2500,
      scope: 'new',
      startsAt: '2026-11-01T00:00:00Z',
      endsAt: '2026-12-31T00:00:00Z',
      rewardAmount: 250,
      currency: 'EUR',
    });
    expect(form.getByText(preview)).toBeTruthy();

    fireEvent.click(form.getByRole('button', { name: /^Launch/ }));
    await waitFor(() => expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1));
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({
      programId: 'prog_1',
      name: 'Q4 revenue',
      description: 'Invoices only.',
      metric: 'revenue',
      eventType: 'invoice_paid',
      threshold: 2500,
      scope: 'new',
      startsAt: '2026-11-01T00:00:00Z',
      endsAt: '2026-12-31T00:00:00Z',
      rewardAmount: 250,
      currency: 'EUR',
      status: 'active',
    });
  });

  it('wants whole numbers for counts and refuses an end before the start', async () => {
    const page = adminPage();
    fireEvent.click(await page.findByRole('button', { name: 'New bounty' }));
    const form = within(await page.findByRole('region', { name: 'New bounty' }));
    fireEvent.change(form.getByLabelText('Bounty name'), { target: { value: 'X' } });
    fireEvent.change(form.getByLabelText('Reward'), { target: { value: '50' } });
    fireEvent.change(form.getByLabelText('Threshold'), { target: { value: '2.5' } });
    expect(form.getByText(/Count in whole numbers/)).toBeTruthy();
    expect((form.getByRole('button', { name: /^Launch/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(form.getByLabelText('Threshold'), { target: { value: '3' } });
    fireEvent.change(form.getByLabelText('Starts'), { target: { value: '2026-12-01' } });
    fireEvent.change(form.getByLabelText('Ends'), { target: { value: '2026-11-01' } });
    expect(form.getByText(/The end must be after the start/)).toBeTruthy();
    expect((form.getByRole('button', { name: /^Launch/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('ends a bounty after confirming', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const page = adminPage();
    fireEvent.click(await page.findByRole('button', { name: 'End now' }));
    await waitFor(() => expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ status: 'ended' }));
  });
});

describe('partner: Bounties tab', () => {
  it('shows each bounty, its progress and whether it was earned', async () => {
    const page = renderAt('/bounties', '/bounties', <PartnerBountiesPage />);
    expect(await page.findByText(BOUNTY.summary)).toBeTruthy();
    expect(page.getByRole('progressbar', { name: '7 of 10' })).toBeTruthy();
    // The description is the brand's plain text, line breaks kept.
    expect(page.getAllByText(/Ten sales before New Year\./)[0]!.textContent).toContain('\n');
    expect(page.getByRole('progressbar', { name: '$1,250.50 of $1,000' })).toBeTruthy();
    expect(page.getByRole('status').textContent).toBe('Earned. It goes out with your next payout.');
  });
});

describe('commission lists', () => {
  it('label a bounty bonus with the bounty’s name', async () => {
    const page = renderAt('/commissions', '/commissions', <CommissionsPage principal={{ role: 'admin' }} />);
    expect(await page.findByText('Bounty: Holiday push')).toBeTruthy();
  });
});
