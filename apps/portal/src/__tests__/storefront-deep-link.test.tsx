// @vitest-environment jsdom
/**
 * /go/creators/:handle — the public storefront's "Book as a tracked deal"
 * (openpartner.dev/creators/<handle>) opens the creator's in-app storefront
 * in the brand's own workspace, /t/<slug>/admin/network/creators/<handle>,
 * without knowing <slug>. It hands /workspaces a ?next= that rides through
 * sign-in (password, emailed link, Google) and back; safeNextPath drops
 * anything but a same-origin path under /admin/, so ?next= can't send
 * anyone off-site.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { safeNextPath } from '@openpartner/db';
import { GoCreatorPage } from '../pages/GoLinks.js';
import { WorkspacesPage } from '../pages/Workspaces.js';
import { SigninPage } from '../pages/Signin.js';
import { PlatformMagicLandingPage } from '../pages/auth/PlatformMagicLanding.js';

interface Workspace {
  tenantSlug: string;
  tenantDisplayName: string;
  adminId: string;
  activated: boolean;
}

const ACME: Workspace = { tenantSlug: 'acme', tenantDisplayName: 'Acme', adminId: 'a1', activated: true };
const BETA: Workspace = { tenantSlug: 'beta', tenantDisplayName: 'Beta Co', adminId: 'a2', activated: true };

const STOREFRONT = '/admin/network/creators/jane-doe';
const NEXT = `?next=${encodeURIComponent(STOREFRONT)}`;

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}
let sent: Sent[];
/** null = no platform session (401). */
let workspaces: Workspace[] | null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  sent = [];
  workspaces = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ method, url, body });
    if (url === '/api/me/workspaces') {
      return workspaces ? json(200, { email: 'ada@acme.test', workspaces }) : json(401, { error: 'unauthorized' });
    }
    if (url === '/api/workspaces/enter' && method === 'POST') {
      const slug = String(body?.slug);
      return json(200, { ok: true, tenantSlug: slug, home: `/t/${slug}/` });
    }
    if (url === '/api/auth/providers') {
      return json(200, { google: true, googleStartUrl: 'http://localhost:5673/api/auth/google/start' });
    }
    if (url === '/api/signin/password' && method === 'POST') return json(200, { ok: true, token: 'op_pml_pw' });
    if (url === '/api/auth/platform-verify' && method === 'POST') {
      // Verifying signs the browser in.
      workspaces = [ACME];
      return json(200, { ok: true, email: 'ada@acme.test' });
    }
    if (url === '/api/signin' && method === 'POST') return json(200, { ok: true });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/go/creators/:handle" element={<GoCreatorPage multiTenant />} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/signin" element={<SigninPage />} />
          <Route path="/auth/magic" element={<PlatformMagicLandingPage />} />
          <Route path="/t/:slug/*" element={<div>inside the workspace</div>} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

function here(): string {
  return `${window.location.pathname}${window.location.search}`;
}

async function landsOn(path: string): Promise<void> {
  await waitFor(() => expect(here()).toBe(path), { timeout: 2000 });
}

function entered(): string[] {
  return sent.filter((s) => s.url === '/api/workspaces/enter').map((s) => String(s.body?.slug));
}

