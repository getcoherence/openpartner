// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AdminPartnerCoupons } from '../pages/AdminPartnerCoupons.js';
afterEach(cleanup);
function show(canEdit: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['partner', 'p1'], { id: 'p1', name: 'Partner' });
  client.setQueryData(['partner-coupons', 'p1'], { coupons: [{ id: 'c1', code: 'MYCODE', programId: 'pr1', canEdit }] });
  client.setQueryData(['me-campaigns'], { programs: [{ id: 'pr1', name: 'Brand', partnersMayCustomizeCode: canEdit }] });
  return render(<MemoryRouter><QueryClientProvider client={client}><AdminPartnerCoupons ownPartnerId="p1" /></QueryClientProvider></MemoryRouter>);
}
describe('local partner coupon page', () => {
  it('offers another code for an editable assigned program while preserving existing codes', () => {
    const page = show(true);
    expect(page.getByText('MYCODE')).toBeTruthy();
    expect(page.getByText('Deactivate')).toBeTruthy();
    const program = page.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(program, { target: { value: 'pr1' } });
    expect((page.getByText('Mint coupon') as HTMLButtonElement).disabled).toBe(false);
  });
  it('keeps brand-managed codes visible without edit controls', () => {
    const page = show(false);
    expect(page.getByText('MYCODE')).toBeTruthy();
    expect(page.getByText('Managed by brand')).toBeTruthy();
    expect(page.queryByText('Deactivate')).toBeNull();
    expect(page.queryByText('Mint coupon')).toBeNull();
  });
});
