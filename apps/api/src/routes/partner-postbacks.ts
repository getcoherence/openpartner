/**
 * Partner postback URL CRUD.
 *
 * Both the partner (managing their own tracker callback) and the brand
 * admin (managing on a partner's behalf) hit the same routes; the
 * `requirePartnerOrAdmin('id')` guard scopes access to the partner
 * named in the URL.
 *
 * Allowlist-only: events must be the partner's own earnings, commission.*
 * (the conversion ledger) or bonus.awarded / bonus.paid. partner-state
 * events stay tenant-scoped via the WebhookEndpoint surface and don't make
 * sense to send to an affiliate tracker.
 *
 * The URL holds the partner's tracker secret, so it is sealed at rest
 * (postback-url.ts) and no response here carries it, except GET
 * …/:postbackId/url, which answers the partner who owns it and nobody
 * else, for the edit form. Everything else shows `urlPreview`, the URL
 * with its path and query values masked. An admin can still replace a
 * partner's URL, without seeing the one it replaces.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  TABLES,
  type PartnerPostbackEvent,
  type PartnerPostbackRow,
} from '@openpartner/db';
import { requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { isPostbackEvent, postbackEventsList } from '../partner-postback.js';
import { checkOutboundDestination } from '../outbound-guard.js';
import { openPostbackUrl, postbackUrlPreview, storedPostbackUrl } from '../postback-url.js';

const URL_MAX = 2048;

const eventSchema = z
  .string()
  .refine(isPostbackEvent, { message: 'event must be one of commission.*, bonus.awarded or bonus.paid' });

const createSchema = z.object({
  url: z.string().url().max(URL_MAX),
  events: z.array(eventSchema).min(1).max(10),
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  url: z.string().url().max(URL_MAX).optional(),
  events: z.array(eventSchema).min(1).max(10).optional(),
  enabled: z.boolean().optional(),
});

/** A postback as every response shows it: `url` swapped for its preview.
 *  `url` is left out rather than masked, so a client that sends a row it
 *  read back can't overwrite the real URL with the masked one. */
export type PostbackView = Omit<PartnerPostbackRow, 'url' | 'urlPreview'> & { urlPreview: string | null };

export function postbackView(row: PartnerPostbackRow): PostbackView {
  const { url: _sealed, urlPreview: _stored, ...rest } = row;
  return { ...rest, urlPreview: postbackUrlPreview(row) };
}

/** The partner named in the route, signed in as themselves (not an
 *  admin acting for them). */
function isOwningPartner(req: Request): boolean {
  const p = req.principal;
  return p?.role === 'partner' && p.partnerId === req.params.id;
}

export const partnerPostbacksRouter = Router();

partnerPostbacksRouter.get(
  '/partners/:id/postbacks',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const rows = await db<PartnerPostbackRow>(TABLES.PartnerPostback)
      .where({ tenantId, partnerId: req.params.id })
      .orderBy('createdAt', 'desc');
    res.json({ postbacks: rows.map(postbackView), supportedEvents: postbackEventsList() });
  },
);

/**
 * The URL itself, for the partner's edit form. Only the partner who owns
 * it: an admin managing a partner's postbacks sees the preview and can
 * replace the URL, but never reads it. 409 `url_unreadable` when it was
 * sealed under another deployment's key; the partner enters it again.
 */
partnerPostbacksRouter.get(
  '/partners/:id/postbacks/:postbackId/url',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    if (!isOwningPartner(req)) return res.status(403).json({ error: 'partner_only' });
    const { db, tenantId } = tenantOf(req);
    const row = await db<PartnerPostbackRow>(TABLES.PartnerPostback)
      .where({ id: req.params.postbackId, tenantId, partnerId: req.params.id })
      .first('url');
    if (!row) return res.status(404).json({ error: 'postback_not_found' });
    const url = openPostbackUrl(row.url);
    res.set('cache-control', 'no-store');
    if (!url) return res.status(409).json({ error: 'url_unreadable' });
    res.json({ url });
  },
);

partnerPostbacksRouter.post(
  '/partners/:id/postbacks',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = createSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const partner = await db(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });
    // Same check every fire runs (partner trust: never the private-CIDR
    // escape hatch), so a URL no fire could reach is refused up front.
    const refused = await checkOutboundDestination(body.data.url, 'partner');
    if (refused) return res.status(400).json({ error: 'destination_not_allowed', ...refused });

    const id = ulid();
    const [row] = await db<PartnerPostbackRow>(TABLES.PartnerPostback)
      .insert({
        id,
        tenantId,
        partnerId: req.params.id,
        ...storedPostbackUrl(body.data.url),
        events: JSON.stringify(body.data.events) as unknown as PartnerPostbackEvent[],
        enabled: body.data.enabled ?? true,
      })
      .returning('*');
    res.status(201).json(postbackView(row!));
  },
);

partnerPostbacksRouter.patch(
  '/partners/:id/postbacks/:postbackId',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = updateSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    if (body.data.url !== undefined) {
      const refused = await checkOutboundDestination(body.data.url, 'partner');
      if (refused) return res.status(400).json({ error: 'destination_not_allowed', ...refused });
    }

    const patch: Partial<PartnerPostbackRow> = { updatedAt: new Date() };
    if (body.data.url !== undefined) Object.assign(patch, storedPostbackUrl(body.data.url));
    if (body.data.events !== undefined) {
      patch.events = JSON.stringify(body.data.events) as unknown as PartnerPostbackEvent[];
    }
    if (body.data.enabled !== undefined) patch.enabled = body.data.enabled;

    const updated = await db<PartnerPostbackRow>(TABLES.PartnerPostback)
      .where({ id: req.params.postbackId, tenantId, partnerId: req.params.id })
      .update(patch)
      .returning('*');
    if (updated.length === 0) return res.status(404).json({ error: 'postback_not_found' });
    res.json(postbackView(updated[0]!));
  },
);

partnerPostbacksRouter.delete(
  '/partners/:id/postbacks/:postbackId',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const deleted = await db(TABLES.PartnerPostback)
      .where({ id: req.params.postbackId, tenantId, partnerId: req.params.id })
      .del();
    if (deleted === 0) return res.status(404).json({ error: 'postback_not_found' });
    res.status(204).send();
  },
);
