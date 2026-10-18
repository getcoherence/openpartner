/**
 * Operator runtime switches for the hosted platform (PlatformSetting table).
 *
 * Env is reserved for secrets and deploy-time properties; anything an
 * operator should be able to flip without a redeploy lives here and is
 * edited from the /platform ops console. Platform-scoped — read and written
 * only through the privileged `db` pool.
 */

import type { Knex } from 'knex';
import { TABLES, type PlatformSettingRow } from '@openpartner/db';

export interface NotificationSettings {
  /** Daily sweep emailing brand admins whose setup is incomplete. */
  brandSetupReminders: boolean;
  /** Daily trigger of the Network's creator profile-completion reminders. */
  creatorProfileReminders: boolean;
}

/** Off until an operator turns them on — both sweeps email real people,
 *  so the first run should be a deliberate act after a preview. */
const NOTIFICATION_DEFAULTS: NotificationSettings = {
  brandSetupReminders: false,
  creatorProfileReminders: false,
};

const NOTIFICATIONS_KEY = 'notifications';

export async function getNotificationSettings(db: Knex): Promise<NotificationSettings> {
  const row = await db<PlatformSettingRow>(TABLES.PlatformSetting).where({ key: NOTIFICATIONS_KEY }).first();
  const v = (row?.value ?? {}) as Partial<NotificationSettings>;
  return {
    brandSetupReminders: typeof v.brandSetupReminders === 'boolean' ? v.brandSetupReminders : NOTIFICATION_DEFAULTS.brandSetupReminders,
    creatorProfileReminders:
      typeof v.creatorProfileReminders === 'boolean' ? v.creatorProfileReminders : NOTIFICATION_DEFAULTS.creatorProfileReminders,
  };
}

export async function setNotificationSettings(
  db: Knex,
  patch: Partial<NotificationSettings>,
  operatorEmail: string,
): Promise<NotificationSettings> {
  const next = { ...(await getNotificationSettings(db)), ...patch };
  await db(TABLES.PlatformSetting)
    .insert({ key: NOTIFICATIONS_KEY, value: next as unknown as never, updatedByEmail: operatorEmail, updatedAt: new Date() })
    .onConflict('key')
    .merge({ value: next as unknown as never, updatedByEmail: operatorEmail, updatedAt: new Date() });
  return next;
}

/** The commission-floor platform fee's rates, as fractions (0.03 = 3%). */
export interface FeeRates {
  /** Share of partner-attributed revenue. */
  revenueRate: number;
  /** Floor: share of the commissions partners earned. */
  commissionRate: number;
}

/**
 * The commission-floor platform fee (docs/platform-fee.md). Nothing here
 * changes what anyone is billed until an operator sets `cutoverAt`, and
 * then only for plans started after it; tenants with an older plan move
 * when their pricing-change notice runs out (fee-notice.ts).
 */
export interface FeeRuleSettings {
  /** Record, on every usage report of a tenant still on the old rule,
   *  what the new rule would have billed (UsageFeeShadow). */
  shadow: boolean;
  /** ISO time. A paid plan that starts at or after it is on the new rule
   *  from day one. Null: no cutover yet, nobody is moved automatically. */
  cutoverAt: string | null;
  /** Keyed by billing mode: `flat` is the Flex plan, `revshare` Revshare. */
  rates: { flat: FeeRates; revshare: FeeRates };
}

/**
 * Recommended defaults. Commission rate = revenue rate × 10/3 on both
 * plans, so a program paying up to 30% commission on honest revenue pays
 * exactly the advertised revenue rate; the floor only bites when revenue
 * is missing, understated, or paid as fixed bounties.
 */
export const FEE_RULE_DEFAULTS: FeeRuleSettings = {
  shadow: false,
  cutoverAt: null,
  rates: {
    flat: { revenueRate: 0.015, commissionRate: 0.05 },
    revshare: { revenueRate: 0.03, commissionRate: 0.1 },
  },
};

const FEE_RULE_KEY = 'feeRule';

function rate(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}

function rates(v: unknown, fallback: FeeRates): FeeRates {
  const r = (v ?? {}) as Partial<FeeRates>;
  return { revenueRate: rate(r.revenueRate, fallback.revenueRate), commissionRate: rate(r.commissionRate, fallback.commissionRate) };
}

export async function getFeeRuleSettings(db: Knex): Promise<FeeRuleSettings> {
  const row = await db<PlatformSettingRow>(TABLES.PlatformSetting).where({ key: FEE_RULE_KEY }).first();
  const v = (row?.value ?? {}) as Partial<FeeRuleSettings>;
  const cutover = typeof v.cutoverAt === 'string' && !Number.isNaN(Date.parse(v.cutoverAt)) ? new Date(v.cutoverAt).toISOString() : null;
  return {
    shadow: typeof v.shadow === 'boolean' ? v.shadow : FEE_RULE_DEFAULTS.shadow,
    cutoverAt: cutover,
    rates: {
      flat: rates(v.rates?.flat, FEE_RULE_DEFAULTS.rates.flat),
      revshare: rates(v.rates?.revshare, FEE_RULE_DEFAULTS.rates.revshare),
    },
  };
}

export async function setFeeRuleSettings(
  db: Knex,
  patch: { shadow?: boolean; cutoverAt?: string | null; rates?: { flat?: Partial<FeeRates>; revshare?: Partial<FeeRates> } },
  operatorEmail: string,
): Promise<FeeRuleSettings> {
  const current = await getFeeRuleSettings(db);
  const next: FeeRuleSettings = {
    shadow: patch.shadow ?? current.shadow,
    cutoverAt: patch.cutoverAt === undefined ? current.cutoverAt : patch.cutoverAt === null ? null : new Date(patch.cutoverAt).toISOString(),
    rates: {
      flat: { ...current.rates.flat, ...patch.rates?.flat },
      revshare: { ...current.rates.revshare, ...patch.rates?.revshare },
    },
  };
  await db(TABLES.PlatformSetting)
    .insert({ key: FEE_RULE_KEY, value: next as unknown as never, updatedByEmail: operatorEmail, updatedAt: new Date() })
    .onConflict('key')
    .merge({ value: next as unknown as never, updatedByEmail: operatorEmail, updatedAt: new Date() });
  return next;
}
