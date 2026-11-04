// @vitest-environment jsdom
/**
 * The brand outreach console page (pages/platform/BrandOutreach.tsx): the
 * review queue (why each is held, approve with or without an address found,
 * reject), the prospect list with masked addresses and the words that place
 * a company in the US, the views and reasons it asks the Network for, what
 * an admin can do and support can't, the runs' phase-1 numbers, and saving
 * settings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrandOutreachPage } from '../pages/platform/BrandOutreach.js';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}
let calls: Recorded[] = [];

const SETTINGS = { enabled: true, monthlyBudgetUsd: 20, queries: ['developer tools'], lookbackDays: 7, sendAfterDays: 14, maxLaunchAgeDays: 60, readConcurrency: 4 };

const ACME = {
  id: 'bpr_1',
  status: 'qualified',
  launchUrl: 'https://www.producthunt.com/products/acme-notes',
  launchedAt: '2026-10-20T00:00:00.000Z',
  discoveredBy: 'exa:note-taking apps',
  name: 'Acme Notes',
  siteUrl: 'https://acmenotes.example',
  siteFoundBy: 'copy',
  summary: 'Writes meeting notes for small teams.',
  categories: ['productivity'],
  country: 'US',
  countryEvidence: 'Acme Notes, Inc. is a Delaware corporation',
  pricingUrl: 'https://acmenotes.example/pricing',
  contact: { masked: 'h••••@acmenotes.example', foundOn: 'https://acmenotes.example/about' },
  rejectReason: null,
  dueAt: '2026-11-03T00:00:00.000Z',
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
};

const HELD = {
  ...ACME,
  id: 'bpr_2',
  status: 'review',
  name: 'Pipewise',
  siteUrl: 'https://pipewise.example',
  country: null,
  countryEvidence: null,
  rejectReason: 'country_unknown',
  reviewNote: 'Said US, quoting words not on the pages read: "Based in Ohio"',
  dueAt: null,
};
const HELD_NO_ADDRESS = { ...HELD, id: 'bpr_3', name: 'Shipcheck', siteUrl: 'https://shipcheck.example', rejectReason: 'no_address', reviewNote: null, contact: null };

const STATS = {
  byStatus: { qualified: 1, queued: 3, rejected: 5, review: 2 },
  held: { country_unknown: 1, no_address: 1 },
  copyLinks: { website: 7, redirect_only: 2, none: 1 },
  ready: 1,
  waiting: 0,
  rejections: { not_us: 3, has_affiliate_program: 2 },
  siteFoundBy: { copy: 4 },
  spend: { thisMonthUsd: 1.5, budgetUsd: 20 },
  enabled: true,
  queriesSearchedAt: {},
  runs: {
    read: {
      startedAt: '2026-11-03T10:00:00.000Z',
      finishedAt: '2026-11-03T10:02:00.000Z',
      result: {
        ran: true,
        expired: 0,
        read: 9,
        qualified: 1,
        rejected: { not_us: 3 },
        retried: 0,
        copies: { websiteLink: 6, onlyRedirectLinks: 2, noLinks: 1 },
        website: { copy: 6, search: 2, none: 1 },
      },
    },
  },
};

function respond(url: string, method: string): { status: number; body: unknown } {
  if (url.endsWith('/brand-outreach/settings') && method === 'PUT') return { status: 200, body: { settings: calls[calls.length - 1]!.body, updatedAt: null, updatedByEmail: null } };
  if (url.endsWith('/brand-outreach/settings')) return { status: 200, body: { settings: SETTINGS, defaults: SETTINGS, updatedAt: null, updatedByEmail: null, configured: { exa: true, treg: true, classifier: true, classifierModel: 'claude-opus-5-5' } } };
  if (url.endsWith('/brand-outreach/stats')) return { status: 200, body: STATS };
  if (url.includes('/brand-outreach/prospects?')) {
    const prospects = url.includes('view=review') ? [HELD, HELD_NO_ADDRESS] : url.includes('view=rejected') ? [] : [ACME];
    return { status: 200, body: { prospects, nextCursor: null } };
  }
  if (url.endsWith('/prospects/bpr_2/approve')) return { status: 200, body: { prospect: { ...HELD, status: 'qualified' } } };
  if (url.endsWith('/prospects/bpr_3/approve')) return { status: 400, body: { error: 'not_their_address' } };
  if (url.endsWith('/reject')) return { status: 204, body: null };
  if (url.endsWith('/prospects/bpr_1/contact')) return { status: 200, body: { contact: { email: 'hello@acmenotes.example', foundOn: ACME.contact.foundOn } } };
  return { status: 404, body: { error: 'not_found' } };
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const { status, body } = respond(url, method);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(role: 'admin' | 'support', path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <BrandOutreachPage operator={{ id: 'pa_1', email: 'ops@test', role } as never} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** The page opens on the review queue; the others are a button away. */
async function openView(name: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name }));
}

