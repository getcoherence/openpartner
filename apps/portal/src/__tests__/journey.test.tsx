// @vitest-environment jsdom
/**
 * Admin → Customer journey: the customer's partner touches and events in
 * one timeline, each touch marked with what became of it for the selected
 * conversion, who got credit and why, and who each model would credit.
 * Opened from a commission (?event=) or by customer id (?customer=); a
 * decision today's data no longer matches says so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminJourney, gap, type Journey } from '../pages/admin/Journey.js';

let journey: Journey;
let requested: string[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const touch = (o: Partial<Journey['touches'][number]> & Pick<Journey['touches'][number], 'clickId' | 'ts'>): Journey['touches'][number] => ({
  kind: 'link',
  partner: { id: 'pa', name: 'Ada' },
  program: { id: 'pr1', name: 'Refer & Earn' },
  code: null,
  landingUrl: 'https://brand.example/pricing',
  landedAt: null,
  referer: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  subId: null,
  browser: 'Mobile Safari',
  device: 'mobile',
  country: 'GB',
  linkedAt: null,
  flagged: false,
  ...o,
});

function baseJourney(): Journey {
  return {
    userId: 'cust_42',
    touches: [
      touch({ clickId: 'c1', ts: '2026-10-01T10:00:00.000Z', referer: 'https://ada.blog/review', landedAt: '2026-10-01T10:00:02.000Z' }),
      touch({ clickId: 'c2', ts: '2026-10-13T10:00:00.000Z', partner: { id: 'pb', name: 'Bob' } }),
      touch({ clickId: 'c3', ts: '2026-10-14T09:59:52.000Z', kind: 'code', code: 'CAM10', landingUrl: null, partner: { id: 'pc', name: 'Cam' } }),
    ],
    events: [
      { id: 'e1', type: 'invoice_paid', ts: '2026-10-14T10:00:00.000Z', value: 100, currency: 'USD', corrective: false, credited: [{ partnerId: 'pc', partnerName: 'Cam', weight: 1 }] },
    ],
    selected: {
      eventId: 'e1',
      status: 'credited',
      source: 'window',
      model: 'last_click',
      candidates: 3,
      fromEvent: null,
      touches: [
        { clickId: 'c1', verdict: 'in_window', weight: 0, pastWindow: false, secondsBeforeEvent: 13 * 86_400, linkedAfterEvent: false },
        { clickId: 'c2', verdict: 'in_window', weight: 0, pastWindow: false, secondsBeforeEvent: 86_400, linkedAfterEvent: false },
        { clickId: 'c3', verdict: 'credited', weight: 1, pastWindow: false, secondsBeforeEvent: 8, linkedAfterEvent: false },
      ],
      recorded: [
        {
          attributionId: 'a1',
          clickId: 'c3',
          partnerId: 'pc',
          partnerName: 'Cam',
          model: 'last_click',
          weight: 1,
          computedAt: '2026-10-14T10:00:01.000Z',
          commissions: [{ id: 'cm1', partnerId: 'pc', partnerName: 'Cam', amount: '10.00', currency: 'USD', status: 'accrued', recruiter: false }],
        },
      ],
      matchesRecord: true,
      alternatives: [
        { model: 'last_click', live: true, credits: [{ partnerId: 'pc', partnerName: 'Cam', weight: 1 }] },
        { model: 'first_click', live: false, credits: [{ partnerId: 'pa', partnerName: 'Ada', weight: 1 }] },
        {
          model: 'linear',
          live: false,
          credits: [
            { partnerId: 'pa', partnerName: 'Ada', weight: 0.3333 },
            { partnerId: 'pb', partnerName: 'Bob', weight: 0.3333 },
            { partnerId: 'pc', partnerName: 'Cam', weight: 0.3333 },
          ],
        },
        {
          model: 'position',
          live: false,
          credits: [
            { partnerId: 'pa', partnerName: 'Ada', weight: 0.4 },
            { partnerId: 'pc', partnerName: 'Cam', weight: 0.4 },
            { partnerId: 'pb', partnerName: 'Bob', weight: 0.2 },
          ],
        },
      ],
    },
    truncated: { touches: false, events: false },
  };
}

beforeEach(() => {
  journey = baseJourney();
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    requested.push(url.pathname + url.search);
    if (/^\/api\/events\/[^/]+\/journey$/.test(url.pathname)) return json(200, journey);
    if (/^\/api\/customers\/[^/]+\/journey$/.test(url.pathname)) return json(200, journey);
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <AdminJourney />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('gap', () => {
  it('says how long before or after the conversion a touch was', () => {
    expect(gap(8)).toBe('8 seconds before');
    expect(gap(1)).toBe('1 second before');
    expect(gap(13 * 86_400)).toBe('13 days before');
    expect(gap(-7200)).toBe('2 hours after');
  });
});

describe('Customer journey page', () => {
  it('opens a commission’s conversion: who got credit, why, and under each model', async () => {
    renderPage('/admin/journey?event=e1');
    expect(await screen.findByText('Credited to Cam (100%)')).toBeTruthy();
    expect(requested).toContain('/api/events/e1/journey');
    expect(screen.getByText('Decided by the last click model over the 3 partner touches in the window.')).toBeTruthy();

    // Each touch, in order, with its verdict for this sale.
    expect(screen.getAllByText('In window, no share')).toHaveLength(2);
    expect(screen.getByText('Credited 100%')).toBeTruthy();
    expect(screen.getByText(/8 seconds before the selected event/)).toBeTruthy();
    expect(screen.getByText(/from ada\.blog/)).toBeTruthy();
    expect(screen.getByText('CAM10')).toBeTruthy();

    // The alternatives, with this program's model marked.
    const firstClick = screen.getByText('First click').closest('tr')!;
    expect(within(firstClick).getByText('Ada 100%')).toBeTruthy();
    expect(screen.getByText(/this program's model/)).toBeTruthy();
    expect(screen.getByText('Ada 40%, Cam 40%, Bob 20%')).toBeTruthy();

    // What it earned.
    expect(screen.getByText('$10.00')).toBeTruthy();
    // Says what it can't see.
    expect(screen.getByText(/paid search, organic and direct visits/)).toBeTruthy();
  });

  it('looks a customer up by id', async () => {
    renderPage('/admin/journey');
    expect(screen.getByText('Look up a customer')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Customer id'), { target: { value: 'cust 42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() => expect(requested).toContain('/api/customers/cust%2042/journey'));
    expect(await screen.findByText('Credited to Cam (100%)')).toBeTruthy();
  });

  it('a renewal names the conversion it came from, and a stale decision says so', async () => {
    journey.events.unshift({ id: 'e0', type: 'invoice_paid', ts: '2026-09-14T10:00:00.000Z', value: 100, currency: 'USD', corrective: false, credited: [{ partnerId: 'pa', partnerName: 'Ada', weight: 1 }] });
    journey.selected = {
      ...journey.selected!,
      source: 'renewal',
      fromEvent: { id: 'e0', type: 'invoice_paid', ts: '2026-09-14T10:00:00.000Z' },
      alternatives: null,
      matchesRecord: false,
    };
    renderPage('/admin/journey?event=e1');
    expect(await screen.findByText(/A repeat invoice_paid\. It stays with the partner credited for the customer's first invoice_paid/)).toBeTruthy();
    expect(screen.queryByText('Under each model, over the same touches')).toBeNull();
    expect(screen.getByRole('note').textContent).toMatch(/Today's data would credit this differently/);

    fireEvent.click(screen.getByRole('button', { name: 'Show that conversion' }));
    await waitFor(() => expect(requested).toContain('/api/events/e0/journey'));
  });

  it('counts the model’s input from the decision, not the touches shown', async () => {
    journey.selected = { ...journey.selected!, candidates: 240 };
    journey.truncated = { touches: true, events: false };
    renderPage('/admin/journey?event=e1');
    expect(await screen.findByText('Decided by the last click model over the 240 partner touches in the window.')).toBeTruthy();
    expect(screen.getByText(/a credited one can be older than those shown/)).toBeTruthy();
  });

  it('a conversion nobody got says why', async () => {
    journey.selected = { ...journey.selected!, status: 'outside_window', source: null, model: null, recorded: [], alternatives: null };
    journey.events[0]!.credited = [];
    renderPage('/admin/journey?event=e1');
    expect(await screen.findByText('Nobody was credited')).toBeTruthy();
    expect(screen.getByText(/No touch could take this conversion \(each touch's reason is below/)).toBeTruthy();
    expect(screen.getByText(/nobody credited/)).toBeTruthy();
  });
});
