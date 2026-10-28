/**
 * Tracking alerts: a daily email to the brand's admins when a setup check
 * turns failing (setup-checks.ts) or Tracking health raises a new flag
 * (tracking-flags.ts). On by default; the Config key `tracking_alerts`
 * (`{ "email": false }`) turns it off. A brand setting with no credential
 * in it, so it travels with the export bundle (export.ts
 * PORTABLE_CONFIG_KEYS).
 *
 * A failing check is kept like a flag, as kind `setup_<check>` with the
 * program id (or `account`) as its subject; a check that passes, waits or
 * can't be checked has no open episode. So a check is emailed when it goes
 * from anything else to failing, not every day it stays failing. The first
 * run to check a brand finds no episode for anything, so it emails one list
 * of whatever fails then, and after that only a check that turns failing is
 * news.
 *
 * Each flag or check is emailed once per episode, kept in TrackingAlert:
 *   - a flag with no open episode opens one and goes in the email, unless
 *     the same flag was emailed in the last RENOTIFY_COOLDOWN_DAYS (it went
 *     back under its threshold and returned);
 *   - a flag with an open episode only refreshes lastSeenAt;
 *   - an open episode not seen for RESOLVE_AFTER_DAYS closes, so a flag
 *     that comes back after that is news again.
 * One email per brand per run lists every new check and flag, to each activated,
 * unrevoked admin, each sent on its own. When none of them could be sent,
 * the run closes the episodes it opened without marking them sent, so the
 * next run opens and emails them again. When some were, the admins whose
 * send failed aren't retried (the flags stay on the page).
 *
 * Runs per active tenant in a tenant-scoped transaction (scheduler.ts,
 * daily), in every deployment mode: the flags read the brand's own raw
 * tables, and the checks those plus a fresh fetch of each destination and
 * a Stripe read. A brand with no admin to tell is skipped and keeps no
 * episodes, so its first admin hears about whatever is open then.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type TenantRow, type TrackingAlertRow } from '@openpartner/db';
import { getConfig, setConfig } from './config.js';
import { computeTrackingFlags, describeFlag } from './tracking-flags.js';
import { computeSetupChecks, describeSetupCheck, type SetupCheck } from './setup-checks.js';
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
  | {
      /** Setup checks failing on this run. */
      failingChecks: number;
      flags: number;
      opened: number;
      notified: number;
      resolved: number;
      emailed: boolean;
      /** Admins whose send failed this run, with the last error. */
      failedRecipients?: number;
      sendError?: string;
    };

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
  // The checks read the outside world. If they can't be computed, the
  // flags still go out, and no check episode opens or closes this run.
  let checks: SetupCheck[] | null = null;
  try {
    // A savepoint: a failed statement must not abort the sweep's transaction.
    checks = (await db.transaction((sp) => computeSetupChecks(sp, tenantId, { now, refresh: true }))).checks;
  } catch (err) {
    console.error('[tracking-alerts] setup checks failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
  }
  const failing = (checks ?? []).filter((c) => c.status === 'fail');

  const alerts: Alert[] = [
    ...failing.map((c) => ({ kind: `setup_${c.id}`, subject: c.subject, detail: c, line: describeSetupCheck(c), check: true })),
    ...flags.map((f) => ({ kind: f.kind, subject: f.subject, detail: f, line: describeFlag(f), check: false })),
  ];
  const open = await db<TrackingAlertRow>(TABLES.TrackingAlert).where({ tenantId }).whereNull('resolvedAt');
  const openBy = new Map(open.map((r) => [`${r.kind}|${r.subject}`, r]));
  const cooldownSince = new Date(now.getTime() - RENOTIFY_COOLDOWN_DAYS * DAY);

  let opened = 0;
  const fresh: Array<{ id: string; alert: Alert }> = [];
  for (const alert of alerts) {
    const row = openBy.get(`${alert.kind}|${alert.subject}`);
    if (row) {
      await db(TABLES.TrackingAlert).where({ id: row.id, tenantId }).update({ lastSeenAt: now, detail: alert.detail });
      continue;
    }
    const recentlySent = await db(TABLES.TrackingAlert)
      .where({ tenantId, kind: alert.kind, subject: alert.subject })
      .where('notifiedAt', '>', cooldownSince)
      .first('id');
    const id = ulid();
    // The partial unique index allows one open episode per flag or check:
    // a second run racing this one opens nothing.
    const { rows } = await db.raw<{ rows: Array<{ id: string }> }>(
      `insert into ?? (id, "tenantId", kind, subject, "openedAt", "lastSeenAt", "notifiedAt", detail)
       values (?, ?, ?, ?, ?, ?, ?, ?::jsonb)
       on conflict ("tenantId", kind, subject) where "resolvedAt" is null do nothing
       returning id`,
      [TABLES.TrackingAlert, id, tenantId, alert.kind, alert.subject, now, now, recentlySent ? null : now, JSON.stringify(alert.detail)],
    );
    if (rows.length === 0) continue;
    opened += 1;
    if (!recentlySent) fresh.push({ id, alert });
  }

  const resolved = await db(TABLES.TrackingAlert)
    .where({ tenantId })
    .whereNull('resolvedAt')
    .where('lastSeenAt', '<', new Date(now.getTime() - RESOLVE_AFTER_DAYS * DAY))
    .modify((q) => {
      if (!checks) q.whereNot('kind', 'like', 'setup_%');
    })
    .update({ resolvedAt: now });

  let emailed = false;
  let failedRecipients = 0;
  let sendError: string | undefined;
  if (fresh.length > 0) {
    const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first('slug', 'customDomain');
    const tmpl = trackingFlagsEmail(
      await resolveBrandName(db, tenantId),
      {
        checks: fresh.filter((f) => f.alert.check).map((f) => f.alert.line),
        flags: fresh.filter((f) => !f.alert.check).map((f) => f.alert.line),
      },
      `${getPortalBaseUrl(tenant)}/admin/tracking-health`,
    );
    // Each admin on their own: one address that bounces mustn't keep the
    // others from hearing.
    for (const admin of admins) {
      try {
        await getMailer().send(
          { db, tenantId },
          {
            to: admin.email,
            subject: tmpl.subject,
            text: tmpl.text,
            html: tmpl.html,
            tag: 'tracking_flags',
            // Postmark takes short string values only.
            metadata: {
              purpose: 'tracking_flags',
              flagCount: String(fresh.filter((f) => !f.alert.check).length),
              checkCount: String(fresh.filter((f) => f.alert.check).length),
            },
          },
        );
        emailed = true;
      } catch (err) {
        failedRecipients += 1;
        sendError = err instanceof Error ? err.message : String(err);
        console.error('[tracking-alerts] send failed', { tenantId, error: sendError });
      }
    }
    // Nobody got it: close these episodes unsent, so the next run reopens
    // and emails them. When some admins did, the rest aren't retried, so
    // those who got it don't get it twice; the flags stay on the page.
    if (!emailed) {
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
    failingChecks: failing.length,
    flags: flags.length,
    opened,
    notified: emailed ? fresh.length : 0,
    resolved,
    emailed,
    ...(failedRecipients ? { failedRecipients, sendError } : {}),
  };
}

interface Alert {
  /** A flag's kind, or `setup_<check>`. */
  kind: string;
  subject: string;
  /** Kept on the episode: the flag or the check, as last seen. */
  detail: object;
  /** Its line in the email. */
  line: string;
  check: boolean;
}

