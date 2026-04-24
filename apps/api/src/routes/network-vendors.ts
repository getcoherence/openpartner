import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type NetworkVendorRow } from '@openpartner/db';
import { db } from '../db.js';
import { createApiKeyRow, requireAdmin, requireAuth, requireNetworkVendor } from '../auth.js';
import { encryptKey } from '../network/crypto.js';
import { vendorCreateSchema } from '../network/validation.js';
import { NETWORK_FEDERATION_SCOPES } from './api-keys.js';

export const networkVendorsRouter = Router();

const verifyKeySchema = z.object({
  instanceUrl: z.string().url(),
  instanceKey: z.string().min(8),
});

/**
 * Server-side introspection helper. Before an admin registers a vendor,
 * the onboarding UI calls this to check the key the vendor pasted. We
 * hit the vendor's own /auth/introspect with that key and report back.
 *
 * Why this exists: we strongly prefer vendors hand us a SCOPED key with
 * only the federation permissions (partners:write, links:write,
 * partners:read, commissions:read). If they paste a full admin key we
 * want to warn them so they can go mint a scoped one instead.
 */
// Intentionally open (no auth) — useful during the unauthenticated vendor
// signup flow so the prospective vendor can sanity-check the key they're
// about to hand over. The caller must already know the key + instance
// URL, so this grants nothing they don't already have. We only proxy
// GET /auth/introspect (narrow surface), not arbitrary URLs.
networkVendorsRouter.post('/network/vendors/verify-key', async (req, res) => {
  const body = verifyKeySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const { instanceUrl, instanceKey } = body.data;
  const url = `${instanceUrl.replace(/\/$/, '')}/auth/introspect`;
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${instanceKey}` } });
    const text = await response.text();
    if (!response.ok) {
      return res.status(502).json({
        error: 'instance_rejected_key',
        status: response.status,
        detail: text.slice(0, 300),
      });
    }
    const introspect = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    const required = [...NETWORK_FEDERATION_SCOPES] as string[];
    const scopes = Array.isArray(introspect.scopes) ? (introspect.scopes as string[]) : null;
    const missing = scopes ? required.filter((s) => !scopes.includes(s)) : [];
    const unrestricted = introspect.role === 'admin' && introspect.unrestricted === true;

    res.json({
      ok: true,
      instanceUrl,
      introspect,
      recommended: required,
      missing,
      unrestricted,
      // Green — "good to register":
      acceptable: (scopes != null && missing.length === 0) || unrestricted,
    });
  } catch (err: unknown) {
    res.status(502).json({
      error: 'instance_unreachable',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// -------- Admin: list + create + activate --------

networkVendorsRouter.get('/network/vendors', requireAuth, requireAdmin, async (_req, res) => {
  const vendors = await db<NetworkVendorRow>(TABLES.NetworkVendor).orderBy('createdAt', 'desc');
  res.json({ vendors: vendors.map(stripKey) });
});

// Vendor self-registration is admin-gated for MVP — keeps quality high
// before we have Stripe-based paid tiers on the Network.
networkVendorsRouter.post('/network/vendors', requireAuth, requireAdmin, async (req, res) => {
  const body = vendorCreateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const id = ulid();
  const prefix = body.data.instanceKey.slice(0, 8);
  const ciphertext = encryptKey(body.data.instanceKey);

  try {
    await db<NetworkVendorRow>(TABLES.NetworkVendor).insert({
      id,
      name: body.data.name,
      slug: body.data.slug,
      websiteUrl: body.data.websiteUrl ?? null,
      logoUrl: body.data.logoUrl ?? null,
      description: body.data.description ?? null,
      instanceUrl: body.data.instanceUrl.replace(/\/$/, ''),
      instanceKeyCiphertext: ciphertext,
      instanceKeyPrefix: prefix,
      routerUrl: body.data.routerUrl ? body.data.routerUrl.replace(/\/$/, '') : null,
      status: 'pending',
    });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'slug_taken' });
    }
    throw err;
  }

  // Issue a vendor-scoped API key so the merchant can sign in to the
  // Network-side UI without needing admin rights.
  const key = await createApiKeyRow({ networkVendorId: id, label: 'vendor portal' });

  const vendor = await db<NetworkVendorRow>(TABLES.NetworkVendor).where({ id }).first();
  res.status(201).json({
    vendor: stripKey(vendor!),
    apiKey: key.plaintext, // shown once
  });
});

networkVendorsRouter.post('/network/vendors/:id/activate', requireAuth, requireAdmin, async (req, res) => {
  const updated = await db<NetworkVendorRow>(TABLES.NetworkVendor)
    .where({ id: req.params.id })
    .update({ status: 'active', activatedAt: new Date() })
    .returning('*');
  if (updated.length === 0) return res.status(404).json({ error: 'vendor_not_found' });
  res.json({ vendor: stripKey(updated[0]!) });
});

networkVendorsRouter.post('/network/vendors/:id/suspend', requireAuth, requireAdmin, async (req, res) => {
  const updated = await db<NetworkVendorRow>(TABLES.NetworkVendor)
    .where({ id: req.params.id })
    .update({ status: 'suspended' })
    .returning('*');
  if (updated.length === 0) return res.status(404).json({ error: 'vendor_not_found' });
  res.json({ vendor: stripKey(updated[0]!) });
});

// -------- Vendor: view self --------

networkVendorsRouter.get('/network/vendors/me', requireAuth, requireNetworkVendor, async (req, res) => {
  const p = req.principal!;
  if (p.role !== 'network_vendor') return res.status(403).json({ error: 'forbidden' });
  const vendor = await db<NetworkVendorRow>(TABLES.NetworkVendor).where({ id: p.networkVendorId }).first();
  if (!vendor) return res.status(404).json({ error: 'vendor_not_found' });
  res.json({ vendor: stripKey(vendor) });
});

// -------- Public-ish: browse active vendors --------

networkVendorsRouter.get('/network/directory/vendors', async (_req, res) => {
  const vendors = await db<NetworkVendorRow>(TABLES.NetworkVendor)
    .where({ status: 'active' })
    .orderBy('createdAt', 'desc')
    .select('id', 'name', 'slug', 'websiteUrl', 'logoUrl', 'description');
  res.json({ vendors });
});

function stripKey(v: NetworkVendorRow): Omit<NetworkVendorRow, 'instanceKeyCiphertext'> & { instanceKeyPrefix: string } {
  const { instanceKeyCiphertext: _omit, ...rest } = v;
  return rest;
}
