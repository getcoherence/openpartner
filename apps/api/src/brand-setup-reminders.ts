/**
 * Setup reminders to brand admins (hosted multi-tenant only).
 *
 * Most brands sign up, poke around, and stop before they can earn anything:
 * no program, no marketplace listing, no tracking. This sweep emails the
 * primary admin of each such brand a short, specific "here's what's left"
 * — at most three times, spaced out, and never once setup is complete or
 * they've unsubscribed.
 *
 *   step 1 — 2 days after signup
 *   step 2 — 4 days after step 1
 *   step 3 — 7 days after step 2 (the last one)
 *
 * Who: status='active' brands that are pending or approved (rejected
 * brands are suspended and excluded), with an admin who has proven the
 * address by signing in (Admin.activatedAt). Pending brands are included —
 * they can configure everything while they wait, so they're ready the day
 * they're approved; the email says so.
 *
 * Exactly-once: each send first INSERTs its BrandNotification row (unique
 * per tenant + step) and only the run that wins the insert sends. A failed
 * send deletes its claim so the next run retries it.
 *
 * Sent in the platform voice via the platform transport (DEFAULT_TENANT_ID
 * context + Message.platform) — this is OpenPartner talking to its
 * customer, not a brand talking to its partners.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  DEFAULT_TENANT_ID,
  TABLES,
  type AdminRow,
  type BrandNotificationRow,
  type TenantRow,
} from '@openpartner/db';
import { getMailer } from './mailer.js';
import { brandSetupReminderEmail } from './email-templates.js';
import { brandSetupFor } from './brand-setup.js';
import { isOptedOut, unsubscribeUrl } from './email-optout.js';
import { getPortalBaseUrl } from './portal-url.js';
import { resolveBrandName } from './brand-name.js';

const KIND = 'setup_incomplete';
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_SETUP_REMINDERS = 3;
/** Days to wait before step n: step 1 counts from signup, later steps from
 *  the previous reminder. */
const GAP_DAYS = [2, 4, 7] as const;

interface Candidate {
  tenantId: string;
  slug: string;
  customDomain: string | null;
  approvalStatus: TenantRow['approvalStatus'];
  createdAt: Date;
  adminEmail: string;
  adminName: string | null;
  sentCount: number;
  lastSentAt: Date | null;
}

export interface BrandReminderPreview {
  tenantId: string;
  slug: string;
  email: string;
  step: number;
  missing: string[];
}

export interface BrandReminderRunResult {
  dryRun: boolean;
  eligible: BrandReminderPreview[];
  sent: number;
  failed: number;
}

/** Live brands with a signed-in admin, annotated with reminder history. */
async function loadCandidates(db: Knex, tenantIds?: string[]): Promise<Candidate[]> {
  let q = db<TenantRow>(TABLES.Tenant)
    .where({ status: 'active' })
    .whereIn('approvalStatus', ['pending', 'approved'])
    .whereNot({ id: DEFAULT_TENANT_ID })
    .whereNull('pendingDeletionAt');
  if (tenantIds) q = q.whereIn('id', tenantIds);
  const tenants = (await q.select('id', 'slug', 'customDomain', 'approvalStatus', 'createdAt')) as Array<
    Pick<TenantRow, 'id' | 'slug' | 'customDomain' | 'approvalStatus' | 'createdAt'>
  >;
  if (tenants.length === 0) return [];
  const ids = tenants.map((t) => t.id);

  // Primary admin = the oldest one who has actually signed in.
  const admins = (await db<AdminRow>(TABLES.Admin)
    .whereIn('tenantId', ids)
    .whereNull('revokedAt')
    .whereNotNull('activatedAt')
    .orderBy('activatedAt', 'asc')
    .select('tenantId', 'email', 'name')) as Array<Pick<AdminRow, 'tenantId' | 'email' | 'name'>>;
  const adminBy = new Map<string, { email: string; name: string | null }>();
  for (const a of admins) if (!adminBy.has(a.tenantId)) adminBy.set(a.tenantId, { email: a.email, name: a.name });

  const history = (await db<BrandNotificationRow>(TABLES.BrandNotification)
    .whereIn('tenantId', ids)
    .andWhere({ kind: KIND })
    .groupBy('tenantId')
    .select('tenantId')
    .count({ sent: '*' })
    .max({ last: 'sentAt' })) as Array<{ tenantId: string; sent: string | number; last: Date | null }>;
  const historyBy = new Map(history.map((h) => [h.tenantId, h]));

  const out: Candidate[] = [];
  for (const t of tenants) {
    const admin = adminBy.get(t.id);
    if (!admin) continue;
    const h = historyBy.get(t.id);
    out.push({
      tenantId: t.id,
      slug: t.slug,
      customDomain: t.customDomain,
      approvalStatus: t.approvalStatus,
      createdAt: new Date(t.createdAt),
      adminEmail: admin.email,
      adminName: admin.name,
      sentCount: Number(h?.sent ?? 0),
      lastSentAt: h?.last ? new Date(h.last) : null,
    });
  }
  return out;
}

function isDue(c: Candidate, now: Date): boolean {
  if (c.sentCount >= MAX_SETUP_REMINDERS) return false;
  const since = c.sentCount === 0 ? c.createdAt : c.lastSentAt;
  if (!since) return false;
  return now.getTime() - since.getTime() >= GAP_DAYS[c.sentCount]! * DAY_MS;
}

