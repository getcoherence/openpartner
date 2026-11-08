import type { Knex } from 'knex';
import { getConfig, setConfig } from './config.js';
import { getMode } from './stripe.js';

export const CONNECT_SETTINGS_KEY = 'stripe_connect';

export interface ConnectSettings {
  accountMode: 'standard' | 'custom_payouts';
  collectTaxInformation: boolean;
  collect1099KTaxInformation: boolean;
  collectEventuallyDue: boolean;
  collectFutureRequirements: boolean;
  productDescription: string;
}

// An absent setting must preserve the original Standard-account integration.
// The remaining defaults apply only when Custom payout accounts are selected.
export const CONNECT_DEFAULTS: ConnectSettings = {
  accountMode: 'standard',
  collectTaxInformation: true,
  collect1099KTaxInformation: false,
  collectEventuallyDue: true,
  collectFutureRequirements: false,
  productDescription: 'Affiliate marketing and referral commissions.',
};

// Whoever owns STRIPE_SECRET_KEY carries a Custom account's negative
// balances, fees and verification duties. Self-hosted, that's the operator
// choosing for themselves. Hosted, it would be OpenPartner on every
// tenant's behalf, so hosted stays on Standard (CLAUDE.md principle #4).
export function customAccountsAvailable(): boolean {
  return getMode() === 'selfhost';
}

export async function readConnectSettings(db: Knex, tenantId: string): Promise<ConnectSettings> {
  const value = await getConfig<Partial<ConnectSettings>>(db, tenantId, CONNECT_SETTINGS_KEY);
  return {
    // A Custom setting imported into a hosted instance reads as Standard.
    accountMode: value?.accountMode === 'custom_payouts' && customAccountsAvailable() ? 'custom_payouts' : 'standard',
    collectTaxInformation: value?.collectTaxInformation ?? CONNECT_DEFAULTS.collectTaxInformation,
    collect1099KTaxInformation: value?.collect1099KTaxInformation ?? CONNECT_DEFAULTS.collect1099KTaxInformation,
    collectEventuallyDue: value?.collectEventuallyDue ?? CONNECT_DEFAULTS.collectEventuallyDue,
    collectFutureRequirements: value?.collectFutureRequirements ?? CONNECT_DEFAULTS.collectFutureRequirements,
    productDescription: value?.productDescription ?? CONNECT_DEFAULTS.productDescription,
  };
}

export async function saveConnectSettings(db: Knex, tenantId: string, patch: Partial<ConnectSettings>): Promise<ConnectSettings> {
  const next = { ...await readConnectSettings(db, tenantId), ...patch };
  await setConfig(db, tenantId, CONNECT_SETTINGS_KEY, next);
  return next;
}
