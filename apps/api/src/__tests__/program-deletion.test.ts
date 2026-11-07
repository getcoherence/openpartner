/**
 * Deleting a program nothing uses yet (DELETE /programs/:id,
 * program-deletion.ts).
 *
 *   - GET /programs flags an unused program deletable, and DELETE removes it
 *   - a row naming the program, in any of the nine tables with a programId,
 *     makes it in use: 409 program_in_use, and nothing is deleted (four of
 *     those tables would cascade)
 *   - its Network offering comes down first: deleted, else unpublished; an
 *     offering the Network no longer has is down already. When neither call
 *     works, or the Network is switched off, the program stays.
 *
 * Single-tenant mode against a fake Network. The cross-tenant 404 is in
 * tenant-scope-no-rls.test.ts, where RLS can't hide a missing tenant
 * filter. Skipped when DATABASE_URL is unset, like the rest of the
 * integration suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_program_deletion_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { encryptSecret } = await import('../crypto.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const auth = { Authorization: `Bearer ${ADMIN_KEY}` };
const tenantId = DEFAULT_TENANT_ID;

// ----- fake Network -----

/** 'ok' answers everything; 'delete-fails' 500s a DELETE; 'gone' 404s, as
 *  for an offering the Network doesn't have; 'down' 503s. */
let netMode: 'ok' | 'delete-fails' | 'gone' | 'down' = 'ok';
let netCalls: Array<{ method: string; path: string; body: unknown }> = [];
let netServer: Server;
let netUrl = '';
let savedMembership: unknown;

function membership(enabled: boolean) {
  return {
    enabled,
    networkUrl: netUrl,
    vendorId: 'vnd_program_deletion',
    vendorTokenCiphertext: encryptSecret('vntok_test'),
    autoEnroll: false,
    scopedKeyId: null,
  };
}

async function setMembership(enabled: boolean): Promise<void> {
  const value = membership(enabled);
  await db(TABLES.Config)
    .insert({ tenantId, key: 'network_membership', value: value as never, updatedAt: new Date() })
    .onConflict(['tenantId', 'key'])
    .merge({ value: value as never, updatedAt: new Date() });
}

// ----- seeding -----

const programIds: string[] = [];
const eventIds: string[] = [];
let partnerId = '';

async function seedProgram(networkOfferingId: string | null = null): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId,
    name: `Duplicate ${id.slice(-6)}`,
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 10 }]) as never,
    destinationUrl: 'https://app.example.com/',
    networkOfferingId,
  });
  programIds.push(id);
  return id;
}

/** One row naming the program in each table with a programId, labelled as
 *  the 409 names it. */
