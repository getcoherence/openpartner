import express, { Router } from 'express';
import { TABLES } from '@openpartner/db';
import { requireAuth, requireAdmin } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { sendHeartbeat } from '../network-client.js';
import { fsStorageDir, getStorage, MAX_UPLOAD_BYTES, newUploadKey, UploadError, validateImageUpload } from '../storage.js';
import { brandAssetUploadHandler, handleBrandAssetUpload } from './brand-resources.js';

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
    // Bind the raw body to a local and type-guard it BEFORE any .length
    // read — with express.raw a mismatched Content-Type leaves req.body as
    // {}, and CodeQL doesn't narrow req.body through the guard, so only
    // the guarded local is used below (js/type-confusion otherwise re-fires
    // on every fresh req.body read).
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'empty_body' });
    }
    let validated;
    try {
      validated = validateImageUpload(req.header('content-type'), body.length);
    } catch (err) {
      if (err instanceof UploadError) return res.status(400).json({ error: err.code, detail: err.message });
      throw err;
    }

    const key = newUploadKey(`tenants/${tenantId}/logos`, validated.ext);
    await getStorage().put(key, body, { contentType: validated.contentType });
    const url = getStorage().publicUrl(key);

    await db(TABLES.Tenant).where({ id: tenantId }).update({ logoUrl: url, updatedAt: new Date() });

    // Push the new logo to the Network now instead of waiting up to an
    // hour for the cron heartbeat. Brand admins upload then immediately
    // check the discover/offering pages — without this they see the old
    // (or missing) logo and assume something's broken. Fire-and-forget
    // so a Network blip doesn't fail the upload.
    sendHeartbeat(db, tenantId).catch((err) => {
      console.error('[uploads/logo] opportunistic heartbeat failed', err);
    });

    res.json({ logoUrl: url });
  },
);

// ---------- Favicon upload ----------
//
// Same flow as /uploads/logo, stamped onto Tenant.faviconUrl. Kept as a
// separate field because logos are lockups/wordmarks while favicons are
// square marks — one image rarely works as both. PNG/JPEG/WebP only (no
// SVG/ICO: SVG is a script vector and browsers render PNG favicons fine).
uploadsRouter.post(
  '/uploads/favicon',
  express.raw({
    type: ['image/jpeg', 'image/png', 'image/webp'],
    limit: MAX_UPLOAD_BYTES,
  }),
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    // Bind the raw body to a local and type-guard it BEFORE any .length
    // read — with express.raw a mismatched Content-Type leaves req.body as
    // {}, and CodeQL doesn't narrow req.body through the guard, so only
    // the guarded local is used below (js/type-confusion otherwise re-fires
    // on every fresh req.body read).
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'empty_body' });
    }
    let validated;
    try {
      validated = validateImageUpload(req.header('content-type'), body.length);
    } catch (err) {
      if (err instanceof UploadError) return res.status(400).json({ error: err.code, detail: err.message });
      throw err;
    }
    const key = newUploadKey(`tenants/${tenantId}/favicons`, validated.ext);
    await getStorage().put(key, body, { contentType: validated.contentType });
    const url = getStorage().publicUrl(key);
    await db(TABLES.Tenant).where({ id: tenantId }).update({ faviconUrl: url, updatedAt: new Date() });
    res.json({ faviconUrl: url });
  },
);

// ---------- Brand asset image upload ----------
//
// Same pattern as /uploads/logo but the URL goes back to the client
// instead of being stamped on Tenant. The client then posts to
// /brand-resources/images with the URL + a label to attach metadata.
uploadsRouter.post(
  '/uploads/brand-asset',
  brandAssetUploadHandler,
  requireAuth,
  requireAdmin,
  handleBrandAssetUpload,
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
