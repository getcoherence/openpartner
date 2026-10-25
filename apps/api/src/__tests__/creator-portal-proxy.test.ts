/**
 * The /creator-api reverse proxy only forwards allowlisted Network paths.
 * Covers the account-verification POSTs under /creators/me/platforms/
 * (verify/start, verify), the creator data export, the location prompt,
 * the avatar and cover image uploads, the password routes,
 * that paths off the allowlist stay 404 without reaching the Network, and
 * the signed header that tells the Network the creator's own address. A
 * local HTTP server plays the Network.
 */

import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

process.env.OPENPARTNER_MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';
process.env.OPENPARTNER_TENANCY = process.env.OPENPARTNER_TENANCY ?? 'single';

const { createApp } = await import('../app.js');
const app = createApp({ enableLogger: false });

let network: Server;
const calls: Array<{ method: string; path: string; cookie: string | undefined }> = [];
const clientIpHeaders: Array<string | undefined> = [];
let previousNetworkUrl: string | undefined;
let previousAdminKey: string | undefined;

beforeAll(async () => {
  previousNetworkUrl = process.env.NETWORK_URL;
  previousAdminKey = process.env.NETWORK_ADMIN_API_KEY;
  await new Promise<void>((resolve) => {
    network = createServer((req, res) => {
      calls.push({ method: req.method ?? '', path: req.url ?? '', cookie: req.headers.cookie });
      clientIpHeaders.push(req.headers['x-openpartner-client-ip'] as string | undefined);
      req.resume();
      req.on('end', () => {
        if (req.url === '/creators/me/export') {
          if (!req.headers.cookie) {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'unauthenticated' }));
          }
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': 'attachment; filename="openpartner-creator-export-ada_example_com-2026-10-19.json"',
          });
          return res.end(JSON.stringify({ exportedAt: '2026-10-19T00:00:00.000Z', creator: { id: 'cr_1' } }));
        }
        if (req.url?.endsWith('/realtime')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ticket: 'tkt_1', expiresAt: '2026-10-25T21:00:00.000Z' }));
        }
        if (req.url?.endsWith('/verify')) {
          res.writeHead(409, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'code_not_found', detail: 'Not in the description yet.' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: '012345' }));
      });
    }).listen(0, '127.0.0.1', () => {
      process.env.NETWORK_URL = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (previousNetworkUrl === undefined) delete process.env.NETWORK_URL;
  else process.env.NETWORK_URL = previousNetworkUrl;
  if (previousAdminKey === undefined) delete process.env.NETWORK_ADMIN_API_KEY;
  else process.env.NETWORK_ADMIN_API_KEY = previousAdminKey;
  await new Promise<void>((r) => network.close(() => r()));
});

beforeEach(() => {
  calls.length = 0;
  clientIpHeaders.length = 0;
  delete process.env.NETWORK_ADMIN_API_KEY;
});

describe('creator-api proxy: platform verification', () => {
  it('forwards verify/start and verify with the creator cookie, relaying the Network’s answer', async () => {
    const start = await request(app)
      .post('/creator-api/creators/me/platforms/youtube/verify/start')
      .set('Cookie', 'op_network_creator_session=abc')
      .send({});
    expect(start.status).toBe(200);
    expect(start.body).toEqual({ code: '012345' });

    const check = await request(app)
      .post('/creator-api/creators/me/platforms/youtube/verify')
      .set('Cookie', 'op_network_creator_session=abc')
      .send({});
    expect(check.status).toBe(409);
    expect(check.body).toEqual({ error: 'code_not_found', detail: 'Not in the description yet.' });

    expect(calls).toEqual([
      { method: 'POST', path: '/creators/me/platforms/youtube/verify/start', cookie: 'op_network_creator_session=abc' },
      { method: 'POST', path: '/creators/me/platforms/youtube/verify', cookie: 'op_network_creator_session=abc' },
    ]);
  });

  it('still refuses paths off the allowlist without calling the Network', async () => {
    const res = await request(app).post('/creator-api/vendors/me/discover/creators').send({});
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('creator-api proxy: live conversations', () => {
  it('forwards a socket ticket request and adds where to open the socket', async () => {
    const res = await request(app)
      .post('/creator-api/creators/me/conversations/cnv_1/realtime')
      .set('Cookie', 'op_network_creator_session=abc')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ticket: 'tkt_1',
      expiresAt: '2026-10-25T21:00:00.000Z',
      url: `${process.env.NETWORK_URL!.replace(/^http/, 'ws')}/realtime`,
    });
    expect(calls).toEqual([{ method: 'POST', path: '/creators/me/conversations/cnv_1/realtime', cookie: 'op_network_creator_session=abc' }]);
  });
});

describe('creator-api proxy: data export', () => {
  it('forwards GET /creators/me/export with the creator cookie and relays the download', async () => {
    const res = await request(app)
      .get('/creator-api/creators/me/export')
      .set('Cookie', 'op_network_creator_session=abc');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="openpartner-creator-export-ada_example_com-2026-10-19.json"',
    );
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({ exportedAt: '2026-10-19T00:00:00.000Z', creator: { id: 'cr_1' } });
    expect(calls).toEqual([{ method: 'GET', path: '/creators/me/export', cookie: 'op_network_creator_session=abc' }]);
  });

  it('leaves the session check to the Network, like the other /creators/me routes', async () => {
    const res = await request(app).get('/creator-api/creators/me/export');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthenticated' });
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(calls).toEqual([{ method: 'GET', path: '/creators/me/export', cookie: undefined }]);
  });
});

describe('creator-api proxy: location prompt', () => {
  it('forwards GET and PUT /creators/me/location', async () => {
    const read = await request(app)
      .get('/creator-api/creators/me/location')
      .set('Cookie', 'op_network_creator_session=abc');
    expect(read.status).toBe(200);
    const save = await request(app)
      .put('/creator-api/creators/me/location')
      .set('Cookie', 'op_network_creator_session=abc')
      .send({ country: 'DE' });
    expect(save.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /creators/me/location',
      'PUT /creators/me/location',
    ]);
  });
});

