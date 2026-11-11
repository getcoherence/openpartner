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
 * POST /admin/tracking-health/test-click — `{ programId }`: a single-use
 * test link for one program (test-clicks.ts). Returns `{ id, path,
 * expiresAt }`; the portal opens the share-link base + `path`.
 *
 * GET /admin/tracking-health/test-click/:id — how far that test got: the
 * link opened, the script reported it, a signup was linked to it.
 *
 * POST /admin/tracking-health/send-to-developer — `{ email }`: mail the
 * script tag and install guide to the person who edits the brand's site.
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
import { TABLES, type AdminRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { resolveBrandName } from '../brand-name.js';
import { trackingInstallForDeveloperEmail } from '../email-templates.js';
import { getMailer } from '../mailer.js';
import { KeyedLimiter } from '../middleware/rate-limit.js';
import { getApiBaseUrl, linkTenantOf, type PortalLinkTenant } from '../portal-url.js';
import { TRACKING_HEALTH_MAX_DAYS, trackingHealth } from '../tracking-health.js';
import { computeTrackingFlags } from '../tracking-flags.js';
import { computeSetupChecks } from '../setup-checks.js';
import { createTestClick, testClickResult } from '../test-clicks.js';
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

export const testClickSchema = z.object({
  programId: z.string().min(1).max(64),
});

trackingHealthRouter.post('/admin/tracking-health/test-click', requireAuth, requireAdmin, async (req, res) => {
  const body = testClickSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const { db, tenantId } = tenantOf(req);
  const result = await createTestClick(db, tenantId, body.data.programId);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(201).json({ id: result.id, path: result.path, expiresAt: result.expiresAt });
});

trackingHealthRouter.get('/admin/tracking-health/test-click/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  if (id.length > 64) return res.status(404).json({ error: 'test_click_not_found' });
  const { db, tenantId } = tenantOf(req);
  const result = await testClickResult(db, tenantId, id);
  if (!result) return res.status(404).json({ error: 'test_click_not_found' });
  res.json(result);
});

export const INSTALL_GUIDE_URL =
  'https://github.com/getcoherence/openpartner/blob/main/packages/sdk/README.md#script-tag-no-bundler';

/** The tag a brand adds to its site: the same string the portal shows
 *  (apps/portal/src/lib/InstallSnippet.tsx). */
export function trackingScriptTag(tenant: PortalLinkTenant): string {
  const origin = tenant.customDomain
    ? `https://${tenant.customDomain}`
    : new URL(process.env.PORTAL_URL ?? 'http://localhost:5673').origin;
  return `<script src="${origin}/op.js" data-api-url="${getApiBaseUrl(tenant)}"></script>`;
}

export const sendToDeveloperSchema = z.object({
  email: z.string().trim().email().max(254),
});

/** Per brand. The mail goes to an address the admin typed, with content
 *  they don't control, so a handful a day is plenty. */
const developerMailLimit = new KeyedLimiter(5, 24 * 60 * 60_000);

/** For tests. */
export function __resetDeveloperMailLimit(tenantId: string): void {
  developerMailLimit.reset(tenantId);
}

/**
 * POST /admin/tracking-health/send-to-developer — `{ email }`: mail the
 * script tag and the install guide to whoever edits the brand's site. The
 * body is built here, never taken from the request.
 */
trackingHealthRouter.post('/admin/tracking-health/send-to-developer', requireAuth, requireAdmin, async (req, res) => {
  const body = sendToDeveloperSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const { db, tenantId } = tenantOf(req);
  if (!developerMailLimit.hit(tenantId)) return res.status(429).json({ error: 'too_many_emails' });

  const principal = req.principal;
  const sender =
    principal?.role === 'admin' && principal.source === 'session'
      ? await db<AdminRow>(TABLES.Admin).where({ id: principal.adminId, tenantId }).first(['email'])
      : undefined;
  const tmpl = trackingInstallForDeveloperEmail({
    brandName: (await resolveBrandName(db, tenantId)) ?? 'Your team',
    senderEmail: sender?.email ?? null,
    scriptTag: trackingScriptTag(linkTenantOf(req)),
    guideUrl: INSTALL_GUIDE_URL,
  });
  try {
    await getMailer().send(
      { db, tenantId },
      { to: body.data.email, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag: 'tracking_install_for_developer' },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[tracking-health] developer mail failed', { tenantId, detail });
    return res.status(422).json({ error: 'mail_send_failed' });
  }
  res.json({ ok: true });
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
