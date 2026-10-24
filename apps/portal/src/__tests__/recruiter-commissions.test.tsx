// @vitest-environment jsdom
/**
 * Two-tier commissions in the portal: a recruiter commission reads as the
 * recruit's sale, and the join page carries a recruit link's ?ref= to the
 * status check (for "Jane invited you") and says who invited them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { commissionSourceLabel, isRecruiterCommission } from '../lib/commission-source.js';
import { PartnerJoinPage } from '../pages/PartnerJoin.js';

describe('commissionSourceLabel', () => {
  it('names the recruit and the sale on a recruiter commission', () => {
    const c = {
      source: 'attribution' as const,
      eventType: 'invoice_paid',
      recruiter: { sourceCommissionId: 'c1', recruitedPartnerName: 'Ben', percent: 10 },
    };
    expect(isRecruiterCommission(c)).toBe(true);
    expect(commissionSourceLabel(c)).toBe('Recruiter commission: Ben, invoice paid');
    expect(commissionSourceLabel({ ...c, eventType: null, recruiter: { ...c.recruiter, recruitedPartnerName: null } })).toBe(
      'Recruiter commission: a partner you recruited',
    );
  });

  it('leaves a sale without a recruiter as it was', () => {
    expect(isRecruiterCommission({ source: 'attribution', eventType: 'invoice_paid', recruiter: null })).toBe(false);
    expect(commissionSourceLabel({ source: 'attribution', eventType: 'invoice_paid', recruiter: null })).toBe('Invoice paid');
  });
});

describe('PartnerJoinPage with a recruit link', () => {
  let urls: string[] = [];
  beforeEach(() => {
    urls = [];
    window.history.pushState({}, '', '/join?ref=abcde23456');
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes('/partner-signup/status')
        ? { open: true, reviewRequired: false, recruiter: { name: 'Ada' } }
        : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });
  afterEach(() => {
    cleanup();
    window.history.pushState({}, '', '/');
  });

  it('asks the status check about the ref and says who invited them', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['public-branding', null], {
      tenantSlug: 'acme',
      programName: 'Acme',
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
          <PartnerJoinPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(page.getByText('Ada invited you to join.')).toBeTruthy());
    expect(urls).toContain('/api/partner-signup/status?ref=abcde23456');
  });
});
