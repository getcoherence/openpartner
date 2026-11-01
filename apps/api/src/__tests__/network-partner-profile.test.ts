/**
 * Partner-role proxies for editing the partner's Network profile from the
 * brand portal: everything the Network's completeness bar checks (handle,
 * avatar, bio, categories, platforms) plus the audience fields and the cover.
 *
 *   PATCH  /network/me/profile              → PATCH  /creators/me
 *   GET    /network/me/platforms            → GET    /creators/me/platforms
 *   PUT    /network/me/platforms/:platform  → PUT    /creators/me/platforms/:platform
 *   DELETE /network/me/platforms/:platform  → DELETE /creators/me/platforms/:platform
 *   POST   /network/me/platforms/:platform/verify/start → same path on the Network
 *   POST   /network/me/platforms/:platform/verify       → same path on the Network
 *   POST   /network/me/uploads/avatar       → POST   /creators/me/uploads/avatar (raw image)
 *   POST   /network/me/uploads/cover        → POST   /creators/me/uploads/cover (raw image)
 *   POST   /network/me/cover/youtube        → POST   /creators/me/cover/youtube
 *
 * Each acts as the signed-in partner (vendor bearer + x-act-as-vendor-partner),
 * exactly like the existing /network/me/profile GET. A local HTTP server
 * plays the Network. Skipped if DATABASE_URL isn't set.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { encryptSecret } from '../crypto.js';
import { createSession } from '../auth-sessions.js';

const ADMIN_KEY = 'op_test_network_profile_0123456789abcdef01';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';
process.env.OPENPARTNER_TENANCY = process.env.OPENPARTNER_TENANCY ?? 'single';
process.env.PORTAL_URL = process.env.PORTAL_URL ?? 'http://localhost:5673';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

interface NetCall {
  method: string;
  path: string;
  contentType: string | undefined;
  actingAs: string | undefined;
  authorization: string | undefined;
  raw: Buffer;
}

let receiver: Server;
let receiverUrl: string;
const calls: NetCall[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: { ok: true } };

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        calls.push({
          method: req.method ?? '',
          path: req.url ?? '',
          contentType: req.headers['content-type'],
          actingAs: req.headers['x-act-as-vendor-partner'] as string | undefined,
          authorization: req.headers.authorization,
          raw: Buffer.concat(chunks),
        });
        res.writeHead(nextResponse.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(nextResponse.body));
      });
    }).listen(0, '127.0.0.1', () => {
      receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (receiver) await new Promise<void>((r) => receiver.close(() => r()));
  // Membership makes POST /programs default shareOnNetwork on (and then
  // demand a marketplaceDescription) — don't leave it, or the last test's
  // partner (its consent cascades), for later files.
  if (!skipIntegration) {
    await db(TABLES.Session).where({ tenantId: DEFAULT_TENANT_ID }).del();
    await db(TABLES.Partner).where({ tenantId: DEFAULT_TENANT_ID }).del();
    await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).del();
  }
  await db.destroy();
});

let partnerId: string;
let cookie: string;

beforeEach(async () => {
  if (skipIntegration) return;
  calls.length = 0;
  nextResponse = { status: 200, body: { ok: true } };
  await db(TABLES.Session).where({ tenantId: DEFAULT_TENANT_ID }).del();
  await db(TABLES.Partner).where({ tenantId: DEFAULT_TENANT_ID }).del();
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).del();

  const value = {
    enabled: true,
    networkUrl: receiverUrl,
    vendorTokenCiphertext: encryptSecret('vntok_profiletest'),
    scopedKeyId: null,
    autoEnroll: true,
  };
  await db(TABLES.Config)
    .insert({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership', value: value as unknown as never, updatedAt: new Date() })
    .onConflict(['tenantId', 'key'])
    .merge({ value: value as unknown as never, updatedAt: new Date() });

  partnerId = ulid();
  await db(TABLES.Partner).insert({
    id: partnerId,
    tenantId: DEFAULT_TENANT_ID,
    email: 'partner@example.test',
    name: 'Pat Partner',
    activatedAt: new Date(),
  });
  // Acting as the partner on the Network needs their consent.
  await db(TABLES.PartnerNetworkConsent).insert({
    partnerId,
    tenantId: DEFAULT_TENANT_ID,
    status: 'granted',
    source: 'portal_setting',
    consentedAt: new Date(),
  });
  const session = await createSession(db, { tenantId: DEFAULT_TENANT_ID, principalKind: 'partner', principalId: partnerId });
  cookie = `op_session=${session.plaintext}`;
});

function expectActingCall(call: NetCall | undefined, method: string, path: string): void {
  expect(call?.method).toBe(method);
  expect(call?.path).toBe(path);
  expect(call?.authorization).toBe('Bearer vntok_profiletest');
  expect(call?.actingAs).toBe(partnerId);
}

describe.skipIf(skipIntegration)('PATCH /network/me/profile', () => {
  it('forwards every profile field the creator portal can edit', async () => {
    const patch = {
      name: 'Pat',
      handle: 'pat',
      avatarUrl: 'https://cdn.example/pat.png',
      coverImageUrl: 'https://cdn.example/pat-cover.png',
      bio: 'I make weekly videos about design tools for indie founders.',
      categories: ['Design', 'tech'],
      audienceLocations: ['us', 'GB'],
      audienceAgeRange: '25-34',
      audienceSize: '10k_50k',
      portfolioLinks: ['https://youtube.com/watch?v=1'],
      pastBrands: ['Linear'],
    };
    const res = await request(app).patch('/network/me/profile').set('Cookie', cookie).send(patch);
    expect(res.status).toBe(200);
    expectActingCall(calls[0], 'PATCH', '/creators/me');
    expect(JSON.parse(calls[0]!.raw.toString('utf8'))).toEqual({
      ...patch,
      // Normalized the way the Network normalizes them.
      categories: ['design', 'tech'],
      audienceLocations: ['US', 'GB'],
    });
  });

  it('clears audience fields with null', async () => {
    const res = await request(app)
      .patch('/network/me/profile')
      .set('Cookie', cookie)
      .send({ audienceSize: null, audienceAgeRange: null });
    expect(res.status).toBe(200);
    expect(JSON.parse(calls[0]!.raw.toString('utf8'))).toEqual({ audienceSize: null, audienceAgeRange: null });
  });

  it('removes the cover with null', async () => {
    const res = await request(app).patch('/network/me/profile').set('Cookie', cookie).send({ coverImageUrl: null });
    expect(res.status).toBe(200);
    expect(JSON.parse(calls[0]!.raw.toString('utf8'))).toEqual({ coverImageUrl: null });
  });

  it.each([
    ['an unknown audience bucket', { audienceSize: 'huge' }],
    ['a bad country code', { audienceLocations: ['USA'] }],
    ['too many categories', { categories: Array.from({ length: 13 }, (_, i) => `c${i}`) }],
    ['a non-URL portfolio link', { portfolioLinks: ['not a url'] }],
    ['a non-http cover', { coverImageUrl: 'javascript:alert(1)' }],
  ])('rejects %s without calling the Network', async (_label, body) => {
    const res = await request(app).patch('/network/me/profile').set('Cookie', cookie).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('platform proxies', () => {
  it('lists, upserts and removes platforms as the partner', async () => {
    nextResponse = { status: 200, body: { platforms: [{ id: 'cpf_1', platform: 'youtube', handle: 'pat' }] } };
    const list = await request(app).get('/network/me/platforms').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.platforms).toHaveLength(1);
    expectActingCall(calls[0], 'GET', '/creators/me/platforms');

    nextResponse = { status: 200, body: { id: 'cpf_1', platform: 'youtube', handle: 'pat', followerCount: 1200 } };
    const put = await request(app)
      .put('/network/me/platforms/youtube')
      .set('Cookie', cookie)
      .send({ handle: 'pat', followerCount: 1200 });
    expect(put.status).toBe(200);
    expect(put.body.followerCount).toBe(1200);
    expectActingCall(calls[1], 'PUT', '/creators/me/platforms/youtube');
    expect(JSON.parse(calls[1]!.raw.toString('utf8'))).toEqual({ handle: 'pat', followerCount: 1200 });

    nextResponse = { status: 200, body: { ok: true } };
    const del = await request(app).delete('/network/me/platforms/youtube').set('Cookie', cookie);
    expect(del.status).toBe(200);
    expectActingCall(calls[2], 'DELETE', '/creators/me/platforms/youtube');
  });

  it('a partner not on the Network yet lists no platforms instead of an error', async () => {
    nextResponse = { status: 403, body: { error: 'invalid_acting_context' } };
    const res = await request(app).get('/network/me/platforms').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platforms: [] });
  });

  it('surfaces the Network’s validation errors', async () => {
    nextResponse = { status: 400, body: { error: 'invalid_platform' } };
    const res = await request(app).put('/network/me/platforms/myspace').set('Cookie', cookie).send({ handle: 'pat' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('network_call_failed');
  });

  it('starts and checks account verification as the partner', async () => {
    nextResponse = { status: 200, body: { platform: 'youtube', method: 'bio_code', code: '012345' } };
    const start = await request(app).post('/network/me/platforms/youtube/verify/start').set('Cookie', cookie).send({});
    expect(start.status).toBe(200);
    expect(start.body.code).toBe('012345');
    expectActingCall(calls[0], 'POST', '/creators/me/platforms/youtube/verify/start');

    nextResponse = { status: 200, body: { ok: true, platform: { platform: 'youtube', verified: true } } };
    const check = await request(app).post('/network/me/platforms/youtube/verify').set('Cookie', cookie).send({});
    expect(check.status).toBe(200);
    expect(check.body.platform.verified).toBe(true);
    expectActingCall(calls[1], 'POST', '/creators/me/platforms/youtube/verify');
  });

  it('passes a failed check through with the Network’s reason', async () => {
    nextResponse = { status: 409, body: { error: 'code_not_found', detail: 'Code 012345 is not in the channel description yet.' } };
    const res = await request(app).post('/network/me/platforms/youtube/verify').set('Cookie', cookie).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('network_call_failed');
    expect(JSON.parse(res.body.detail)).toMatchObject({ error: 'code_not_found' });
  });

  it('refuses a platform segment that could leave the platforms path', async () => {
    const res = await request(app).delete('/network/me/platforms/..%2F..%2Fdelete').set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('POST /network/me/uploads/cover', () => {
  it('forwards the image bytes and type as the partner', async () => {
    nextResponse = { status: 200, body: { coverImageUrl: 'https://cdn.example/creators/crt_1/covers/c.webp' } };
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3]);
    const res = await request(app)
      .post('/network/me/uploads/cover')
      .set('Cookie', cookie)
      .set('content-type', 'image/webp')
      .send(webp);
    expect(res.status).toBe(200);
    expect(res.body.coverImageUrl).toBe('https://cdn.example/creators/crt_1/covers/c.webp');
    expectActingCall(calls[0], 'POST', '/creators/me/uploads/cover');
    expect(calls[0]!.contentType).toBe('image/webp');
    expect(calls[0]!.raw.equals(webp)).toBe(true);
  });

  it('rejects non-image bodies without calling the Network', async () => {
    const res = await request(app)
      .post('/network/me/uploads/cover')
      .set('Cookie', cookie)
      .set('content-type', 'application/json')
      .send({ coverImageUrl: 'https://cdn.example/x.png' });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('POST /network/me/cover/youtube', () => {
  it("uses the partner's YouTube banner as the cover, as the partner", async () => {
    const coverSource = { platform: 'youtube', url: 'https://www.youtube.com/channel/UC_pat' };
    nextResponse = { status: 200, body: { coverImageUrl: 'https://cdn.example/creators/crt_1/youtube/b.jpg', coverSource } };
    const res = await request(app).post('/network/me/cover/youtube').set('Cookie', cookie).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ coverImageUrl: 'https://cdn.example/creators/crt_1/youtube/b.jpg', coverSource });
    expectActingCall(calls[0], 'POST', '/creators/me/cover/youtube');
  });

  it('passes a refusal through with the Network’s reason', async () => {
    nextResponse = { status: 409, body: { error: 'no_youtube_banner', detail: 'Your YouTube channel has no banner.' } };
    const res = await request(app).post('/network/me/cover/youtube').set('Cookie', cookie).send({});
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body.detail)).toMatchObject({ error: 'no_youtube_banner' });
  });
});

describe.skipIf(skipIntegration)('POST /network/me/uploads/avatar', () => {
  it('forwards the image bytes and type as the partner', async () => {
    nextResponse = { status: 200, body: { avatarUrl: 'https://cdn.example/creators/crt_1/avatars/a.png' } };
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const res = await request(app)
      .post('/network/me/uploads/avatar')
      .set('Cookie', cookie)
      .set('content-type', 'image/png')
      .send(png);
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBe('https://cdn.example/creators/crt_1/avatars/a.png');
    expectActingCall(calls[0], 'POST', '/creators/me/uploads/avatar');
    expect(calls[0]!.contentType).toBe('image/png');
    expect(calls[0]!.raw.equals(png)).toBe(true);
  });

  it('rejects non-image bodies without calling the Network', async () => {
    const res = await request(app)
      .post('/network/me/uploads/avatar')
      .set('Cookie', cookie)
      .set('content-type', 'text/plain')
      .send('hello');
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('auth', () => {
  it('needs a partner principal for every new route', async () => {
    const routes = [
      () => request(app).get('/network/me/platforms'),
      () => request(app).put('/network/me/platforms/youtube').send({ handle: 'x' }),
      () => request(app).delete('/network/me/platforms/youtube'),
      () => request(app).post('/network/me/platforms/youtube/verify/start').send({}),
      () => request(app).post('/network/me/platforms/youtube/verify').send({}),
      () => request(app).post('/network/me/uploads/avatar').set('content-type', 'image/png').send(Buffer.from([1])),
      () => request(app).post('/network/me/uploads/cover').set('content-type', 'image/png').send(Buffer.from([1])),
      () => request(app).post('/network/me/cover/youtube').send({}),
    ];
    for (const route of routes) {
      expect((await route()).status).toBe(401);
      expect((await route().set('Authorization', `Bearer ${ADMIN_KEY}`)).status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('acting as a partner needs their Network consent', () => {
  beforeEach(async () => {
    await db(TABLES.PartnerNetworkConsent).where({ partnerId }).del();
  });

  it('refuses writes with network_consent_required and never calls the Network', async () => {
    const res = await request(app).patch('/network/me/profile').set('Cookie', cookie).send({ bio: 'hello' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('network_consent_required');
    const apply = await request(app).post('/network/offerings/off_1/apply').set('Cookie', cookie).send({});
    expect(apply.status).toBe(403);
    for (const path of ['/network/me/platforms/youtube/verify/start', '/network/me/platforms/youtube/verify']) {
      const verify = await request(app).post(path).set('Cookie', cookie).send({});
      expect(verify.status).toBe(403);
      expect(verify.body.error).toBe('network_consent_required');
    }
    expect(calls).toHaveLength(0);
  });

  it('answers reads with the empty state, flagged consentRequired', async () => {
    const platforms = await request(app).get('/network/me/platforms').set('Cookie', cookie);
    expect(platforms.status).toBe(200);
    expect(platforms.body).toEqual({ platforms: [], consentRequired: true });
    const profile = await request(app).get('/network/me/profile').set('Cookie', cookie);
    expect(profile.body).toEqual({ notFederated: true, consentRequired: true });
    expect(calls).toHaveLength(0);
  });

  it('a withdrawn partner is refused too, even before the unlink lands', async () => {
    await db(TABLES.PartnerNetworkConsent).insert({
      partnerId,
      tenantId: DEFAULT_TENANT_ID,
      status: 'withdrawn',
      source: 'join_page',
      consentedAt: new Date(Date.now() - 60_000),
      withdrawnAt: new Date(),
    });
    const res = await request(app).get('/network/me/affiliations').set('Cookie', cookie);
    expect(res.body).toEqual({ affiliations: [], consentRequired: true });
    expect(calls).toHaveLength(0);
  });

  it('browsing public offerings needs no consent', async () => {
    nextResponse = { status: 200, body: { offerings: [] } };
    const res = await request(app).get('/network/discover').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(calls[0]?.path).toBe('/offerings');
  });
});
