// @vitest-environment jsdom
/**
 * Applying to a Network offering needs a complete profile. The page blocks
 * up front from the profile checklist, and if the Network still refuses
 * (409 profile_incomplete) it shows what's missing instead of a raw error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorOfferingDetailPage } from '../pages/creator/CreatorOfferingDetail.js';

const OFFERING = {
  id: 'off_1',
  title: 'Acme Partners',
  description: 'Acme makes design tools.',
  productUrl: 'https://acme.example',
  vendorId: 'vnd_1',
  vendorName: 'Acme',
  vendorLogoUrl: null,
  terms: { commissionDescription: '20% recurring' },
  coverImageUrl: null,
  video: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  myStatus: 'none',
};

let applyStatus = 201;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  applyStatus = 201;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/offerings/off_1/apply')) {
      return applyStatus === 409
        ? json(409, { error: 'profile_incomplete', missing: [{ field: 'platforms', label: 'A social platform' }] })
        : json(201, { id: 'req_1' });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderPage(profile: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['creator-offering', 'off_1'], OFFERING);
  qc.setQueryData(['creator-whoami'], { creator: { id: 'crt_1', handle: 'ada' } });
  qc.setQueryData(['creator-my-profile'], profile);
  return render(
    <MemoryRouter initialEntries={['/creator/offerings/off_1']}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/creator/offerings/:id" element={<CreatorOfferingDetailPage />} />
          <Route path="/creator/requests" element={<div>My applications page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('creator apply gate', () => {
  it('blocks up front when the checklist says the profile is incomplete', () => {
    const page = renderPage({
      profileComplete: false,
      profileChecklist: [
        { field: 'handle', label: 'Handle', done: true },
        { field: 'bio', label: 'Bio', done: false },
      ],
    });
    expect(page.getByText('Complete your profile to apply')).toBeTruthy();
    expect(page.getByText(/Still missing: Bio\./)).toBeTruthy();
    expect(page.getByRole('link', { name: 'Go to your profile →' }).getAttribute('href')).toBe('/creator/profile');
    expect((page.getByRole('button', { name: 'Submit application' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the Network’s missing list when it refuses the application', async () => {
    applyStatus = 409;
    const page = renderPage({ profileComplete: true, profileChecklist: [] });
    expect(page.queryByText('Complete your profile to apply')).toBeNull();
    fireEvent.click(page.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(page.getByText('Complete your profile to apply')).toBeTruthy());
    expect(page.getByText(/Still missing: A social platform\./)).toBeTruthy();
    expect(page.queryByText(/profile_incomplete/)).toBeNull();
  });

  it('applies normally with a complete profile', async () => {
    const page = renderPage({ profileComplete: true, profileChecklist: [] });
    fireEvent.click(page.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(page.getByText('My applications page')).toBeTruthy());
  });
});
