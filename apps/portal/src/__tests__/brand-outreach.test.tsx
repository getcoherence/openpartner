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
  companySize: '≈12 employees · Seed · $3.5M raised · founded 2023 · Austin, US',
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
const HELD_NO_ADDRESS = {
  ...HELD,
  id: 'bpr_3',
  name: 'Shipcheck',
  siteUrl: 'https://shipcheck.example',
  rejectReason: 'no_address',
  reviewNote: null,
  contact: null,
  country: 'US',
  countryEvidence: 'Shipcheck, Inc., a Delaware corporation',
  launchSite: 'job_post',
  launchUrl: 'https://boards.greenhouse.io/shipcheck/jobs/1',
  sourceNote: 'Hiring: Head of Partnerships',
};

/** From a Network with the sources and countries settings. */
const NEW_SETTINGS = {
  ...SETTINGS,
  sources: { productHunt: true, jobPosts: true, creatorMentions: false },
  jobQueries: ['Head of Partnerships'],
  minCreatorMentions: 2,
  excludedCountries: ['DE', 'FR', 'GB'],
  maxEmployees: 50,
  maxFundingUsdMillions: 30,
};
let settingsBody: Record<string, unknown> = SETTINGS;

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
    discover: {
      startedAt: '2026-11-03T09:00:00.000Z',
      finishedAt: '2026-11-03T09:00:20.000Z',
      result: { ran: true, searches: 3, queued: 4, failed: 0, wholeSite: 1, found: { 'developer tools': { new: 3, known: 1, unusable: 0 }, 'design tools': { new: 1, known: 0, unusable: 2, wholeSite: true } }, unusableKinds: { p: 2 } },
    },
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
        size: { checked: 9, withData: 7, tooBig: { employees: 2, round: 1 }, placed: 2, rechecked: 0 },
      },
    },
  },
};

function respond(url: string, method: string): { status: number; body: unknown } {
  if (url.endsWith('/brand-outreach/settings') && method === 'PUT') return { status: 200, body: { settings: calls[calls.length - 1]!.body, updatedAt: null, updatedByEmail: null } };
  if (url.endsWith('/brand-outreach/settings')) {
    return {
      status: 200,
      body: { settings: settingsBody, defaults: settingsBody, updatedAt: null, updatedByEmail: null, configured: { exa: true, treg: true, classifier: true, classifierModel: 'claude-opus-5-5' }, blockedCountries: ['CU', 'IR', 'KP', 'RU'] },
    };
  }
  if (url.endsWith('/brand-outreach/stats')) return { status: 200, body: STATS };
  if (url.includes('/brand-outreach/prospects?')) {
    const prospects = url.includes('view=review') ? [HELD, HELD_NO_ADDRESS] : url.includes('view=rejected') ? [] : [ACME];
    return { status: 200, body: { prospects, nextCursor: null } };
  }
  if (url.endsWith('/prospects/bpr_2/approve')) return { status: 200, body: { prospect: { ...HELD, status: 'qualified' } } };
  if (url.endsWith('/prospects/bpr_3/approve')) return { status: 400, body: { error: 'not_their_address' } };
  if (url.endsWith('/reject')) return { status: 204, body: null };
  if (url.endsWith('/brand-outreach/outreach/run')) {
    const dry = (calls[calls.length - 1]!.body as { dryRun: boolean }).dryRun;
    if (!dry) return { status: 202, body: { started: true } };
    return {
      status: 200,
      body: {
        enabled: true,
        style: 'plain',
        mailerConfigured: true,
        sender: 'keith@openpartner.test',
        senderName: 'Keith Fawcett',
        due: 2,
        waiting: 5,
        candidates: 2,
        dailyLimit: 50,
        sentLastDay: 12,
        targets: [
          { id: 'bpr_1', name: 'Acme Notes', siteUrl: 'https://acmenotes.example', sourceNote: 'Hiring: Head of Partnerships', country: 'US', address: 'h••••@acmenotes.example', addressFoundOn: 'https://acmenotes.example/about', opening: "Acme Notes came up while I was looking at companies hiring for partnerships: you're hiring a Head of Partnerships." },
          { id: 'bpr_2', name: 'Pipewise', siteUrl: null, sourceNote: null, country: 'CA', address: 'f••••@pipewise.example', addressFoundOn: null, opening: 'Congrats on the Product Hunt launch.', skip: 'refuses_unsolicited' },
        ],
      },
    };
  }
  if (url.endsWith('/brand-outreach/outreach/sample')) return { status: 200, body: { subject: 'Partner program for Acme Notes', sent: ['seed@example.com'], failed: [] } };
  if (url.endsWith('/prospects/bpr_1/contact')) return { status: 200, body: { contact: { email: 'hello@acmenotes.example', foundOn: ACME.contact.foundOn } } };
  return { status: 404, body: { error: 'not_found' } };
}

