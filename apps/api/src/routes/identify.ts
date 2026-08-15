import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type ClickRow, type IdentityRow } from '@openpartner/db';
import { attributeBacklogForUser } from '../attribution.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { tenantOf } from '../tenancy.js';

const schema = z.object({
  cref: z.string().min(1),
  userId: z.string().min(1),
  ts: z.number().optional(),
});

export const identifyRouter = Router();

// Stitch a click (cref) to an authenticated user. Called by the SDK on
// login/signup. The endpoint is unauth'd, but it IS tenant-scoped — in
// multi-tenant mode the SDK calls /t/<slug>/attribution/identify so the
// click lookup is bounded to that tenant. Routing through tenantMiddleware
// gives us a tenant-bound transaction so the Identity insert is scoped
// correctly via the WITH CHECK clause on RLS.
//
// 120/min per IP is generous for legitimate use (stitches once per
// login) but cuts off spray.
identifyRouter.post(
  '/attribution/identify',
  ipRateLimit({ name: 'identify', max: 120, windowMs: 60_000 }),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = schema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const { cref, userId } = body.data;

    const click = await db<ClickRow>(TABLES.Click).where({ id: cref }).first();
    if (!click) return res.status(404).json({ error: 'click_not_found' });

    // Multi-touch: every (clickId, userId) pair kept. Unique constraint makes
    // re-identify() calls for the same click a no-op.
    const identityId = ulid();
    const inserted = await db<IdentityRow>(TABLES.Identity)
      .insert({ id: identityId, tenantId, clickId: cref, userId })
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
  },
);