const REFERENCES: Array<{ label: string; table: string; seed: (programId: string) => Promise<unknown> }> = [
  {
    label: 'partners',
    table: TABLES.PartnerProgram,
    seed: (programId) => db(TABLES.PartnerProgram).insert({ id: `pc_${ulid()}`, tenantId, partnerId, programId, source: 'admin' }),
  },
  {
    label: 'links',
    table: TABLES.Link,
    seed: (programId) => db(TABLES.Link).insert({ id: ulid(), tenantId, linkKey: `del-${ulid()}`, partnerId, programId }),
  },
  {
    label: 'clicks',
    table: TABLES.Click,
    seed: (programId) =>
      db(TABLES.Click).insert({ id: ulid(), tenantId, partnerId, programId, landingUrl: 'https://app.example.com/' }),
  },
  {
    label: 'coupons',
    table: TABLES.Coupon,
    seed: (programId) => db(TABLES.Coupon).insert({ id: ulid(), tenantId, partnerId, programId, code: `DEL${ulid().slice(-8)}` }),
  },
  {
    label: 'partner commission terms',
    table: TABLES.PartnerCommission,
    seed: (programId) =>
      db(TABLES.PartnerCommission).insert({
        id: `pcm_${ulid()}`,
        tenantId,
        partnerId,
        programId,
        commissionType: 'percent',
        commissionValue: 20,
        source: 'admin',
      }),
  },
  {
    label: 'bonuses',
    table: TABLES.Bonus,
    seed: (programId) =>
      db(TABLES.Bonus).insert({ id: ulid(), tenantId, partnerId, programId, amount: '10.00', currency: 'USD', source: 'manual' }),
  },
  {
    label: 'bounties',
    table: TABLES.Bounty,
    seed: (programId) =>
      db(TABLES.Bounty).insert({
        id: ulid(),
        tenantId,
        programId,
        name: 'Five sales',
        metric: 'conversions',
        threshold: 5,
        rewardAmount: 50,
        currency: 'USD',
      }),
  },
  {
    label: 'test clicks',
    table: TABLES.TestClick,
    seed: (programId) =>
      db(TABLES.TestClick).insert({
        id: ulid(),
        tenantId,
        programId,
        tokenHash: `del-${ulid()}`,
        expiresAt: new Date(Date.now() + 60_000),
      }),
  },
  {
    label: 'conversions',
    table: TABLES.Attribution,
    seed: async (programId) => {
      const eventId = ulid();
      eventIds.push(eventId);
      await db(TABLES.Event).insert({ id: eventId, tenantId, userId: `u_${eventId}`, type: 'signup' });
      await db(TABLES.Attribution).insert({
        id: ulid(),
        tenantId,
        eventId,
        partnerId,
        programId,
        clickId: `clk_${eventId}`,
        model: 'last_click',
      });
    },
  },
];

