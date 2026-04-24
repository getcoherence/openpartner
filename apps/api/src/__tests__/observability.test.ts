/**
 * Request correlation IDs + /metrics exposition.
 */

import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../db.js';
import { createApp } from '../app.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const app = createApp({ enableLogger: false });

afterAll(async () => {
  await db.destroy();
});

describe.skipIf(skipIntegration)('observability', () => {
  it('generates X-Request-Id when client sends none', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
  });

  it('echoes an inbound X-Request-Id', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'trace-abc-123').expect(200);
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('rejects an excessively long inbound id and mints a fresh one', async () => {
    const tooLong = 'x'.repeat(200);
    const res = await request(app).get('/health').set('X-Request-Id', tooLong).expect(200);
    const id = res.headers['x-request-id'] as string | undefined;
    expect(id).toBeDefined();
    expect(id).not.toBe(tooLong);
    expect(id!.length).toBeLessThanOrEqual(128);
  });

  it('/metrics returns Prometheus text with the expected counters', async () => {
    const res = await request(app).get('/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('# TYPE openpartner_clicks_total counter');
    expect(res.text).toContain('openpartner_clicks_total ');
    expect(res.text).toContain('openpartner_events_total ');
    expect(res.text).toContain('openpartner_attributions_total ');
  });

  it('/metrics requires Bearer token when METRICS_TOKEN is set', async () => {
    const before = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = 'metrics-secret-abc';
    try {
      await request(app).get('/metrics').expect(401);
      await request(app).get('/metrics').set('Authorization', 'Bearer wrong').expect(401);
      await request(app).get('/metrics').set('Authorization', 'Bearer metrics-secret-abc').expect(200);
    } finally {
      if (before === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = before;
    }
  });
});
