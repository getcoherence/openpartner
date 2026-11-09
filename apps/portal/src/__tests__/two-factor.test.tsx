// @vitest-environment jsdom
/**
 * Two-step sign-in in the portal (docs/two-step-sign-in.md): the code a
 * sign-in stops at, setting up an authenticator, and the Admins section.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { api, ApiError, TWO_FACTOR_REQUIRED } from '../api.js';
import { TwoFactorChallenge, TwoFactorSetup } from '../pages/auth/TwoFactor.js';
import { TwoFactorSection } from '../pages/admin/TwoFactorSection.js';

type Handler = (body: Record<string, unknown> | undefined) => { status: number; body: unknown };
let routes: Record<string, Handler> = {};
let calls: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  routes = {};
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    if (!handler) return json(404, { error: 'not_found' });
    const r = handler(body);
    return json(r.status, r.body);
  }) as typeof fetch;
});

afterEach(cleanup);

function renderWith(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('api()', () => {
  it('tells a sign-in waiting for its code from a signed-out one', async () => {
    routes['GET /auth/whoami'] = () => ({ status: 401, body: { error: 'two_factor_required' } });
    const err = (await api('/auth/whoami').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe(TWO_FACTOR_REQUIRED);
    routes['GET /auth/whoami'] = () => ({ status: 401, body: { error: 'unauthorized' } });
    expect(((await api('/auth/whoami').catch((e: unknown) => e)) as ApiError).message).toBe('unauthorized');
  });
});

describe('the code screen', () => {
  it('says how many tries are left, then lets the right code in', async () => {
    let tries = 0;
    routes['POST /auth/two-factor/verify'] = (b) =>
      b?.code === '654321' ? { status: 200, body: { ok: true } } : { status: 400, body: { error: 'invalid_code', attemptsLeft: 4 - tries++ } };
    const onDone = vi.fn();
    const page = renderWith(<TwoFactorChallenge onDone={onDone} />);
    fireEvent.change(page.getByLabelText('Code'), { target: { value: '111111' } });
    fireEvent.click(page.getByRole('button', { name: 'Continue' }));
    await page.findByText('That code didn’t work. 4 tries left.');
    fireEvent.change(page.getByLabelText('Code'), { target: { value: '654321' } });
    fireEvent.click(page.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('takes a recovery code instead', async () => {
    routes['POST /auth/two-factor/verify'] = () => ({ status: 200, body: { ok: true } });
    const page = renderWith(<TwoFactorChallenge onDone={() => {}} />);
    fireEvent.click(page.getByRole('button', { name: 'Use a recovery code' }));
    fireEvent.change(page.getByLabelText('Recovery code'), { target: { value: 'ABCD-EFGH-JKMN' } });
    fireEvent.click(page.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(calls.at(-1)?.body).toEqual({ code: 'ABCD-EFGH-JKMN' }));
  });
});

describe('setting it up', () => {
  it('shows a QR code and key, turns on with a code, then shows the recovery codes once', async () => {
    routes['POST /auth/two-factor/setup'] = () => ({
      status: 200,
      body: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/OpenPartner:ada%40example.com?secret=JBSWY3DPEHPK3PXP' },
    });
    routes['POST /auth/two-factor/enable'] = () => ({
      status: 200,
      body: { recoveryCodes: Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CC${String(i).padStart(2, '0')}`) },
    });
    const onEnabled = vi.fn();
    const page = renderWith(<TwoFactorSetup onEnabled={onEnabled} />);
    const qr = (await page.findByAltText('QR code for your authenticator app')) as HTMLImageElement;
    expect(qr.src.startsWith('data:image/svg+xml')).toBe(true);
    expect(page.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeTruthy();
    fireEvent.change(page.getByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(page.getByRole('button', { name: 'Turn on' }));
    await page.findByText('AAAA-BBBB-CC09');
    expect(page.getByLabelText('Recovery codes').children).toHaveLength(10);
    fireEvent.click(page.getByRole('button', { name: 'Done' }));
    expect(onEnabled).toHaveBeenCalled();
  });
});

describe('Admins → Two-step sign-in', () => {
  it('offers to turn it on when it is off', async () => {
    routes['GET /auth/two-factor'] = () => ({ status: 200, body: { enabled: false, recoveryCodesLeft: 0, verified: false, requiredByBrand: false } });
    routes['GET /config/admin-security'] = () => ({ status: 200, body: { requireTwoFactor: false } });
    const page = renderWith(<TwoFactorSection />);
    await page.findByRole('button', { name: 'Turn on' });
    expect(page.getByText('off')).toBeTruthy();
  });

  it("won't offer to turn it off while the brand requires it", async () => {
    routes['GET /auth/two-factor'] = () => ({ status: 200, body: { enabled: true, recoveryCodesLeft: 7, verified: true, requiredByBrand: true } });
    routes['GET /config/admin-security'] = () => ({ status: 200, body: { requireTwoFactor: true } });
    const page = renderWith(<TwoFactorSection />);
    await page.findByText('7 recovery codes left');
    expect(page.queryByRole('button', { name: 'Turn off' })).toBeNull();
    expect(page.getByRole('button', { name: 'New recovery codes' })).toBeTruthy();
    await waitFor(() => expect((page.getByRole('checkbox', { name: 'Require for every admin' }) as HTMLInputElement).checked).toBe(true));
  });

  it('asks the admin to turn it on for themselves before requiring it', async () => {
    routes['GET /auth/two-factor'] = () => ({ status: 200, body: { enabled: false, recoveryCodesLeft: 0, verified: false, requiredByBrand: false } });
    routes['GET /config/admin-security'] = () => ({ status: 200, body: { requireTwoFactor: false } });
    routes['POST /config/admin-security'] = () => ({ status: 409, body: { error: 'two_factor_not_enabled' } });
    const page = renderWith(<TwoFactorSection />);
    const box = await page.findByRole('checkbox', { name: 'Require for every admin' });
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(box);
    await page.findByText('Turn it on for yourself first.');
  });
});