beforeAll(async () => {
  if (skipIntegration) return;
  await new Promise<void>((resolve) => {
    netServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        netCalls.push({ method: req.method ?? '', path: req.url ?? '', body });
        const [status, out] =
          netMode === 'down'
            ? [503, { error: 'unavailable' }]
            : netMode === 'gone'
              ? [404, { error: 'not_found' }]
              : netMode === 'delete-fails' && req.method === 'DELETE'
                ? [500, { error: 'internal' }]
                : [200, req.method === 'DELETE' ? { ok: true, hardDeleted: true } : { ok: true }];
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    }).listen(0, '127.0.0.1', () => {
      netUrl = `http://127.0.0.1:${(netServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
  // Keep whatever membership the local dev DB had so afterAll can put it back.
  savedMembership =
    (await db(TABLES.Config).where({ tenantId, key: 'network_membership' }).first())?.value ?? null;
  await setMembership(true);
  partnerId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId, email: `del-${partnerId.toLowerCase()}@example.com`, name: 'Del' });
});

beforeEach(async () => {
  netCalls = [];
  netMode = 'ok';
  if (!skipIntegration) await setMembership(true);
});

afterAll(async () => {
  if (netServer) await new Promise<void>((r) => netServer.close(() => r()));
  if (!skipIntegration) {
    await db(TABLES.Attribution).whereIn('programId', programIds).del();
    await db(TABLES.Event).whereIn('id', eventIds).del();
    for (const t of [TABLES.Bonus, TABLES.Bounty, TABLES.Click, TABLES.Link, TABLES.Coupon, TABLES.PartnerProgram, TABLES.PartnerCommission, TABLES.TestClick]) {
      await db(t).whereIn('programId', programIds).del();
    }
    await db(TABLES.Program).whereIn('id', programIds).del();
    await db(TABLES.Partner).where({ id: partnerId }).del();
    if (savedMembership) {
      await db(TABLES.Config)
        .where({ tenantId, key: 'network_membership' })
        .update({ value: savedMembership as never, updatedAt: new Date() });
    } else {
      await db(TABLES.Config).where({ tenantId, key: 'network_membership' }).del();
    }
  }
  await db.destroy();
});

async function listed(programId: string): Promise<{ deletable: boolean } | undefined> {
  const res = await request(app).get('/programs').set(auth);
  expect(res.status).toBe(200);
  return (res.body.programs as Array<{ id: string; deletable: boolean }>).find((p) => p.id === programId);
}

const exists = async (programId: string) => Boolean(await db(TABLES.Program).where({ id: programId }).first());

describe.skipIf(skipIntegration)('DELETE /programs/:id', () => {
  it('deletes a program nothing uses', async () => {
    const id = await seedProgram();
    expect(await listed(id)).toMatchObject({ deletable: true });

    const res = await request(app).delete(`/programs/${id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await exists(id)).toBe(false);
    expect(await listed(id)).toBeUndefined();
    expect(netCalls).toEqual([]);
  });

  it('answers 404 for a program that is not there', async () => {
    const res = await request(app).delete(`/programs/${ulid()}`).set(auth);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it.each(REFERENCES)('keeps a program with $label', async ({ label, table, seed }) => {
    const id = await seedProgram();
    await seed(id);
    expect(await listed(id)).toMatchObject({ deletable: false });

    const res = await request(app).delete(`/programs/${id}`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('program_in_use');
    expect(res.body.detail).toContain(label);
    expect(res.body.detail).toContain('End it instead');
    expect(await exists(id)).toBe(true);
    expect(await db(table).where({ programId: id }).first()).toBeTruthy();
  });

  it('names everything that uses the program', async () => {
    const id = await seedProgram();
    await REFERENCES[0]!.seed(id);
    await REFERENCES[1]!.seed(id);
    await REFERENCES[2]!.seed(id);
    const res = await request(app).delete(`/programs/${id}`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.detail).toBe("This program has partners, links and clicks, so it can't be deleted. End it instead.");
  });

  it('leaves the Network alone for a program in use', async () => {
    const id = await seedProgram('off_in_use');
    await REFERENCES[1]!.seed(id);
    const res = await request(app).delete(`/programs/${id}`).set(auth);
    expect(res.status).toBe(409);
    expect(netCalls).toEqual([]);
  });
});

describe.skipIf(skipIntegration)('DELETE /programs/:id with a Network listing', () => {
  it('deletes the offering, then the program', async () => {
    const id = await seedProgram('off_dup');
    const res = await request(app).delete(`/programs/${id}`).set(auth);
    expect(res.status).toBe(200);
    expect(netCalls).toEqual([{ method: 'DELETE', path: '/vendors/me/offerings/off_dup', body: null }]);
    expect(await exists(id)).toBe(false);
  });

  it('unpublishes the offering when the Network refuses to delete it', async () => {
    netMode = 'delete-fails';
    const id = await seedProgram('off_dup');
    const res = await request(app).delete(`/programs/${id}`).set(auth);
    expect(res.status).toBe(200);
    expect(netCalls).toEqual([
      { method: 'DELETE', path: '/vendors/me/offerings/off_dup', body: null },
      { method: 'PATCH', path: '/vendors/me/offerings/off_dup', body: { published: false } },
    ]);
    expect(await exists(id)).toBe(false);
  });

  it('deletes the program when the Network no longer has the offering', async () => {
    netMode = 'gone';
    const id = await seedProgram('off_gone');
    const res = await request(app).delete(`/programs/${id}`).set(auth);
    expect(res.status).toBe(200);
    expect(await exists(id)).toBe(false);
  });

  it('keeps the program when the offering may still be listed', async () => {
    netMode = 'down';
    const id = await seedProgram('off_dup');
    const res = await request(app).delete(`/programs/${id}`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('network_listing_not_removed');
    expect(res.body.detail).toContain('Try again');
    expect(netCalls.map((c) => c.method)).toEqual(['DELETE', 'PATCH']);
    expect(await exists(id)).toBe(true);
    expect(await listed(id)).toMatchObject({ deletable: true });
  });

  it('keeps the program while the Network is switched off', async () => {
    await setMembership(false);
    const id = await seedProgram('off_dup');
    const res = await request(app).delete(`/programs/${id}`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('network_listing_not_removed');
    expect(res.body.detail).toContain('switched off');
    expect(netCalls).toEqual([]);
    expect(await exists(id)).toBe(true);
  });
});
