import { TABLES, type ConfigRow } from '@openpartner/db';
import { db } from './db.js';

export async function getConfig<T>(key: string): Promise<T | null> {
  const row = await db<ConfigRow>(TABLES.Config).where({ key }).first();
  return row ? (row.value as T) : null;
}

export async function setConfig<T>(key: string, value: T): Promise<void> {
  // Config.value is jsonb. Knex/pg auto-serialize objects, but a plain
  // primitive (string, number, boolean) is sent as raw text and rejected
  // because "foo" is not valid JSON without quotes. Stringify + cast so
  // every value type round-trips correctly.
  const json = JSON.stringify(value);
  const jsonbValue = db.raw('?::jsonb', [json]);
  await db<ConfigRow>(TABLES.Config)
    .insert({ key, value: jsonbValue as unknown as object, updatedAt: new Date() })
    .onConflict('key')
    .merge({ value: jsonbValue as unknown as object, updatedAt: new Date() });
}

// Known config keys — centralized so we don't stringly-type across the codebase.
export const CONFIG_KEYS = {
  StripeMerchantCustomerId: 'stripe.merchant.customerId',
  StripeMerchantSubscriptionId: 'stripe.merchant.subscriptionId',
  // High-water mark for usage reporting. Stored as ISO string. The next
  // run aggregates Events with ts > this value, then advances the mark.
  LastUsageReportedAt: 'stripe.merchant.lastUsageReportedAt',
} as const;
