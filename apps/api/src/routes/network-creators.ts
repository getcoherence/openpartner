import { Router } from 'express';
import { ulid } from 'ulid';
import { TABLES, type NetworkCreatorRow } from '@openpartner/db';
import { db } from '../db.js';
import { createApiKeyRow, requireAdmin, requireAuth, requireNetworkCreator } from '../auth.js';
import { creatorCreateSchema } from '../network/validation.js';

export const networkCreatorsRouter = Router();

// Admin: list + activate. In a real production world this would be
// self-serve with email verification; MVP keeps a moderation queue.
networkCreatorsRouter.get('/network/creators', requireAuth, requireAdmin, async (_req, res) => {
  const creators = await db<NetworkCreatorRow>(TABLES.NetworkCreator).orderBy('createdAt', 'desc');
  res.json({ creators });
});

networkCreatorsRouter.post('/network/creators', requireAuth, requireAdmin, async (req, res) => {
  const body = creatorCreateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const id = ulid();
  try {
    await db<NetworkCreatorRow>(TABLES.NetworkCreator).insert({
      id,
      name: body.data.name,
      handle: body.data.handle,
      email: body.data.email,
      bio: body.data.bio ?? null,
      avatarUrl: body.data.avatarUrl ?? null,
      platforms: JSON.stringify(body.data.platforms ?? []) as unknown as never, // jsonb
      defaultPromoCode: body.data.defaultPromoCode ?? null,
      status: 'pending',
    });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'handle_or_email_taken' });
    }
    throw err;
  }

  const key = await createApiKeyRow({ networkCreatorId: id, label: 'creator portal' });
  const creator = await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ id }).first();
  res.status(201).json({ creator, apiKey: key.plaintext });
});

networkCreatorsRouter.post('/network/creators/:id/activate', requireAuth, requireAdmin, async (req, res) => {
  const updated = await db<NetworkCreatorRow>(TABLES.NetworkCreator)
    .where({ id: req.params.id })
    .update({ status: 'active', activatedAt: new Date() })
    .returning('*');
  if (updated.length === 0) return res.status(404).json({ error: 'creator_not_found' });
  res.json({ creator: updated[0] });
});

// Creator self-view (own profile) — already in /auth/whoami but this is
// the canonical profile endpoint.
networkCreatorsRouter.get('/network/creators/me', requireAuth, requireNetworkCreator, async (req, res) => {
  const p = req.principal!;
  if (p.role !== 'network_creator') return res.status(403).json({ error: 'forbidden' });
  const creator = await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ id: p.networkCreatorId }).first();
  if (!creator) return res.status(404).json({ error: 'creator_not_found' });
  res.json({ creator });
});
