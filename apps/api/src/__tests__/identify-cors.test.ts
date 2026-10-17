/**
 * Open CORS on /attribution/identify (the browser SDK's stitch call).
 *
 * The call originates from the BRAND'S OWN website origin, which can never
 * be in our allowlist ahead of time — so this one path gets
 * analytics-collector CORS (any origin, no credentials), while every other
 * route keeps the strict allowlist. Preflight-only tests: no DB needed.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

const app = createApp({ enableLogger: false });

describe('identify CORS carve-out', () => {
  it('preflights /attribution/identify from any origin, without credentials', async () => {
    const res = await request(app)
      .options('/attribution/identify')
      .set('Origin', 'https://xispark.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(res.headers['access-control-allow-origin']).toBe('https://xispark.com');
    // No credentials on the open route — a reflected origin + credentials
    // would be the CSRF foot-gun the strict allowlist exists to prevent.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('covers the tenant-scoped path shapes', async () => {
    for (const path of ['/t/xispark/attribution/identify', '/api/t/xispark/attribution/identify']) {
      const res = await request(app)
        .options(path)
        .set('Origin', 'https://brand-site.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-allow-origin']).toBe('https://brand-site.example');
    }
  });

  it('does NOT open any other route — the strict allowlist still governs', async () => {
    for (const path of ['/attribution/events', '/partners', '/t/xispark/config/program']) {
      const res = await request(app)
        .options(path)
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});
