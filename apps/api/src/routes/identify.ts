import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type ClickRow, type IdentityRow } from '@openpartner/db';
import { db } from '../db.js';
import { attributeBacklogForUser } from '../attribution.js';

const schema = z.object({
  cref: z.string().min(1),
  userId: z.string().min(1),
  ts: z.number().optional(),
});

export const identifyRouter = Router();

// Stitch a click (cref) to an authenticated user. Called by the SDK on login/signup.
// First stitch per user wins — matches the unique index on Identity.userId.
identifyRouter.post('/attribution/identify', async (req, res) => {
  const body = schema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const { cref, userId } = body.data;

  const click = await db<ClickRow>(TABLES.Click).where({ id: cref }).first();
  if (!click) return res.status(404).json({ error: 'click_not_found' });

  // Multi-touch: we keep every (clickId, userId) pair. The unique constraint
  // makes re-identify() calls for the same click a no-op.
  const identityId = ulid();
  const inserted = await db<IdentityRow>(TABLES.Identity)
    .insert({ id: identityId, clickId: cref, userId })
    .onConflict(['clickId', 'userId'])
    .ignore()
    .returning('id');

  const firstStitch = inserted.length > 0;
  const attributed = firstStitch ? await attributeBacklogForUser(db, userId) : 0;

  res.json({
    ok: true,
    identityId: firstStitch ? identityId : null,
    firstStitch,
    backfilledAttributions: attributed,
  });
});
