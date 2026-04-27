import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  TABLES,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
} from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { makeSecret, redeliver } from '../webhook-dispatcher.js';
import { tenantOf } from '../tenancy.js';

export const webhooksRouter = Router();

const KNOWN_EVENTS = [
  'attribution.created',
  'commission.approved',
  'commission.paid',
  'commission.reversed',
  'payout.created',
  'partnership.approved',
  '*',
] as const;

const createSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(KNOWN_EVENTS)).min(1),
  label: z.string().max(80).optional(),
});

const updateSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum(KNOWN_EVENTS)).min(1).optional(),
  label: z.string().max(80).nullable().optional(),
  active: z.boolean().optional(),
});

// -------- Endpoints CRUD --------

webhooksRouter.post('/webhooks', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const secret = makeSecret();
  const id = ulid();
  await db<WebhookEndpointRow>(TABLES.WebhookEndpoint).insert({
    id,
    tenantId,
    url: body.data.url,
    secretPrefix: secret.prefix,
    secret: secret.plaintext,
    events: JSON.stringify(body.data.events) as unknown as never,
    label: body.data.label ?? null,
    active: true,
  });
  const endpoint = await db<WebhookEndpointRow>(TABLES.WebhookEndpoint).where({ id }).first();
  res.status(201).json({ endpoint: strip(endpoint!), secret: secret.plaintext });
});

webhooksRouter.get('/webhooks', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const endpoints = await db<WebhookEndpointRow>(TABLES.WebhookEndpoint).orderBy('createdAt', 'desc');
  res.json({ endpoints: endpoints.map(strip) });
});

webhooksRouter.get('/webhooks/:id', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const endpoint = await db<WebhookEndpointRow>(TABLES.WebhookEndpoint).where({ id: req.params.id }).first();
  if (!endpoint) return res.status(404).json({ error: 'not_found' });
  res.json({ endpoint: strip(endpoint) });
});

webhooksRouter.patch('/webhooks/:id', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const body = updateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const existing = await db<WebhookEndpointRow>(TABLES.WebhookEndpoint).where({ id: req.params.id }).first();
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const patch: Record<string, unknown> = {};
  if (body.data.url !== undefined) patch.url = body.data.url;
  if (body.data.events !== undefined) patch.events = JSON.stringify(body.data.events);
  if (body.data.label !== undefined) patch.label = body.data.label;
  if (body.data.active !== undefined) patch.active = body.data.active;

  await db<WebhookEndpointRow>(TABLES.WebhookEndpoint).where({ id: existing.id }).update(patch);
  const fresh = await db<WebhookEndpointRow>(TABLES.WebhookEndpoint).where({ id: existing.id }).first();
  res.json({ endpoint: strip(fresh!) });
});

webhooksRouter.delete('/webhooks/:id', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  // Soft-delete via active=false keeps the delivery history intact for
  // forensics. We also allow hard-delete via ?hard=1 in case an operator
  // explicitly wants the row gone.
  if (req.query.hard === '1') {
    await db(TABLES.WebhookDelivery).where({ endpointId: req.params.id }).del();
    await db(TABLES.WebhookEndpoint).where({ id: req.params.id }).del();
  } else {
    await db(TABLES.WebhookEndpoint).where({ id: req.params.id }).update({ active: false });
  }
  res.json({ ok: true });
});

// -------- Delivery log + retry --------

webhooksRouter.get('/webhooks/:id/deliveries', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const deliveries = await db<WebhookDeliveryRow>(TABLES.WebhookDelivery)
    .where({ endpointId: req.params.id })
    .orderBy('createdAt', 'desc')
    .limit(100);
  res.json({ deliveries });
});

webhooksRouter.post('/webhooks/:id/deliveries/:deliveryId/retry', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  // Verify the delivery actually belongs to this endpoint BEFORE firing
  // — the previous order re-delivered and only then checked, which
  // meant hitting /webhooks/A/.../retry with a delivery id that belonged
  // to endpoint B would silently re-fire B's webhook before surfacing
  // the mismatch.
  const existing = await db<WebhookDeliveryRow>(TABLES.WebhookDelivery)
    .where({ id: req.params.deliveryId! })
    .first();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (existing.endpointId !== req.params.id) return res.status(400).json({ error: 'endpoint_mismatch' });

  const delivery = await redeliver(tenantId, req.params.deliveryId!);
  if (!delivery) return res.status(404).json({ error: 'not_found' });
  res.json({ delivery });
});

function strip(e: WebhookEndpointRow): Omit<WebhookEndpointRow, 'secret'> {
  const { secret: _secret, ...rest } = e;
  return rest;
}
