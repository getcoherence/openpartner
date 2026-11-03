/**
 * The tracking gate's advance notice (tracking-verification.ts), sent once
 * from the ops console to every approved brand whose tracking isn't
 * verified: from <date>, until it is, new partners can't join and its
 * marketplace listings are hidden.
 *
 * Exactly once per brand: a BrandNotification row (kind 'tracking_required',
 * step 1) is the claim, and a failed send deletes it so a later run retries.
 * Sent to the oldest signed-in admin, in the platform voice, like the setup
 * reminders, and skipped for an admin who stopped setup reminders.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type AdminRow, type TenantRow } from '@openpartner/db';
import { getMailer } from './mailer.js';
import { trackingRequiredNoticeEmail } from './email-templates.js';
import { isOptedOut, unsubscribeUrl } from './email-optout.js';
import { getPortalBaseUrl } from './portal-url.js';
import { resolveBrandName } from './brand-name.js';
import { trackingVerifiedFor } from './tracking-verification.js';

const KIND = 'tracking_required';

export interface TrackingGateAffected {
  /** Approved, active brands whose tracking isn't verified. */
  brands: number;
  /** …with a program listed on the marketplace. */
  listed: number;
  /** …with at least one partner. */
  withPartners: number;
  /** …already sent the notice. */
  noticed: number;
}

/** Approved, active brands (not the platform's own) whose tracking isn't verified. */
async function unverifiedBrands(db: Knex): Promise<Array<Pick<TenantRow, 'id' | 'slug' | 'customDomain'>>> {
  const tenants = (await db<TenantRow>(TABLES.Tenant)
    .where({ status: 'active', approvalStatus: 'approved' })
    .whereNot({ id: DEFAULT_TENANT_ID })
    .whereNull('pendingDeletionAt')
    .select('id', 'slug', 'customDomain')) as Array<Pick<TenantRow, 'id' | 'slug' | 'customDomain'>>;
  const verified = await trackingVerifiedFor(db, tenants.map((t) => t.id));
  return tenants.filter((t) => !verified.has(t.id));
}

export async function trackingGateAffected(db: Knex): Promise<TrackingGateAffected> {
  const brands = await unverifiedBrands(db);
  const ids = brands.map((b) => b.id);
  if (ids.length === 0) return { brands: 0, listed: 0, withPartners: 0, noticed: 0 };
  const [listed] = (await db(TABLES.Program)
    .whereIn('tenantId', ids)
    .where('shareOnNetwork', true)
    .whereNotNull('networkOfferingId')
    .whereNull('blockedAt')
    .countDistinct({ n: 'tenantId' })) as Array<{ n: string | number }>;
  const [partnered] = (await db(TABLES.Partner)
    .whereIn('tenantId', ids)
    .whereNull('revokedAt')
    .countDistinct({ n: 'tenantId' })) as Array<{ n: string | number }>;
  const [noticed] = (await db(TABLES.BrandNotification)
    .whereIn('tenantId', ids)
    .where({ kind: KIND })
    .countDistinct({ n: 'tenantId' })) as Array<{ n: string | number }>;
  return {
    brands: ids.length,
    listed: Number(listed?.n ?? 0),
    withPartners: Number(partnered?.n ?? 0),
    noticed: Number(noticed?.n ?? 0),
  };
}

export interface TrackingNoticeRunResult {
  sent: number;
  /** Told already, by an earlier run. */
  alreadySent: number;
  noSignedInAdmin: number;
  optedOut: number;
  failed: number;
}

export async function sendTrackingGateNotices(
  db: Knex,
  enforceFrom: Date,
  operatorEmail: string,
): Promise<TrackingNoticeRunResult> {
  const out: TrackingNoticeRunResult = { sent: 0, alreadySent: 0, noSignedInAdmin: 0, optedOut: 0, failed: 0 };
  const brands = await unverifiedBrands(db);
  if (brands.length === 0) return out;
  const ids = brands.map((b) => b.id);

  const told = new Set(
    ((await db(TABLES.BrandNotification).whereIn('tenantId', ids).where({ kind: KIND }).select('tenantId')) as Array<{
      tenantId: string;
    }>).map((r) => r.tenantId),
  );
  const admins = (await db<AdminRow>(TABLES.Admin)
    .whereIn('tenantId', ids)
    .where({ role: 'admin' })
    .whereNull('revokedAt')
    .whereNotNull('activatedAt')
    .orderBy('activatedAt', 'asc')
    .select('tenantId', 'email', 'name')) as Array<Pick<AdminRow, 'tenantId' | 'email' | 'name'>>;
  const adminBy = new Map<string, { email: string; name: string | null }>();
  for (const a of admins) if (!adminBy.has(a.tenantId)) adminBy.set(a.tenantId, { email: a.email, name: a.name });
  const listed = new Set(
    ((await db(TABLES.Program)
      .whereIn('tenantId', ids)
      .where('shareOnNetwork', true)
      .whereNotNull('networkOfferingId')
      .whereNull('blockedAt')
      .distinct('tenantId')) as Array<{ tenantId: string }>).map((r) => r.tenantId),
  );

  for (const b of brands) {
    if (told.has(b.id)) {
      out.alreadySent += 1;
      continue;
    }
    const admin = adminBy.get(b.id);
    if (!admin) {
      out.noSignedInAdmin += 1;
      continue;
    }
    if (await isOptedOut(db, admin.email, 'brand_setup')) {
      out.optedOut += 1;
      continue;
    }
    const id = ulid();
    const claimed = await db(TABLES.BrandNotification)
      .insert({ id, tenantId: b.id, kind: KIND, step: 1, recipientEmail: admin.email, sentByEmail: operatorEmail, sentAt: new Date() })
      .onConflict(['tenantId', 'kind', 'step'])
      .ignore()
      .returning('id');
    if (claimed.length === 0) {
      out.alreadySent += 1;
      continue;
    }
    try {
      const brandName = (await resolveBrandName(db, b.id)) ?? b.slug;
      const unsub = unsubscribeUrl(admin.email, 'brand_setup');
      const tmpl = trackingRequiredNoticeEmail({
        adminName: admin.name,
        brandName,
        enforceFrom,
        listed: listed.has(b.id),
        trackingHealthUrl: `${getPortalBaseUrl({ slug: b.slug, customDomain: b.customDomain })}/admin/tracking-health`,
        unsubscribeUrl: unsub,
      });
      await getMailer().send(
        { db, tenantId: DEFAULT_TENANT_ID },
        {
          to: admin.email,
          subject: tmpl.subject,
          text: tmpl.text,
          html: tmpl.html,
          tag: 'brand_tracking_required',
          metadata: { tenantId: b.id },
          platform: true,
          headers: {
            'List-Unsubscribe': `<${unsub}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        },
      );
      out.sent += 1;
    } catch (err) {
      await db(TABLES.BrandNotification).where({ id }).del();
      console.error('[tracking-gate-notice] send failed', { tenantId: b.id, err });
      out.failed += 1;
    }
  }
  return out;
}
