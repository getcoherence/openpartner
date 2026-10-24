/**
 * GET /admin/tracking-health — where partner clicks and conversions go
 * missing (tracking-health.ts). Admin → Tracking health in the portal.
 *
 *   ?days=30        window, 1–90
 *   ?programId=…    only that program's clicks and coupon credits;
 *                   unattributed conversions stay account-wide (an event
 *                   belongs to no program until it attributes)
 *
 * Admins only (a session or an admin API key): it reads every partner's
 * traffic.
 */

import { Router } from 'express';
import { z } from '../zod.js';
import { TABLES } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { TRACKING_HEALTH_MAX_DAYS, trackingHealth } from '../tracking-health.js';

export const trackingHealthRouter = Router();

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(TRACKING_HEALTH_MAX_DAYS).optional().default(30),
  programId: z.string().min(1).max(64).optional(),
});

trackingHealthRouter.get('/admin/tracking-health', requireAuth, requireAdmin, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query', detail: parsed.error.flatten() });
  const { db, tenantId } = tenantOf(req);
  const { days, programId } = parsed.data;
  if (programId) {
    const program = await db(TABLES.Program).where({ id: programId, tenantId }).first('id');
    if (!program) return res.status(404).json({ error: 'program_not_found' });
  }
  res.json(await trackingHealth(db, tenantId, { days, programId }));
});
