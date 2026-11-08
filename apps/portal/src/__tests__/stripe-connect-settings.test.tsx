// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StripeConnectSettingsSection } from '../pages/admin/StripeConnectSettingsSection.js';

const defaults = {
  accountMode: 'standard', collectTaxInformation: true, collectEventuallyDue: true,
  collect1099KTaxInformation: false, collectFutureRequirements: false,
  productDescription: 'Affiliate marketing and referral commissions.',
};
let stored = { ...defaults };
let posts: unknown[];
let failSave: boolean;
beforeEach(() => {
  stored = { ...defaults };
  posts = [];
  failSave = false;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (failSave) return new Response(JSON.stringify({ error: 'save_failed' }), { status: 500 });
      stored = JSON.parse(String(init.body));
    }
    return new Response(JSON.stringify({ ...stored, customAccountsAvailable: true }), { status: 200 });
  }) as typeof fetch;
});
afterEach(cleanup);
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><StripeConnectSettingsSection /></QueryClientProvider>);
}

describe('Stripe Connect settings', () => {
  it('clears the save confirmation after two seconds like other settings', async () => {
    const page = mount();
    fireEvent.change(await page.findByLabelText('Accounts for new partners'), { target: { value: 'custom_payouts' } });
    fireEvent.click(page.getByRole('button', { name: 'Save Stripe settings' }));
    expect((await page.findByRole('status')).textContent).toBe('Saved.');
    await waitFor(() => expect(page.queryByRole('status')).toBeNull(), { timeout: 3500 });
    expect(stored.accountMode).toBe('custom_payouts');
  });

  it('defaults to Standard, saves Custom options explicitly, and persists across remount', async () => {
    const page = mount();
    const select = await page.findByLabelText('Accounts for new partners') as HTMLSelectElement;
    expect(select.value).toBe('standard');
    expect(page.queryByRole('checkbox')).toBeNull();
    expect(page.getByRole('link', { name: 'Stripe account capabilities' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'custom_payouts' } });
    expect(posts).toEqual([]);
    expect(page.queryByRole('checkbox', { name: /card payments/i })).toBeNull();
    fireEvent.click(page.getByRole('checkbox', { name: /Collect US 1099-MISC/ }));
    fireEvent.click(page.getByRole('checkbox', { name: /Collect all known verification/ }));
    fireEvent.click(page.getByRole('checkbox', { name: /Collect US 1099-K/ }));
    fireEvent.click(page.getByRole('checkbox', { name: /Include upcoming verification changes/ }));
    expect((page.getByRole('checkbox', { name: /Receive transfers/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(page.getByLabelText('Affiliate activity description'), { target: { value: 'Referral services.' } });
    fireEvent.click(page.getByRole('button', { name: 'Save Stripe settings' }));
    await page.findByRole('status');
    expect(posts).toEqual([{ accountMode: 'custom_payouts', collectTaxInformation: false, collectEventuallyDue: false,
      collect1099KTaxInformation: true, collectFutureRequirements: true,
      productDescription: 'Referral services.' }]);
    page.unmount();
    const reloaded = mount();
    expect((await reloaded.findByLabelText('Accounts for new partners') as HTMLSelectElement).value).toBe('custom_payouts');
    for (const name of [/Collect US 1099-K/, /Include upcoming verification changes/]) {
      expect((reloaded.getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(true);
    }
    fireEvent.change(reloaded.getByLabelText('Accounts for new partners'), { target: { value: 'standard' } });
    fireEvent.click(reloaded.getByRole('button', { name: 'Save Stripe settings' }));
    await reloaded.findByRole('status');
    expect(stored.accountMode).toBe('standard');
  });

  it('keeps unsaved changes on a save error and allows a retry', async () => {
    const page = mount();
    const select = await page.findByLabelText('Accounts for new partners');
    fireEvent.change(select, { target: { value: 'custom_payouts' } });
    failSave = true;
    fireEvent.click(page.getByRole('button', { name: 'Save Stripe settings' }));
    await waitFor(() => expect(page.getByRole('button', { name: 'Save Stripe settings' }).hasAttribute('disabled')).toBe(false));
    expect(page.queryByRole('status')).toBeNull();
    expect(stored.accountMode).toBe('standard');
    expect((select as HTMLSelectElement).value).toBe('custom_payouts');
    failSave = false;
    fireEvent.click(page.getByRole('button', { name: 'Save Stripe settings' }));
    await page.findByRole('status');
    expect(stored.accountMode).toBe('custom_payouts');
  });
});
