/**
 * Program marketplace media — cover image + video.
 *
 *   - POST /uploads/program-cover stores the image under this tenant's
 *     program-covers/ prefix and returns its URL
 *   - programs accept only a cover from that prefix, and only a YouTube /
 *     Vimeo / Loom video (stored as its canonical URL)
 *   - the listing sync sends both to the Network, dropping a non-https
 *     cover rather than failing the whole offering write
 *
 * Single-tenant mode against a fake Network. Skipped when DATABASE_URL is
 * unset, like the rest of the integration suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DEFAULT_TENANT_ID, TABLES, isTrustedEmbedUrl, parseVideoUrl } from '@openpartner/db';

const ADMIN_KEY = 'op_test_program_media_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';
const uploadDir = mkdtempSync(join(tmpdir(), 'op-program-covers-'));
process.env.OPENPARTNER_STORAGE_KIND = 'fs';
process.env.OPENPARTNER_STORAGE_FS_DIR = uploadDir;
process.env.OPENPARTNER_STORAGE_FS_PUBLIC_BASE = 'https://cdn.example.test/uploads';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { encryptSecret } = await import('../crypto.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const auth = { Authorization: `Bearer ${ADMIN_KEY}` };

const YT = 'dQw4w9WgXcQ';
const COVER_PREFIX = `https://cdn.example.test/uploads/tenants/${DEFAULT_TENANT_ID}/program-covers/`;

describe('program video parser (shared with the Network)', () => {
  it('canonicalizes allowlisted links and builds trusted embeds', () => {
    const v = parseVideoUrl(`youtu.be/${YT}?si=x`)!;
    expect(v.url).toBe(`https://www.youtube.com/watch?v=${YT}`);
    expect(isTrustedEmbedUrl(v.embedUrl)).toBe(true);
    expect(isTrustedEmbedUrl(parseVideoUrl('https://vimeo.com/76979871/abc123def0')!.embedUrl)).toBe(true);
    expect(isTrustedEmbedUrl(parseVideoUrl(`https://www.loom.com/share/${'a'.repeat(32)}`)!.embedUrl)).toBe(true);
  });

  it('rejects other hosts and refuses foreign embed URLs', () => {
    expect(parseVideoUrl('https://example.com/clip.mp4')).toBeNull();
    expect(parseVideoUrl(`https://youtube.com.evil.example/watch?v=${YT}`)).toBeNull();
    expect(isTrustedEmbedUrl('https://evil.example/embed')).toBe(false);
    expect(isTrustedEmbedUrl(`https://www.youtube-nocookie.com/embed/${YT}?rel=0&autoplay=1`)).toBe(false);
  });
});

// ----- fake Network -----

interface NetCall { method: string; path: string; body: Record<string, unknown> | null }
let netServer: Server;
let netUrl = '';
let netCalls: NetCall[] = [];
let savedMembership: unknown;
const createdProgramIds: string[] = [];

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    netServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        netCalls.push({ method: req.method ?? '', path: req.url ?? '', body });
        res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.method === 'POST' ? { id: 'off_media_1' } : { ok: true }));
      });
    }).listen(0, '127.0.0.1', () => {
      netUrl = `http://127.0.0.1:${(netServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
  // Federate the default tenant to the fake Network, keeping whatever
  // membership the local dev DB had so afterAll can put it back.
  savedMembership =
    (await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).first())?.value ??
    null;
  const value = {
    enabled: true,
    networkUrl: netUrl,
    vendorId: 'vnd_media_test',
    vendorTokenCiphertext: encryptSecret('vntok_test'),
    autoEnroll: true,
    scopedKeyId: null,
  };
  await db(TABLES.Config)
    .insert({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership', value: value as never, updatedAt: new Date() })
    .onConflict(['tenantId', 'key'])
    .merge({ value: value as never, updatedAt: new Date() });
});

beforeEach(() => {
  netCalls = [];
});

afterAll(async () => {
  if (netServer) await new Promise<void>((r) => netServer.close(() => r()));
  if (!skipIntegration) {
    if (createdProgramIds.length) await db(TABLES.Program).whereIn('id', createdProgramIds).del();
    if (savedMembership) {
      await db(TABLES.Config)
        .where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' })
        .update({ value: savedMembership as never, updatedAt: new Date() });
    } else {
      await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).del();
    }
  }
  await db.destroy();
  rmSync(uploadDir, { recursive: true, force: true });
});

async function uploadCover(): Promise<string> {
  const res = await request(app)
    .post('/uploads/program-cover')
    .set(auth)
    .set('Content-Type', 'image/png')
    .send(Buffer.from('not-really-a-png-but-the-bytes-are-opaque'));
  expect(res.status).toBe(200);
  return res.body.url as string;
}

async function createProgram(extra: Record<string, unknown>) {
  const res = await request(app)
    .post('/programs')
    .set(auth)
    .send({
      name: 'Media Program',
      destinationUrl: 'https://brand.example.test',
      commissionRule: [{ trigger: 'every', type: 'percent', value: 20 }],
      shareOnNetwork: true,
      marketplaceDescription: 'A program with a cover and a video.',
      ...extra,
    });
  if (res.body?.id) createdProgramIds.push(res.body.id as string);
  return res;
}

const offeringWrite = (method: 'POST' | 'PATCH') =>
  netCalls.find((c) => c.method === method && c.path.startsWith('/vendors/me/offerings'));

describe.skipIf(skipIntegration)('program cover + video', () => {
  it('uploads a cover under the tenant prefix', async () => {
    const url = await uploadCover();
    expect(url.startsWith(COVER_PREFIX)).toBe(true);
    const key = url.slice('https://cdn.example.test/uploads/'.length);
    expect(existsSync(join(uploadDir, key))).toBe(true);
    // The static handler still serves reads — it just no longer swallows
    // the POST above (single-tenant upload routes live under /uploads).
    const served = await request(app).get(`/uploads/${key}`);
    expect(served.status).toBe(200);
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect((await request(app).get('/uploads/tenants/nope/missing.png')).status).toBe(404);
  });

  it('saves both and sends them to the Network on create and edit', async () => {
    const cover = await uploadCover();
    const created = await createProgram({ marketplaceCoverUrl: cover, marketplaceVideoUrl: `https://youtu.be/${YT}?si=t` });
    expect(created.status).toBe(201);
    expect(created.body.marketplaceCoverUrl).toBe(cover);
    expect(created.body.marketplaceVideoUrl).toBe(`https://www.youtube.com/watch?v=${YT}`);
    expect(offeringWrite('POST')?.body).toMatchObject({
      coverImageUrl: cover,
      videoUrl: `https://www.youtube.com/watch?v=${YT}`,
    });

    netCalls = [];
    const cleared = await request(app)
      .patch(`/programs/${created.body.id}`)
      .set(auth)
      .send({ marketplaceVideoUrl: null, marketplaceCoverUrl: cover });
    expect(cleared.status).toBe(200);
    expect(cleared.body.marketplaceVideoUrl).toBeNull();
    expect(offeringWrite('PATCH')?.body).toMatchObject({ coverImageUrl: cover, videoUrl: null });
  });

  it('rejects a cover we did not store and a non-allowlisted video', async () => {
    const foreign = await createProgram({ marketplaceCoverUrl: 'https://tracker.example/pixel.png' });
    expect(foreign.status).toBe(400);
    expect(foreign.body.detail.fieldErrors.marketplaceCoverUrl).toBeDefined();

    // Another tenant's prefix is just as foreign.
    const otherTenant = await createProgram({
      marketplaceCoverUrl: 'https://cdn.example.test/uploads/tenants/other/program-covers/x.png',
    });
    expect(otherTenant.status).toBe(400);

    const badVideo = await createProgram({ marketplaceVideoUrl: 'https://example.com/clip.mp4' });
    expect(badVideo.status).toBe(400);
    expect(badVideo.body.detail.fieldErrors.marketplaceVideoUrl).toBeDefined();

    const ok = await createProgram({});
    const badPatch = await request(app)
      .patch(`/programs/${ok.body.id}`)
      .set(auth)
      .send({ marketplaceCoverUrl: 'https://tracker.example/pixel.png' });
    expect(badPatch.status).toBe(400);
  });

  it('lists without a cover rather than failing the sync when the cover is plain http', async () => {
    const created = await createProgram({});
    // e.g. a self-host serving uploads over http, saved before this check.
    await db(TABLES.Program)
      .where({ id: created.body.id })
      .update({ marketplaceCoverUrl: `http://localhost:4601/uploads/tenants/${DEFAULT_TENANT_ID}/program-covers/a.png` });
    netCalls = [];
    const res = await request(app).patch(`/programs/${created.body.id}`).set(auth).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(offeringWrite('PATCH')?.body).toMatchObject({ title: 'Renamed', coverImageUrl: null });
  });
});