describe('creator-api proxy: the creator address header', () => {
  // The Network's parser for it (openpartner-network src/client-ip.ts).
  const NETWORK_SHAPE = /^([0-9A-Fa-f.:]{2,45});t=(\d{1,12});sig=([0-9a-f]{64})$/;
  const key = 'network-admin-key-for-tests';

  it('vouches for the address the request came from, signed with the Network admin key', async () => {
    process.env.NETWORK_ADMIN_API_KEY = key;
    const before = Math.floor(Date.now() / 1000);
    // The app trusts one proxy hop (the platform ingress), so this is req.ip.
    const res = await request(app)
      .post('/creator-api/creators/signin')
      .set('X-Forwarded-For', '203.0.113.7')
      .send({ email: 'a@example.com' });
    expect(res.status).toBe(200);

    const header = clientIpHeaders[0];
    const m = NETWORK_SHAPE.exec(header ?? '');
    expect(m).not.toBeNull();
    const [, ip, t, sig] = m!;
    expect(ip).toBe('203.0.113.7');
    expect(Number(t)).toBeGreaterThanOrEqual(before);
    expect(Number(t)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(sig).toBe(createHmac('sha256', key).update(`${ip}.${t}`).digest('hex'));
    // The key itself never travels with creator traffic.
    expect(header).not.toContain(key);
  });

  it('sends it on every proxied path', async () => {
    process.env.NETWORK_ADMIN_API_KEY = key;
    await request(app).get('/creator-api/offerings').set('X-Forwarded-For', '198.51.100.4');
    await request(app).get('/creator-api/creators/me/location').set('X-Forwarded-For', '198.51.100.4');
    expect(clientIpHeaders).toHaveLength(2);
    for (const h of clientIpHeaders) expect(h).toMatch(/^198\.51\.100\.4;t=\d+;sig=[0-9a-f]{64}$/);
  });

  it('sends nothing when the Network admin key is not set', async () => {
    const res = await request(app).post('/creator-api/creators/signin').set('X-Forwarded-For', '203.0.113.7').send({});
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(clientIpHeaders).toEqual([undefined]);
  });

  it("doesn't pass on a header the caller sent", async () => {
    const res = await request(app)
      .post('/creator-api/creators/signin')
      .set('x-openpartner-client-ip', `10.0.0.1;t=1;sig=${'0'.repeat(64)}`)
      .send({});
    expect(res.status).toBe(200);
    expect(clientIpHeaders).toEqual([undefined]);
  });
});

describe('creator-api proxy: image uploads', () => {
  it('forwards the avatar and cover uploads as raw images', async () => {
    const cookie = 'op_network_creator_session=abc';
    for (const path of ['/creators/me/uploads/avatar', '/creators/me/uploads/cover']) {
      const res = await request(app)
        .post(`/creator-api${path}`)
        .set('Cookie', cookie)
        .set('Content-Type', 'image/png')
        .send(Buffer.from('89504e470d0a1a0a', 'hex'));
      expect(res.status, path).toBe(200);
    }
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /creators/me/uploads/avatar',
      'POST /creators/me/uploads/cover',
    ]);
  });
});

