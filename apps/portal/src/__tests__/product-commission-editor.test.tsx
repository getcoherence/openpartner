// @vitest-environment jsdom
/**
 * Limiting a commission rule to products in the shared rule editor
 * (docs/product-commissions.md), exercised through the partner override
 * screen (the program forms render the same control): pick products from
 * recent sales or by id, save them on the rule, block Save on an empty
 * pick, and say so in the summary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { api } from '../api.js';
import { renderCommissionSummary } from '../lib/commission-summary.js';
import { rulesLeftUnpaid } from '../lib/commission-override.js';
import { ruleProductProblem, type CommissionSubRule } from '../lib/CompoundRuleEditor.js';
import { AdminPartnerCommission } from '../pages/AdminPartnerCommission.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  api: vi.fn(),
}));

const SEEN = [
  { id: 'prod_pro', kind: 'product', name: 'Pro', productId: null, sales: 4, lastSeenAt: '2026-11-01T00:00:00Z' },
  { id: 'price_pro_y', kind: 'price', name: 'Pro', productId: 'prod_pro', sales: 1, lastSeenAt: '2026-10-01T00:00:00Z' },
];

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => (path === '/programs/products' ? { products: SEEN } : {}));
});

const FLAT: CommissionSubRule = { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 30 };

function show(rules: CommissionSubRule[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['partner', 'p1'], { id: 'p1', name: 'Ada', email: 'ada@example.com' });
  client.setQueryData(['partner-commission-snapshot', 'p1'], {
    snapshot: {
      partnerId: 'p1',
      source: 'amendment',
      snapshottedAt: '2026-10-01T00:00:00Z',
      commissionType: rules[0]!.type,
      commissionValue: String(rules[0]!.value),
      recurring: rules[0]!.recurring ?? false,
      commissionRules: rules,
      holdbackDays: null,
    },
  });
  return render(
    <MemoryRouter initialEntries={['/admin/partners/p1/commission']}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/admin/partners/:id/commission" element={<AdminPartnerCommission />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function putRules(): CommissionSubRule[] {
  const call = vi.mocked(api).mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT');
  expect(call).toBeTruthy();
  return JSON.parse(JSON.stringify((call![1] as { body: { commissionRules: CommissionSubRule[] } }).body.commissionRules));
}

describe('products on a rule', () => {
  it("doesn't fetch suggestions until a rule is limited to products", () => {
    show([FLAT]);
    expect(vi.mocked(api).mock.calls.some((c) => c[0] === '/programs/products')).toBe(false);
  });

  it('picks products from recent sales or by id, and saves them on the rule', async () => {
    const page = show([FLAT]);
    const save = () => page.getByText('Update override').closest('button')!;

    fireEvent.change(page.getByLabelText('Products'), { target: { value: 'some' } });
    expect(page.getByText('Add a product, or pay on all products.')).toBeTruthy();
    expect(save().disabled).toBe(true);

    // Suggestions from recent sales, products and prices both.
    await waitFor(() => expect(page.container.querySelectorAll('datalist option')).toHaveLength(2));
    const input = page.getByLabelText('Add product');
    fireEvent.change(input, { target: { value: 'prod_pro' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: ' sku_new ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // A price keeps its id: the product's name would read as every Pro sale.
    fireEvent.change(input, { target: { value: 'price_pro_y' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // The same id twice is one product.
    fireEvent.change(input, { target: { value: 'prod_pro' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(page.getByText('Pro')).toBeTruthy();
    expect(page.getByText('sku_new')).toBeTruthy();
    expect(page.getByText('price_pro_y')).toBeTruthy();
    expect(save().disabled).toBe(false);

    fireEvent.click(save());
    await waitFor(() =>
      expect(putRules()).toEqual([{ ...FLAT, products: [{ id: 'prod_pro', name: 'Pro' }, { id: 'sku_new' }, { id: 'price_pro_y' }] }]),
    );
  });

  it('shows the products in the terms, removes one, and "All products" drops the list', async () => {
    const limited: CommissionSubRule = { ...FLAT, products: [{ id: 'prod_pro', name: 'Pro' }, { id: 'prod_team', name: 'Team' }] };
    const page = show([limited]);
    expect(page.getByText('30% on every invoice (Pro and Team only)')).toBeTruthy();
    expect(renderCommissionSummary([limited])).toBe('30% on every invoice (Pro and Team only)');
    fireEvent.click(page.getByLabelText('Remove Team'));
    expect(page.queryByText('Team')).toBeNull();
    fireEvent.change(page.getByLabelText('Products'), { target: { value: 'all' } });
    expect(page.queryByLabelText('Add product')).toBeNull();
    fireEvent.click(page.getByText('Update override'));
    await waitFor(() => expect(putRules()[0]).not.toHaveProperty('products'));
  });

  it('says what blocks Save', () => {
    expect(ruleProductProblem(FLAT)).toBeNull();
    expect(ruleProductProblem({ ...FLAT, products: [] })).toBe('Add a product, or pay on all products.');
    expect(ruleProductProblem({ ...FLAT, products: Array.from({ length: 51 }, (_, i) => ({ id: `p${i}` })) })).toBe(
      'At most 50 products.',
    );
  });
});

describe('rulesLeftUnpaid with products', () => {
  const pro: CommissionSubRule = { ...FLAT, products: [{ id: 'prod_pro' }] };
  const team: CommissionSubRule = { ...FLAT, products: [{ id: 'prod_team' }] };

  it('a rule for some products leaves the others unpaid', () => {
    expect(rulesLeftUnpaid([FLAT], [pro])).toEqual([FLAT]);
    expect(rulesLeftUnpaid([pro, team], [pro])).toEqual([team]);
  });

  it('a rule for every product, or for more of them, covers a narrower one', () => {
    expect(rulesLeftUnpaid([pro, team], [FLAT])).toEqual([]);
    expect(rulesLeftUnpaid([pro], [{ ...FLAT, products: [{ id: 'prod_pro' }, { id: 'prod_team' }] }])).toEqual([]);
    expect(rulesLeftUnpaid([pro], [{ trigger: 'every', type: 'percent', value: 5 }])).toEqual([]);
  });
});
