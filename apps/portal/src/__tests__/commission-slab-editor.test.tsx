// @vitest-environment jsdom
/**
 * Slab and tier editing in the shared rule editor, exercised through the
 * partner override screen (the program forms render the same control).
 * A slab table has to survive a save untouched, a new one has to be
 * reachable from the row, and anything the API would 400 has to block
 * Save with the reason on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { api } from '../api.js';
import { renderCommissionSummary } from '../lib/commission-summary.js';
import { ruleSlabProblem, type CommissionSubRule } from '../lib/CompoundRuleEditor.js';
import { AdminPartnerCommission } from '../pages/AdminPartnerCommission.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  api: vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({});
});

const TIERED: CommissionSubRule = {
  trigger: 'every',
  eventType: 'invoice_paid',
  type: 'percent',
  value: 10,
  recurring: true,
  tiers: { metric: 'revenue', window: 'calendar_month', levels: [{ atLeast: 100000, value: 15 }] },
};

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

describe('slab editor', () => {
  it('shows a tiered override as a range and saves the tiers untouched', async () => {
    const page = show([TIERED]);
    expect(page.getByText(renderCommissionSummary([TIERED]))).toBeTruthy();
    expect((page.getByLabelText('Rate varies') as HTMLSelectElement).value).toBe('tiers');
    expect((page.getByLabelText('Step 1 threshold') as HTMLInputElement).value).toBe('100000');

    fireEvent.click(page.getByText('Update override'));
    await waitFor(() => expect(putRules()).toEqual([TIERED]));
  });

  it('turns a flat rule into value slabs and saves the new table', async () => {
    const page = show([{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 10 }]);
    fireEvent.change(page.getByLabelText('Rate varies'), { target: { value: 'bands' } });
    fireEvent.change(page.getByLabelText('Step 1 threshold'), { target: { value: '50000' } });
    fireEvent.change(page.getByLabelText('Step 1 rate'), { target: { value: '15' } });
    fireEvent.click(page.getByText('+ Add step'));
    fireEvent.change(page.getByLabelText('Slab mode'), { target: { value: 'marginal' } });
    fireEvent.change(page.getByLabelText('Threshold currency'), { target: { value: 'inr' } });

    fireEvent.click(page.getByText('Update override'));
    await waitFor(() =>
      expect(putRules()).toEqual([
        {
          trigger: 'every',
          eventType: 'invoice_paid',
          type: 'percent',
          value: 10,
          currency: 'INR',
          bands: { mode: 'marginal', levels: [{ above: 50000, value: 15 }, { above: 100000, value: 20 }] },
        },
      ]),
    );
  });

  it('blocks Save on a table the API would reject, and says why', () => {
    const page = show([TIERED]);
    const save = () => page.getByText('Update override').closest('button')!;
    expect(save().disabled).toBe(false);

    fireEvent.click(page.getByText('+ Add step'));
    fireEvent.change(page.getByLabelText('Step 2 threshold'), { target: { value: '5000' } });
    expect(page.getByText('Thresholds must increase from one step to the next.')).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it('switching back to a flat rate drops the table', async () => {
    const page = show([TIERED]);
    fireEvent.change(page.getByLabelText('Rate varies'), { target: { value: 'flat' } });
    expect(page.queryByLabelText('Step 1 threshold')).toBeNull();
    fireEvent.click(page.getByText('Update override'));
    await waitFor(() => expect(putRules()[0]).not.toHaveProperty('tiers'));
  });

  // Review finding: a half-typed "Thresholds in" currency survived the
  // switch back to flat, Save stayed enabled, and the API answered 400.
  it('switching to flat drops a half-typed threshold currency', async () => {
    const page = show([{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 10 }]);
    fireEvent.change(page.getByLabelText('Rate varies'), { target: { value: 'bands' } });
    fireEvent.change(page.getByLabelText('Threshold currency'), { target: { value: 'in' } });
    expect(page.getByText('Currency is a 3-letter code, e.g. INR.')).toBeTruthy();

    fireEvent.change(page.getByLabelText('Rate varies'), { target: { value: 'flat' } });
    const save = page.getByText('Update override').closest('button')!;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(putRules()[0]).not.toHaveProperty('currency'));
  });

  it('a flat rule stored with a bad currency says so and offers a way out', () => {
    const page = show([{ trigger: 'every', type: 'fixed', value: 50, currency: '$$$' }]);
    const save = () => page.getByText('Update override').closest('button')!;
    expect(page.getByText('Currency is a 3-letter code, e.g. INR.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.click(page.getByText('Clear currency'));
    expect(save().disabled).toBe(false);
  });

  it('a conversions tier still shows a currency that is set, so a bad one can be fixed', () => {
    const page = show([
      { ...TIERED, currency: 'XY', tiers: { metric: 'conversions', window: 'lifetime', levels: [{ atLeast: 5, value: 15 }] } },
    ]);
    expect((page.getByLabelText('Threshold currency') as HTMLInputElement).value).toBe('XY');
    fireEvent.change(page.getByLabelText('Threshold currency'), { target: { value: '' } });
    expect(page.getByText('Update override').closest('button')!.disabled).toBe(false);
  });
});

describe('ruleSlabProblem (gates Save on the override and both program forms)', () => {
  const base: CommissionSubRule = { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 10 };
  const bands = (levels: Array<{ above: number; value: number }>, mode: 'whole' | 'marginal' = 'whole') => ({
    ...base,
    bands: { mode, levels },
  });

  it('passes flat rules and well-formed tables', () => {
    expect(ruleSlabProblem(base)).toBeNull();
    expect(ruleSlabProblem(bands([{ above: 1, value: 15 }, { above: 2, value: 20 }]))).toBeNull();
    expect(ruleSlabProblem(TIERED)).toBeNull();
  });

  it('mirrors the API checks', () => {
    expect(ruleSlabProblem(bands([]))).toMatch(/at least one step/);
    expect(ruleSlabProblem(bands([{ above: 0, value: 15 }]))).toMatch(/more than 0/);
    expect(ruleSlabProblem(bands([{ above: 2, value: 15 }, { above: 2, value: 20 }]))).toMatch(/increase/);
    expect(ruleSlabProblem(bands([{ above: 1, value: 101 }]))).toMatch(/exceed 100/);
    expect(ruleSlabProblem(bands(Array.from({ length: 11 }, (_, i) => ({ above: i + 1, value: 1 }))))).toMatch(/At most 10/);
    expect(ruleSlabProblem({ ...bands([{ above: 1, value: 5 }], 'marginal'), type: 'fixed' })).toMatch(/Marginal/);
    expect(
      ruleSlabProblem({ ...TIERED, tiers: { ...TIERED.tiers!, window: 'rolling_days', windowDays: undefined } }),
    ).toMatch(/rolling window/);
    expect(ruleSlabProblem({ ...TIERED, eventType: undefined })).toMatch(/event the tier counts/);
    expect(ruleSlabProblem({ ...TIERED, currency: 'RUPEE' })).toMatch(/3-letter/);
    expect(ruleSlabProblem({ ...TIERED, bands: { mode: 'whole', levels: [{ above: 1, value: 1 }] } })).toMatch(/not both/);
  });
});
