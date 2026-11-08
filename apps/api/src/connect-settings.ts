import type { Knex } from 'knex';
import { getConfig, setConfig } from './config.js';

export const CONNECT_SETTINGS_KEY = 'stripe_connect';

export interface ConnectSettings {
  accountMode: 'standard' | 'custom_payouts';
  collectTaxInformation: boolean;
  requestCardPayments: boolean;
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
  requestCardPayments: false,
  collect1099KTaxInformation: false,
  collectEventuallyDue: true,
  collectFutureRequirements: false,
  productDescription: 'Affiliate marketing and referral commissions.',
};

export async function readConnectSettings(db: Knex, tenantId: string): Promise<ConnectSettings> {
  const value = await getConfig<Partial<ConnectSettings>>(db, tenantId, CONNECT_SETTINGS_KEY);
  return {
    accountMode: value?.accountMode === 'custom_payouts' ? 'custom_payouts' : 'standard',
    collectTaxInformation: value?.collectTaxInformation ?? CONNECT_DEFAULTS.collectTaxInformation,
    requestCardPayments: value?.requestCardPayments ?? CONNECT_DEFAULTS.requestCardPayments,
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
