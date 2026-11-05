/**
 * Brand outreach, openpartner side (openpartner-network docs/brand-outreach.md
 * §6; routes/platform-admin.ts): the ops console reads and writes the
 * Network's settings with the admin key and audits writes; support operators
 * can look; changes, runs, rejections and full addresses take an admin; the
 * list's filters pass through and nothing else does.
 *
 * A local HTTP server plays the Network. Skipped without DATABASE_URL.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type PlatformAdminRow } from '@openpartner/db';

const NETWORK_ADMIN = 'netadm_test_brandoutreach_0123456789abc';
process.env.ADMIN_API_KEY = 'op_test_brandoutreach_0123456789abcdef01';
process.env.OPENPARTNER_MODE = 'revshare';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.NETWORK_ADMIN_API_KEY = NETWORK_ADMIN;
delete process.env.PLATFORM_OPS_EMAIL;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import('../platform-admin-sessions.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

interface Call {
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown> | null;
}
const calls: Call[] = [];
let network: Server;
const OPS_EMAIL = `ops-${ulid().slice(-6).toLowerCase()}@openpartner.test`;
const operatorIds: string[] = [];

const SETTINGS = {
  enabled: true,
  monthlyBudgetUsd: 20,
  queries: ['developer tools'],
  lookbackDays: 7,
  sendAfterDays: 14,
  maxLaunchAgeDays: 60,
  readConcurrency: 4,
};

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    network = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : null;
        const path = req.url ?? '';
        calls.push({ method: req.method ?? '', path, auth: req.headers.authorization, body });
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.headers.authorization !== `Bearer ${NETWORK_ADMIN}`) return json(401, { error: 'unauthorized' });
        if (path === '/admin/brand-outreach/settings' && req.method === 'GET') {
          return json(200, { settings: SETTINGS, defaults: SETTINGS, updatedAt: null, updatedByEmail: null, configured: { exa: true, treg: true, classifier: true, classifierModel: 'claude-opus-5-5' } });
        }
        if (path === '/admin/brand-outreach/settings' && req.method === 'PUT') {
          if (Number(body?.maxLaunchAgeDays) <= Number(body?.sendAfterDays)) return json(400, { error: 'invalid_body' });
          const { updatedByEmail, ...settings } = body ?? {};
          return json(200, { settings, updatedAt: new Date().toISOString(), updatedByEmail });
        }
        if (path === '/admin/brand-outreach/stats') return json(200, { byStatus: { qualified: 2 }, ready: 1, waiting: 1 });
        if (path.startsWith('/admin/brand-outreach/prospects?')) return json(200, { prospects: [{ id: 'bpr_1' }], nextCursor: null });
        if (path === '/admin/brand-outreach/prospects/bpr_1/contact') return json(200, { contact: { email: 'hello@acmenotes.example', foundOn: 'https://acmenotes.example' } });
        if (path === '/admin/brand-outreach/prospects/bpr_1/reject' && req.method === 'POST') {
          res.writeHead(204);
          return res.end();
        }
        if (path === '/admin/brand-outreach/prospects/bpr_gone/reject') return json(404, { error: 'not_found' });
        if (path === '/admin/brand-outreach/prospects/bpr_1/approve') {
          if (body?.email === 'support@acmenotes.example') return json(400, { error: 'not_their_address' });
          return json(200, { prospect: { id: 'bpr_1', status: 'qualified' } });
        }
        if (path === '/admin/brand-outreach/prospects/bpr_1/find-address') {
          if (body?.country === 'CA') return json(422, { error: 'published_only_country' });
          return json(200, { prospect: { id: 'bpr_1', status: 'review', contact: { masked: 'j•@acmenotes.example', foundOn: 'via:own-domain:acmenotes.example', person: 'Jo Rivera, Founder' } } });
        }
        if (path === '/admin/brand-outreach/seeds') return json(200, { queued: 1, duplicate: 0, invalid: 0 });
        if (path === '/admin/brand-outreach/run/discover') return json(202, { started: true });
        if (path === '/admin/brand-outreach/outreach/run') return body?.dryRun ? json(200, { due: 1, targets: [] }) : json(202, { started: true });
        if (path === '/admin/brand-outreach/outreach/sample') return json(200, { sent: body?.to, failed: [] });
        if (path === '/admin/brand-outreach/run/read') return json(409, { error: 'already_running' });
        json(404, { error: 'not_found' });
      });
    }).listen(0, '127.0.0.1', () => {
      process.env.NETWORK_URL = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (!skipIntegration) {
    await db(TABLES.PlatformAuditLog).whereIn('platformAdminEmail', [OPS_EMAIL, `support-${OPS_EMAIL}`]).del();
    for (const id of operatorIds) {
      await db(TABLES.PlatformAdminSession).where({ platformAdminId: id }).del();
      await db(TABLES.PlatformAdmin).where({ id }).del();
    }
  }
  if (network) await new Promise<void>((r) => network.close(() => r()));
  await db.destroy();
});

beforeEach(() => {
  calls.length = 0;
});

async function operator(role: 'admin' | 'support' = 'admin'): Promise<string> {
  const email = role === 'admin' ? OPS_EMAIL : `support-${OPS_EMAIL}`;
  let admin = (await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ email }).first()) as PlatformAdminRow | undefined;
  if (!admin) {
    admin = { id: ulid(), email, name: 'Ops', role, createdAt: new Date(), revokedAt: null } as PlatformAdminRow;
    await db<PlatformAdminRow>(TABLES.PlatformAdmin).insert(admin);
    operatorIds.push(admin.id);
  }
  const session = await createPlatformAdminSession(db, admin);
  return `${PLATFORM_ADMIN_SESSION_COOKIE}=${session.plaintext}`;
}

function last(path: string | RegExp): Call | undefined {
  return [...calls].reverse().find((c) => (typeof path === 'string' ? c.path === path : path.test(c.path)));
}

async function audited(action: string): Promise<Record<string, unknown> | undefined> {
  return db(TABLES.PlatformAuditLog).where({ action, platformAdminEmail: OPS_EMAIL }).orderBy('createdAt', 'desc').first();
}

describe.skipIf(skipIntegration)('brand outreach: ops console', () => {
  it('reads settings with the admin key and saves them with the operator, audited', async () => {
    const cookie = await operator();
    const got = await request(app).get('/platform-admin/brand-outreach/settings').set('Cookie', cookie);
    expect(got.status).toBe(200);
    expect(got.body.configured).toMatchObject({ exa: true, classifierModel: 'claude-opus-5-5' });
    expect(last('/admin/brand-outreach/settings')!.auth).toBe(`Bearer ${NETWORK_ADMIN}`);

    const put = await request(app).put('/platform-admin/brand-outreach/settings').set('Cookie', cookie).send({ ...SETTINGS, queries: ['developer tools', 'AI tools for marketers'] });
    expect(put.status).toBe(200);
    expect(last('/admin/brand-outreach/settings')!.body).toMatchObject({ queries: ['developer tools', 'AI tools for marketers'], updatedByEmail: OPS_EMAIL });
    expect(await audited('brand_outreach.settings')).toBeTruthy();

    // The sources, job roles and countries, the codes made upper case.
    const sourced = await request(app)
      .put('/platform-admin/brand-outreach/settings')
      .set('Cookie', cookie)
      .send({ ...SETTINGS, sources: { productHunt: true, jobPosts: true, creatorMentions: false }, jobQueries: ['Head of Partnerships'], minCreatorMentions: 3, excludedCountries: ['de', 'GB'] });
    expect(sourced.status).toBe(200);
    expect(last('/admin/brand-outreach/settings')!.body).toMatchObject({ excludedCountries: ['DE', 'GB'], minCreatorMentions: 3, sources: { creatorMentions: false } });
    expect((await request(app).put('/platform-admin/brand-outreach/settings').set('Cookie', cookie).send({ ...SETTINGS, excludedCountries: ['XX'] })).status).toBe(400);

    // Nothing the Network doesn't take, and its own refusal comes back.
    expect((await request(app).put('/platform-admin/brand-outreach/settings').set('Cookie', cookie).send({ ...SETTINGS, bogus: true })).status).toBe(400);
    expect((await request(app).put('/platform-admin/brand-outreach/settings').set('Cookie', cookie).send({ ...SETTINGS, readConcurrency: 11 })).status).toBe(400);
    expect((await request(app).put('/platform-admin/brand-outreach/settings').set('Cookie', cookie).send({ ...SETTINGS, maxLaunchAgeDays: 14 })).status).toBe(400);
  });

  it('lets support look, and keeps changes, runs, rejections and full addresses to admins', async () => {
    const support = await operator('support');
    expect((await request(app).get('/platform-admin/brand-outreach/stats').set('Cookie', support)).body).toEqual({ byStatus: { qualified: 2 }, ready: 1, waiting: 1 });
    expect((await request(app).get('/platform-admin/brand-outreach/prospects?view=ready').set('Cookie', support)).status).toBe(200);
    for (const [method, path] of [
      ['put', '/platform-admin/brand-outreach/settings'],
      ['post', '/platform-admin/brand-outreach/run/discover'],
      ['post', '/platform-admin/brand-outreach/seeds'],
      ['post', '/platform-admin/brand-outreach/prospects/bpr_1/reject'],
      ['post', '/platform-admin/brand-outreach/prospects/bpr_1/approve'],
      ['post', '/platform-admin/brand-outreach/prospects/bpr_1/find-address'],
      ['get', '/platform-admin/brand-outreach/prospects/bpr_1/contact'],
    ] as const) {
      expect({ path, status: (await request(app)[method](path).set('Cookie', support).send(SETTINGS)).status }).toEqual({ path, status: 403 });
    }
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);

    const admin = await operator();
    expect((await request(app).post('/platform-admin/brand-outreach/run/discover').set('Cookie', admin)).body).toEqual({ started: true });
    expect(await audited('brand_outreach.run_discover')).toBeTruthy();
    const busy = await request(app).post('/platform-admin/brand-outreach/run/read').set('Cookie', admin);
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({ error: 'already_running' });
    expect((await request(app).post('/platform-admin/brand-outreach/run/refresh').set('Cookie', admin)).status).toBe(404);

    const seeds = await request(app).post('/platform-admin/brand-outreach/seeds').set('Cookie', admin).send({ urls: ['https://www.producthunt.com/products/acme-notes'] });
    expect(seeds.body).toEqual({ queued: 1, duplicate: 0, invalid: 0 });
    expect(await audited('brand_outreach.seeds')).toBeTruthy();

    expect((await request(app).post('/platform-admin/brand-outreach/prospects/bpr_1/reject').set('Cookie', admin)).status).toBe(204);
    expect(last('/admin/brand-outreach/prospects/bpr_1/reject')!.body).toEqual({ reviewedByEmail: OPS_EMAIL });
    expect(await audited('brand_outreach.reject')).toMatchObject({ targetType: 'brand_prospect', targetId: 'bpr_1' });
    expect((await request(app).post('/platform-admin/brand-outreach/prospects/bpr_gone/reject').set('Cookie', admin)).body).toEqual({ error: 'not_found' });
  });

  it('approves a held one for admins with who did it, audited, and passes the Network’s refusal back', async () => {
    const admin = await operator();
    const ok = await request(app).post('/platform-admin/brand-outreach/prospects/bpr_1/approve').set('Cookie', admin).send({});
    expect(ok.body).toEqual({ prospect: { id: 'bpr_1', status: 'qualified' } });
    expect(last('/admin/brand-outreach/prospects/bpr_1/approve')!.body).toEqual({ reviewedByEmail: OPS_EMAIL });
    // The country ops name, as a code.
    await request(app).post('/platform-admin/brand-outreach/prospects/bpr_1/approve').set('Cookie', admin).send({ country: 'ca' });
    expect(last('/admin/brand-outreach/prospects/bpr_1/approve')!.body).toEqual({ country: 'CA', reviewedByEmail: OPS_EMAIL });
    expect((await request(app).post('/platform-admin/brand-outreach/prospects/bpr_1/approve').set('Cookie', admin).send({ country: 'XX' })).status).toBe(400);
    expect(await audited('brand_outreach.approve')).toMatchObject({ targetType: 'brand_prospect', targetId: 'bpr_1' });

    const page = 'https://acmenotes.example/about';
    const refused = await request(app).post('/platform-admin/brand-outreach/prospects/bpr_1/approve').set('Cookie', admin).send({ email: 'support@acmenotes.example', sourceUrl: page });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'not_their_address' });
    expect(last('/admin/brand-outreach/prospects/bpr_1/approve')!.body).toEqual({ email: 'support@acmenotes.example', sourceUrl: page, reviewedByEmail: OPS_EMAIL });

    // An address goes with its page.
    expect((await request(app).post('/platform-admin/brand-outreach/prospects/bpr_1/approve').set('Cookie', admin).send({ email: 'jo@acmenotes.example' })).status).toBe(400);
    expect((await request(app).post('/platform-admin/brand-outreach/prospects/bpr_1/approve').set('Cookie', admin).send({ reviewedByEmail: 'someone@else.example' })).status).toBe(400);
  });

  it("asks the Network to find a founder's address for admins, audited, and passes its refusal back", async () => {
    const admin = await operator();
    const found = await request(app).post('/platform-admin/brand-outreach/prospects/bpr_1/find-address').set('Cookie', admin).send({});
    expect(found.body.prospect.contact).toEqual({ masked: 'j•@acmenotes.example', foundOn: 'via:own-domain:acmenotes.example', person: 'Jo Rivera, Founder' });
    expect(last('/admin/brand-outreach/prospects/bpr_1/find-address')!.body).toEqual({ reviewedByEmail: OPS_EMAIL });
    expect(await audited('brand_outreach.find_address')).toMatchObject({ targetType: 'brand_prospect', targetId: 'bpr_1' });

    const refused = await request(app).post('/platform-admin/brand-outreach/prospects/bpr_1/find-address').set('Cookie', admin).send({ country: 'ca' });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ error: 'published_only_country' });
    expect(last('/admin/brand-outreach/prospects/bpr_1/find-address')!.body).toEqual({ country: 'CA', reviewedByEmail: OPS_EMAIL });
    expect((await request(app).post('/platform-admin/brand-outreach/prospects/bpr_1/find-address').set('Cookie', admin).send({ email: 'jo@acmenotes.example' })).status).toBe(400);
  });

  it("previews a batch for support, sends one for admins, and never emails openpartner's own brands", async () => {
    const tenantId = ulid();
    const slug = `bo${ulid().slice(-8).toLowerCase()}`;
    await db(TABLES.Tenant).insert({ id: tenantId, slug, displayName: 'Ours', status: 'active', approvalStatus: 'approved' });
    await db(TABLES.Admin).insert([
      { id: ulid(), tenantId, email: `owner@${slug}.example`, name: 'Owner', activatedAt: new Date() },
      { id: ulid(), tenantId, email: `someone-${slug}@gmail.com`, name: 'Free', activatedAt: new Date() },
    ]);
    try {
      const support = await operator('support');
      const dry = await request(app).post('/platform-admin/brand-outreach/outreach/run').set('Cookie', support).send({ dryRun: true, limit: 10 });
      expect(dry.status).toBe(200);
      const sent = last('/admin/brand-outreach/outreach/run')!.body as { dryRun: boolean; limit: number; excludeDomains: string[] };
      expect(sent).toMatchObject({ dryRun: true, limit: 10 });
      expect(sent.excludeDomains).toContain(`${slug}.example`);
      // A free-mail provider isn't a company.
      expect(sent.excludeDomains).not.toContain('gmail.com');
      expect((await request(app).post('/platform-admin/brand-outreach/outreach/run').set('Cookie', support).send({})).status).toBe(403);
      expect((await request(app).post('/platform-admin/brand-outreach/outreach/sample').set('Cookie', support).send({ to: ['seed@example.com'] })).status).toBe(403);

      const admin = await operator();
      const live = await request(app).post('/platform-admin/brand-outreach/outreach/run').set('Cookie', admin).send({ limit: 25 });
      expect(live.status).toBe(202);
      expect(await audited('brand_outreach.outreach_run')).toMatchObject({ detail: { limit: 25 } });
      expect((await request(app).post('/platform-admin/brand-outreach/outreach/run').set('Cookie', admin).send({ limit: 51 })).status).toBe(400);

      const sample = await request(app).post('/platform-admin/brand-outreach/outreach/sample').set('Cookie', admin).send({ to: ['Seed@Example.com'], style: 'designed' });
      expect(sample.body).toEqual({ sent: ['seed@example.com'], failed: [] });
      expect(await audited('brand_outreach.outreach_sample')).toMatchObject({ detail: { to: ['seed@example.com'], style: 'designed' } });
    } finally {
      await db(TABLES.Admin).where({ tenantId }).del();
      await db(TABLES.Tenant).where({ id: tenantId }).del();
    }
  });

  it('shows one address in full to admins, uncached and audited', async () => {
    const admin = await operator();
    const r = await request(app).get('/platform-admin/brand-outreach/prospects/bpr_1/contact').set('Cookie', admin);
    expect(r.body.contact.email).toBe('hello@acmenotes.example');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(await audited('brand_outreach.contact_view')).toMatchObject({ targetId: 'bpr_1' });
  });

  it("passes the list's filters through, and nothing else", async () => {
    const admin = await operator();
    await request(app).get('/platform-admin/brand-outreach/prospects?view=rejected&reason=not_us&q=acme&after=abc&extra=1').set('Cookie', admin);
    const path = last(/^\/admin\/brand-outreach\/prospects\?/)!.path;
    expect(Object.fromEntries(new URLSearchParams(path.split('?')[1]))).toEqual({ view: 'rejected', reason: 'not_us', q: 'acme', after: 'abc' });
  });
});
