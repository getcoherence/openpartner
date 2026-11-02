// @vitest-environment jsdom
/**
 * Brands sign up with a work email (the API's work_email_required). The
 * signup form says so as the address is typed and on the API's refusal;
 * add-brand (where "Sign up with Google" lands) and a storefront request's
 * landing page show the reason instead of a form; ops switch the rule from
 * the Blocklist page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SignupPage } from '../pages/Signup.js';
import { AddBrandPage } from '../pages/AddBrand.js';
import { BookingConfirmPage } from '../pages/creator/BookingConfirm.js';
import { BlocklistPage } from '../pages/platform/Blocklist.js';

const NEEDED = 'Use your work email to sign up as a brand.';

interface Sent {
  method: string;
  url: string;
  body: unknown;
}
let sent: Sent[] = [];
/** Per-test answers, keyed by "METHOD /path" (path after /api). */
let routes: Record<string, () => Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  sent = [];
  routes = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const path = url.replace(/^\/api/, '').replace(/\?.*$/, '');
    const handler = routes[`${method} ${path}`];
    return handler ? handler() : json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderAt(path: string, element: React.ReactNode, routePath = '*') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path={routePath} element={element} />
          <Route path="/signup" element={<div>signup page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('brand signup', () => {
  function fill(page: ReturnType<typeof render>, email: string) {
    fireEvent.change(page.getByPlaceholderText('Acme'), { target: { value: 'Acme' } });
    fireEvent.change(page.getByPlaceholderText('acme'), { target: { value: 'acme' } });
    fireEvent.change(page.getByRole('combobox'), { target: { value: 'US' } });
    fireEvent.change(page.getByPlaceholderText('Ada Lovelace'), { target: { value: 'Ada' } });
    fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: email } });
    fireEvent.change(page.container.querySelector('input[autocomplete="new-password"]')!, { target: { value: 'correct horse battery' } });
  }

  it('asks for a work email, and says so as soon as a free mail address is typed', async () => {
    routes['GET /signup/settings'] = () => json(200, { workEmailRequired: true });
    const page = renderAt('/signup', <SignupPage />, '/signup');
    await waitFor(() => expect(page.getByText('Work email')).toBeTruthy());
    const submit = page.getByRole('button', { name: 'Create brand account' }) as HTMLButtonElement;

    fill(page, 'Ada@Gmail.com');
    expect(page.getByText(NEEDED)).toBeTruthy();
    expect(submit.disabled).toBe(true);

    fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: 'ada@acme.example' } });
    expect(page.queryByText(NEEDED)).toBeNull();
    expect(submit.disabled).toBe(false);
  });

  it('shows the API’s refusal too, and asks for any email where the rule is off', async () => {
    routes['GET /signup/settings'] = () => json(200, { workEmailRequired: false });
    routes['POST /signup'] = () => json(403, { error: 'work_email_required' });
    const page = renderAt('/signup', <SignupPage />, '/signup');
    await waitFor(() => expect(sent.some((s) => s.url === '/api/signup/settings')).toBe(true));
    expect(page.getByText('Your email')).toBeTruthy();

    fill(page, 'ada@gmail.com');
    expect(page.queryByText(NEEDED)).toBeNull();
    fireEvent.click(page.getByRole('button', { name: 'Create brand account' }));
    await waitFor(() => expect(page.getByText(NEEDED)).toBeTruthy());
    expect(sent.find((s) => s.url === '/api/signup')!.body).toMatchObject({ adminEmail: 'ada@gmail.com' });
  });
});

describe('add-brand', () => {
  it('a free mail identity (Sign up with Google with Gmail) gets the reason, not the form', async () => {
    routes['GET /me/workspaces'] = () => json(200, { email: 'ada@gmail.com', workspaces: [], workEmailRequired: true });
    const page = renderAt('/brands/new', <AddBrandPage />, '/brands/new');
    await waitFor(() => expect(page.getByText(/You’re signed in as ada@gmail\.com\./)).toBeTruthy());
    expect(page.getByText(new RegExp(NEEDED.replace('.', '\\.')))).toBeTruthy();
    expect(page.queryByPlaceholderText('Acme Coffee')).toBeNull();
    fireEvent.click(page.getByRole('link', { name: 'Sign up with a work email' }));
    expect(page.getByText('signup page')).toBeTruthy();
  });

  it('a work address gets the form', async () => {
    routes['GET /me/workspaces'] = () => json(200, { email: 'ada@acme.example', workspaces: [], workEmailRequired: false });
    const page = renderAt('/brands/new', <AddBrandPage />, '/brands/new');
    await waitFor(() => expect(page.getByPlaceholderText('Acme Coffee')).toBeTruthy());
    expect(page.queryByText(/You’re signed in as/)).toBeNull();
  });
});

describe('a storefront request from a free mail address', () => {
  it('asks for a brand on a work address instead of creating one', async () => {
    routes['POST /booking-claims/preview'] = () =>
      json(200, {
        creator: { id: 'crt_1', name: 'Jane Doe', handle: 'jane', avatarUrl: null },
        packageTitle: 'Deep dive',
        contactName: 'Grace Hopper',
        company: null,
        brief: 'A post about our app.',
        email: 'grace@gmail.com',
        accountExists: false,
        workEmailRequired: true,
        suggested: { displayName: '', slug: '' },
      });
    routes['GET /session/home'] = () => json(200, { home: null });
    const page = renderAt(`/booking/confirm?token=opbk_${'a'.repeat(48)}`, <BookingConfirmPage />, '/booking/confirm');
    await waitFor(() => expect(page.getByText(`${NEEDED} Then open this link again to send your request.`)).toBeTruthy());
    expect(page.queryByText('Create your brand account')).toBeNull();
    fireEvent.click(page.getByRole('button', { name: 'Sign up with a work email' }));
    expect(page.getByText('signup page')).toBeTruthy();
  });
});

describe('ops console', () => {
  it('an admin switches the rule; a read-only operator only sees it', async () => {
    let on = true;
    routes['GET /platform-admin/blocklist'] = () => json(200, { entries: [] });
    routes['GET /platform-admin/brand-signup'] = () => json(200, { settings: { workEmailRequired: on } });
    routes['PUT /platform-admin/brand-signup'] = () => {
      on = (sent.at(-1)!.body as { workEmailRequired: boolean }).workEmailRequired;
      return json(200, { settings: { workEmailRequired: on } });
    };
    const page = renderAt('/platform/blocklist', <BlocklistPage operator={{ email: 'ops@example.com', role: 'admin' }} />);
    await waitFor(() => expect(page.getByText('on')).toBeTruthy());
    expect(page.getByText('Work email required')).toBeTruthy();
    fireEvent.click(page.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(page.getByRole('button', { name: 'Turn on' })).toBeTruthy());
    expect(sent.find((s) => s.method === 'PUT')!.body).toEqual({ workEmailRequired: false });
    expect(page.getByText('off')).toBeTruthy();
    cleanup();

    const readOnly = renderAt('/platform/blocklist', <BlocklistPage operator={{ email: 'support@example.com', role: 'support' }} />);
    await waitFor(() => expect(readOnly.getByText('off')).toBeTruthy());
    expect(readOnly.queryByRole('button', { name: /Turn (on|off)/ })).toBeNull();
  });
});