async function signInWithPassword(): Promise<void> {
  const email = await waitFor(() => document.querySelector<HTMLInputElement>('input[name="email"]')!);
  fireEvent.change(email, { target: { value: 'ada@acme.test' } });
  fireEvent.change(document.querySelector<HTMLInputElement>('input[type="password"]')!, {
    target: { value: 'correct horse battery' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('/go/creators/:handle', () => {
  it('signed in with one workspace: opens the creator’s storefront in it', async () => {
    workspaces = [ACME];
    renderAt('/go/creators/jane-doe');
    await landsOn(`/t/acme${STOREFRONT}`);
    expect(entered()).toEqual(['acme']);
  });

  it('several workspaces: a picker, and the one picked opens the storefront', async () => {
    workspaces = [ACME, BETA];
    renderAt('/go/creators/jane-doe');
    await landsOn(`/workspaces${NEXT}`);
    fireEvent.click(await screen.findByText('Beta Co'));
    await landsOn(`/t/beta${STOREFRONT}`);
    expect(entered()).toEqual(['beta']);
  });

  it('signed out: /signin keeps the destination, and a password sign-in comes back to it', async () => {
    renderAt('/go/creators/jane-doe');
    await landsOn(`/signin${NEXT}`);

    // Google carries it too: the start URL hands it to the API's state cookie.
    const google = await screen.findByText('Continue with Google');
    const start = new URL(google.closest('a')!.getAttribute('href')!);
    expect(start.searchParams.get('flow')).toBe('account');
    expect(start.searchParams.get('next')).toBe(STOREFRONT);

    await signInWithPassword();
    await landsOn(`/t/acme${STOREFRONT}`);
    expect(entered()).toEqual(['acme']);
  });

  it('signed out: the emailed link is asked to carry it, and its landing passes it on', async () => {
    renderAt(`/signin${NEXT}`);
    fireEvent.click(await screen.findByText('Email me a sign-in link instead'));
    fireEvent.change(document.querySelector<HTMLInputElement>('input[name="email"]')!, {
      target: { value: 'ada@acme.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    await waitFor(() => expect(sent.find((s) => s.url === '/api/signin')?.body).toEqual({
      email: 'ada@acme.test',
      add: false,
      next: STOREFRONT,
    }));
    cleanup();

    // The link the API mails: /auth/magic?token=…&next=….
    renderAt(`/auth/magic?token=op_pml_mailed${NEXT.replace('?', '&')}`);
    await landsOn(`/t/acme${STOREFRONT}`);
  });

  it('an unsafe next is dropped: the workspace opens at its home', async () => {
    workspaces = [ACME];
    renderAt(`/workspaces?next=${encodeURIComponent('https://evil.example/admin/x')}`);
    await landsOn('/t/acme/');
  });

  it('an unsafe next never reaches sign-in, the emailed link or Google', async () => {
    renderAt(`/signin?next=${encodeURIComponent('//evil.example/admin/x')}`);
    const google = await screen.findByText('Continue with Google');
    expect(new URL(google.closest('a')!.getAttribute('href')!).searchParams.has('next')).toBe(false);

    fireEvent.click(screen.getByText('Email me a sign-in link instead'));
    fireEvent.change(document.querySelector<HTMLInputElement>('input[name="email"]')!, {
      target: { value: 'ada@acme.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    await waitFor(() => expect(sent.find((s) => s.url === '/api/signin')?.body).toEqual({ email: 'ada@acme.test', add: false }));
    cleanup();

    renderAt(`/auth/magic?token=op_pml_mailed&next=${encodeURIComponent('/platform/vendors')}`);
    await landsOn('/t/acme/');
  });
});

describe('safeNextPath', () => {
  it('accepts a path under /admin/, query included', () => {
    expect(safeNextPath(STOREFRONT)).toBe(STOREFRONT);
    expect(safeNextPath('/admin/network/creators/jane-doe?package=p1')).toBe('/admin/network/creators/jane-doe?package=p1');
    expect(safeNextPath('/admin/network/creators/caf%C3%A9')).toBe('/admin/network/creators/caf%C3%A9');
  });

  it('rejects anything that could leave the workspace or the site', () => {
    for (const raw of [
      null,
      undefined,
      '',
      'https://evil.example/admin/x',
      '//evil.example/admin/x',
      '/\\evil.example/admin/x',
      '/admin\\..\\..\\x',
      'javascript:alert(1)',
      'admin/network',
      '/admin',
      '/signin',
      '/go/creators/jane-doe',
      '/t/other/admin/partners',
      '/admin/../platform/vendors',
      '/admin/%2e%2e/platform/vendors',
      '/admin/x y',
      '/admin/x\n',
      `/admin/${'a'.repeat(600)}`,
    ]) {
      expect(safeNextPath(raw), String(raw)).toBeNull();
    }
  });
});
