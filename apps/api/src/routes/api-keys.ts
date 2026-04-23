import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type ApiKeyRow } from '@openpartner/db';
import { db } from '../db.js';
import { createApiKeyRow, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';

const createSchema = z.object({ label: z.string().optional() });

export const apiKeysRouter = Router();

// Admin: create admin key (ADMIN_API_KEY env is the first-class bootstrap; this is for rotation).
apiKeysRouter.post('/api-keys', requireAuth, requireAdmin, async (req, res) => {
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const key = await createApiKeyRow({ partnerId: null, label: body.data.label ?? undefined });
  res.status(201).json({ id: key.id, plaintext: key.plaintext });
});

// Admin or the partner themselves: create a partner-scoped key.
apiKeysRouter.post(
  '/partners/:id/api-keys',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
    const partnerId = req.params.id!;
    const partner = await db(TABLES.Partner).where({ id: partnerId }).first();
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });
    const key = await createApiKeyRow({ partnerId, label: body.data.label });
    res.status(201).json({ id: key.id, plaintext: key.plaintext });
  },
);

apiKeysRouter.get(
  '/partners/:id/api-keys',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const keys = await db<ApiKeyRow>(TABLES.ApiKey)
      .where({ partnerId: req.params.id })
      .select('id', 'prefix', 'label', 'createdAt', 'lastUsedAt', 'revokedAt')
      .orderBy('createdAt', 'desc');
    res.json({ apiKeys: keys });
  },
);

// Revoke. Admin can revoke any key; partner can only revoke their own.
apiKeysRouter.delete('/api-keys/:keyId', requireAuth, async (req, res) => {
  const key = await db<ApiKeyRow>(TABLES.ApiKey).where({ id: req.params.keyId }).first();
  if (!key) return res.status(404).json({ error: 'not_found' });

  const p = req.principal!;
  const allowed = p.role === 'admin' || (p.role === 'partner' && key.partnerId === p.partnerId);
  if (!allowed) return res.status(403).json({ error: 'forbidden' });

  await db<ApiKeyRow>(TABLES.ApiKey).where({ id: key.id }).update({ revokedAt: new Date() });
  res.json({ ok: true });
});