describe('creator-api proxy: storefront', () => {
  it('forwards the creator storefront, package and bookings calls', async () => {
    const cookie = 'op_network_creator_session=abc';
    const steps: Array<[string, string]> = [
      ['GET', '/creators/me/storefront'],
      ['PUT', '/creators/me/storefront'],
      ['POST', '/creators/me/packages'],
      ['PATCH', '/creators/me/packages/cpk_1'],
      ['DELETE', '/creators/me/packages/cpk_1'],
      ['POST', '/creators/me/packages/order'],
      ['GET', '/creators/me/bookings?status=pending'],
      ['POST', '/creators/me/bookings/bkr_1/accept'],
      ['POST', '/creators/me/bookings/bkr_1/decline'],
      ['POST', '/creators/me/bookings/bkr_1/withdraw'],
      ['POST', '/creators/me/bookings/bkr_1/deliver'],
      ['POST', '/creators/me/bookings/bkr_1/refund'],
      ['DELETE', '/creators/me/bookings/bkr_1'],
      ['GET', '/creators/me/conversations'],
      ['GET', '/creators/me/conversations/cnv_1?before=cnm_9'],
      ['POST', '/creators/me/conversations/cnv_1/messages'],
      ['POST', '/creators/me/conversations/cnv_1/offers'],
      ['POST', '/creators/me/conversations/cnv_1/block'],
      ['GET', '/creators/me/payments?refresh=1'],
      ['POST', '/creators/me/payments/onboarding'],
      ['POST', '/creators/me/storefront/import/preview'],
      ['POST', '/creators/me/storefront/import/apply'],
    ];
    for (const [method, path] of steps) {
      const r = request(app)[method.toLowerCase() as 'get' | 'put' | 'post' | 'patch' | 'delete'](`/creator-api${path}`).set('Cookie', cookie);
      const res = method === 'GET' || method === 'DELETE' ? await r : await r.send({});
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(steps.map(([m, p]) => `${m} ${p}`));
    expect(calls.every((c) => c.cookie === cookie)).toBe(true);
  });

  it('forwards the public request form without a session; the old confirm link is not proxied', async () => {
    const send = await request(app)
      .post('/creator-api/creators/by-handle/ada/bookings')
      .send({ contactName: 'Grace', contactEmail: 'g@example.com', brief: 'A sponsored post about our app.' });
    expect(send.status).toBe(200);
    // A request is continued as a brand now (routes/booking-claims.ts), and
    // the preview behind it is read with the admin key, never by a browser.
    expect((await request(app).post('/creator-api/bookings/confirm').send({ token: 'opbk_x' })).status).toBe(404);
    expect((await request(app).post('/creator-api/bookings/preview').send({ token: 'opbk_x' })).status).toBe(404);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /creators/by-handle/ada/bookings']);
  });

  it('forwards operator messages: the list and marking one read', async () => {
    const cookie = 'op_network_creator_session=abc';
    expect((await request(app).get('/creator-api/creators/me/messages').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).post('/creator-api/creators/me/messages/cmsg_1/read').set('Cookie', cookie).send({})).status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /creators/me/messages', 'POST /creators/me/messages/cmsg_1/read']);
    expect(calls.every((c) => c.cookie === cookie)).toBe(true);
    // Deleting or editing a message isn't a creator action.
    expect((await request(app).delete('/creator-api/creators/me/messages/cmsg_1')).status).toBe(404);
    expect((await request(app).get('/creator-api/creators/me/messages/cmsg_1')).status).toBe(404);
    expect(calls).toHaveLength(2);
  });

  it('keeps the methods it does not need off the allowlist', async () => {
    expect((await request(app).put('/creator-api/creators/me/packages/cpk_1').send({})).status).toBe(404);
    expect((await request(app).get('/creator-api/creators/me/bookings/bkr_1')).status).toBe(404);
    expect((await request(app).delete('/creator-api/creators/me/conversations/cnv_1')).status).toBe(404);
    expect((await request(app).get('/creator-api/creators/me/payments')).status).toBe(200); // exact paths forward any method; the Network answers
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /creators/me/payments']);
  });
});

describe('creator-api proxy: passwords', () => {
  it('forwards password sign-in, forgot, reset and set/change, with the creator cookie and address', async () => {
    process.env.NETWORK_ADMIN_API_KEY = 'netadm_test_proxy_0123456789abcdef';
    const cookie = 'op_network_creator_session=opscreator_abc';
    const steps: Array<[string, string]> = [
      ['POST', '/creators/signin/password'],
      ['POST', '/creators/password/forgot'],
      ['POST', '/creators/password/reset'],
      ['GET', '/creators/me/password'],
      ['PUT', '/creators/me/password'],
    ];
    for (const [method, path] of steps) {
      const r = request(app)[method.toLowerCase() as 'get' | 'put' | 'post'](`/creator-api${path}`).set('Cookie', cookie);
      const res = method === 'GET' ? await r : await r.send({ email: 'ada@example.com', password: 'correct horse battery' });
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(steps.map(([m, p]) => `${m} ${p}`));
    expect(calls.every((c) => c.cookie === cookie)).toBe(true);
    // The Network's country gate sees the creator, not this server.
    expect(clientIpHeaders.every((h) => typeof h === 'string' && /;sig=[0-9a-f]{64}$/.test(h))).toBe(true);
  });

  it('forwards nothing next to them', async () => {
    for (const path of [
      '/creators/password',
      '/creators/password/forgot/extra',
      '/creators/signin/password/extra',
      '/creators/me/password/history',
      '/admin/creators/signin-token',
      '/admin/creators/signup',
    ]) {
      const res = await request(app).post(`/creator-api${path}`).send({});
      expect(res.status, path).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});
