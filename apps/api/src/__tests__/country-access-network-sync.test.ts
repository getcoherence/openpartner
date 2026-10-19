/**
 * The Network's copy of the country list (country-access-sync.ts).
 *
 * The Network checks creators against its own copy, which this platform
 * pushes (PUT /admin/country-access, full replace) on every ops console
 * save and daily from the scheduler. The console reads it back to show
 * when it was last synced and whether it matches.
 *
 * A local HTTP server plays the Network's admin API. Skipped when
 * DATABASE_URL is unset, like the rest of the integration suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type PlatformAdminRow } from '@openpartner/db';

const NETWORK_KEY = 'network-admin-key-country-sync';
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.PLATFORM_ADMIN_EMAILS = 'ops-country-sync@openpartner.test';
delete process.env.PLATFORM_OPS_EMAIL;
const previousNetworkUrl = process.env.NETWORK_URL;
const previousNetworkKey = process.env.NETWORK_ADMIN_API_KEY;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { runCountryAccessSyncJob } = await import('../scheduler.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import(
  '../platform-admin-sessions.js'
);

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const OPS_EMAIL = 'ops-country-sync@openpartner.test';
let operatorId: string | null = null;
let settingExisted = false;

type Blocked = Array<{ code: string; basis: 'sanctions' | 'policy' }>;
const SANCTIONS: Blocked = [
  { code: 'CU', basis: 'sanctions' },
  { code: 'IR', basis: 'sanctions' },
  { code: 'KP', basis: 'sanctions' },
  { code: 'RU', basis: 'sanctions' },
];

/** What the fake Network holds and what it was sent. */
const fake = {
  copy: { settings: { enforce: true, blocked: SANCTIONS as Blocked }, syncedAt: null as string | null, updatedByEmail: null as string | null },
  puts: [] as Array<{ auth: string | undefined; body: Record<string, unknown> }>,
  mode: 'ok' as 'ok' | 'fail' | 'missing',
};
let network: Server;

function resetFake() {
  fake.copy = { settings: { enforce: true, blocked: SANCTIONS }, syncedAt: null, updatedByEmail: null };
  fake.puts.length = 0;
  fake.mode = 'ok';
}

async function operatorCookie(): Promise<string> {
  const existing = await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ email: OPS_EMAIL }).first();
  let admin: PlatformAdminRow;
  if (existing) {
    admin = existing;
  } else {
    admin = { id: ulid(), email: OPS_EMAIL, name: 'Ops', role: 'admin', createdAt: new Date(), revokedAt: null };
    await db<PlatformAdminRow>(TABLES.PlatformAdmin).insert(admin);
  }
  operatorId = admin.id;
  const session = await createPlatformAdminSession(db, admin);
  return `${PLATFORM_ADMIN_SESSION_COOKIE}=${session.plaintext}`;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    network = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.url !== '/admin/country-access') return send(404, { error: 'not_found' });
        if (req.headers.authorization !== `Bearer ${NETWORK_KEY}`) return send(401, { error: 'unauthorized' });
        if (fake.mode === 'missing') return send(404, { error: 'not_found' });
        if (fake.mode === 'fail') return send(500, { error: 'internal_error' });
        if (req.method === 'PUT') {
          const body = JSON.parse(raw) as { enforce: boolean; blocked: Blocked; updatedByEmail?: string };
          fake.puts.push({ auth: req.headers.authorization, body });
          fake.copy = {
            settings: { enforce: body.enforce, blocked: body.blocked },
            syncedAt: new Date().toISOString(),
            updatedByEmail: body.updatedByEmail ?? null,
          };
          return send(200, { settings: fake.copy.settings, syncedAt: fake.copy.syncedAt });
        }
        return send(200, {
          ...fake.copy,
          defaults: { enforce: true, blocked: SANCTIONS },
          creatorsWithoutCountry: 3,
          geoip: 'db-ip-lite',
        });
      });
    }).listen(0, '127.0.0.1', () => resolve());
  });
  if (skipIntegration) return;
  settingExisted = !!(await db(TABLES.PlatformSetting).where({ key: 'countryAccess' }).first());
});

