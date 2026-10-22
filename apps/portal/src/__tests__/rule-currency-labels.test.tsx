// @vitest-environment jsdom
/**
 * Fixed commission amounts name their currency. An INR brand's ₹100-per-lead
 * rule used to read "Fixed $ 100" in Programs → Edit, and a fixed rule with
 * no currency of its own (every one made in the editor, which has no
 * currency field for a flat rule) read "$100" in the program list. A fixed
 * amount is in the rule's currency, else the brand's default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api.js';
import type { CommissionSubRule } from '../lib/CompoundRuleEditor.js';
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

function program(commissionRule: CommissionSubRule[]) {
  return {
    id: 'prog_1',
    name: 'Default',
    commissionRule,
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
}

/** The program list for a brand whose default currency is `defaultCurrency`
 *  (undefined = an API that predates the field). */
function showPrograms(rules: CommissionSubRule[], defaultCurrency: string | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['campaigns'], { programs: [program(rules)], customerRewardDelivery: 'brand' });
  qc.setQueryData(['network-membership'], { enabled: false });
  qc.setQueryData(['program-settings'], {
    programName: 'Acme Partners',
    supportEmail: null,
    logoUrl: null,
    brandColor: null,
    programTermsUrl: null,
    whiteLabel: false,
    ...(defaultCurrency ? { defaultCurrency } : {}),
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AdminPrograms />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const editProgram = () => fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
const fixedLabels = () =>
  Array.from(document.querySelectorAll<HTMLOptionElement>('option[value="fixed"]')).map((o) => o.textContent);
const text = () => document.body.textContent ?? '';

describe('fixed-amount currency labels', () => {
  it('labels an INR rule "Fixed INR" in the editor and ₹ in the list', () => {
    showPrograms(
      [
        { trigger: 'every', eventType: 'lead_created', type: 'fixed', value: 100, currency: 'INR' },
        { trigger: 'every', eventType: 'demo_booked', type: 'fixed', value: 500, currency: 'INR' },
      ],
      'USD',
    );
    expect(text()).toContain('₹100 on every lead created + ₹500 on every demo booked');

    editProgram();
    expect(fixedLabels()).toEqual(['Fixed INR', 'Fixed INR']);
    expect(text()).not.toContain('Fixed $');
  });

  it('falls back to the brand default currency for a rule with none', () => {
    showPrograms([{ trigger: 'first', eventType: 'signup', type: 'fixed', value: 100 }], 'INR');
    expect(text()).toContain('₹100 on first signup');

    editProgram();
    expect(fixedLabels()).toEqual(['Fixed INR']);
  });

  it('reads USD when the brand has no default currency on record', () => {
    showPrograms([{ trigger: 'first', eventType: 'signup', type: 'fixed', value: 100 }], undefined);
    expect(text()).toContain('$100 on first signup');

    editProgram();
    expect(fixedLabels()).toEqual(['Fixed USD']);
  });

  it('puts a slab table’s fixed steps in the same currency', () => {
    showPrograms(
      [
        {
          trigger: 'every',
          eventType: 'invoice_paid',
          type: 'fixed',
          value: 100,
          bands: { mode: 'whole', levels: [{ above: 50000, value: 200 }] },
        },
      ],
      'INR',
    );
    expect(text()).toContain('₹100–₹200 on every invoice (slabs by invoice value)');

    editProgram();
    expect(fixedLabels()).toEqual(['Fixed INR']);
    expect(text()).toContain('Base: 100 INR up to and including the first threshold');
    expect(text()).not.toMatch(/\$\s?\d/);
  });
});
