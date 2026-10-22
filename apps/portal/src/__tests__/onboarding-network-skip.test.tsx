// @vitest-environment jsdom
/**
 * "Not now" on the Getting started card's Network step. The OpenPartner
 * Network is optional, but the card only hid once the brand had joined and
 * published, so a brand that didn't want the Network could never clear it.
 * The open Network step now carries a "Not now" (and, once skipped, an
 * "Undo") that saves `POST /config/onboarding`; the API then reports the
 * card complete and it goes away.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Dashboard } from '../pages/Dashboard.js';

interface Status {
  brandInfoComplete: boolean;
  campaignCount: number;
  networkConnected: boolean;
  offeringPublishedCount: number;
  networkListingSkipped?: boolean;
  partnerCount: number;
  pendingPartnershipRequests: number;
  billingReady: boolean;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  trackingInstalled: boolean;
  approvalStatus: 'approved';
  complete: boolean;
}

/** Every step done except the Network ones. */
function readyStatus(overrides: Partial<Status> = {}): Status {
  return {
    brandInfoComplete: true,
    campaignCount: 1,
    networkConnected: false,
    offeringPublishedCount: 0,
    networkListingSkipped: false,
    partnerCount: 1,
    pendingPartnershipRequests: 0,
    billingReady: true,
    trialEndsAt: null,
    trialDaysRemaining: null,
    trackingInstalled: true,
    approvalStatus: 'approved',
    complete: false,
    ...overrides,
  };
}

let status: Status;
let whiteLabel: boolean;
let posts: unknown[];

function json(code: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
}

/** A stand-in API: `POST /config/onboarding` updates the status the way
 *  the real route does for a brand off the Network. */
beforeEach(() => {
  whiteLabel = false;
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/config/onboarding' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { networkListingSkipped: boolean };
      posts.push(body);
      const settled = body.networkListingSkipped || (status.networkConnected && status.offeringPublishedCount > 0);
      status = { ...status, networkListingSkipped: body.networkListingSkipped, complete: settled && status.partnerCount > 0 };
      return json(200, { networkListingSkipped: body.networkListingSkipped });
    }
    if (url.pathname === '/api/admin/onboarding-status') return json(200, status);
    if (url.pathname === '/api/config/program') {
      return json(200, { programName: 'Volza', defaultCurrency: 'INR', whiteLabel });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Dashboard principal={{ role: 'admin' }} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** The step's bordered box: the label's ancestor that sits directly in the
 *  card's column of steps. */
async function stepRow(page: ReturnType<typeof renderDashboard>, label: string): Promise<HTMLElement> {
  let el: HTMLElement | null = await page.findByText(label);
  while (el && el.parentElement?.style.flexDirection !== 'column') el = el.parentElement;
  expect(el).toBeTruthy();
  return el!;
}

describe('Getting started: Network "Not now"', () => {
  it('skipping the Network step clears the card for a brand that has done everything else', async () => {
    status = readyStatus();
    const page = renderDashboard();
    const row = await stepRow(page, 'List your brand on the OpenPartner Network');

    // The control sits beside the step's link, not inside it.
    const notNow = within(row).getByRole('button', { name: 'Not now' });
    expect(notNow.closest('a')).toBeNull();
    fireEvent.click(notNow);

    await waitFor(() => expect(page.queryByText('Getting started')).toBeNull());
    expect(posts).toEqual([{ networkListingSkipped: true }]);
  });

  it('shows a skipped step with Undo while other steps are still open', async () => {
    status = readyStatus({ networkListingSkipped: true, partnerCount: 0 });
    const page = renderDashboard();
    const row = await stepRow(page, 'List your brand on the OpenPartner Network');
    expect(within(row).getByText(/Skipped\. Join any time/)).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Not now' })).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(posts).toEqual([{ networkListingSkipped: false }]));
    expect(await within(row).findByRole('button', { name: 'Not now' })).toBeTruthy();
  });

  it('on the Network already, the control moves to the publish step', async () => {
    status = readyStatus({ networkConnected: true });
    const page = renderDashboard();
    await page.findByText('Publish a program on the marketplace');
    const buttons = page.getAllByRole('button', { name: 'Not now' });
    expect(buttons).toHaveLength(1);
    const publish = await stepRow(page, 'Publish a program on the marketplace');
    expect(within(publish).getByRole('button', { name: 'Not now' })).toBe(buttons[0]);
  });

  it('a white-label brand gets no Network step to skip', async () => {
    whiteLabel = true;
    status = readyStatus({ partnerCount: 0 });
    const page = renderDashboard();
    await page.findByText('Getting started');
    await waitFor(() => expect(page.queryByText('List your brand on the OpenPartner Network')).toBeNull());
    expect(page.queryByRole('button', { name: 'Not now' })).toBeNull();
  });

  it("offers no control on an API that doesn't know the setting", async () => {
    const older = readyStatus();
    delete older.networkListingSkipped;
    status = older;
    const page = renderDashboard();
    await page.findByText('List your brand on the OpenPartner Network');
    expect(page.queryByRole('button', { name: 'Not now' })).toBeNull();
  });
});
