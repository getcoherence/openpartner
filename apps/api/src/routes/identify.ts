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

  const existing = await db<IdentityRow>(TABLES.Identity).where({ userId }).first();
  if (existing) {
    return res.json({ ok: true, identityId: existing.id, firstStitch: false });
  }

  const identityId = ulid();
  await db(TABLES.Identity).insert({ id: identityId, clickId: cref, userId });

  // Catch up any events that arrived before the stitch.
  const attributed = await attributeBacklogForUser(db, userId);

  res.json({ ok: true, identityId, firstStitch: true, backfilledAttributions: attributed });
});