export async function runBrandSetupReminders(
  db: Knex,
  opts: {
    dryRun?: boolean;
    now?: Date;
    limit?: number;
    /** Restrict the sweep to these brands (tests, targeted re-runs). */
    tenantIds?: string[];
  } = {},
): Promise<BrandReminderRunResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const limit = opts.limit ?? 200;

  const due: Candidate[] = [];
  for (const c of await loadCandidates(db, opts.tenantIds)) {
    if (!isDue(c, now)) continue;
    if (await isOptedOut(db, c.adminEmail, 'brand_setup')) continue;
    due.push(c);
  }
  const setups = await brandSetupFor(db, due.map((c) => c.tenantId));
  const eligible = due
    .filter((c) => setups.get(c.tenantId) && !setups.get(c.tenantId)!.complete)
    .slice(0, limit);

  const result: BrandReminderRunResult = {
    dryRun,
    eligible: eligible.map((c) => ({
      tenantId: c.tenantId,
      slug: c.slug,
      email: c.adminEmail,
      step: c.sentCount + 1,
      missing: setups.get(c.tenantId)!.missing,
    })),
    sent: 0,
    failed: 0,
  };
  if (dryRun) return result;

  for (const c of eligible) {
    const ok = await claimAndSend(db, c, setups.get(c.tenantId)!.missing, null, now);
    if (ok === 'sent') result.sent += 1;
    else if (ok === 'failed') result.failed += 1;
  }
  return result;
}

export type RemindBrandResult =
  | { ok: true; step: number; to: string }
  | {
      ok: false;
      error: 'brand_not_found' | 'not_eligible' | 'no_signed_in_admin' | 'opted_out' | 'setup_complete' | 'max_reminders_sent' | 'send_failed';
    };

/** Operator "send the next reminder now" — skips the timing gaps, keeps every
 *  other rule (eligibility, opt-out, the three-reminder cap). */
export async function remindBrandNow(db: Knex, tenantId: string, operatorEmail: string): Promise<RemindBrandResult> {
  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first('id');
  if (!tenant) return { ok: false, error: 'brand_not_found' };
  const [c] = await loadCandidates(db, [tenantId]);
  if (!c) {
    const anyAdmin = await db<AdminRow>(TABLES.Admin)
      .where({ tenantId })
      .whereNull('revokedAt')
      .whereNotNull('activatedAt')
      .first('id');
    return { ok: false, error: anyAdmin ? 'not_eligible' : 'no_signed_in_admin' };
  }
  if (c.sentCount >= MAX_SETUP_REMINDERS) return { ok: false, error: 'max_reminders_sent' };
  if (await isOptedOut(db, c.adminEmail, 'brand_setup')) return { ok: false, error: 'opted_out' };
  const setup = (await brandSetupFor(db, [tenantId])).get(tenantId);
  if (!setup || setup.complete) return { ok: false, error: 'setup_complete' };
  const outcome = await claimAndSend(db, c, setup.missing, operatorEmail, new Date());
  if (outcome === 'sent') return { ok: true, step: c.sentCount + 1, to: c.adminEmail };
  // 'raced': a concurrent sweep sent this step a moment ago — same outcome
  // for the brand, so report it as sent.
  if (outcome === 'raced') return { ok: true, step: c.sentCount + 1, to: c.adminEmail };
  return { ok: false, error: 'send_failed' };
}

async function claimAndSend(
  db: Knex,
  c: Candidate,
  missing: string[],
  operatorEmail: string | null,
  now: Date,
): Promise<'sent' | 'raced' | 'failed'> {
  const step = c.sentCount + 1;
  const id = ulid();
  const claimed = await db(TABLES.BrandNotification)
    .insert({
      id,
      tenantId: c.tenantId,
      kind: KIND,
      step,
      recipientEmail: c.adminEmail,
      sentByEmail: operatorEmail,
      sentAt: now,
    })
    .onConflict(['tenantId', 'kind', 'step'])
    .ignore()
    .returning('id');
  if (claimed.length === 0) return 'raced';

  try {
    const brandName = (await resolveBrandName(db, c.tenantId)) ?? c.slug;
    const unsub = unsubscribeUrl(c.adminEmail, 'brand_setup');
    const tmpl = brandSetupReminderEmail({
      adminName: c.adminName,
      brandName,
      missing,
      step,
      dashboardUrl: `${getPortalBaseUrl({ slug: c.slug, customDomain: c.customDomain })}/`,
      unsubscribeUrl: unsub,
      pendingReview: c.approvalStatus === 'pending',
    });
    await getMailer().send(
      { db, tenantId: DEFAULT_TENANT_ID },
      {
        to: c.adminEmail,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag: 'brand_setup_reminder',
        metadata: { tenantId: c.tenantId, step },
        platform: true,
        headers: {
          'List-Unsubscribe': `<${unsub}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
    );
    return 'sent';
  } catch (err) {
    // Release the claim so the next run retries this step.
    await db(TABLES.BrandNotification).where({ id }).del();
    console.error('[brand-setup-reminders] send failed', { tenantId: c.tenantId, step, err });
    return 'failed';
  }
}

/** Per-brand reminder history for the ops console. */
export async function brandReminderHistory(
  db: Knex,
  tenantIds: string[],
): Promise<Map<string, { sent: number; lastSentAt: Date | null }>> {
  if (tenantIds.length === 0) return new Map();
  const rows = (await db(TABLES.BrandNotification)
    .whereIn('tenantId', tenantIds)
    .andWhere({ kind: KIND })
    .groupBy('tenantId')
    .select('tenantId')
    .count({ sent: '*' })
    .max({ last: 'sentAt' })) as Array<{ tenantId: string; sent: string | number; last: Date | null }>;
  return new Map(rows.map((r) => [r.tenantId, { sent: Number(r.sent), lastSentAt: r.last ? new Date(r.last) : null }]));
}
