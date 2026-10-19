// @vitest-environment jsdom
/**
 * A live program's destination and allowed deep-link domains are editable.
 * They used to be create-only, so a brand that connected Stripe couldn't add
 * client_reference_id={click_id} to an existing program's Payment Link.
 * The edit form runs the same checks and hints as create (shared
 * DestinationFields).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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
  deepLinkAllowedDomains: 'acme.example',
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

function openEdit() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['campaigns'], { programs: [PROGRAM], customerRewardDelivery: 'brand' });
  qc.setQueryData(['network-membership'], { enabled: false });
  qc.setQueryData(['program-settings'], {
    programName: 'Acme Partners',
    supportEmail: null,
    logoUrl: null,
    brandColor: null,
    programTermsUrl: null,
    whiteLabel: false,
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AdminPrograms />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
}

const destination = () => screen.getByPlaceholderText('https://yourbrand.com/landing-page') as HTMLInputElement;
const domains = () => screen.getByPlaceholderText('yourbrand.com,docs.yourbrand.com') as HTMLInputElement;
const save = () => screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;
const text = () => document.body.textContent ?? '';

function sentPatch(): Record<string, unknown> {
  const call = vi.mocked(api).mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH');
  expect(call).toBeTruthy();
  expect(call![0]).toBe('/programs/prog_1');
  return (call![1] as { body: Record<string, unknown> }).body;
}

describe('editing a program destination', () => {
  it('shows the saved destination and domains, and sends the changes', async () => {
    openEdit();
    expect(destination().value).toBe('https://acme.example/landing');
    expect(domains().value).toBe('acme.example');
    expect(text()).toMatch(/applies at once to every share-link without its own deep link/);

    fireEvent.change(destination(), { target: { value: 'https://acme.example/pricing?client={click_id}' } });
    fireEvent.change(domains(), { target: { value: 'acme.example, docs.acme.example' } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(sentPatch()).toMatchObject({
        destinationUrl: 'https://acme.example/pricing?client={click_id}',
        deepLinkAllowedDomains: 'acme.example, docs.acme.example',
      }),
    );
  });

  it('clears the deep-link domains with null', async () => {
    openEdit();
    fireEvent.change(domains(), { target: { value: '  ' } });
    fireEvent.click(save());
    await waitFor(() => expect(sentPatch().deepLinkAllowedDomains).toBeNull());
  });

  it('offers the Stripe Payment Link fix, as on create, and saves the fixed URL', async () => {
    openEdit();
    fireEvent.change(destination(), { target: { value: 'https://buy.stripe.com/abc' } });
    expect(text()).toMatch(/Stripe reads the referral only from client_reference_id/);
    fireEvent.click(screen.getByRole('button', { name: 'Add it' }));
    expect(destination().value).toBe('https://buy.stripe.com/abc?client_reference_id={click_id}');

    fireEvent.click(save());
    await waitFor(() =>
      expect(sentPatch().destinationUrl).toBe('https://buy.stripe.com/abc?client_reference_id={click_id}'),
    );
  });

  it("won't save an empty or malformed destination, and offers the https:// fix", () => {
    openEdit();
    fireEvent.change(destination(), { target: { value: '' } });
    expect(save().disabled).toBe(true);

    fireEvent.change(destination(), { target: { value: 'acme.example/landing' } });
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Use https://acme.example/landing' }));
    expect(destination().value).toBe('https://acme.example/landing');
    expect(save().disabled).toBe(false);
  });
});
