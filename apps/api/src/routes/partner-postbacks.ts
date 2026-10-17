/**
 * Partner postback URL CRUD.
 *
 * Both the partner (managing their own tracker callback) and the brand
 * admin (managing on a partner's behalf) hit the same routes; the
 * `requirePartnerOrAdmin('id')` guard scopes access to the partner
 * named in the URL.
 *
 * Allowlist-only: events must be commission.* (the conversion ledger).
 * partner-state events stay tenant-scoped via the WebhookEndpoint
 * surface and don't make sense to send to an affiliate tracker.
 */

import { Router } from 'express';
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

const URL_MAX = 2048;

const eventSchema = z
  .string()
  .refine(isPostbackEvent, { message: 'event must be one of commission.*' });

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

export const partnerPostbacksRouter = Router();

partnerPostbacksRouter.get(
  '/partners/:id/postbacks',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db } = tenantOf(req);
    const rows = await db<PartnerPostbackRow>(TABLES.PartnerPostback)
      .where({ partnerId: req.params.id })
      .orderBy('createdAt', 'desc');
    res.json({ postbacks: rows, supportedEvents: postbackEventsList() });
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

    const partner = await db(TABLES.Partner).where({ id: req.params.id }).first();
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });

    const id = ulid();
    const [row] = await db<PartnerPostbackRow>(TABLES.PartnerPostback)
      .insert({
        id,
        tenantId,
        partnerId: req.params.id,
        url: body.data.url,
        events: JSON.stringify(body.data.events) as unknown as PartnerPostbackEvent[],
        enabled: body.data.enabled ?? true,
      })
      .returning('*');
    res.status(201).json(row);
  },
);

partnerPostbacksRouter.patch(
  '/partners/:id/postbacks/:postbackId',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db } = tenantOf(req);
    const body = updateSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const patch: Partial<PartnerPostbackRow> = { updatedAt: new Date() };
    if (body.data.url !== undefined) patch.url = body.data.url;
    if (body.data.events !== undefined) {
      patch.events = JSON.stringify(body.data.events) as unknown as PartnerPostbackEvent[];
    }
    if (body.data.enabled !== undefined) patch.enabled = body.data.enabled;

    const updated = await db<PartnerPostbackRow>(TABLES.PartnerPostback)
      .where({ id: req.params.postbackId, partnerId: req.params.id })
      .update(patch)
      .returning('*');
    if (updated.length === 0) return res.status(404).json({ error: 'postback_not_found' });
    res.json(updated[0]);
  },
);

partnerPostbacksRouter.delete(
  '/partners/:id/postbacks/:postbackId',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db } = tenantOf(req);
    const deleted = await db(TABLES.PartnerPostback)
      .where({ id: req.params.postbackId, partnerId: req.params.id })
      .del();
    if (deleted === 0) return res.status(404).json({ error: 'postback_not_found' });
    res.status(204).send();
  },
);
