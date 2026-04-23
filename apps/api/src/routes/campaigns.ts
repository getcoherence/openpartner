import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type CampaignRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';

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
});

export const campaignsRouter = Router();

campaignsRouter.get('/campaigns', requireAuth, requireAdmin, async (_req, res) => {
  const campaigns = await db<CampaignRow>(TABLES.Campaign).orderBy('createdAt', 'desc');
  res.json({ campaigns });
});

campaignsRouter.post('/campaigns', requireAuth, requireAdmin, async (req, res) => {
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const id = ulid();
  const [campaign] = await db<CampaignRow>(TABLES.Campaign)
    .insert({
      id,
      name: body.data.name,
      commissionRule: body.data.commissionRule,
      attributionWindowDays: body.data.attributionWindowDays ?? 60,
      attributionModel: body.data.attributionModel ?? 'last_click',
    })
    .returning('*');

  res.status(201).json(campaign);
});
