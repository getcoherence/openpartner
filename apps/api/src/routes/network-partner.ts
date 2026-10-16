/**
 * Partner-role proxy onto the OpenPartner Network.
 *
 * The Network used to host its own creator-facing SPA. We collapsed that
 * surface into the openpartner portal so creators have a single home (the
 * vendor instance they signed up at). These routes are how that portal
 * reaches Network APIs without ever leaking the vendor's bearer token to
 * the browser — the partner's session principal authenticates locally,
 * and we proxy server-side using the encrypted vendorToken in
 * network_membership Config plus an x-act-as-vendor-partner header.
 *
 * Network's requireCreator middleware accepts that header (when paired
 * with an active vendor bearer) and resolves the Creator via
 * VendorAffiliation(vendorId, vendorPartnerId), so the same handler code
 * serves both browser-creator and proxied-from-vendor cases.
 */

import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import { AUDIENCE_SIZES } from '@openpartner/db';
import { requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { partnerProxy, NetworkProxyError } from '../network-client.js';

export const networkPartnerRouter = Router();

function requirePartnerPrincipal(req: Request, res: Response): string | null {
  const p = req.principal;
  if (!p) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  if (p.role !== 'partner' || !p.partnerId) {
    res.status(403).json({ error: 'partner_only' });
    return null;
  }
  return p.partnerId;
}

async function proxy(
  req: Request,
  res: Response,
  fn: (db: Knex, tenantId: string) => Promise<unknown>,
  successStatus = 200,
  /** Shape returned when the partner has no Network identity yet
   *  (Network 403 invalid_acting_context). Lets the SPA show an empty
   *  state instead of an error banner for the common case where the
   *  brand exists on the Network but auto-enroll never pushed this
   *  particular partner. */
  notFederatedFallback?: () => unknown,
): Promise<void> {
  const { db, tenantId } = tenantOf(req);
  try {
    const out = await fn(db, tenantId);
    res.status(successStatus).json(out);
  } catch (err) {
    if (err instanceof NetworkProxyError) {
      if (notFederatedFallback && (err.status === 403 || err.status === 404) && err.message.includes('invalid_acting_context')) {
        res.json(notFederatedFallback());
        return;
      }
      res.status(err.status).json({ error: 'network_call_failed', detail: err.message });
      return;
    }
    throw err;
  }
}

// ---------- Public discovery (no acting partner needed) ----------
//
// These routes don't require partner role — anyone authenticated on the
// vendor instance can browse. We still gate with requireAuth so we have a
// tenant context for the vendorToken.

networkPartnerRouter.get('/network/discover', requireAuth, async (req, res) => {
  const qs = new URLSearchParams();
  if (typeof req.query.q === 'string') qs.set('q', req.query.q);
  if (typeof req.query.sort === 'string') qs.set('sort', req.query.sort);
  return proxy(req, res, (db, tenantId) => partnerProxy.listOfferings(db, tenantId, qs.toString()));
});

networkPartnerRouter.get('/network/offerings/:id', requireAuth, async (req, res) =>
  proxy(req, res, (db, tenantId) => partnerProxy.getOffering(db, tenantId, req.params.id!)),
);

networkPartnerRouter.get('/network/vendors/:id', requireAuth, async (req, res) =>
  proxy(req, res, (db, tenantId) => partnerProxy.getVendor(db, tenantId, req.params.id!)),
);

// ---------- Acting-as-creator (partner-only) ----------

const applySchema = z.object({
  message: z.string().max(2000).optional(),
  preferredSlug: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
});

networkPartnerRouter.post('/network/offerings/:id/apply', requireAuth, async (req, res) => {
  const partnerId = requirePartnerPrincipal(req, res);
  if (!partnerId) return;
  const body = applySchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  return proxy(
    req,
    res,
    (db, tenantId) => partnerProxy.applyToOffering(db, tenantId, partnerId, req.params.id!, body.data),
    201,
  );
});

networkPartnerRouter.get('/network/me/affiliations', requireAuth, async (req, res) => {
  const partnerId = requirePartnerPrincipal(req, res);
  if (!partnerId) return;
  return proxy(
    req,
    res,
    (db, tenantId) => partnerProxy.listMyAffiliations(db, tenantId, partnerId),
    200,
    () => ({ affiliations: [] }),
  );
});

networkPartnerRouter.get('/network/me/affiliations/:id/earnings', requireAuth, async (req, res) => {
  const partnerId = requirePartnerPrincipal(req, res);
  if (!partnerId) return;
  return proxy(req, res, (db, tenantId) =>
    partnerProxy.getAffiliationEarnings(db, tenantId, partnerId, req.params.id!),
  );
});

networkPartnerRouter.get('/network/me/requests', requireAuth, async (req, res) => {
  const partnerId = requirePartnerPrincipal(req, res);
  if (!partnerId) return;
  return proxy(
    req,
    res,
    (db, tenantId) => partnerProxy.listMyRequests(db, tenantId, partnerId),
    200,
    () => ({ requests: [] }),
  );
});

networkPartnerRouter.post('/network/me/requests/:id/cancel', requireAuth, async (req, res) => {
  const partnerId = requirePartnerPrincipal(req, res);
  if (!partnerId) return;
  return proxy(req, res, (db, tenantId) => partnerProxy.cancelRequest(db, tenantId, partnerId, req.params.id!));
});

networkPartnerRouter.get('/network/me/profile', requireAuth, async (req, res) => {
  const partnerId = requirePartnerPrincipal(req, res);
  if (!partnerId) return;
  // Profile fallback returns null instead of an empty object so the
  // SPA can show a "not on the Network yet" message rather than a
  // half-rendered editable form.
  return proxy(
    req,
    res,
    (db, tenantId) => partnerProxy.getMyProfile(db, tenantId, partnerId),
    200,
    () => ({ notFederated: true }),
  );
});

// Mirrors the Network's PATCH /creators/me (src/routes/creators.ts
// updateMeSchema) so a partner can edit every field the creator portal
// can — including everything the Network's completeness bar checks.
const isoCountry = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'expected ISO-3166 alpha-2');
const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  handle: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .nullable()
    .optional(),
  avatarUrl: z.string().url().nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  profile: z.record(z.unknown()).optional(),
  categories: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(12).optional(),
  audienceLocations: z.array(isoCountry).max(5).optional(),
  audienceAgeRange: z.enum(['13-17', '18-24', '25-34', '35-44', '45-54', '55+']).nullable().optional(),
  audienceSize: z.enum(AUDIENCE_SIZES).nullable().optional(),
  portfolioLinks: z.array(z.string().url().max(500)).max(6).optional(),
  pastBrands: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
});