beforeEach(() => {
  calls = [];
  settingsBody = SETTINGS;
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
  it('opens on the review queue: why each is held, approved after a confirm with the country its pages didn\'t give', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap('admin');
    expect(await screen.findByText('Pipewise')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/prospects?view=review'))).toBe(true);
    expect(screen.getByText('country unknown')).toBeTruthy();
    expect(screen.getByText('“Said US, quoting words not on the pages read: "Based in Ohio"”')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^To review 2/ })).toBeTruthy();
    const approve = screen.getAllByRole('button', { name: 'Approve' })[0] as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getAllByLabelText('Country')[0]!, { target: { value: 'ca' } });
    fireEvent.click(approve);
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/prospects/bpr_2/approve'))).toMatchObject({ method: 'POST', body: { country: 'CA' } }));
    // Where each was found.
    expect(screen.getByText('Hiring: Head of Partnerships')).toBeTruthy();
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
    expect((await screen.findByRole('alert')).textContent).toMatch(/not support@ or the like/);
  });

  it('lists ready companies with the words that place them and the address masked, shown in full on request', async () => {
    wrap('admin');
    await openView(/^Ready/);
    expect(await screen.findByText('Acme Notes')).toBeTruthy();
    expect(screen.getByText('“Acme Notes, Inc. is a Delaware corporation”')).toBeTruthy();
    expect(screen.getByText('h••••@acmenotes.example')).toBeTruthy();
    // Exa's company data, in a line.
    expect(screen.getByText('≈12 employees · Seed · $3.5M raised · founded 2023 · Austin, US')).toBeTruthy();
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
    const reason = await screen.findByLabelText('Reason');
    // As wide as its choices, on the row with the search.
    expect(reason.style.width).toBe('auto');
    expect(reason.parentElement).toBe(screen.getByLabelText('Search prospects').closest('form')!.parentElement);
    fireEvent.change(reason, { target: { value: 'not_us' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('view=rejected&reason=not_us'))).toBe(true));
  });

  it("shows what the latest read found in Exa's copies", async () => {
    wrap('admin', '/?tab=runs');
    expect(await screen.findByText(/6 with a website link · 2 only Product Hunt links · 1 no links/)).toBeTruthy();
    expect(screen.getByText(/9 read · 1 qualified · not US 3/)).toBeTruthy();
    expect(screen.getByText(/Size: 7 of 9 with Exa data · 3 too big · 2 placed by headquarters/)).toBeTruthy();
    // A query whose product-page search found nothing, searched on the whole site.
    expect(screen.getByText(/3 searches · 4 new launches · 1 on the whole site/)).toBeTruthy();
    expect(screen.getByText(/design tools: 1 new, 0 known, 2 other pages \(whole site\)/)).toBeTruthy();
    expect(screen.getByText(/Every launch page read so far: 7 with a website link · 2 only Product Hunt links · 1 no links/)).toBeTruthy();
  });

  it('sets the sources, job roles and countries never emailed', async () => {
    settingsBody = NEW_SETTINGS;
    wrap('admin', '/?tab=settings');
    fireEvent.click(await screen.findByLabelText('Brands creators mention'));
    fireEvent.change(screen.getByLabelText('Countries never emailed'), { target: { value: 'de fr, gb  it' } });
    fireEvent.change(screen.getByLabelText('Roles searched on job boards'), { target: { value: 'Head of Partnerships\nAffiliate Manager' } });
    fireEvent.change(screen.getByLabelText('Max employees'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Max funding ($M)'), { target: { value: '15' } });
    expect(screen.getByText('Also never emailed: CU IR KP RU')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
        sources: { productHunt: true, jobPosts: true, creatorMentions: true },
        excludedCountries: ['DE', 'FR', 'GB', 'IT'],
        jobQueries: ['Head of Partnerships', 'Affiliate Manager'],
        maxEmployees: 25,
        maxFundingUsdMillions: 15,
      }),
    );
  });

  it('scrolls the list within the window, its header in view', async () => {
    wrap('admin');
    await screen.findByText('Pipewise');
    const scroller = screen.getByRole('table').parentElement as HTMLElement;
    expect(scroller.style.overflowY).toBe('auto');
    expect(Number.parseInt(scroller.style.maxHeight, 10)).toBeGreaterThanOrEqual(320);
  });

  it('previews the next batch as it would go, and an admin sends it after a confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap('admin', '/?tab=email');
    fireEvent.change(await screen.findByLabelText('Batch size'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview batch' }));
    expect(await screen.findByText("Acme Notes came up while I was looking at companies hiring for partnerships: you're hiring a Head of Partnerships.")).toBeTruthy();
    expect(screen.getByText('skipped: page refuses email')).toBeTruthy();
    expect(screen.getByText(/2 due · 5 waiting · sends as Keith Fawcett <keith@openpartner.test> · plain · 12 of 50 sent in the last 24 hours/)).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/outreach/run'))?.body).toEqual({ dryRun: true, limit: 10 });
    fireEvent.click(screen.getByRole('button', { name: 'Send this batch' }));
    // One goes: the other would be skipped.
    expect(confirm).toHaveBeenCalledWith('Send the email to 1 company as Keith Fawcett?');
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/outreach/run') && (c.body as { dryRun: boolean }).dryRun === false)).toBe(true));
  });

  it('sends a sample in the style asked for, and keeps sending and samples from support', async () => {
    wrap('admin', '/?tab=email');
    fireEvent.change(await screen.findByLabelText('Sample addresses'), { target: { value: 'seed@example.com\n' } });
    fireEvent.change(screen.getByLabelText('Sample style'), { target: { value: 'designed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send sample' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/outreach/sample'))?.body).toEqual({ to: ['seed@example.com'], style: 'designed' }));
    expect(await screen.findByText('Sent to 1')).toBeTruthy();
    cleanup();

    wrap('support', '/?tab=email');
    fireEvent.click(await screen.findByRole('button', { name: 'Preview batch' }));
    expect(await screen.findByText('Acme Notes')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send this batch' })).toBeNull();
    expect(screen.queryByLabelText('Sample addresses')).toBeNull();
  });

  it('switches the email on and picks its style in Settings', async () => {
    settingsBody = { ...NEW_SETTINGS, outreachEnabled: false, outreachStyle: 'plain' };
    wrap('admin', '/?tab=settings');
    fireEvent.click(await screen.findByLabelText('Email on'));
    fireEvent.change(screen.getByLabelText('Email style'), { target: { value: 'designed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ outreachEnabled: true, outreachStyle: 'designed' }));
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
