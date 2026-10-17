// @vitest-environment jsdom
/**
 * The "Renewals stay with the partner who earned the customer" checkbox
 * (Program.renewalsStayWithPartner) on the program forms: it shows the
 * saved value, treats a response without the field as on (the API
 * default), and sends what the admin picked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api.js';
import { AdminPrograms } from '../pages/AdminPrograms.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  api: vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({});
});

const PROGRAM = {
  id: 'prog_1',
  name: 'Default',
  commissionRule: [{ trigger: 'every', type: 'percent', value: 20, recurring: true }],
  attributionWindowDays: 60,
  attributionModel: 'last_click',
  destinationUrl: 'https://acme.example/landing',
  deepLinkAllowedDomains: null,
  holdbackDays: 0,
  startsAt: null,
  endsAt: null,
  customerReward: null,
  shareOnNetwork: false,
  partnersMayCustomizeCode: false,
  marketplaceDescription: null,
  networkOfferingId: null,
  categories: [],
  createdAt: '2026-10-01T00:00:00.000Z',
};

function renderPrograms(program: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['campaigns'], { programs: [program], customerRewardDelivery: 'unconfigured' });
  qc.setQueryData(['network-membership'], { enabled: false });
  qc.setQueryData(['program-settings'], {
    programName: 'Acme Partners',
    supportEmail: null,
    logoUrl: null,
    brandColor: null,
    programTermsUrl: null,
    whiteLabel: false,
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AdminPrograms />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const checkbox = () => screen.getByLabelText(/renewals stay with the partner/i) as HTMLInputElement;

function sentBody(method: 'PATCH' | 'POST'): Record<string, unknown> {
  const call = vi.mocked(api).mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === method);
  expect(call).toBeTruthy();
  return (call![1] as { body: Record<string, unknown> }).body;
}

describe('renewals setting', () => {
  it('edits the saved value and sends it on save', async () => {
    renderPrograms({ ...PROGRAM, renewalsStayWithPartner: false });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(checkbox().checked).toBe(false);

    fireEvent.click(checkbox());
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(sentBody('PATCH').renewalsStayWithPartner).toBe(true));
  });

  it('shows on for a program response without the field', () => {
    renderPrograms(PROGRAM);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(checkbox().checked).toBe(true);
  });

  it('defaults on for a new program, and can be switched off', async () => {
    renderPrograms(PROGRAM);
    fireEvent.click(screen.getByRole('button', { name: /new campaign/i }));
    expect(checkbox().checked).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('Default'), { target: { value: 'Refer & earn' } });
    fireEvent.change(screen.getByPlaceholderText('https://yourbrand.com/landing-page'), {
      target: { value: 'https://acme.example/signup' },
    });
    fireEvent.click(checkbox());
    fireEvent.click(screen.getByRole('button', { name: /create campaign/i }));
    await waitFor(() => expect(sentBody('POST').renewalsStayWithPartner).toBe(false));
  });
});
