// @vitest-environment jsdom
/**
 * Admin Partners: the join-page application (Partner.metadata.application)
 * is readable from the row. Links open in a new tab with rel=noopener and
 * only http(s) values become links; applicants from before the join page
 * asked for one show "No application on file". Approve/Revoke unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminPartners, PARTNERS_PAGE_SIZE } from '../pages/AdminPartners.js';
import { partnerListKey } from '../lib/usePartnerSearch.js';

afterEach(cleanup);

const base = { stripeConnectAccountId: null, activatedAt: null, revokedAt: null, createdAt: '2026-10-01T10:00:00.000Z' };

const PARTNERS = [
  {
    ...base,
    id: 'p_app',
    name: 'Ada Applicant',
    email: 'ada@example.com',
    metadata: {
      review: { status: 'pending', appliedAt: '2026-10-14T09:30:00.000Z' },
      application: {
        websiteUrl: 'https://ada.example',
        socialUrls: ['https://youtube.com/@ada', 'javascript:alert(1)'],
        audienceSize: '50k_250k',
        pitch: 'Weekly design-tool reviews.\nI would do a full walkthrough video.',
        submittedAt: '2026-10-14T09:30:00.000Z',
      },
    },
  },
  {
    ...base,
    id: 'p_old',
    name: 'Old Applicant',
    email: 'old@example.com',
    metadata: { review: { status: 'pending', appliedAt: '2026-09-01T09:30:00.000Z' } },
  },
  { ...base, id: 'p_inv', name: 'Invited Partner', email: 'inv@example.com', activatedAt: '2026-10-02T00:00:00.000Z', metadata: {} },
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(partnerListKey('', PARTNERS_PAGE_SIZE), {
    pages: [{ partners: PARTNERS, nextCursor: null }],
    pageParams: [null],
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AdminPartners />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('admin partners: View application', () => {
  it('offers the action only where an application exists, and says when there is none', () => {
    const page = renderPage();
    expect(page.getAllByRole('button', { name: 'View application' })).toHaveLength(1);
    // The pre-application applicant is still pending review: tell the admin.
    expect(page.getAllByText('No application on file')).toHaveLength(1);
    // Approve / Revoke are untouched.
    expect(page.getAllByRole('button', { name: 'Approve' })).toHaveLength(2);
    expect(page.getAllByRole('button', { name: 'Revoke' })).toHaveLength(3);
  });

  it('shows the four answers and when they applied, with safe external links', () => {
    const page = renderPage();
    fireEvent.click(page.getByRole('button', { name: 'View application' }));

    const panel = within(page.getByRole('region', { name: "Ada Applicant's application" }));
    expect(panel.getByText(/Applied Oct 14, 2026/)).toBeTruthy();
    expect(panel.getByText('Website or main channel')).toBeTruthy();
    expect(panel.getByText('Social profiles')).toBeTruthy();
    expect(panel.getByText('Audience size')).toBeTruthy();
    expect(panel.getByText('50K–250K')).toBeTruthy();
    expect(panel.getByText(/Weekly design-tool reviews\./).textContent).toBe(
      'Weekly design-tool reviews.\nI would do a full walkthrough video.',
    );

    const website = panel.getByRole('link', { name: 'https://ada.example' });
    expect(website.getAttribute('href')).toBe('https://ada.example');
    expect(website.getAttribute('target')).toBe('_blank');
    expect(website.getAttribute('rel')).toContain('noopener');
    expect(panel.getByRole('link', { name: 'https://youtube.com/@ada' }).getAttribute('rel')).toContain('noopener');
    // A non-http value is shown as text, never as an href.
    expect(panel.getByText('javascript:alert(1)').tagName).toBe('SPAN');
    expect(panel.queryByRole('link', { name: 'javascript:alert(1)' })).toBeNull();

    fireEvent.click(panel.getByRole('button', { name: 'Close' }));
    expect(page.queryByRole('region', { name: "Ada Applicant's application" })).toBeNull();
  });
});
