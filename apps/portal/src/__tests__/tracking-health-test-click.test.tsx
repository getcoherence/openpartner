// @vitest-environment jsdom
/**
 * Admin → Tracking health → Send a test click. Each program the script can
 * be tested on gets the button (not one that sends partners to Stripe's own
 * checkout, nor the account-wide checks). Pressing it opens a tab at once,
 * sends it to the single-use test link under the brand's share-link root
 * with no handle back to the portal, and follows the test until it passes:
 * the link to open or copy while unopened, the fix at the first step that
 * didn't happen, and no more polling once it's done. A refusal closes the
 * tab and says why in words; without a router URL the button is disabled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminTrackingHealth, type SetupChecksReport, type TestClickReport } from '../pages/admin/TrackingHealth.js';

const SPRING = { id: 'p1', name: 'Spring' };
const PAY = { id: 'p2', name: 'Pay link' };

let routerUrl: string | null;
let created: { status: number; body: unknown };
let progress: TestClickReport;
let posted: unknown[];
let polls: number;
let tab: { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function check(id: SetupChecksReport['checks'][number]['id'], program: { id: string; name: string } | null) {
  return { id, title: id, subject: program?.id ?? 'account', program, status: 'waiting' as const, summary: `${id} summary`, fix: null };
}

const setup: SetupChecksReport = {
  computedAt: new Date().toISOString(),
  checks: [check('partners', SPRING), check('destination', SPRING), check('script', SPRING), check('destination', PAY), check('linking', null)],
};

function report(state: TestClickReport['state'], steps: Array<[TestClickReport['steps'][number]['status'], string | null]>): TestClickReport {
  const ids = ['click', 'landing', 'identify'] as const;
  return {
    id: 'tc1',
    program: SPRING,
    createdAt: '2026-10-28T12:00:00.000Z',
    expiresAt: '2026-10-28T12:30:00.000Z',
    state,
    destination: steps[0]![0] === 'done' ? 'https://brand.example/signup?cref=01JTESTCLICK0000000000000' : null,
    steps: steps.map(([status, fix], i) => ({
      id: ids[i]!,
      title: ['Link opened', 'Reached the script', 'Linked to a signup'][i]!,
      status,
      at: status === 'done' ? '2026-10-28T12:01:00.000Z' : null,
      summary: `${ids[i]} is ${status}`,
      fix,
    })),
  };
}

beforeEach(() => {
  routerUrl = 'https://links.brand.test';
  created = { status: 201, body: { id: 'tc1', path: '/_test/tok_abc', expiresAt: '2026-10-28T12:30:00.000Z' } };
  progress = report('waiting', [['waiting', null], ['pending', null], ['pending', null]]);
  posted = [];
  polls = 0;
  tab = { opener: {}, location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/branding') return json(200, { tenantSlug: 'default' });
    if (url.pathname === '/api/config/program') return json(200, { routerUrl });
    if (url.pathname === '/api/programs') return json(200, { programs: [SPRING, PAY] });
    if (url.pathname === '/api/admin/tracking-health/setup') return json(200, setup);
    if (url.pathname === '/api/config/tracking-alerts') return json(200, { email: true });
    if (url.pathname === '/api/admin/tracking-health/test-click' && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return json(created.status, created.body);
    }
    if (url.pathname === '/api/admin/tracking-health/test-click/tc1') {
      polls += 1;
      return json(200, progress);
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter initialEntries={['/admin/tracking-health']}>
      <QueryClientProvider client={qc}>
        <AdminTrackingHealth />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function sendButton(): Promise<HTMLButtonElement> {
  const buttons = await screen.findAllByRole('button', { name: 'Send a test click' });
  // Only Spring: Pay link has no script check, and the account none at all.
  expect(buttons).toHaveLength(1);
  await waitFor(() => expect(buttons[0]!.hasAttribute('disabled')).toBe(false));
  return buttons[0] as HTMLButtonElement;
}

describe('Send a test click', () => {
  it('opens the single-use link in a new tab and follows the test until it passes', async () => {
    renderPage();
    fireEvent.click(await sendButton());
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('https://links.brand.test/r/_test/tok_abc'));
    expect(tab.opener).toBeNull();
    expect(posted).toEqual([{ programId: 'p1' }]);

    // Unopened: the link can be opened here or copied.
    const link = await screen.findByText('Open the test link');
    expect(link.getAttribute('href')).toBe('https://links.brand.test/r/_test/tok_abc');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('Test click: open the link by', { exact: false })).toBeTruthy();

    // Opened, but the page never reported it: the fix shows.
    progress = report('waiting', [['done', null], ['missing', 'Add the script tag from Integrations.'], ['waiting', null]]);
    expect(await screen.findByText('Add the script tag from Integrations.', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText('not seen')).toBeTruthy();
    expect(screen.queryByText('Open the test link')).toBeNull();
    expect(screen.getByText('https://brand.example/signup?cref=01JTESTCLICK0000000000000')).toBeTruthy();

    progress = report('passed', [['done', null], ['done', null], ['done', null]]);
    expect(await screen.findByText(/^Test click passed/, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText('Add the script tag from Integrations.')).toBeNull();
    const after = polls;
    await new Promise((r) => setTimeout(r, 2500));
    expect(polls).toBe(after);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(/^Test click passed/)).toBeNull();
  }, 15_000);

  it('closes the tab and says why when the test is refused', async () => {
    created = { status: 409, body: { error: 'links_paused' } };
    renderPage();
    fireEvent.click(await sendButton());
    expect(await screen.findByText(/don’t record clicks right now/)).toBeTruthy();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
  });

  it('keeps programs that share a name apart, and finishes each test started while another is being made', async () => {
    const TWIN = { id: 'p3', name: 'Spring' };
    setup.checks.push(check('destination', TWIN), check('script', TWIN));
    try {
      const tabs: Array<typeof tab> = [];
      vi.mocked(window.open).mockImplementation(() => {
        const t = { opener: {}, location: { href: '' }, close: vi.fn() };
        tabs.push(t);
        return t as unknown as Window;
      });
      // Each POST answers only when released, so the second press lands
      // while the first is still in flight.
      const release: Array<() => void> = [];
      const plain = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/admin/tracking-health/test-click' && init?.method === 'POST') {
          const { programId } = JSON.parse(String(init.body)) as { programId: string };
          await new Promise<void>((r) => release.push(r));
          return json(201, { id: `tc_${programId}`, path: `/_test/tok_${programId}`, expiresAt: '2026-10-28T12:30:00.000Z' });
        }
        if (url.pathname.startsWith('/api/admin/tracking-health/test-click/')) return json(200, progress);
        return plain(input, init);
      }) as typeof fetch;

      renderPage();
      const buttons = await screen.findAllByRole('button', { name: 'Send a test click' });
      expect(buttons).toHaveLength(2);
      await waitFor(() => expect(buttons[0]!.hasAttribute('disabled')).toBe(false));
      fireEvent.click(buttons[0]!);
      fireEvent.click(buttons[1]!);
      await waitFor(() => expect(release).toHaveLength(2));
      release.forEach((r) => r());

      await waitFor(() => expect(tabs.map((t) => t.location.href)).toEqual([
        'https://links.brand.test/r/_test/tok_p1',
        'https://links.brand.test/r/_test/tok_p3',
      ]));
      await waitFor(() => expect(screen.getAllByText('Open the test link')).toHaveLength(2));
    } finally {
      setup.checks.splice(-2);
    }
  });

  it('is disabled until the brand has a router URL to send it through', async () => {
    routerUrl = null;
    renderPage();
    const [button] = await screen.findAllByRole('button', { name: 'Send a test click' });
    expect(button!.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button!);
    expect(window.open).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });
});
