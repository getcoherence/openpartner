import { Router } from 'express';
import { z } from '../zod.js';
import { ulid } from 'ulid';
import { TABLES, type ClickLandingRow, type ClickRow, type IdentityRow } from '@openpartner/db';
import { attributeBacklogForUser } from '../attribution.js';
import { sendTenantSlugMissing } from '../auth.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { tenantOf } from '../tenancy.js';
import { noteTrackingIssue } from '../tracking-issues.js';

export const schema = z.object({
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
    // No requireAuth here to turn a missing tenant into a 400, so do it
    // ourselves — tenantOf would throw and surface as a 500.
    if (!req.db) return sendTenantSlugMissing(res);
    const { db, tenantId } = tenantOf(req);
    const body = schema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const { cref, userId } = body.data;

    const click = await db<ClickRow>(TABLES.Click).where({ id: cref, tenantId }).first();
    if (!click) {
      // Counted for Admin → Tracking health: the SDK only logs this to the
      // visitor's console, so a script tag pointed at the wrong tenant
      // would otherwise drop every stitch unseen.
      await noteTrackingIssue(db, tenantId, 'identify_unknown_click', cref);
      return res.status(404).json({ error: 'click_not_found' });
    }

    // Multi-touch: every (clickId, userId) pair kept. Unique constraint makes
    // re-identify() calls for the same click a no-op.
    const identityId = ulid();
    const inserted = await db<IdentityRow>(TABLES.Identity)
      .insert({ id: identityId, tenantId, clickId: cref, userId })
      .onConflict(['clickId', 'userId'])
      .ignore()
      .returning('id');

    const firstStitch = inserted.length > 0;
    const attributed = firstStitch ? await attributeBacklogForUser(db, tenantId, userId) : 0;

    res.json({
      ok: true,
      identityId: firstStitch ? identityId : null,
      firstStitch,
      backfilledAttributions: attributed,
    });
  },
);

export const landingSchema = z.object({
  cref: z.string().min(1).max(200),
});

/** The page's hostname, from the browser's own Origin (or Referer) header.
 *  Never the path or query, which can carry an email or a token. */
function landingHost(origin: string | undefined, referer: string | undefined): string | null {
  for (const value of [origin, referer]) {
    if (!value || value === 'null') continue;
    try {
      const host = new URL(value).hostname.toLowerCase();
      if (host) return host.slice(0, 255);
    } catch {
      // Not a URL; try the next header.
    }
  }
  return null;
}

// The browser SDK reports that a partner click arrived on the brand's site
// (ClickLanding), once per click: the first page that captures it from the
// URL. Admin → Tracking health compares landings with clicks to show the
// ones lost between the partner link and the page (a redirect that dropped
// ?cref=, a page without the script, a consent banner holding it).
//
// Unauthenticated and open to any origin, like identify, and for the same
// reason: it runs on the brand's pages. It reads no cookies and writes
// nothing but the landing. Someone who knows a click id can mark it landed,
// which skews one diagnostic and earns nobody anything.
identifyRouter.post(
  '/attribution/landing',
  ipRateLimit({ name: 'landing', max: 120, windowMs: 60_000 }),
  async (req, res) => {
    if (!req.db) return sendTenantSlugMissing(res);
    const { db, tenantId } = tenantOf(req);
    const body = landingSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const { cref } = body.data;
    const click = await db<ClickRow>(TABLES.Click).where({ id: cref, tenantId }).first('id');
    if (!click) {
      await noteTrackingIssue(db, tenantId, 'landing_unknown_click', cref);
      return res.status(404).json({ error: 'click_not_found' });
    }

    const inserted = await db<ClickLandingRow>(TABLES.ClickLanding)
      .insert({ clickId: cref, tenantId, host: landingHost(req.header('origin'), req.header('referer')) })
      .onConflict('clickId')
      .ignore()
      .returning('clickId');

    res.json({ ok: true, firstLanding: inserted.length > 0 });
  },
);
