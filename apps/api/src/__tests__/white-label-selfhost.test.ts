/**
 * Self-host white-label toggle.
 *
 * Self-host has no billing relationship, so POST/DELETE /billing/white-label
 * flip Tenant.whiteLabel directly, for free. They used to 400 with "Self-host
 * installs are always white-label entitled" while the effective check still
 * required the flag, so a self-host install could never drop OpenPartner
 * branding ("via OpenPartner" mail, "· OpenPartner" tab title, Network nav).
 *
 * It stays opt-in rather than implied by selfhost mode: white-label isolates
 * the tenant from the Network, and a self-host install on the Network plan
 * must be able to stay connected.
 *
 * Skipped if DATABASE_URL isn't set.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_wl_selfhost_admin_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.PORTAL_URL = 'http://localhost:5673';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const auth = { Authorization: `Bearer ${ADMIN_KEY}` };

async function resetTenant(): Promise<void> {
  await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ whiteLabel: false, customDomain: null });
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).del();
}

beforeEach(async () => {
  if (skipIntegration) return;
  await resetTenant();
});

afterAll(async () => {
  if (!skipIntegration) await resetTenant();
  await db.destroy();
});

describe.skipIf(skipIntegration)('self-host white-label toggle', () => {
  it('is off out of the box, so the Network stays reachable', async () => {
    const res = await request(app).get('/billing/white-label').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'selfhost', provisioned: false, effective: false });
    expect((await request(app).get('/branding')).body.whiteLabel).toBe(false);
  });

  it('enables for free and takes effect: branding drops and Network joins are refused', async () => {
    const on = await request(app).post('/billing/white-label').set(auth);
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ ok: true, provisioned: true, billedVia: 'selfhost' });

    const state = await request(app).get('/billing/white-label').set(auth);
    expect(state.body).toMatchObject({ provisioned: true, effective: true });
    expect((await request(app).get('/branding')).body.whiteLabel).toBe(true);

    const connect = await request(app).post('/config/network/start-connect').set(auth).send({});
    expect(connect.status).toBe(409);
    expect(connect.body.error).toBe('white_label_network_conflict');
  });

  it('disables again, restoring platform branding', async () => {
    expect((await request(app).post('/billing/white-label').set(auth)).status).toBe(200);

    const off = await request(app).delete('/billing/white-label').set(auth);
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ ok: true, provisioned: false });

    const state = await request(app).get('/billing/white-label').set(auth);
    expect(state.body).toMatchObject({ provisioned: false, effective: false });
    expect((await request(app).get('/branding')).body.whiteLabel).toBe(false);
  });
});
