/**
 * Daily sweep that finds campaigns ending in ~7 days and emails the
 * brand admin + every partner that has at least one Link in the
 * campaign. Stamps Campaign.endNotificationSentAt to make it
 * idempotent across deploys / re-runs.
 *
 * "About 7 days out" is a 24h window: endsAt between (now+6.5d) and
 * (now+7.5d). Scheduler fires daily at 09:00 UTC; the half-day padding
 * means a clock skew or a missed run still catches everything.
 *
 * If the admin extends endsAt past 7.5 days from now we clear the
 * flag so a fresh reminder fires before the new end date.
 */

import { TABLES, type AdminRow, type ProgramRow, type PartnerRow, type TenantRow } from '@openpartner/db';
import { db, appDb } from './db.js';
import { getMailer } from './mailer.js';
import { campaignEndingBrandEmail, campaignEndingPartnerEmail } from './email-templates.js';
import { resolveBrandName } from './brand-name.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface SweepResult {
  notified: number;
  cleared: number;
  errors: number;
}

export async function sweepCampaignEndNotifications(): Promise<SweepResult> {
  const now = new Date();
  const windowStart = new Date(now.getTime() + 6.5 * ONE_DAY_MS);
  const windowEnd = new Date(now.getTime() + 7.5 * ONE_DAY_MS);

  // Reset endNotificationSentAt on campaigns whose endsAt got pushed
  // past the 7.5-day window — admin extended, so a future reminder
  // should fire when the new end date approaches.
  const { rowCount: clearedCount } = (await db.raw(
    `update "Campaign"
       set "endNotificationSentAt" = null
     where "endNotificationSentAt" is not null
       and "endsAt" is not null
       and "endsAt" > ?`,
    [windowEnd],
  )) as { rowCount: number };
  const cleared = Number(clearedCount ?? 0);

  // Now find campaigns ripe for the reminder.
  const due = await db<ProgramRow>(TABLES.Program)
    .whereNotNull('endsAt')
    .andWhere('endsAt', '>=', windowStart)
    .andWhere('endsAt', '<', windowEnd)
    .whereNull('endNotificationSentAt')
    .select('*');

  let notified = 0;
  let errors = 0;

  for (const campaign of due) {
    try {
      await notifyOne(campaign);
      // Stamp via privileged db (cross-tenant context here in scheduler).
      await db<ProgramRow>(TABLES.Program)
        .where({ id: campaign.id })
        .update({ endNotificationSentAt: new Date() });
      notified += 1;
    } catch (err) {
      console.error('[end-notify] campaign failed', { id: campaign.id, err });
      errors += 1;
    }
  }

  return { notified, cleared, errors };
}

async function notifyOne(campaign: ProgramRow): Promise<void> {
  if (!campaign.endsAt) return;

  // Need a tenant-scoped trx for mailer.send (it reads tenant mail
  // settings + brand name via the privileged-but-tenant-aware path).
  // The scheduler runs cross-tenant so we open one per campaign.
  const trx = await appDb.transaction();
  try {
    await trx.raw(`set local app.tenant_id = '${campaign.tenantId.replace(/'/g, "''")}'`);

    const tenant = await trx<TenantRow>(TABLES.Tenant).where({ id: campaign.tenantId }).first();
    const brandName = await resolveBrandName(trx, campaign.tenantId);

    // Brand admin: pick the oldest activated admin to avoid spamming
    // every co-admin. They can forward internally if needed.
    const admin = await trx<AdminRow>(TABLES.Admin)
      .where({ tenantId: campaign.tenantId })
      .whereNotNull('activatedAt')
      .whereNull('revokedAt')
      .orderBy('activatedAt', 'asc')
      .first();

    const portalBase = (process.env.PORTAL_URL ?? '').replace(/\/$/, '');
    const tenantSlug = tenant?.slug ?? '';
    const tenantBase = portalBase && tenantSlug ? `${portalBase}/t/${tenantSlug}` : '';
    const manageUrl = tenantBase ? `${tenantBase}/admin/campaigns` : '';

    if (admin && manageUrl) {
      const tmpl = campaignEndingBrandEmail(brandName, campaign.name, campaign.endsAt, manageUrl);
      await getMailer().send({ db: trx, tenantId: campaign.tenantId }, {
        to: admin.email,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag: 'campaign_ending_brand',
        metadata: { programId: campaign.id },
      });
    }

    // Partners with at least one Link in this campaign. Joining
    // through Link rather than PartnerCampaign on purpose — only
    // partners who actually promoted should get the email; passive
    // grants without any posted Link are noise.
    const linkPartners = (await trx
      .from(TABLES.Link)
      .join(TABLES.Partner, `${TABLES.Partner}.id`, `${TABLES.Link}.partnerId`)
      .where(`${TABLES.Link}.programId`, campaign.id)
      .whereNull(`${TABLES.Partner}.revokedAt`)
      .whereNotNull(`${TABLES.Partner}.activatedAt`)
      .distinct(
        `${TABLES.Partner}.id`,
        `${TABLES.Partner}.email`,
        `${TABLES.Partner}.name`,
      )) as Array<Pick<PartnerRow, 'id' | 'email' | 'name'>>;

    const programUrl = tenantBase ? `${tenantBase}/links` : '';
    for (const p of linkPartners) {
      try {
        const tmpl = campaignEndingPartnerEmail(p.name, brandName, campaign.name, campaign.endsAt, programUrl);
        await getMailer().send({ db: trx, tenantId: campaign.tenantId }, {
          to: p.email,
          subject: tmpl.subject,
          text: tmpl.text,
          html: tmpl.html,
          tag: 'campaign_ending_partner',
          metadata: { programId: campaign.id, partnerId: p.id },
        });
      } catch (err) {
        // One partner's mail failure shouldn't block the rest. Log,
        // continue. Stamping endNotificationSentAt at the campaign
        // level still moves on — we don't re-try individual partners.
        console.error('[end-notify] partner mail failed', { programId: campaign.id, partnerId: p.id, err });
      }
    }

    await trx.commit();
  } catch (err) {
    await trx.rollback().catch(() => {});
    throw err;
  }
}
