/**
 * A wrong workspace slug, or any unmatched route, answers 404 in the API's
 * JSON error shape. It used to fall through to Express's default HTML page
 * ("Cannot POST /t/<slug>/attribution/identify"), which an integration
 * parsing JSON can't read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';

const { db, appDb } = await import('../db.js');
const { createApp } = await import('../app.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const ACTIVE = { id: `01TNFA${ulid().slice(6)}`, slug: `tnf-active-${ulid().slice(-6).toLowerCase()}` };
const SUSPENDED = { id: `01TNFS${ulid().slice(6)}`, slug: `tnf-suspended-${ulid().slice(-6).toLowerCase()}` };
const TENANTS = [ACTIVE.id, SUSPENDED.id];

beforeAll(async () => {
  if (skipIntegration) return;
  await db(TABLES.Tenant).whereIn('id', TENANTS).del();
  await db(TABLES.Tenant).insert([
    { id: ACTIVE.id, slug: ACTIVE.slug, displayName: 'Active', status: 'active', approvalStatus: 'approved' },
    { id: SUSPENDED.id, slug: SUSPENDED.slug, displayName: 'Suspended', status: 'suspended', approvalStatus: 'rejected' },
  ]);
});

afterAll(async () => {
  if (!skipIntegration) await db(TABLES.Tenant).whereIn('id', TENANTS).del();
  await db.destroy();
  await appDb.destroy();
});

const identify = { cref: '00000000000000000000000000', userId: 'u1' };

describe.skipIf(skipIntegration)('unknown workspace and unmatched routes', () => {
  it('answers 404 tenant_not_found as JSON for a slug that does not exist', async () => {
    for (const prefix of ['/t', '/api/t']) {
      const res = await request(app).post(`${prefix}/no-such-workspace/attribution/identify`).send(identify);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ error: 'tenant_not_found' });
    }
  });

  it('gives a suspended workspace the same answer as an unknown one', async () => {
    const res = await request(app).get(`/t/${SUSPENDED.slug}/programs`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
  });

  it('still routes a real workspace', async () => {
    const res = await request(app).post(`/t/${ACTIVE.slug}/attribution/identify`).send(identify);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'click_not_found' });
  });

  it('answers an unknown route under a real workspace with not_found JSON', async () => {
    const res = await request(app).post(`/t/${ACTIVE.slug}/no/such/route`).send({});
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('answers an unknown route outside any workspace with not_found JSON', async () => {
    const res = await request(app).get('/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('lets a reserved slug fall through to not_found, not tenant_not_found', async () => {
    const res = await request(app).get('/t/api/anything');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
