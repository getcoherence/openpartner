import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type CampaignRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';

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
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  commissionRule: commissionRuleSchema.optional(),
  attributionWindowDays: z.number().int().min(1).max(365).optional(),
  attributionModel: z.enum(['last_click', 'first_click', 'linear', 'position']).optional(),
  destinationUrl: z.string().url().optional(),
  deepLinkAllowedDomains: z.string().max(1000).nullable().optional(),
});

export const campaignsRouter = Router();

campaignsRouter.get('/campaigns', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const campaigns = await db<CampaignRow>(TABLES.Campaign).orderBy('createdAt', 'desc');
  res.json({ campaigns });
});

/**
 * Partner-facing campaign list — fields are limited to what a partner
 * needs to create a Link (id, name, destinationUrl, deepLinkAllowedDomains).
 * Commission rules + attribution settings are admin-only and stay out
 * of the response.
 */
campaignsRouter.get('/me/campaigns', requireAuth, async (req, res) => {
  if (req.principal?.role !== 'partner' && req.principal?.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { db } = tenantOf(req);
  const campaigns = (await db<CampaignRow>(TABLES.Campaign)
    .select('id', 'name', 'destinationUrl', 'deepLinkAllowedDomains')
    .orderBy('createdAt', 'desc')) as Array<Pick<CampaignRow, 'id' | 'name' | 'destinationUrl' | 'deepLinkAllowedDomains'>>;
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
    })
    .returning('*');

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

  await db<CampaignRow>(TABLES.Campaign).where({ id: req.params.id }).update(patch);
  const updated = await db<CampaignRow>(TABLES.Campaign).where({ id: req.params.id }).first();
  res.json(updated);
});
