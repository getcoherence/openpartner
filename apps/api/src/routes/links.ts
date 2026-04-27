import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type LinkRow } from '@openpartner/db';
import { grantScope, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { tenantOf } from '../tenancy.js';

const createSchema = z.object({
  linkKey: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'linkKey must be url-safe'),
  campaignId: z.string().min(1),
  destinationUrl: z.string().url(),
});

export const linksRouter = Router();

linksRouter.get('/partners/:id/links', requireAuth, requirePartnerOrAdmin('id'), async (req, res) => {
  const { db } = tenantOf(req);
  const links = await db<LinkRow>(TABLES.Link)
    .where({ partnerId: req.params.id })
    .orderBy('createdAt', 'desc');
  res.json({ links });
});

linksRouter.post('/partners/:id/links', requireAuth, grantScope('links:write'), requirePartnerOrAdmin('id'), async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const partner = await db(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });

  const campaign = await db(TABLES.Campaign).where({ id: body.data.campaignId }).first();
  if (!campaign) return res.status(404).json({ error: 'campaign_not_found' });

  const id = ulid();
  try {
    const [link] = await db<LinkRow>(TABLES.Link)
      .insert({
        id,
        tenantId,
        linkKey: body.data.linkKey,
        partnerId: req.params.id,
        campaignId: body.data.campaignId,
        destinationUrl: body.data.destinationUrl,
      })
      .returning('*');
    res.status(201).json(link);
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'linkKey_taken' });
    }
    throw err;
  }
});

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