networkPartnerRouter.patch('/network/me/profile', requireAuth, async (req, res) => {
  const partnerId = requirePartnerPrincipal(req, res);
  if (!partnerId) return;
  const body = updateProfileSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  return proxy(req, res, (db, tenantId) => partnerProxy.updateMyProfile(db, tenantId, partnerId, body.data));
});

// ---------- Platforms + avatar (the rest of the completeness bar) ----------

// The Network validates the platform slug and body; we only keep the path
// segment to something that can't escape /creators/me/platforms/.
const platformParam = z.string().regex(/^[a-z]{2,20}$/);

networkPartnerRouter.get('/network/me/platforms', requireAuth, async (req, res) => {
  const partnerId = requirePartnerPrincipal(req, res);
  if (!partnerId) return;
  return proxy(
    req,
    res,
    (db, tenantId) => partnerProxy.listMyPlatforms(db, tenantId, partnerId),
    200,
    () => ({ platforms: [] }),
  );
});

networkPartnerRouter.put('/network/me/platforms/:platform', requireAuth, async (req, res) => {
  const partnerId = requirePartnerPrincipal(req, res);
  if (!partnerId) return;
  const platform = platformParam.safeParse(req.params.platform);
  if (!platform.success) return res.status(400).json({ error: 'invalid_platform' });
  return proxy(req, res, (db, tenantId) =>
    partnerProxy.upsertMyPlatform(db, tenantId, partnerId, platform.data, req.body ?? {}),
  );
});

networkPartnerRouter.delete('/network/me/platforms/:platform', requireAuth, async (req, res) => {
  const partnerId = requirePartnerPrincipal(req, res);
  if (!partnerId) return;
  const platform = platformParam.safeParse(req.params.platform);
  if (!platform.success) return res.status(400).json({ error: 'invalid_platform' });
  return proxy(req, res, (db, tenantId) => partnerProxy.deleteMyPlatform(db, tenantId, partnerId, platform.data));
});

const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

networkPartnerRouter.post(
  '/network/me/uploads/avatar',
  // Same types + 2 MB cap as the Network's own endpoint (and the
  // /api/creator-api proxy). express.json() ignores image bodies.
  express.raw({ type: AVATAR_TYPES, limit: 2 * 1024 * 1024 }),
  requireAuth,
  async (req, res) => {
    const partnerId = requirePartnerPrincipal(req, res);
    if (!partnerId) return;
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!AVATAR_TYPES.includes(contentType)) return res.status(400).json({ error: 'unsupported_type' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'empty_body' });
    const image = req.body;
    return proxy(req, res, (db, tenantId) => partnerProxy.uploadMyAvatar(db, tenantId, partnerId, image, contentType));
  },
);
