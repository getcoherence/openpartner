import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type PartnerRow } from '@openpartner/db';
import { db } from '../db.js';
import { grantScope, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';

const createSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export const partnersRouter = Router();

partnersRouter.post('/partners', requireAuth, grantScope('partners:write'), requireAdmin, async (req, res) => {
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const id = ulid();
  const [partner] = await db<PartnerRow>(TABLES.Partner)
    .insert({
      id,
      email: body.data.email,
      name: body.data.name,
      metadata: body.data.metadata ?? {},
    })
    .returning('*');

  res.status(201).json(partner);
});

partnersRouter.get('/partners', requireAuth, requireAdmin, async (_req, res) => {
  const partners = await db<PartnerRow>(TABLES.Partner).orderBy('createdAt', 'desc').limit(500);
  res.json({ partners });
});

partnersRouter.get('/partners/:id', requireAuth, requirePartnerOrAdmin('id'), async (req, res) => {
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'not_found' });
  res.json(partner);
});
