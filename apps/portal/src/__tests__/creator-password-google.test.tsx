// @vitest-environment jsdom
/**
 * Creator passwords and "Continue with Google" in the creator portal
 * (docs/creator-sign-in.md). Every way in ends at the Network's
 * /creators/verify: a correct password returns the sign-in token and the
 * page redeems it; Google lands on the magic-link page, or on signup with a
 * Google-verified address the form can't change.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorSigninPage } from '../pages/creator/CreatorSignin.js';
import { CreatorSignupPage } from '../pages/creator/CreatorSignup.js';
import { CreatorResetPasswordPage } from '../pages/creator/CreatorResetPassword.js';
import { CreatorPasswordCard } from '../pages/creator/CreatorMyProfile.js';

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

function Landed() {
  const loc = useLocation();
  return <div>landed at {loc.pathname}</div>;
}

function renderAt(path: string, element: React.ReactNode, routePath: string, state?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[state ? { pathname: path.split('?')[0]!, search: path.includes('?') ? `?${path.split('?')[1]}` : '', state } : path]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path={routePath} element={element} />
          <Route path="/creator" element={<Landed />} />
          <Route path="/creator/login" element={routePath === '/creator/login' ? element : <CreatorSigninPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const posts = (path: string) => sent.filter((s) => s.method !== 'GET' && s.url.startsWith(path));

describe('creator sign-in with a password', () => {
  it('trades the password for the sign-in token and redeems it at /creators/verify', async () => {
    routes['POST /creator-api/creators/signin/password'] = () => json(200, { ok: true, token: 'opmlcreator_t' });
    routes['POST /creator-api/creators/verify'] = () => json(200, { ok: true });
    const page = renderAt('/creator/login', <CreatorSigninPage />, '/creator/login');
    fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.change(page.container.querySelector('input[name="password"]')!, { target: { value: 'correct horse battery' } });
    fireEvent.click(page.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(page.getByText('landed at /creator')).toBeTruthy());
    expect(posts('/api/creator-api/creators/signin/password')[0]!.body).toEqual({
      email: 'ada@example.com',
      password: 'correct horse battery',
    });
    expect(posts('/api/creator-api/creators/verify')[0]!.body).toEqual({ token: 'opmlcreator_t' });
  });

  it('says plainly when the password is wrong, and when the address is held', async () => {
    routes['POST /creator-api/creators/signin/password'] = () => json(401, { error: 'invalid_credentials' });
    const page = renderAt('/creator/login', <CreatorSigninPage />, '/creator/login');
    fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.change(page.container.querySelector('input[name="password"]')!, { target: { value: 'nope' } });
    fireEvent.click(page.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(page.getByText(/don’t match/)).toBeTruthy());
    expect(posts('/api/creator-api/creators/verify')).toHaveLength(0);

    routes['POST /creator-api/creators/signin/password'] = () => json(429, { error: 'too_many_attempts' });
    fireEvent.click(page.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(page.getByText(/Too many wrong passwords/)).toBeTruthy());
  });

  it('“Forgot password?” asks the Network to mail a reset link', async () => {
    routes['POST /creator-api/creators/password/forgot'] = () => json(200, { ok: true });
    const page = renderAt('/creator/login', <CreatorSigninPage />, '/creator/login');
    fireEvent.click(page.getByRole('button', { name: 'Forgot password?' }));
    fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.click(page.getByRole('button', { name: 'Email me a password link' }));
    await waitFor(() => expect(page.getByText(/we sent a link to choose a password/)).toBeTruthy());
    expect(posts('/api/creator-api/creators/password/forgot')[0]!.body).toEqual({ email: 'ada@example.com' });
  });

  it('offers Continue with Google for the creator flow when Google is on', async () => {
    routes['GET /auth/providers'] = () =>
      json(200, { google: true, googleStartUrl: 'https://app.openpartner.test/api/auth/google/start' });
    const page = renderAt('/creator/login', <CreatorSigninPage />, '/creator/login');
    const link = (await waitFor(() => page.getByRole('link', { name: /Continue with Google/ }))) as HTMLAnchorElement;
    expect(link.href).toBe('https://app.openpartner.test/api/auth/google/start?flow=creator');
  });

  it('hides Google when it isn’t configured', async () => {
    const page = renderAt('/creator/login', <CreatorSigninPage />, '/creator/login');
    await waitFor(() => expect(sent.some((s) => s.url === '/api/auth/providers')).toBe(true));
    expect(page.queryByRole('link', { name: /Continue with Google/ })).toBeNull();
  });

  it('shows why a Google round trip came back', () => {
    const blocked = renderAt('/creator/login?error=creator_not_active', <CreatorSigninPage />, '/creator/login');
    expect(blocked.getByText(/This creator account can’t sign in/)).toBeTruthy();
    cleanup();
    const country = renderAt('/creator/login?error=country_not_supported', <CreatorSigninPage />, '/creator/login');
    expect(country.getByText("Sorry — OpenPartner isn't available in your country.")).toBeTruthy();
  });
});

describe('creator password reset', () => {
  it('saves the new password, then sends the creator to sign in with the address filled in', async () => {
    routes['POST /creator-api/creators/password/reset'] = () => json(200, { ok: true, email: 'ada@example.com' });
    const page = renderAt('/creator/reset-password?token=opmlcreator_reset', <CreatorResetPasswordPage />, '/creator/reset-password');
    const [pw, confirm] = Array.from(page.container.querySelectorAll('input[autocomplete="new-password"]'));
    fireEvent.change(pw!, { target: { value: 'brand new passphrase' } });
    fireEvent.change(confirm!, { target: { value: 'brand new passphrase' } });
    fireEvent.click(page.getByRole('button', { name: 'Save password' }));

    await waitFor(() => expect(page.getByText('Password saved. Sign in with it below.')).toBeTruthy());
    expect(posts('/api/creator-api/creators/password/reset')[0]!.body).toEqual({
      token: 'opmlcreator_reset',
      password: 'brand new passphrase',
    });
    expect((page.getByPlaceholderText('ada@example.com') as HTMLInputElement).value).toBe('ada@example.com');
  });

  it('won’t submit until the two passwords match and are long enough', () => {
    const page = renderAt('/creator/reset-password?token=opmlcreator_reset', <CreatorResetPasswordPage />, '/creator/reset-password');
    const save = page.getByRole('button', { name: 'Save password' }) as HTMLButtonElement;
    const [pw, confirm] = Array.from(page.container.querySelectorAll('input[autocomplete="new-password"]'));
    fireEvent.change(pw!, { target: { value: 'short' } });
    fireEvent.change(confirm!, { target: { value: 'short' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(pw!, { target: { value: 'long enough passphrase' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(confirm!, { target: { value: 'long enough passphrase' } });
    expect(save.disabled).toBe(false);
  });

  it('explains an expired link', async () => {
    routes['POST /creator-api/creators/password/reset'] = () => json(400, { error: 'invalid_or_expired_token' });
    const page = renderAt('/creator/reset-password?token=opmlcreator_old', <CreatorResetPasswordPage />, '/creator/reset-password');
    const [pw, confirm] = Array.from(page.container.querySelectorAll('input[autocomplete="new-password"]'));
    fireEvent.change(pw!, { target: { value: 'long enough passphrase' } });
    fireEvent.change(confirm!, { target: { value: 'long enough passphrase' } });
    fireEvent.click(page.getByRole('button', { name: 'Save password' }));
    await waitFor(() => expect(page.getByText(/invalid or has expired/)).toBeTruthy());
  });

  it('a link without its token says so', () => {
    const page = renderAt('/creator/reset-password', <CreatorResetPasswordPage />, '/creator/reset-password');
    expect(page.getByText(/missing its token/)).toBeTruthy();
  });
});

describe('creator signup with Google', () => {
  it('offers Sign up with Google', async () => {
    routes['GET /auth/providers'] = () =>
      json(200, { google: true, googleStartUrl: 'https://app.openpartner.test/api/auth/google/start' });
    const page = renderAt('/creator/signup', <CreatorSignupPage />, '/creator/signup');
    const link = (await waitFor(() => page.getByRole('link', { name: /Sign up with Google/ }))) as HTMLAnchorElement;
    expect(link.href).toBe('https://app.openpartner.test/api/auth/google/start?flow=creator');
  });

  it('back from Google: the verified address is fixed, and finishing signs the creator in with no email', async () => {
    routes['GET /auth/google/creator-signup'] = () => json(200, { email: 'new@example.com' });
    routes['POST /auth/google/creator-signup'] = () => json(200, { ok: true, token: 'opmlcreator_signup' });
    routes['POST /creator-api/creators/verify'] = () => json(200, { ok: true });
    const page = renderAt('/creator/signup?google=1', <CreatorSignupPage />, '/creator/signup');

    await waitFor(() => expect(page.getByText('new@example.com')).toBeTruthy());
    expect(page.getByText('✓ Verified by Google')).toBeTruthy();
    // No editable email field in this mode.
    expect(page.queryByPlaceholderText('ada@example.com')).toBeNull();

    fireEvent.change(page.getByPlaceholderText('Ada Lovelace'), { target: { value: 'Ada' } });
    fireEvent.change(page.getByRole('combobox'), { target: { value: 'GB' } });
    fireEvent.click(page.getByRole('button', { name: 'Create my account' }));

    await waitFor(() => expect(page.getByText('landed at /creator')).toBeTruthy());
    // The address is the server's, never the form's.
    expect(posts('/api/auth/google/creator-signup')[0]!.body).toEqual({ name: 'Ada', country: 'GB' });
    expect(posts('/api/creator-api/creators/verify')[0]!.body).toEqual({ token: 'opmlcreator_signup' });
    expect(posts('/api/creator-api/creators/signup')).toHaveLength(0);
  });

  it('shows the Network’s refusal and keeps the form', async () => {
    routes['GET /auth/google/creator-signup'] = () => json(200, { email: 'new@example.com' });
    routes['POST /auth/google/creator-signup'] = () => json(409, { error: 'handle_taken' });
    const page = renderAt('/creator/signup?google=1', <CreatorSignupPage />, '/creator/signup');
    await waitFor(() => expect(page.getByText('new@example.com')).toBeTruthy());
    fireEvent.change(page.getByPlaceholderText('Ada Lovelace'), { target: { value: 'Ada' } });
    fireEvent.change(page.getByRole('combobox'), { target: { value: 'GB' } });
    fireEvent.click(page.getByRole('button', { name: 'Create my account' }));
    await waitFor(() => expect(page.getByText('That handle is already taken — pick another.')).toBeTruthy());
    expect(page.getByText('new@example.com')).toBeTruthy();
  });

  it('a Google proof that expires before submitting drops back to the emailed-link signup, keeping the form', async () => {
    routes['GET /auth/google/creator-signup'] = () => json(200, { email: 'new@example.com' });
    routes['POST /auth/google/creator-signup'] = () => json(401, { error: 'google_signup_expired' });
    const page = renderAt('/creator/signup?google=1', <CreatorSignupPage />, '/creator/signup');
    await waitFor(() => expect(page.getByText('new@example.com')).toBeTruthy());
    fireEvent.change(page.getByPlaceholderText('Ada Lovelace'), { target: { value: 'Ada' } });
    fireEvent.change(page.getByRole('combobox'), { target: { value: 'GB' } });
    fireEvent.click(page.getByRole('button', { name: 'Create my account' }));
    await waitFor(() => expect(page.getByText(/Google sign-in timed out/)).toBeTruthy());
    expect(page.getByPlaceholderText('ada@example.com')).toBeTruthy();
    expect((page.getByPlaceholderText('Ada Lovelace') as HTMLInputElement).value).toBe('Ada');
  });

  it('an expired Google round trip says so; “Use a different email” goes back to the emailed-link signup', async () => {
    routes['GET /auth/google/creator-signup'] = () => json(404, { error: 'google_signup_expired' });
    const expired = renderAt('/creator/signup?google=1', <CreatorSignupPage />, '/creator/signup');
    await waitFor(() => expect(expired.getByText(/Google sign-in timed out/)).toBeTruthy());
    expect(expired.getByPlaceholderText('ada@example.com')).toBeTruthy();
    cleanup();

    routes['GET /auth/google/creator-signup'] = () => json(200, { email: 'new@example.com' });
    routes['DELETE /auth/google/creator-signup'] = () => json(200, { ok: true });
    const page = renderAt('/creator/signup?google=1', <CreatorSignupPage />, '/creator/signup');
    await waitFor(() => expect(page.getByText('new@example.com')).toBeTruthy());
    fireEvent.click(page.getByRole('button', { name: 'Use a different email' }));
    await waitFor(() => expect(page.getByPlaceholderText('ada@example.com')).toBeTruthy());
    expect(sent.some((s) => s.method === 'DELETE' && s.url === '/api/auth/google/creator-signup')).toBe(true);
    expect(page.getByRole('button', { name: 'Become a creator' })).toBeTruthy();
  });
});

describe('creator account: password', () => {
  function renderCard(pendingDeletion = false) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <CreatorPasswordCard pendingDeletion={pendingDeletion} />
      </QueryClientProvider>,
    );
  }

  function typeNew(page: ReturnType<typeof render>, value: string) {
    const [pw, confirm] = Array.from(page.container.querySelectorAll('input[autocomplete="new-password"]'));
    fireEvent.change(pw!, { target: { value } });
    fireEvent.change(confirm!, { target: { value } });
  }

  it('sets a first password with no current one', async () => {
    let has = false;
    routes['GET /creator-api/creators/me/password'] = () => json(200, { hasPassword: has });
    routes['PUT /creator-api/creators/me/password'] = () => {
      has = true;
      return json(200, { ok: true });
    };
    const page = renderCard();
    await waitFor(() => expect(page.getByText(/You sign in with emailed links/)).toBeTruthy());
    expect(page.container.querySelector('input[autocomplete="current-password"]')).toBeNull();
    typeNew(page, 'correct horse battery');
    fireEvent.click(page.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(page.getByText('Password saved.')).toBeTruthy());
    expect(sent.find((s) => s.method === 'PUT')!.body).toEqual({ password: 'correct horse battery' });
    await waitFor(() => expect(page.getByRole('button', { name: 'Change password' })).toBeTruthy());
  });

  it('changing needs the current password, and says when it’s wrong', async () => {
    routes['GET /creator-api/creators/me/password'] = () => json(200, { hasPassword: true });
    routes['PUT /creator-api/creators/me/password'] = () => json(403, { error: 'current_password_incorrect' });
    const page = renderCard();
    await waitFor(() => expect(page.getByText(/signs you out on your other devices/)).toBeTruthy());
    const change = page.getByRole('button', { name: 'Change password' }) as HTMLButtonElement;
    typeNew(page, 'another long passphrase');
    expect(change.disabled).toBe(true);
    fireEvent.change(page.container.querySelector('input[autocomplete="current-password"]')!, { target: { value: 'not it' } });
    fireEvent.click(change);
    await waitFor(() => expect(page.getByText('Your current password isn’t right.')).toBeTruthy());
    expect(sent.find((s) => s.method === 'PUT')!.body).toEqual({ currentPassword: 'not it', password: 'another long passphrase' });
  });

  it('isn’t offered while the account is scheduled for deletion', () => {
    routes['GET /creator-api/creators/me/password'] = () => json(200, { hasPassword: false });
    const page = renderCard(true);
    expect(page.queryByText('Password')).toBeNull();
  });
});
