/**
 * Brand resources surface for partners.
 *
 * Brands upload images and write short text snippets via the admin UI;
 * partners list them in their portal (read-only) and use them in their
 * own content. Two storage shapes:
 *
 *   image    file uploaded via /uploads/brand-asset (sister to /uploads/logo).
 *            BrandAsset row carries the public URL.
 *   snippet  plain text body kept inline on the row. No upload step.
 *
 * Documents (PDFs etc.) are deferred — the DB CHECK constraint allows
 * `kind='document'`, but the API and admin UI don't expose creation paths
 * for them yet. Adding later is column-compatible.
 *
 * Per-tenant ordering: sortOrder is a 0..N integer the admin can drag-
 * shuffle. New rows go to the end (max + 1). Reorder calls accept a full
 * list of asset ids and rewrite sortOrder densely so we don't have to
 * deal with collisions or gaps.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  TABLES,
  type BrandAssetRow,
  type ConfigRow,
  type TenantRow,
} from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import {
  MAX_UPLOAD_BYTES,
  UploadError,
  getStorage,
  newUploadKey,
  validateImageUpload,
} from '../storage.js';

export const brandResourcesRouter = Router();

/** "Any authenticated principal in this tenant" — both admins and partners
 *  can list brand resources. requirePartnerOrAdmin in auth.ts gates on a
 *  specific :partnerId param, which we don't have here; this is the looser
 *  authenticated-in-tenant gate. */
function requireAnyAuthenticated(req: Request, res: Response, next: NextFunction): void {
  const p = req.principal;
  if (!p) return void res.status(401).json({ error: 'unauthorized' });
  if (p.role === 'admin' || p.role === 'partner') return next();
  res.status(403).json({ error: 'forbidden' });
}

// ---------- List (partner-readable + Network-federated) ----------
//
// Three caller paths:
//   - Admin (session/env/db key) — managing assets from the Settings UI
//   - Partner (session) — rendering the Resources tab in the brand-managed
//     partner portal
//   - Scoped api-key with partners:read — the OpenPartner Network proxying
//     on behalf of a creator viewing the program in their multi-vendor
//     dashboard. grantScope rewrites the principal to admin if the scope
//     check passes, so the downstream auth gate doesn't have to know.
//
// Response combines tenant-level brand fields (color, terms URL, support
// email, logo) with the per-tenant asset list. Single call so the
// Network can populate the creator's Resources tab + support footer
// without round-tripping twice.
brandResourcesRouter.get(
  '/brand-resources',
  requireAuth,
  grantScope('partners:read'),
  requireAnyAuthenticated,
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const tenant = await db<TenantRow>(TABLES.Tenant)
      .where({ id: tenantId })
      .first(['displayName', 'logoUrl', 'brandColor', 'programTermsUrl']);

    // supportEmail lives on Config under the same program_settings blob
    // the Settings page writes to. Pull it inline so callers get one
    // authoritative brand block.
    const programConfig = await db<ConfigRow>(TABLES.Config)
      .where({ tenantId, key: 'program_settings' })
      .first();
    const programValue = (programConfig?.value ?? {}) as { supportEmail?: string | null };

    const rows = await db<BrandAssetRow>(TABLES.BrandAsset)
      .where({ tenantId })
      .orderBy('sortOrder', 'asc')
      .orderBy('createdAt', 'asc');

    res.json({
      brand: {
        displayName: tenant?.displayName ?? null,
        logoUrl: tenant?.logoUrl ?? null,
        brandColor: tenant?.brandColor ?? null,
        programTermsUrl: tenant?.programTermsUrl ?? null,
        supportEmail: programValue.supportEmail ?? null,
      },
      assets: rows.map(serializeAsset),
    });
  },
);

// ---------- Create snippet ----------

const createSnippetSchema = z.object({
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  body: z.string().trim().min(1).max(4000),
});

brandResourcesRouter.post(
  '/brand-resources/snippets',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = createSnippetSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const nextOrder = await nextSortOrder(db, tenantId);
    const id = ulid();
    await db<BrandAssetRow>(TABLES.BrandAsset).insert({
      id,
      tenantId,
      kind: 'snippet',
      label: body.data.label,
      description: body.data.description ?? null,
      body: body.data.body,
      url: null,
      sortOrder: nextOrder,
    });
    const row = await db<BrandAssetRow>(TABLES.BrandAsset).where({ id }).first();
    res.status(201).json({ asset: serializeAsset(row!) });
  },
);

// ---------- Create image (multipart-free binary body, like /uploads/logo) ----------
//
// Two-step over the wire because the image bytes are large and we don't
// want JSON-base64. Client:
//   1. POST /uploads/brand-asset with raw image bytes; returns { url }
//   2. POST /brand-resources/images with { label, url, description }
// Step 1 lives in uploads.ts so the express.raw middleware stays scoped.

