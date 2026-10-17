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
