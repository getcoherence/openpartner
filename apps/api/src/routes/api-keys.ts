import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type ApiKeyRow } from '@openpartner/db';
import { createApiKeyRow, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { tenantOf } from '../tenancy.js';

const createSchema = z.object({ label: z.string().optional() });

const scopedCreateSchema = z.object({
  scopes: z.array(z.string().min(3).max(64)).min(1),
  label: z.string().optional(),
});

// Canonical minimum scope set for joining the OpenPartner Network.
// Kept here so the federation code and the portal's docs agree.
export const NETWORK_FEDERATION_SCOPES = [
  'partners:write',
  'partners:read',
  'links:write',
  'commissions:read',
  // Network pushes federated clicks (creator-domain traffic) back to
  // the vendor instance so brand-side analytics still see them.
  'clicks:write',
] as const;

export const apiKeysRouter = Router();

// Admin: create admin key (ADMIN_API_KEY env is the first-class bootstrap; this is for rotation).
apiKeysRouter.post('/api-keys', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const key = await createApiKeyRow(db, { tenantId, partnerId: null, label: body.data.label ?? undefined });
  res.status(201).json({ id: key.id, plaintext: key.plaintext });
});

// Admin: create a SCOPED key. Recommended for server-to-server
// integrations (OpenPartner Network federation is the canonical example)
// so a leak of the stored credential can't escalate to full admin.
apiKeysRouter.post('/api-keys/scoped', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = scopedCreateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const key = await createApiKeyRow(db, { tenantId, scopes: body.data.scopes, label: body.data.label ?? 'scoped' });
  res.status(201).json({ id: key.id, plaintext: key.plaintext, scopes: body.data.scopes });
});

// Admin: list scoped keys (optionally filtered by ?scope=...). Used by
// the CRM integration page so admins can see / revoke the keys they've
// minted for HubSpot / Zapier / etc. Doesn't return plaintext (only
// generated at create time and never stored).
const listQuerySchema = z.object({ scope: z.string().optional() });
apiKeysRouter.get('/api-keys', requireAuth, requireAdmin, async (req, res) => {
  const q = listQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });
  const { db } = tenantOf(req);
  const query = db<ApiKeyRow>(TABLES.ApiKey).whereNotNull('scopes').orderBy('createdAt', 'desc');
  const rows = await query.select('id', 'prefix', 'label', 'scopes', 'createdAt', 'lastUsedAt', 'revokedAt');
  const filtered = q.data.scope ? rows.filter((r) => Array.isArray(r.scopes) && r.scopes.includes(q.data.scope!)) : rows;
  res.json({ apiKeys: filtered });
});

// Admin or the partner themselves: create a partner-scoped key.
apiKeysRouter.post(
  '/partners/:id/api-keys',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = createSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
    const partnerId = req.params.id!;
    const partner = await db(TABLES.Partner).where({ id: partnerId }).first();
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });
    const key = await createApiKeyRow(db, { tenantId, partnerId, label: body.data.label });
    res.status(201).json({ id: key.id, plaintext: key.plaintext });
  },
);

apiKeysRouter.get(
  '/partners/:id/api-keys',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db } = tenantOf(req);
    const keys = await db<ApiKeyRow>(TABLES.ApiKey)
      .where({ partnerId: req.params.id })
      .select('id', 'prefix', 'label', 'createdAt', 'lastUsedAt', 'revokedAt')
      .orderBy('createdAt', 'desc');
    res.json({ apiKeys: keys });
  },
);

// Revoke. Admin can revoke any key; partner can only revoke their own.
apiKeysRouter.delete('/api-keys/:keyId', requireAuth, async (req, res) => {
  const { db } = tenantOf(req);
  const key = await db<ApiKeyRow>(TABLES.ApiKey).where({ id: req.params.keyId }).first();
  if (!key) return res.status(404).json({ error: 'not_found' });

  const p = req.principal!;
  const allowed = p.role === 'admin' || (p.role === 'partner' && key.partnerId === p.partnerId);
  if (!allowed) return res.status(403).json({ error: 'forbidden' });

  await db<ApiKeyRow>(TABLES.ApiKey).where({ id: key.id }).update({ revokedAt: new Date() });
  res.json({ ok: true });
});
