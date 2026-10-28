/**
 * GET /admin/tracking-health — where partner clicks and conversions go
 * missing (tracking-health.ts). Admin → Tracking health in the portal.
 *
 *   ?days=30        window, 1–90
 *   ?programId=…    only that program's clicks and coupon credits;
 *                   unattributed conversions stay account-wide (an event
 *                   belongs to no program until it attributes)
 *
 * GET /admin/tracking-health/stripe — the brand's Stripe revenue next to
 * what OpenPartner recorded and credited (stripe-reconciliation.ts).
 *
 *   ?days=30        window, 1–90
 *   ?refresh=1      skip the cache
 *
 * Listing Stripe takes seconds, so a result is kept for CACHE_TTL_MS per
 * (tenant, window) in this process. `available: false` with a reason when
 * there's no Stripe of the brand's to read.
 *
 * GET /admin/tracking-health/flags — each browser and partner against its
 * own recent past (tracking-flags.ts). Fixed windows, account-wide.
 *
 * GET /admin/tracking-health/setup — pass/fail checks on each step of the
 * tracking chain (setup-checks.ts). Fetches each program's destination and
 * asks the brand's Stripe for recent payments, so those reads are kept for
 * ten minutes in this process.
 *
 *   ?refresh=1      read them again
 *
 * GET|POST /config/tracking-alerts — `{ email }`: whether failing checks
 * and new flags are emailed to the admins (tracking-alerts.ts). On by
 * default.
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
import { computeTrackingFlags } from '../tracking-flags.js';
import { computeSetupChecks } from '../setup-checks.js';
import { readTrackingAlertSettings, saveTrackingAlertSettings } from '../tracking-alerts.js';
import {
  RECONCILE_MAX_DAYS,
  brandStripeAccess,
  reconcileStripe,
  type StripeReconciliationResult,
} from '../stripe-reconciliation.js';

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

trackingHealthRouter.get('/admin/tracking-health/flags', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await computeTrackingFlags(db, tenantId));
});

const setupQuerySchema = z.object({
  refresh: z.enum(['0', '1']).optional(),
});

trackingHealthRouter.get('/admin/tracking-health/setup', requireAuth, requireAdmin, async (req, res) => {
  const parsed = setupQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query', detail: parsed.error.flatten() });
  const { db, tenantId } = tenantOf(req);
  res.json(await computeSetupChecks(db, tenantId, { refresh: parsed.data.refresh === '1' }));
});

export const trackingAlertSettingsSchema = z.object({
  email: z.boolean().optional(),
});

trackingHealthRouter.get('/config/tracking-alerts', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await readTrackingAlertSettings(db, tenantId));
});

/** Omitted fields keep their value. */
trackingHealthRouter.post('/config/tracking-alerts', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = trackingAlertSettingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  res.json(await saveTrackingAlertSettings(db, tenantId, body.data));
});

const reconcileQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(RECONCILE_MAX_DAYS).optional().default(30),
  refresh: z.enum(['0', '1']).optional(),
});

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
const reconcileCache = new Map<string, { expires: number; result: StripeReconciliationResult }>();

/** For tests. */
export function __clearReconcileCache(): void {
  reconcileCache.clear();
}

trackingHealthRouter.get('/admin/tracking-health/stripe', requireAuth, requireAdmin, async (req, res) => {
  const parsed = reconcileQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query', detail: parsed.error.flatten() });
  const { db, tenantId } = tenantOf(req);
  const { days, refresh } = parsed.data;

  // Access first, every time: a disconnected brand or a revoked grant must
  // never be served a cached report, and the cache key names the account
  // and mode, so a reconnect to another one starts fresh.
  let access: Awaited<ReturnType<typeof brandStripeAccess>>;
  try {
    access = await brandStripeAccess(db, tenantId);
  } catch (err) {
    // A token refresh Stripe didn't answer: no detail, it may name the grant.
    console.error('[tracking-health] stripe access failed', { tenantId, error: (err as Error).message });
    return res.json({ available: false, reason: 'stripe_error' } satisfies StripeReconciliationResult);
  }
  if (!access.ok) return res.json({ available: false, reason: access.reason } satisfies StripeReconciliationResult);

  const key = `${tenantId}|${days}|${access.identity}`;
  const cached = reconcileCache.get(key);
  if (cached && cached.expires > Date.now() && refresh !== '1') return res.json(cached.result);

  let result: StripeReconciliationResult;
  try {
    result = await reconcileStripe(db, tenantId, access.stripe, { days, livemode: access.livemode });
  } catch (err) {
    const type = (err as { type?: string }).type;
    // A restricted key or an install without these reads: say which, not 500.
    if (type === 'StripePermissionError') return res.json({ available: false, reason: 'missing_permissions' });
    if (typeof type === 'string' && type.startsWith('Stripe')) {
      return res.json({ available: false, reason: 'stripe_error', detail: (err as Error).message });
    }
    throw err;
  }
  if (reconcileCache.size >= CACHE_MAX) reconcileCache.delete(reconcileCache.keys().next().value!);
  reconcileCache.set(key, { expires: Date.now() + CACHE_TTL_MS, result });
  res.json(result);
});
