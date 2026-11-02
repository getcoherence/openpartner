// @vitest-environment jsdom
/**
 * New brands and new Network creators both wait for operator review. The
 * signup pages say so above the form, so nobody first hears it after
 * signing up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SignupPage } from '../pages/Signup.js';
import { CreatorSignupPage } from '../pages/creator/CreatorSignup.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/\?.*$/, '');
    if ((init?.method ?? 'GET') === 'POST' && path === '/api/creator-api/creators/signup') return json(200, { ok: true });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderAt(path: string, element: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="*" element={element} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('signup review notice', () => {
  it('tells brands they are reviewed before going live', () => {
    const page = renderAt('/signup', <SignupPage />);
    const note = page.getByRole('note');
    expect(note.textContent).toBe(
      'Approval required. New brands are reviewed before going live. You can set up your programs in the meantime.',
    );
  });

  it('tells creators they are reviewed before brands see them or they can apply', () => {
    const page = renderAt('/creator/signup', <CreatorSignupPage />);
    const note = page.getByRole('note');
    expect(note.textContent).toBe(
      'Approval required. New profiles are reviewed before brands can see them or you can apply to programs.',
    );
  });

  it('says brands see complete, approved profiles once the creator has signed up', async () => {
    const page = renderAt('/creator/signup', <CreatorSignupPage />);
    fireEvent.change(page.getByPlaceholderText('Ada Lovelace'), { target: { value: 'Ada' } });
    fireEvent.change(page.getByPlaceholderText('ada@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.change(page.getByRole('combobox'), { target: { value: 'DE' } });
    fireEvent.click(page.getByRole('button', { name: 'Become a creator' }));
    await waitFor(() => expect(page.getByText('Check your inbox')).toBeTruthy());
    expect(page.getByText(/Brands only see complete, approved profiles/)).toBeTruthy();
  });
});
