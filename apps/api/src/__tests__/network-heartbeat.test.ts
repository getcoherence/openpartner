/**
 * The Network heartbeat carries the brand's name and logo to its
 * marketplace listing.
 *
 *   - the heartbeat sends the name the portal shows: program_settings
 *     programName, else Tenant.displayName
 *   - it leaves the name out when it's the self-host seed row's placeholder
 *     or longer than the Network accepts (that would 400 the whole beat)
 *   - renaming the brand under Brand info (POST /config/program) pushes a
 *     heartbeat once the save has committed; a save that keeps the name
 *     doesn't, and a Network failure never fails the save
 *   - a logo upload pushes the new logo the same way, and so does opening
 *     the admin Network page (GET /admin/network/me)
 *
 * Spins up an in-process receiver as the Network. Skipped if DATABASE_URL
 * isn't set, like the rest of the integration suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
// RLS isn't under test here: the app pool runs as the privileged role.
delete process.env.DATABASE_URL_APP;
delete process.env.ADMIN_API_KEY;
const uploadsDir = mkdtempSync(join(tmpdir(), 'op-heartbeat-uploads-'));
process.env.OPENPARTNER_STORAGE_KIND = 'fs';
process.env.OPENPARTNER_STORAGE_FS_DIR = uploadsDir;
process.env.OPENPARTNER_STORAGE_FS_PUBLIC_BASE = 'https://cdn.example.test/uploads';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { encryptSecret } = await import('../crypto.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const T = { id: `01BEAT${ulid().slice(6)}`, slug: `beat-${ulid().slice(-6).toLowerCase()}` };
const SIGNUP_NAME = 'Acme';

// ---------- the stand-in Network ----------

interface Beat {
  body: Record<string, unknown>;
  /** program_settings.programName as committed when the beat arrived. */
  committedName: string | null;
}
let receiver: Server;
let receiverUrl = '';
let beats: Beat[] = [];
let beatStatus = 204;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          if (req.url === '/vendors/me/heartbeat') {
            const row = await db(TABLES.Config).where({ tenantId: T.id, key: 'program_settings' }).first();
            beats.push({
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              committedName: (row?.value as { programName?: string | null } | undefined)?.programName ?? null,
            });
          }
          if (req.url === '/vendors/me') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'vnd_heartbeat_test', displayName: SIGNUP_NAME, status: 'active', partnerCount: 99 }));
            return;
          }
          res.writeHead(beatStatus);
          res.end();
        })();
      });
    }).listen(0, '127.0.0.1', () => {
      receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
      resolve();
    });
  });
  if (skipIntegration) return;
  await wipe();
  await db(TABLES.Tenant).insert({ id: T.id, slug: T.slug, displayName: SIGNUP_NAME, status: 'active', approvalStatus: 'approved' });
});

afterAll(async () => {
  if (receiver) await new Promise<void>((r) => receiver.close(() => r()));
  if (!skipIntegration) {
    await wipe();
    await db(TABLES.Tenant).where({ id: T.id }).del();
  }
  await db.destroy();
  rmSync(uploadsDir, { recursive: true, force: true });
});

async function wipe(): Promise<void> {
  for (const t of [TABLES.ApiKey, TABLES.Config]) await db(t).where({ tenantId: T.id }).del();
}

let adminKey = '';
const asAdmin = () => ({ Authorization: `Bearer ${adminKey}` });

beforeEach(async () => {
  beats = [];
  beatStatus = 204;
  if (skipIntegration) return;
  await wipe();
  await db(TABLES.Tenant).where({ id: T.id }).update({ displayName: SIGNUP_NAME, logoUrl: null });
  adminKey = (await createApiKeyRow(db, { tenantId: T.id, label: 'heartbeat admin' })).plaintext;
  const membership = {
    enabled: true,
    networkUrl: receiverUrl,
    vendorTokenCiphertext: encryptSecret('vntok_heartbeat_test'),
    scopedKeyId: null,
    autoEnroll: true,
  };
  await db(TABLES.Config).insert({ tenantId: T.id, key: 'network_membership', value: membership as unknown as never, updatedAt: new Date() });
});

async function setProgramName(programName: string): Promise<void> {
  await db(TABLES.Config).insert({
    tenantId: T.id,
    key: 'program_settings',
    value: { partnerNetworkVisible: true, routerUrl: null, programName, supportEmail: null } as unknown as never,
    updatedAt: new Date(),
  });
}

