/**
 * The /creator-api reverse proxy only forwards allowlisted Network paths.
 * Covers the account-verification POSTs under /creators/me/platforms/
 * (verify/start, verify), the creator data export, and that paths off the
 * allowlist stay 404 without reaching the Network. A local HTTP server
 * plays the Network.
 */

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
let previousNetworkUrl: string | undefined;

beforeAll(async () => {
  previousNetworkUrl = process.env.NETWORK_URL;
  await new Promise<void>((resolve) => {
    network = createServer((req, res) => {
      calls.push({ method: req.method ?? '', path: req.url ?? '', cookie: req.headers.cookie });
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
  await new Promise<void>((r) => network.close(() => r()));
});

beforeEach(() => {
  calls.length = 0;
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
