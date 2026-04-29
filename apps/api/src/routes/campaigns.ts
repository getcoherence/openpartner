import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type CampaignRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { campaignAcceptsNewActivity } from '../campaign-lifecycle.js';

const commissionRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent'), value: z.number().positive(), recurring: z.boolean().optional() }),
  z.object({
    type: z.literal('fixed'),
    value: z.number().positive(),
    currency: z.string().length(3).optional(),
    recurring: z.boolean().optional(),
  }),
]);

const createSchema = z.object({
  name: z.string().min(1),
  commissionRule: commissionRuleSchema,
  attributionWindowDays: z.number().int().min(1).max(365).optional(),
  attributionModel: z.enum(['last_click', 'first_click', 'linear', 'position']).optional(),
  destinationUrl: z.string().url(),
  /** Comma-separated host allowlist for partner deep-linking. Null/omitted
   *  means partners can't override the destination. */
  deepLinkAllowedDomains: z.string().max(1000).optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  /** When true, after creating the campaign, also grant every existing
   *  non-revoked partner access to it (source='admin'). Defaults to
   *  false so VIP / scoped campaigns stay private unless the brand opts
   *  in. New partners invited later still need to be granted explicitly
   *  at invite time — this only covers the existing roster. */
  grantToAllPartners: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  commissionRule: commissionRuleSchema.optional(),
  attributionWindowDays: z.number().int().min(1).max(365).optional(),
  attributionModel: z.enum(['last_click', 'first_click', 'linear', 'position']).optional(),
  destinationUrl: z.string().url().optional(),
  deepLinkAllowedDomains: z.string().max(1000).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});

export const campaignsRouter = Router();

campaignsRouter.get('/campaigns', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const campaigns = await db<CampaignRow>(TABLES.Campaign).orderBy('createdAt', 'desc');
  res.json({ campaigns });
});

/**
 * Partner-facing campaign list — only the Programs the calling partner
 * was granted access to (via admin assignment or Network-offering
 * approval). Admins see all campaigns in their tenant.
 *
 * Fields are limited to what a partner needs to create a Link
 * (id, name, destinationUrl, deepLinkAllowedDomains, source).
 * Commission rules + attribution settings are admin-only and stay out
 * of the response.
 */
campaignsRouter.get('/me/campaigns', requireAuth, async (req, res) => {
  const p = req.principal;
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  if (p.role !== 'partner' && p.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { db } = tenantOf(req);

  if (p.role === 'admin') {
    const campaigns = (await db<CampaignRow>(TABLES.Campaign)
      .select('id', 'name', 'destinationUrl', 'deepLinkAllowedDomains', 'startsAt', 'endsAt')
      .orderBy('createdAt', 'desc')) as Array<
        Pick<CampaignRow, 'id' | 'name' | 'destinationUrl' | 'deepLinkAllowedDomains' | 'startsAt' | 'endsAt'>
      >;
    return res.json({ campaigns });
  }

  // Partner: filter through PartnerCampaign join. Hide scheduled (not
  // yet started) and ended campaigns — partners shouldn't be picking
  // those when they create a Link. Admins see them all so they can
  // edit dates.
  const rows = (await db(TABLES.Campaign)
    .join(TABLES.PartnerCampaign, `${TABLES.PartnerCampaign}.campaignId`, `${TABLES.Campaign}.id`)
    .where(`${TABLES.PartnerCampaign}.partnerId`, p.partnerId!)
    .select(
      `${TABLES.Campaign}.id`,
      `${TABLES.Campaign}.name`,
      `${TABLES.Campaign}.destinationUrl`,
      `${TABLES.Campaign}.deepLinkAllowedDomains`,
      `${TABLES.Campaign}.startsAt as startsAt`,
      `${TABLES.Campaign}.endsAt as endsAt`,
      `${TABLES.PartnerCampaign}.source as source`,
    )
    .orderBy(`${TABLES.Campaign}.createdAt`, 'desc')) as Array<{
      id: string;
      name: string;
      destinationUrl: string;
      deepLinkAllowedDomains: string | null;
      startsAt: Date | null;
      endsAt: Date | null;
      source: 'admin' | 'offering';
    }>;
  const campaigns = rows.filter((r) => campaignAcceptsNewActivity(r));
  res.json({ campaigns });
});

campaignsRouter.post('/campaigns', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const id = ulid();
  const [campaign] = await db<CampaignRow>(TABLES.Campaign)
    .insert({
      id,
      tenantId,
      name: body.data.name,
      commissionRule: body.data.commissionRule,
      attributionWindowDays: body.data.attributionWindowDays ?? 60,
      attributionModel: body.data.attributionModel ?? 'last_click',
      destinationUrl: body.data.destinationUrl,
      deepLinkAllowedDomains: body.data.deepLinkAllowedDomains ?? null,
      startsAt: body.data.startsAt ? new Date(body.data.startsAt) : null,
      endsAt: body.data.endsAt ? new Date(body.data.endsAt) : null,
    })
    .returning('*');

  // Optional bulk-grant to existing non-revoked partners. Mirrors the
  // invite-time snapshot semantics (revokedAt is the only filter — we
  // include not-yet-activated invitees so a freshly-sent invite still
  // gets the new program).
  if (body.data.grantToAllPartners) {
    const partners = (await db(TABLES.Partner)
      .whereNull('revokedAt')
      .select('id')) as Array<{ id: string }>;
    if (partners.length > 0) {
      await db(TABLES.PartnerCampaign)
        .insert(
          partners.map((p) => ({
            id: `pc_${ulid()}`,
            tenantId,
            partnerId: p.id,
            campaignId: id,
            source: 'admin',
          })),
        )
        .onConflict(['tenantId', 'partnerId', 'campaignId'])
        .ignore();
    }
  }

  res.status(201).json(campaign);
});

campaignsRouter.patch('/campaigns/:id', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const body = updateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const existing = await db<CampaignRow>(TABLES.Campaign).where({ id: req.params.id }).first();
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const patch: Partial<CampaignRow> = {};
  if (body.data.name !== undefined) patch.name = body.data.name;
  if (body.data.commissionRule !== undefined) patch.commissionRule = body.data.commissionRule;
  if (body.data.attributionWindowDays !== undefined) patch.attributionWindowDays = body.data.attributionWindowDays;
  if (body.data.attributionModel !== undefined) patch.attributionModel = body.data.attributionModel;
  if (body.data.destinationUrl !== undefined) patch.destinationUrl = body.data.destinationUrl;
  if (body.data.deepLinkAllowedDomains !== undefined) patch.deepLinkAllowedDomains = body.data.deepLinkAllowedDomains;
  if (body.data.startsAt !== undefined) patch.startsAt = body.data.startsAt ? new Date(body.data.startsAt) : null;
  if (body.data.endsAt !== undefined) patch.endsAt = body.data.endsAt ? new Date(body.data.endsAt) : null;

  await db<CampaignRow>(TABLES.Campaign).where({ id: req.params.id }).update(patch);
  const updated = await db<CampaignRow>(TABLES.Campaign).where({ id: req.params.id }).first();
  res.json(updated);
});
