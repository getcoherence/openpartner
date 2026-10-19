// @vitest-environment jsdom
/**
 * First-run install, when setup already ran but its activation link was
 * lost: POST /install 409s (an admin row exists) while /install/status
 * still says needsSetup (nobody activated). The wizard must not dead-end
 * on that 409 — it offers POST /install/resend for the address entered
 * at setup.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InstallPage } from '../pages/Install.js';

interface Sent {
  method: string;
  url: string;
  body: unknown;
}
let sent: Sent[] = [];
let installResponse: () => Response;
let needsSetup: boolean;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  sent = [];
  installResponse = () => json(409, { error: 'already_installed' });
  needsSetup = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === '/api/install' && method === 'POST') return installResponse();
    if (url === '/api/install/status') return json(200, { needsSetup });
    if (url === '/api/install/resend' && method === 'POST') return json(200, { ok: true });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderInstall() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // What App cached at boot — the reason /install is routed at all.
  qc.setQueryData(['install-status'], { needsSetup: true });
  qc.setQueryData(['public-branding', null], {
    tenantSlug: null,
    programName: 'OpenPartner',
    logoUrl: null,
    faviconUrl: null,
    brandColor: null,
    supportEmail: null,
    programTermsUrl: null,
    whiteLabel: false,
  });
  const page = render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <InstallPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { page, qc };
}

function completeWizard(page: ReturnType<typeof render>) {
  fireEvent.change(page.getByPlaceholderText('Ada Lovelace'), { target: { value: 'Ada Admin' } });
  fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: 'ada@example.com' } });
  fireEvent.click(page.getByRole('button', { name: /Continue/ }));
  fireEvent.change(page.getByPlaceholderText('e.g. Acme Partners'), { target: { value: 'Acme Partners' } });
  fireEvent.click(page.getByRole('button', { name: /Continue/ }));
  fireEvent.change(page.getByRole('combobox'), { target: { value: 'none' } });
  fireEvent.click(page.getByRole('button', { name: /Send my setup link/ }));
}

describe('InstallPage when setup already ran', () => {
  it('turns a 409 on a pending install into a resend for the email entered', async () => {
    const { page } = renderInstall();
    completeWizard(page);

    await page.findByText('Check your inbox');
    expect(page.getByText(/Setup has already run on this server/)).toBeTruthy();
    expect(sent.some((s) => s.url === '/api/install/status')).toBe(true);
    const email = page.getByPlaceholderText('ada@example.com') as HTMLInputElement;
    expect(email.value).toBe('ada@example.com');

    fireEvent.click(page.getByRole('button', { name: /Resend activation link/ }));
    await page.findByText('Activation link sent');
    expect(sent.filter((s) => s.url === '/api/install/resend')).toEqual([
      { method: 'POST', url: '/api/install/resend', body: { adminEmail: 'ada@example.com' } },
    ]);
    // The API never says whether the address matched, so neither does the page.
    expect(page.getByText(/is the admin waiting to activate/)).toBeTruthy();
  });

  it('hands a 409 back to App once the admin has activated elsewhere', async () => {
    needsSetup = false;
    const { page, qc } = renderInstall();
    completeWizard(page);

    // Refreshing the shared query is what re-routes App away from /install.
    await waitFor(() => expect(qc.getQueryData(['install-status'])).toEqual({ needsSetup: false }));
    expect(page.getByText('already_installed')).toBeTruthy();
    expect(page.queryByText('Check your inbox')).toBeNull();
  });

  it('keeps other install failures on the wizard', async () => {
    installResponse = () => json(502, { error: 'install_mail_failed', detail: 'smtp refused' });
    const { page } = renderInstall();
    completeWizard(page);

    await page.findByText('install_mail_failed: smtp refused');
    expect(page.queryByText('Check your inbox')).toBeNull();
    expect(sent.some((s) => s.url === '/api/install/status')).toBe(false);
  });

  it('offers resend from the check-your-email screen, and Back returns to it', async () => {
    installResponse = () => json(200, { ok: true });
    const { page } = renderInstall();
    completeWizard(page);

    await page.findByText('Check your email');
    fireEvent.click(page.getByRole('button', { name: /Resend the link/ }));
    await page.findByText('Check your inbox');
    expect((page.getByPlaceholderText('ada@example.com') as HTMLInputElement).value).toBe('ada@example.com');

    fireEvent.click(page.getByRole('button', { name: /Back/ }));
    await page.findByText('Check your email');
  });

  it('offers resend from the first step without running setup again', async () => {
    const { page } = renderInstall();
    fireEvent.click(page.getByRole('button', { name: /Already ran setup\? Resend the activation link/ }));

    await page.findByText('Check your inbox');
    expect(page.queryByText(/Setup has already run on this server/)).toBeNull();
    const resend = page.getByRole('button', { name: /Resend activation link/ }) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);

    fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.click(resend);
    await page.findByText('Activation link sent');
    expect(sent.find((s) => s.url === '/api/install/resend')?.body).toEqual({ adminEmail: 'ada@example.com' });
    expect(sent.some((s) => s.url === '/api/install')).toBe(false);

    fireEvent.click(page.getByRole('button', { name: /Send another link/ }));
    fireEvent.click(await page.findByRole('button', { name: /Back/ }));
    await page.findByText('Install OpenPartner');
  });
});