beforeEach(async () => {
  resetFake();
  process.env.NETWORK_URL = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
  process.env.NETWORK_ADMIN_API_KEY = NETWORK_KEY;
  if (skipIntegration) return;
  // Every test starts from the shipped defaults.
  await db(TABLES.PlatformSetting).where({ key: 'countryAccess' }).del();
});

afterAll(async () => {
  if (previousNetworkUrl === undefined) delete process.env.NETWORK_URL;
  else process.env.NETWORK_URL = previousNetworkUrl;
  if (previousNetworkKey === undefined) delete process.env.NETWORK_ADMIN_API_KEY;
  else process.env.NETWORK_ADMIN_API_KEY = previousNetworkKey;
  await new Promise<void>((r) => network.close(() => r()));
  if (!skipIntegration) {
    if (!settingExisted) await db(TABLES.PlatformSetting).where({ key: 'countryAccess' }).del();
    await db(TABLES.PlatformAuditLog).where({ platformAdminEmail: OPS_EMAIL }).del();
    if (operatorId) {
      await db(TABLES.PlatformAdminSession).where({ platformAdminId: operatorId }).del();
      await db(TABLES.PlatformAdmin).where({ id: operatorId }).del();
    }
  }
  await db.destroy();
});

// AQ stands in for any country an operator chooses not to serve.
const WITH_POLICY: Blocked = [...SANCTIONS, { code: 'AQ', basis: 'policy' }];