const saveProgram = (body: Record<string, unknown>) =>
  request(app).post(`/t/${T.slug}/config/program`).set(asAdmin()).send(body);
const beatNow = () => request(app).post(`/t/${T.slug}/admin/network/heartbeat`).set(asAdmin());

// ---------- tests ----------

describe.skipIf(skipIntegration)('brand name on the Network heartbeat', () => {
  it('sends the Brand info name, else the signup name', async () => {
    expect((await beatNow()).body).toMatchObject({ sent: true });
    expect(beats[0]!.body.displayName).toBe(SIGNUP_NAME);

    await setProgramName('Acme Labs');
    await beatNow();
    expect(beats[1]!.body.displayName).toBe('Acme Labs');
  });

  it("leaves the name out when it's the self-host placeholder, and still beats", async () => {
    await db(TABLES.Tenant).where({ id: T.id }).update({ displayName: 'Default tenant' });
    expect((await beatNow()).body).toMatchObject({ sent: true });
    expect(beats[0]!.body).not.toHaveProperty('displayName');
  });

  it('leaves out a name longer than the Network accepts, and still beats', async () => {
    await setProgramName('x'.repeat(121));
    expect((await beatNow()).body).toMatchObject({ sent: true });
    expect(beats[0]!.body).not.toHaveProperty('displayName');
    expect(beats[0]!.body).toHaveProperty('partnerCount', 0);
  });
});

describe.skipIf(skipIntegration)('POST /config/program pushes a rename', () => {
  it('pushes the new name once the save has committed', async () => {
    const res = await saveProgram({ programName: '  Acme Labs  ' });
    expect(res.status).toBe(200);
    expect(res.body.programName).toBe('Acme Labs');
    expect(beats).toHaveLength(1);
    expect(beats[0]!.body.displayName).toBe('Acme Labs');
    expect(beats[0]!.committedName).toBe('Acme Labs');
  });

  it('sends nothing when the save keeps the name', async () => {
    await setProgramName('Acme Labs');
    const res = await saveProgram({ programName: 'Acme Labs', supportEmail: 'help@acme.test' });
    expect(res.status).toBe(200);
    expect(beats).toHaveLength(0);
  });

  it('clearing the name pushes the signup name back', async () => {
    await setProgramName('Acme Labs');
    const res = await saveProgram({ programName: '' });
    expect(res.status).toBe(200);
    expect(res.body.programName).toBe(SIGNUP_NAME);
    expect(beats.map((b) => b.body.displayName)).toEqual([SIGNUP_NAME]);
  });

  it('a Network failure never fails the save', async () => {
    beatStatus = 500;
    const res = await saveProgram({ programName: 'Acme Labs' });
    expect(res.status).toBe(200);
    expect(beats).toHaveLength(1);
    const row = await db(TABLES.Config).where({ tenantId: T.id, key: 'program_settings' }).first();
    expect((row!.value as { programName: string }).programName).toBe('Acme Labs');
  });
});

describe.skipIf(skipIntegration)('GET /admin/network/me pushes a heartbeat', () => {
  it('sends it before answering, and reports the local partner count', async () => {
    const res = await request(app).get(`/t/${T.slug}/admin/network/me`).set(asAdmin());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'vnd_heartbeat_test', partnerCount: 0 });
    expect(beats).toHaveLength(1);
    expect(beats[0]!.body.displayName).toBe(SIGNUP_NAME);
  });

  it('a heartbeat failure never fails the page', async () => {
    beatStatus = 500;
    const res = await request(app).get(`/t/${T.slug}/admin/network/me`).set(asAdmin());
    expect(res.status).toBe(200);
    expect(beats).toHaveLength(1);
  });
});

describe.skipIf(skipIntegration)('POST /uploads/logo pushes the new logo', () => {
  it('sends the uploaded logo once the upload has committed', async () => {
    const res = await request(app)
      .post(`/t/${T.slug}/uploads/logo`)
      .set(asAdmin())
      .set('content-type', 'image/png')
      .send(Buffer.from('89504e470d0a1a0a', 'hex'));
    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toMatch(/^https:\/\/cdn\.example\.test\/uploads\/tenants\//);
    expect(beats).toHaveLength(1);
    expect(beats[0]!.body.logoUrl).toBe(res.body.logoUrl);
  });
});