describe('brand outreach console', () => {
  it('opens on the review queue: why each is held, approved after a confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap('admin');
    expect(await screen.findByText('Pipewise')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/prospects?view=review'))).toBe(true);
    expect(screen.getByText('country unknown')).toBeTruthy();
    expect(screen.getByText('“Said US, quoting words not on the pages read: "Based in Ohio"”')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^To review 2/ })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]!);
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/prospects/bpr_2/approve'))).toMatchObject({ method: 'POST', body: {} }));
  });

  it('approves one with no address only with an address and its page, and shows why the Network refused', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap('admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Add address' }));
    const approve = () => screen.getAllByRole('button', { name: 'Approve' }).at(-1) as HTMLButtonElement;
    expect(approve().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'support@shipcheck.example' } });
    fireEvent.change(screen.getByLabelText("Page it's on"), { target: { value: 'https://shipcheck.example/about' } });
    fireEvent.click(approve());
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/prospects/bpr_3/approve'))?.body).toEqual({ email: 'support@shipcheck.example', sourceUrl: 'https://shipcheck.example/about' }),
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/not support@ or sales@/);
  });

  it('lists ready companies with the words that place them and the address masked, shown in full on request', async () => {
    wrap('admin');
    await openView(/^Ready/);
    expect(await screen.findByText('Acme Notes')).toBeTruthy();
    expect(screen.getByText('“Acme Notes, Inc. is a Delaware corporation”')).toBeTruthy();
    expect(screen.getByText('h••••@acmenotes.example')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/prospects?view=ready'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('hello@acmenotes.example')).toBeTruthy();
  });

  it('keeps Show, Approve and Reject from support', async () => {
    wrap('support');
    expect(await screen.findByText('Pipewise')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    await openView(/^Ready/);
    expect(await screen.findByText('Acme Notes')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('rejects by hand after a confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap('admin');
    await openView(/^Ready/);
    await screen.findByText('Acme Notes');
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/prospects/bpr_1/reject'))).toBe(true));
  });

  it('asks for rejected companies by reason', async () => {
    wrap('admin');
    fireEvent.click(await screen.findByRole('button', { name: /^Rejected/ }));
    fireEvent.change(await screen.findByLabelText('Reason'), { target: { value: 'not_us' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('view=rejected&reason=not_us'))).toBe(true));
  });

  it("shows what the latest read found in Exa's copies", async () => {
    wrap('admin', '/?tab=runs');
    expect(await screen.findByText(/6 with a website link · 2 only Product Hunt links · 1 no links/)).toBeTruthy();
    expect(screen.getByText(/9 read · 1 qualified · not US 3/)).toBeTruthy();
    expect(screen.getByText(/Every launch page read so far: 7 with a website link · 2 only Product Hunt links · 1 no links/)).toBeTruthy();
  });

  it('saves settings, and not a wait longer than the age limit', async () => {
    wrap('admin', '/?tab=settings');
    fireEvent.change(await screen.findByLabelText('Queries'), { target: { value: 'developer tools\nAI tools for marketers\n' } });
    fireEvent.change(screen.getByLabelText('Email after launch (days)'), { target: { value: '60' } });
    expect(screen.getByText('Must be over the email wait')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Email after launch (days)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ ...SETTINGS, queries: ['developer tools', 'AI tools for marketers'], sendAfterDays: 10 }),
    );
  });
});
