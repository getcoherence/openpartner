/**
 * Rate limiter unit test. Hits the middleware directly so we can toggle
 * NODE_ENV around the test-env bypass and exercise the real code path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ipRateLimit } from '../middleware/rate-limit.js';

describe('ipRateLimit', () => {
  const original = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('allows up to max requests then returns 429 with Retry-After', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(ipRateLimit({ name: 'test', max: 3, windowMs: 60_000 }));
    app.get('/', (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
    }

    const over = await request(app).get('/');
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('rate_limited');
    expect(over.headers['retry-after']).toMatch(/^\d+$/);
  });

  it('buckets are scoped by name — two limiters do not share state', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/a', ipRateLimit({ name: 'a', max: 2, windowMs: 60_000 }), (_req, res) => res.json({}));
    app.get('/b', ipRateLimit({ name: 'b', max: 2, windowMs: 60_000 }), (_req, res) => res.json({}));

    await request(app).get('/a').expect(200);
    await request(app).get('/a').expect(200);
    await request(app).get('/a').expect(429);
    // /b should still have its own budget untouched
    await request(app).get('/b').expect(200);
  });

  it('bypasses entirely under NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    const app = express();
    app.use(ipRateLimit({ name: 'bypass', max: 1, windowMs: 60_000 }));
    app.get('/', (_req, res) => res.json({}));

    await request(app).get('/').expect(200);
    await request(app).get('/').expect(200);
    await request(app).get('/').expect(200);
  });
});
