import express, { Router } from 'express';
import { TABLES } from '@openpartner/db';
import { requireAuth, requireAdmin } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { fsStorageDir, getStorage, MAX_UPLOAD_BYTES, newUploadKey, UploadError, validateImageUpload } from '../storage.js';

export const uploadsRouter = Router();

// ---------- Brand logo upload ----------
//
// Single binary body: client sends the image as the raw request body,
// Content-Type header carries the mime, X-Tenant-Slug etc are pulled
// from the tenant middleware. Returns the public URL after writing to
// storage AND stamping it onto the Tenant row in one transactional-ish
// shot (file write first; if DB update fails the file is orphaned but
// harmless — no link to anything).
//
// Capped at 2 MB by validateImageUpload + the express.raw limit.
uploadsRouter.post(
  '/uploads/logo',
  express.raw({
    type: ['image/jpeg', 'image/png', 'image/webp'],
    limit: MAX_UPLOAD_BYTES,
  }),
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);

    // req.header() returns string | undefined and normalizes any
    // accidental array form, vs req.headers[name] which is typed as
    // string | string[] | undefined and creates a parameter-tampering
    // hazard if a client sends multiple Content-Type headers.
    let validated;
    try {
      validated = validateImageUpload(req.header('content-type'), req.body?.length ?? 0);
    } catch (err) {
      if (err instanceof UploadError) return res.status(400).json({ error: err.code, detail: err.message });
      throw err;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'empty_body' });
    }

    const key = newUploadKey(`tenants/${tenantId}/logos`, validated.ext);
    await getStorage().put(key, req.body, { contentType: validated.contentType });
    const url = getStorage().publicUrl(key);

    await db(TABLES.Tenant).where({ id: tenantId }).update({ logoUrl: url, updatedAt: new Date() });

    res.json({ logoUrl: url });
  },
);

// ---------- Static handler for FS backend ----------
//
// When OPENPARTNER_STORAGE_KIND=fs, files written by the route above
// need to be served. Mount express.static on /uploads pointing at the
// configured FS dir. No-op when on s3 (the bucket serves directly).
//
// Public — no auth — by design: avatars + logos are shown in
// unauthenticated contexts (creator profile pages, brand listings on
// the Network, etc.). The keys are random hex (16 bytes), so directory
// enumeration isn't feasible.
export function mountStaticUploads(app: import('express').Express): void {
  const dir = fsStorageDir();
  if (!dir) return;
  app.use(
    '/uploads',
    express.static(dir, {
      // Same cache header as S3 ACLs above. Keys change on every
      // re-upload so immutable is safe.
      maxAge: '365d',
      immutable: true,
      // Don't fall through to the next handler on 404 — return a clean
      // 404 instead of attempting to interpret /uploads/<key> as
      // something else further down the stack.
      fallthrough: false,
      // Don't ever serve a directory listing.
      index: false,
    }),
  );
}