const createImageSchema = z.object({
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  url: z.string().trim().url().max(2048),
});

brandResourcesRouter.post(
  '/brand-resources/images',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = createImageSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const nextOrder = await nextSortOrder(db, tenantId);
    const id = ulid();
    await db<BrandAssetRow>(TABLES.BrandAsset).insert({
      id,
      tenantId,
      kind: 'image',
      label: body.data.label,
      description: body.data.description ?? null,
      url: body.data.url,
      body: null,
      sortOrder: nextOrder,
    });
    const row = await db<BrandAssetRow>(TABLES.BrandAsset).where({ id }).first();
    res.status(201).json({ asset: serializeAsset(row!) });
  },
);

// ---------- Update (label, description, snippet body) ----------
//
// Image bytes are immutable post-upload — to change an image, delete and
// re-upload. Keeps the storage-URL lifecycle simple (one URL = one
// uploaded blob, never rewritten).

const updateSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).optional().or(z.literal('')),
  body: z.string().trim().min(1).max(4000).optional(),
});

brandResourcesRouter.patch(
  '/brand-resources/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = updateSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const existing = await db<BrandAssetRow>(TABLES.BrandAsset)
      .where({ id: req.params.id, tenantId })
      .first();
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const patch: Partial<BrandAssetRow> = { updatedAt: new Date() };
    if (body.data.label !== undefined) patch.label = body.data.label;
    if (body.data.description !== undefined) {
      patch.description = body.data.description.trim() ? body.data.description : null;
    }
    // body only writable on snippets; ignoring on image avoids tripping the
    // url/body xor check constraint.
    if (body.data.body !== undefined && existing.kind === 'snippet') {
      patch.body = body.data.body;
    }
    await db<BrandAssetRow>(TABLES.BrandAsset).where({ id: existing.id }).update(patch);
    const row = await db<BrandAssetRow>(TABLES.BrandAsset).where({ id: existing.id }).first();
    res.json({ asset: serializeAsset(row!) });
  },
);

// ---------- Reorder ----------

const reorderSchema = z.object({
  ids: z.array(z.string().min(1)).max(200),
});

brandResourcesRouter.post(
  '/brand-resources/reorder',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = reorderSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    // Re-stamp sortOrder densely from the supplied order. Assets not in
    // the list keep their previous sortOrder (and end up either before or
    // after depending on numeric collision) — practical when admins
    // reorder via drag and only the visible page is sent.
    await db.transaction(async (trx) => {
      for (let i = 0; i < body.data.ids.length; i += 1) {
        await trx<BrandAssetRow>(TABLES.BrandAsset)
          .where({ id: body.data.ids[i]!, tenantId })
          .update({ sortOrder: i, updatedAt: new Date() });
      }
    });
    res.json({ ok: true });
  },
);

// ---------- Delete ----------
//
// Image rows leave the underlying storage blob in place — we never delete
// from object storage from a tenant-facing endpoint. Orphaned blobs are
// harmless (small, infrequent) and the bucket has its own lifecycle policy.

brandResourcesRouter.delete(
  '/brand-resources/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const deleted = await db<BrandAssetRow>(TABLES.BrandAsset)
      .where({ id: req.params.id, tenantId })
      .del();
    if (deleted === 0) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  },
);

// ---------- Image upload endpoint ----------
//
// Lives alongside /uploads/logo. Returns the storage URL; the client then
// hits /brand-resources/images with that URL + a label.

export const brandAssetUploadHandler = express.raw({
  type: ['image/jpeg', 'image/png', 'image/webp'],
  limit: MAX_UPLOAD_BYTES,
});

export async function handleBrandAssetUpload(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const { tenantId } = tenantOf(req);
  // Prove the body is a Buffer BEFORE reading .length — with express.raw
  // a mismatched Content-Type leaves req.body as {} (and CodeQL rightly
  // wants the type check ahead of the read).
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: 'empty_body' });
    return;
  }
  let validated;
  try {
    validated = validateImageUpload(req.header('content-type'), req.body.length);
  } catch (err) {
    if (err instanceof UploadError) {
      res.status(400).json({ error: err.code, detail: err.message });
      return;
    }
    throw err;
  }
  const key = newUploadKey(`tenants/${tenantId}/brand-assets`, validated.ext);
  await getStorage().put(key, req.body, { contentType: validated.contentType });
  const url = getStorage().publicUrl(key);
  res.json({ url });
}

// ---------- helpers ----------

async function nextSortOrder(db: Knex, tenantId: string): Promise<number> {
  const row = await db<BrandAssetRow>(TABLES.BrandAsset)
    .where({ tenantId })
    .max<{ max: number | null }[]>({ max: 'sortOrder' });
  const max = row[0]?.max;
  return typeof max === 'number' ? max + 1 : 0;
}

function serializeAsset(row: BrandAssetRow) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    description: row.description,
    url: row.url,
    body: row.body,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
