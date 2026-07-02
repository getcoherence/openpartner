/**
 * CORS origin decision for white-label custom domains (spec §4.5).
 *
 * Invariants pinned here:
 *   - NO blind reflection: an origin outside seed ∪ custom-domains gets no
 *     Access-Control-Allow-Origin header at all, even with credentials on.
 *   - Custom-domain origins are allowed via the async lookup.
 *   - A failing lookup denies (never allows, never 500s the request).
 */

import { describe, expect, it } from 'vitest';
import express from 'express';
import cors from 'cors';
import request from 'supertest';
import { corsOriginDecider } from '../cors-origins.js';

function appWith(isCustom: (origin: string) => Promise<boolean>) {
  const app = express();
  app.use(
    cors({
      origin: corsOriginDecider(new Set(['https://app.openpartner.dev']), isCustom),
      credentials: true,
    }),
  );
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('corsOriginDecider', () => {
  it('allows a seed origin without consulting the custom-domain lookup', async () => {
    const app = appWith(() => Promise.reject(new Error('must not be called')));
    const res = await request(app).get('/ping').set('Origin', 'https://app.openpartner.dev');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.openpartner.dev');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows a verified custom-domain origin', async () => {
    const app = appWith(async (o) => o === 'https://portal.xispark.com');
    const res = await request(app).get('/ping').set('Origin', 'https://portal.xispark.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://portal.xispark.com');
  });

  it('sends NO Access-Control-Allow-Origin for a non-allowlisted origin (no reflection)', async () => {
    const app = appWith(async () => false);
    const res = await request(app).get('/ping').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200); // CORS is a browser-side control; server still answers
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('denies when the custom-domain lookup fails', async () => {
    const app = appWith(() => Promise.reject(new Error('db down')));
    const res = await request(app).get('/ping').set('Origin', 'https://portal.xispark.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('requests without an Origin header pass through untouched', async () => {
    const app = appWith(() => Promise.reject(new Error('must not be called')));
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
