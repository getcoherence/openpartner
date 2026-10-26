/**
 * Tracking alerts: a daily email to the brand's admins when Tracking health
 * raises a new flag (tracking-flags.ts). On by default; the Config key
 * `tracking_alerts` (`{ "email": false }`) turns it off. A brand setting
 * with no credential in it, so it travels with the export bundle
 * (export.ts PORTABLE_CONFIG_KEYS).
 *
 * Each flag is emailed once per episode, kept in TrackingAlert:
 *   - a flag with no open episode opens one and goes in the email, unless
 *     the same flag was emailed in the last RENOTIFY_COOLDOWN_DAYS (it went
 *     back under its threshold and returned);
 *   - a flag with an open episode only refreshes lastSeenAt;
 *   - an open episode not seen for RESOLVE_AFTER_DAYS closes, so a flag
 *     that comes back after that is news again.
 * One email per brand per run lists every new flag, to each activated,
 * unrevoked admin. A send that fails closes the episodes it opened without
 * marking them sent, so the next run opens and emails them again.
 *
 * Runs per active tenant in a tenant-scoped transaction (scheduler.ts,
 * daily), in every deployment mode: the flags read the brand's own raw
 * tables. A brand with no admin to tell is skipped and keeps no episodes,
 * so its first admin hears about whatever is open then.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type TenantRow, type TrackingAlertRow } from '@openpartner/db';
import { getConfig, setConfig } from './config.js';
import { computeTrackingFlags, describeFlag, type TrackingFlag } from './tracking-flags.js';
import { getMailer } from './mailer.js';
import { trackingFlagsEmail } from './email-templates.js';
import { resolveBrandName } from './brand-name.js';
import { getPortalBaseUrl } from './portal-url.js';

export const TRACKING_ALERTS_CONFIG_KEY = 'tracking_alerts';

/** A flag emailed this recently isn't emailed again when it reopens. */
export const RENOTIFY_COOLDOWN_DAYS = 7;
/** An open episode not seen for this long closes. */
export const RESOLVE_AFTER_DAYS = 3;

const DAY = 86_400_000;

export interface TrackingAlertSettings {
  /** Email admins when a new flag appears. */
  email: boolean;
}

export async function readTrackingAlertSettings(db: Knex, tenantId: string): Promise<TrackingAlertSettings> {
  const value = await getConfig<Partial<TrackingAlertSettings>>(db, tenantId, TRACKING_ALERTS_CONFIG_KEY);
  return { email: value?.email !== false };
}

export async function saveTrackingAlertSettings(
  db: Knex,
  tenantId: string,
  patch: Partial<TrackingAlertSettings>,
): Promise<TrackingAlertSettings> {
  const current = await readTrackingAlertSettings(db, tenantId);
  const next: TrackingAlertSettings = { email: patch.email ?? current.email };
  await setConfig(db, tenantId, TRACKING_ALERTS_CONFIG_KEY, next);
  return next;
}

export type TrackingAlertSweep =
  | { skipped: 'disabled' | 'no_admins' }
  | { flags: number; opened: number; notified: number; resolved: number; emailed: boolean; sendError?: string };

export async function sweepTenantTrackingAlerts(
  db: Knex,
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<TrackingAlertSweep> {
  if (!(await readTrackingAlertSettings(db, tenantId)).email) return { skipped: 'disabled' };
  const admins = await db<AdminRow>(TABLES.Admin)
    .where({ tenantId })
    .whereNotNull('activatedAt')
    .whereNull('revokedAt')
    .orderBy('activatedAt', 'asc')
    .select('email');
  if (admins.length === 0) return { skipped: 'no_admins' };

  const now = opts.now ?? new Date();
  const { flags } = await computeTrackingFlags(db, tenantId, { now });
  const open = await db<TrackingAlertRow>(TABLES.TrackingAlert).where({ tenantId }).whereNull('resolvedAt');
  const openBy = new Map(open.map((r) => [`${r.kind}|${r.subject}`, r]));
  const cooldownSince = new Date(now.getTime() - RENOTIFY_COOLDOWN_DAYS * DAY);

  let opened = 0;
  const fresh: Array<{ id: string; flag: TrackingFlag }> = [];
  for (const flag of flags) {
    const row = openBy.get(`${flag.kind}|${flag.subject}`);
    if (row) {
      await db(TABLES.TrackingAlert).where({ id: row.id, tenantId }).update({ lastSeenAt: now, detail: flag });
      continue;
    }
    const recentlySent = await db(TABLES.TrackingAlert)
      .where({ tenantId, kind: flag.kind, subject: flag.subject })
      .where('notifiedAt', '>', cooldownSince)
      .first('id');
    const id = ulid();
    // The partial unique index allows one open episode per flag: a second
    // run racing this one opens nothing.
    const { rows } = await db.raw<{ rows: Array<{ id: string }> }>(
      `insert into ?? (id, "tenantId", kind, subject, "openedAt", "lastSeenAt", "notifiedAt", detail)
       values (?, ?, ?, ?, ?, ?, ?, ?::jsonb)
       on conflict ("tenantId", kind, subject) where "resolvedAt" is null do nothing
       returning id`,
      [TABLES.TrackingAlert, id, tenantId, flag.kind, flag.subject, now, now, recentlySent ? null : now, JSON.stringify(flag)],
    );
    if (rows.length === 0) continue;
    opened += 1;
    if (!recentlySent) fresh.push({ id, flag });
  }

  const resolved = await db(TABLES.TrackingAlert)
    .where({ tenantId })
    .whereNull('resolvedAt')
    .where('lastSeenAt', '<', new Date(now.getTime() - RESOLVE_AFTER_DAYS * DAY))
    .update({ resolvedAt: now });

  let emailed = false;
  let sendError: string | undefined;
  if (fresh.length > 0) {
    try {
      const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first('slug', 'customDomain');
      const tmpl = trackingFlagsEmail(
        await resolveBrandName(db, tenantId),
        fresh.map((f) => describeFlag(f.flag)),
        `${getPortalBaseUrl(tenant)}/admin/tracking-health`,
      );
      for (const admin of admins) {
        await getMailer().send(
          { db, tenantId },
          {
            to: admin.email,
            subject: tmpl.subject,
            text: tmpl.text,
            html: tmpl.html,
            tag: 'tracking_flags',
            metadata: { flags: fresh.map((f) => `${f.flag.kind}:${f.flag.subject}`) },
          },
        );
      }
      emailed = true;
    } catch (err) {
      // Close these episodes unsent: the next run reopens and emails them.
      // An admin earlier in the list may get that email twice, which beats
      // the rest never getting it.
      sendError = err instanceof Error ? err.message : String(err);
      console.error('[tracking-alerts] send failed', { tenantId, error: sendError });
      await db(TABLES.TrackingAlert)
        .where({ tenantId })
        .whereIn(
          'id',
          fresh.map((f) => f.id),
        )
        .update({ notifiedAt: null, resolvedAt: now });
    }
  }

  return {
    flags: flags.length,
    opened,
    notified: emailed ? fresh.length : 0,
    resolved,
    emailed,
    ...(sendError ? { sendError } : {}),
  };
}