describe.skipIf(skipIntegration)('country access — pushed to the Network', () => {
  it('sends the whole list on every console save, with the operator who saved it', async () => {
    const cookie = await operatorCookie();
    const put = await request(app).put('/platform-admin/country-access').set('Cookie', cookie).send({ blocked: WITH_POLICY });
    expect(put.status).toBe(200);
    expect(put.body.network.status).toBe('synced');
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]!.auth).toBe(`Bearer ${NETWORK_KEY}`);
    expect(fake.puts[0]!.body).toEqual({ enforce: true, blocked: WITH_POLICY, updatedByEmail: OPS_EMAIL });

    // A patch of one field still sends the full settings: the Network
    // replaces its copy wholesale.
    await request(app).put('/platform-admin/country-access').set('Cookie', cookie).send({ enforce: false }).expect(200);
    expect(fake.puts[1]!.body).toEqual({ enforce: false, blocked: WITH_POLICY, updatedByEmail: OPS_EMAIL });

    const audit = await db(TABLES.PlatformAuditLog)
      .where({ action: 'country_access.settings', platformAdminEmail: OPS_EMAIL })
      .orderBy('createdAt', 'desc')
      .first();
    expect(audit.detail.network).toBe('synced');
  });

  it("shows when the Network last synced and whether its copy matches", async () => {
    const cookie = await operatorCookie();
    const before = await request(app).get('/platform-admin/country-access').set('Cookie', cookie);
    expect(before.status).toBe(200);
    // Never pushed: the Network is on its defaults, which are ours too.
    expect(before.body.network).toEqual({
      configured: true,
      ok: true,
      syncedAt: null,
      updatedByEmail: null,
      matches: true,
      creatorsWithoutCountry: 3,
    });

    await request(app).put('/platform-admin/country-access').set('Cookie', cookie).send({ blocked: WITH_POLICY }).expect(200);
    const synced = await request(app).get('/platform-admin/country-access').set('Cookie', cookie);
    expect(synced.body.network.matches).toBe(true);
    expect(synced.body.network.syncedAt).toEqual(expect.any(String));
    expect(synced.body.network.updatedByEmail).toBe(OPS_EMAIL);

    // The Network's copy drifts (say a push was lost).
    fake.copy.settings = { enforce: true, blocked: SANCTIONS };
    const drifted = await request(app).get('/platform-admin/country-access').set('Cookie', cookie);
    expect(drifted.body.network.matches).toBe(false);

    // Same entries in another order still match.
    fake.copy.settings = { enforce: true, blocked: [...WITH_POLICY].reverse() };
    const reordered = await request(app).get('/platform-admin/country-access').set('Cookie', cookie);
    expect(reordered.body.network.matches).toBe(true);
  });

  it('pushes on demand', async () => {
    const cookie = await operatorCookie();
    await request(app).put('/platform-admin/country-access').set('Cookie', cookie).send({ blocked: WITH_POLICY }).expect(200);
    fake.copy.settings = { enforce: true, blocked: SANCTIONS };

    const push = await request(app).post('/platform-admin/country-access/push').set('Cookie', cookie);
    expect(push.status).toBe(200);
    expect(push.body.network.status).toBe('synced');
    expect(fake.copy.settings.blocked).toEqual(WITH_POLICY);
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'country_access.push', platformAdminEmail: OPS_EMAIL });
    expect(audit.length).toBeGreaterThan(0);
  });

  it('keeps the save when the Network push fails, and says so', async () => {
    const cookie = await operatorCookie();
    fake.mode = 'fail';
    const put = await request(app).put('/platform-admin/country-access').set('Cookie', cookie).send({ blocked: WITH_POLICY });
    expect(put.status).toBe(200);
    expect(put.body.settings.blocked).toContainEqual({ code: 'AQ', basis: 'policy' });
    expect(put.body.network.status).toBe('failed');

    const read = await request(app).get('/platform-admin/country-access').set('Cookie', cookie);
    expect(read.body.settings.blocked).toContainEqual({ code: 'AQ', basis: 'policy' });
    expect(read.body.network).toMatchObject({ configured: true, ok: false, error: 'internal_error' });

    expect((await request(app).post('/platform-admin/country-access/push').set('Cookie', cookie)).status).toBe(502);
  });

  it('tells a Network from before country access apart from a failure', async () => {
    const cookie = await operatorCookie();
    fake.mode = 'missing';
    const read = await request(app).get('/platform-admin/country-access').set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body.network).toMatchObject({ configured: true, ok: false, error: 'not_supported' });
  });

  it('skips the Network when it is not configured', async () => {
    const cookie = await operatorCookie();
    delete process.env.NETWORK_ADMIN_API_KEY;
    const read = await request(app).get('/platform-admin/country-access').set('Cookie', cookie);
    expect(read.body.network).toEqual({ configured: false });
    const put = await request(app).put('/platform-admin/country-access').set('Cookie', cookie).send({ enforce: true });
    expect(put.status).toBe(200);
    expect(put.body.network).toEqual({ status: 'not_configured' });
    expect((await request(app).post('/platform-admin/country-access/push').set('Cookie', cookie)).status).toBe(503);
    expect(fake.puts).toHaveLength(0);
  });

  it('re-pushes the stored list from the daily job, so a failed push heals', async () => {
    const cookie = await operatorCookie();
    fake.mode = 'fail';
    await request(app).put('/platform-admin/country-access').set('Cookie', cookie).send({ blocked: WITH_POLICY }).expect(200);
    expect(fake.copy.syncedAt).toBeNull();

    fake.mode = 'ok';
    const result = await runCountryAccessSyncJob();
    expect(result).toMatchObject({ status: 'synced' });
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]!.body).toEqual({ enforce: true, blocked: WITH_POLICY, updatedByEmail: OPS_EMAIL });
  });

  it('sends the defaults, without an operator, before anyone has saved', async () => {
    await runCountryAccessSyncJob();
    expect(fake.puts[0]!.body).toEqual({ enforce: true, blocked: SANCTIONS });
  });
});
