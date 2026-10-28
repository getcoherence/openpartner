// @vitest-environment jsdom
/**
 * The ops Notifications page's storefront email: its switch, a preview of
 * who the next run would email (biggest channel, where their storefront
 * stands), and the two reminder sweeps' previews left as they were.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { NotificationsPage } from '../pages/platform/Notifications.js';

let requests: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
let settings = { brandSetupReminders: true, creatorProfileReminders: true, creatorStorefrontNudge: false };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  requests = [];
  settings = { brandSetupReminders: true, creatorProfileReminders: true, creatorStorefrontNudge: false };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ method, path, body });
    if (path === '/platform-admin/notifications' && method === 'GET') {
      return json(200, { settings, brandRemindersSentLast7Days: 0, networkConfigured: true });
    }
    if (path === '/platform-admin/notifications' && method === 'PUT') {
      settings = { ...settings, ...(body as Partial<typeof settings>) };
      return json(200, { settings });
    }
    if (path === '/platform-admin/notifications/creator-storefront/run') {
      return json(200, {
        dryRun: true,
        eligible: [
          { creatorId: 'crt_1', email: 'ada@example.test', name: 'Ada', handle: 'adawrites', audience: { platform: 'youtube', count: 31400 }, packages: 0, publishedPackages: 0, bookingsOpen: false, paymentsReady: false },
          { creatorId: 'crt_2', email: 'lea@example.test', name: 'Léa', handle: null, audience: null, packages: 1, publishedPackages: 1, bookingsOpen: true, paymentsReady: false },
          { creatorId: 'crt_4', email: 'sam@example.test', name: 'Sam', handle: 'samdesigns', audience: { platform: 'instagram', count: 1200 }, packages: 2, publishedPackages: 0, bookingsOpen: false, paymentsReady: true },
        ],
        sent: 0,
        failed: 0,
      });
    }
    if (path === '/platform-admin/notifications/creator-profile/run') {
      return json(200, {
        dryRun: true,
        eligible: [{ creatorId: 'crt_3', email: 'sam@example.test', name: 'Sam', step: 2, missing: ['Add a profile photo'] }],
        sent: 0,
        failed: 0,
      });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => cleanup());

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The card whose title is `title`: the header row holding its buttons,
 *  then the card around it, where the preview shows. */
async function card(view: ReturnType<typeof render>, title: string): Promise<HTMLElement> {
  const heading = await view.findByText(title);
  let el: HTMLElement | null = heading;
  while (el && !within(el).queryByRole('button', { name: 'Preview next run' })) el = el.parentElement;
  return el!.parentElement!;
}

describe('ops Notifications: storefront email', () => {
  it('previews who would get it, with their biggest channel and storefront', async () => {
    const view = renderWithClient(<NotificationsPage operator={{ email: 'ops@example.test', role: 'admin' }} />);
    const sf = await card(view, 'Creator storefront email');
    expect(within(sf).getByText('off')).toBeTruthy();

    fireEvent.click(within(sf).getByRole('button', { name: 'Preview next run' }));
    await within(sf).findByText('3 people are due the storefront email right now.');
    expect(requests.find((r) => r.path === '/platform-admin/notifications/creator-storefront/run')?.body).toEqual({ dryRun: true });
    expect(within(sf).getByText('@adawrites')).toBeTruthy();
    expect(within(sf).getByText('31,400 on YouTube')).toBeTruthy();
    expect(within(sf).getByText('Not started')).toBeTruthy();
    expect(within(sf).getByText('Léa')).toBeTruthy();
    expect(within(sf).getByText('Under 1,000')).toBeTruthy();
    expect(within(sf).getByText('1 package, Stripe not connected')).toBeTruthy();
    expect(within(sf).getByText('1,200 on Instagram')).toBeTruthy();
    expect(within(sf).getByText('2 draft packages, bookings off')).toBeTruthy();
  });

  it('switches it on', async () => {
    const view = renderWithClient(<NotificationsPage operator={{ email: 'ops@example.test', role: 'admin' }} />);
    const sf = await card(view, 'Creator storefront email');
    fireEvent.click(within(sf).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({ creatorStorefrontNudge: true }));
    await within(sf).findByText('on · runs daily');
  });

  it('leaves the profile reminders preview as it was', async () => {
    const view = renderWithClient(<NotificationsPage operator={{ email: 'ops@example.test', role: 'support' }} />);
    const profile = await card(view, 'Creator profile reminders');
    fireEvent.click(within(profile).getByRole('button', { name: 'Preview next run' }));
    await within(profile).findByText('1 person is due a reminder right now.');
    expect(within(profile).getByText('2 of 3')).toBeTruthy();
    expect(within(profile).getByText('Add a profile photo')).toBeTruthy();
    // Support operators preview but don't switch or send.
    expect(within(profile).queryByRole('button', { name: /Turn|Send/ })).toBeNull();
  });
});
