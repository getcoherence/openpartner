// @vitest-environment jsdom
/**
 * The partner commission override screen must round-trip compound
 * terms. It used to load only the legacy single-rule columns and PUT
 * without commissionRules, which the API treats as "replace with one
 * rule" — so changing anything (even just the holdback) silently
 * dropped a partner's first-sale bonus, event filters and recurring caps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../api.js';
import { renderCommissionSummary } from '../lib/commission-summary.js';
import { ruleEventTypeMissing } from '../lib/CompoundRuleEditor.js';
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

const COMPOUND_RULES = [
  { trigger: 'first', eventType: 'subscription_created', type: 'fixed', value: 200 },
  { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 20, recurring: true, recurringMonths: 12 },
];

function show(snapshot: Record<string, unknown> | null, programs?: Array<Record<string, unknown>>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['partner', 'p1'], { id: 'p1', name: 'Ada', email: 'ada@example.com' });
  client.setQueryData(['partner-commission-snapshot', 'p1'], {
    snapshot: snapshot && { partnerId: 'p1', source: 'approval', snapshottedAt: '2026-10-01T00:00:00Z', ...snapshot },
  });
  if (programs) client.setQueryData(['partner-campaigns', 'p1'], { programs });
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

function putBody(): Record<string, unknown> {
  const call = vi.mocked(api).mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT');
  expect(call).toBeTruthy();
  expect(call![0]).toBe('/partners/p1/commission-snapshot');
  return (call![1] as { body: Record<string, unknown> }).body;
}

describe('partner commission override', () => {
  it('shows the compound terms and keeps them when only the holdback changes', async () => {
    const page = show({
      commissionType: 'percent',
      commissionValue: '20.0000',
      recurring: true,
      commissionRules: COMPOUND_RULES,
      holdbackDays: 14,
    });

    // The current-snapshot card reads the rules the engine pays on, not
    // the legacy summary columns.
    expect(page.getByText(renderCommissionSummary(COMPOUND_RULES as never))).toBeTruthy();
    // Both sub-rules are loaded into the editor.
    expect(page.getAllByLabelText('Remove rule')).toHaveLength(2);

    fireEvent.change(page.getByPlaceholderText('0'), { target: { value: '30' } });
    fireEvent.click(page.getByText('Update override'));

    await waitFor(() => expect(putBody()).toBeTruthy());
    expect(putBody()).toEqual({
      // Legacy columns: the first every-event rule, as the approval-time
      // snapshot stamps them.
      commissionType: 'percent',
      commissionValue: 20,
      recurring: true,
      commissionRules: COMPOUND_RULES,
      holdbackDays: 30,
    });
  });

  it('saves a legacy snapshot (no stored rules) as the one every-event rule it already paid on', async () => {
    const page = show({
      commissionType: 'fixed',
      commissionValue: '50.0000',
      recurring: false,
      commissionRules: null,
      holdbackDays: null,
    });

    fireEvent.click(page.getByText('Update override'));

    await waitFor(() => expect(putBody()).toBeTruthy());
    expect(putBody()).toEqual({
      commissionType: 'fixed',
      commissionValue: 50,
      recurring: false,
      commissionRules: [{ trigger: 'every', type: 'fixed', value: 50, recurring: false }],
      holdbackDays: null,
    });
  });

  // A first/subsequent rule without an eventType isn't "first demo
  // booked" any more: the engine skips the event filter, so the bonus
  // fires on the first event of every type. Clearing the custom event
  // name used to leave eventType undefined, which slipped past the
  // empty-string check and saved.
  it('blocks saving a first-trigger rule whose custom event name is cleared', async () => {
    const page = show({
      commissionType: 'fixed',
      commissionValue: '100.0000',
      recurring: false,
      commissionRules: [{ trigger: 'first', eventType: 'demo_booked', type: 'fixed', value: 100 }],
      holdbackDays: null,
    });
    const save = () => page.getByText('Update override').closest('button')!;
    expect(save().disabled).toBe(false);

    fireEvent.change(page.getByPlaceholderText('e.g. demo_booked'), { target: { value: '' } });

    // The custom input stays up with a prompt rather than flipping the
    // picker to a standard event the rule doesn't filter on.
    expect((page.getByPlaceholderText('e.g. demo_booked') as HTMLInputElement).value).toBe('');
    expect(page.getByText('Name the event this rule pays on.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.click(save());
    expect(vi.mocked(api).mock.calls.some((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT')).toBe(false);
  });

  it('blocks saving a stored subsequent-trigger rule that has no eventType', async () => {
    const page = show({
      commissionType: 'percent',
      commissionValue: '20.0000',
      recurring: true,
      commissionRules: [{ trigger: 'subsequent', type: 'percent', value: 20, recurring: true }],
      holdbackDays: null,
    });
    expect(page.getByText('Name the event this rule pays on.')).toBeTruthy();
    expect(page.getByText('Update override').closest('button')!.disabled).toBe(true);
  });
});

describe('per-program terms', () => {
  const rule = (value: number) => [{ trigger: 'every', type: 'percent', value }];
  const scoped = (programId: string, value: number, holdbackDays: number | null) => ({
    id: `pcm_${programId}`,
    partnerId: 'p1',
    programId,
    commissionType: 'percent',
    commissionValue: `${value}.0000`,
    recurring: false,
    commissionRules: rule(value),
    holdbackDays,
    source: 'amendment',
    snapshottedAt: '2026-10-01T00:00:00Z',
  });
  const PARTNER_WIDE = { commissionType: 'percent', commissionValue: '30.0000', recurring: false, commissionRules: rule(30), holdbackDays: 10 };
  /** The text of one program's row (name line + effective-terms line). */
  const rowText = (page: ReturnType<typeof show>, name: string) =>
    page.getByText(name).closest('div')!.parentElement!.textContent!;

  it('shows what each program pays: its own terms, else the partner-wide default, else its rule', () => {
    const page = show(PARTNER_WIDE, [
      { id: 'a', name: 'Alpha', granted: true, commissionRule: rule(10), holdbackDays: 30, commission: scoped('a', 50, null) },
      { id: 'b', name: 'Beta', granted: true, commissionRule: rule(15), holdbackDays: 30, commission: null },
      { id: 'c', name: 'Gamma', granted: false, commissionRule: rule(5), holdbackDays: null, commission: null },
      { id: 'd', name: 'Delta', granted: false, commissionRule: rule(5), holdbackDays: null, commission: scoped('d', 40, 7) },
    ]);

    // Whichever terms win set the holdback too: Alpha's own terms leave it
    // unset, which means Alpha's 30 days — not the partner-wide 10.
    expect(rowText(page, 'Alpha')).toContain(`Program-specific terms: ${renderCommissionSummary(rule(50) as never)} · 30-day holdback`);
    expect(rowText(page, 'Beta')).toContain(`Partner-wide default: ${renderCommissionSummary(rule(30) as never)} · 10-day holdback`);
    // Not granted and no terms → not listed. Not granted WITH terms → listed.
    expect(page.queryByText('Gamma')).toBeNull();
    expect(rowText(page, 'Delta')).toContain('not granted');
    expect(rowText(page, 'Delta')).toContain('7-day holdback');
  });

  it('falls back to the program rule when there is no partner-wide default', () => {
    const page = show(null, [
      { id: 'b', name: 'Beta', granted: true, commissionRule: rule(15), holdbackDays: null, commission: null },
    ]);
    expect(rowText(page, 'Beta')).toContain(`Program rule: ${renderCommissionSummary(rule(15) as never)} · no holdback`);
  });

  it("sets a program's terms on its own endpoint, starting from what it pays now", async () => {
    const page = show(PARTNER_WIDE, [
      { id: 'b', name: 'Beta', granted: true, commissionRule: rule(15), holdbackDays: null, commission: null },
    ]);
    fireEvent.click(page.getByText('Set terms'));
    // The partner-wide editor plus this one, which starts from the 10-day
    // holdback Beta gets today rather than blank (= Beta's own, none).
    expect(page.getAllByPlaceholderText('0')).toHaveLength(2);
    const holdback = page.getAllByPlaceholderText('0')[1] as HTMLInputElement;
    expect(holdback.value).toBe('10');
    fireEvent.change(holdback, { target: { value: '21' } });
    fireEvent.click(page.getByText('Save program terms'));

    const isPut = (c: unknown[]) => (c[1] as { method?: string } | undefined)?.method === 'PUT';
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(isPut)).toBe(true));
    const call = vi.mocked(api).mock.calls.find(isPut)!;
    expect(call[0]).toBe('/partners/p1/programs/b/commission');
    expect((call[1] as { body: unknown }).body).toEqual({
      commissionType: 'percent',
      commissionValue: 30,
      recurring: false,
      commissionRules: rule(30), // seeded from the partner-wide default it was paying
      holdbackDays: 21,
    });
  });

  it('saving new program terms untouched keeps the holdback the program already had', async () => {
    const page = show(PARTNER_WIDE, [
      { id: 'b', name: 'Beta', granted: true, commissionRule: rule(15), holdbackDays: 30, commission: null },
    ]);
    fireEvent.click(page.getByText('Set terms'));
    fireEvent.click(page.getByText('Save program terms'));
    const isPut = (c: unknown[]) => (c[1] as { method?: string } | undefined)?.method === 'PUT';
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(isPut)).toBe(true));
    // Partner-wide 10 days, explicitly — not blank, which would mean Beta's 30.
    expect((vi.mocked(api).mock.calls.find(isPut)![1] as { body: { holdbackDays: unknown } }).body.holdbackDays).toBe(10);
  });

  it('clears only the program terms', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const page = show(PARTNER_WIDE, [
      { id: 'a', name: 'Alpha', granted: true, commissionRule: rule(10), holdbackDays: null, commission: scoped('a', 50, null) },
    ]);
    fireEvent.click(page.getByText('Edit terms'));
    fireEvent.click(page.getByText('Clear program terms'));
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith('/partners/p1/programs/a/commission', { method: 'DELETE' }),
    );
    expect(vi.mocked(api)).not.toHaveBeenCalledWith('/partners/p1/commission-snapshot', { method: 'DELETE' });
  });
});

describe('ruleEventTypeMissing (gates Save on the override and both program forms)', () => {
  it('requires an eventType on first/subsequent rules and rejects an empty custom name', () => {
    expect(ruleEventTypeMissing({ trigger: 'first', type: 'fixed', value: 100 })).toBe(true);
    expect(ruleEventTypeMissing({ trigger: 'subsequent', type: 'percent', value: 20 })).toBe(true);
    expect(ruleEventTypeMissing({ trigger: 'first', eventType: '', type: 'fixed', value: 100 })).toBe(true);
    expect(ruleEventTypeMissing({ trigger: 'every', eventType: '', type: 'percent', value: 20 })).toBe(true);
    expect(ruleEventTypeMissing({ trigger: 'first', eventType: 'subscription_created', type: 'fixed', value: 100 })).toBe(false);
    // `every` with no eventType = every event with a value (legacy shape).
    expect(ruleEventTypeMissing({ trigger: 'every', type: 'percent', value: 20 })).toBe(false);
  });
});
