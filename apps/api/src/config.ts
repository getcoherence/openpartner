import { TABLES, type ConfigRow } from '@openpartner/db';
import { db } from './db.js';

export async function getConfig<T>(key: string): Promise<T | null> {
  const row = await db<ConfigRow>(TABLES.Config).where({ key }).first();
  return row ? (row.value as T) : null;
}

export async function setConfig<T>(key: string, value: T): Promise<void> {
  await db<ConfigRow>(TABLES.Config)
    .insert({ key, value: value as unknown as object, updatedAt: new Date() })
    .onConflict('key')
    .merge({ value: value as unknown as object, updatedAt: new Date() });
}

// Known config keys — centralized so we don't stringly-type across the codebase.
export const CONFIG_KEYS = {
  StripeMerchantCustomerId: 'stripe.merchant.customerId',
  StripeMerchantSubscriptionId: 'stripe.merchant.subscriptionId',
} as const;
