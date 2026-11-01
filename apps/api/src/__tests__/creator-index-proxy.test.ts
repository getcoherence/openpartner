/**
 * The creator index, openpartner side (openpartner-network
 * docs/creator-index.md §4–§6; routes/settings.ts, creator-portal.ts,
 * platform-admin.ts, scheduler.ts).
 *
 *   1. Brand search and invites are for Flex and Enterprise with an active
 *      plan: anyone else gets 402 and the Network isn't called. The flag
 *      the Network needs is added here, never taken from the browser.
 *   2. Invites carry the signed-in admin and only the invite's own fields;
 *      the Network's error code reaches the portal. Listing and withdrawing
 *      need no plan. A brand in review can't invite.
 *   3. The claim paths pass through the creator portal proxy.
 *   4. The ops console reads and writes the Network's settings with the
 *      admin key, audits writes, and keeps runs to admins. Anyone on it can
 *      preview an outreach batch; sending one takes an admin.
 *   5. The hourly cron triggers the invite email.
 *
 * A local HTTP server plays the Network. Skipped without DATABASE_URL.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type PlatformAdminRow, type TenantRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_creatorindex_0123456789abcdef0123';
const NETWORK_ADMIN = 'netadm_test_creatorindex_0123456789abcd';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'revshare';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.NETWORK_ADMIN_API_KEY = NETWORK_ADMIN;
delete process.env.PLATFORM_OPS_EMAIL;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createSession } = await import('../auth-sessions.js');
const { encryptSecret } = await import('../crypto.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import('../platform-admin-sessions.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

interface Call {
  method: string;
  path: string;
  auth: string | undefined;
  cookie: string | undefined;
  body: Record<string, unknown> | null;
}
const calls: Call[] = [];
let network: Server;
let networkUrl: string;
const OPS_EMAIL = `ops-${ulid().slice(-6).toLowerCase()}@openpartner.test`;
const operatorIds: string[] = [];

const SETTINGS = {
  enabled: true,
  invitesEnabled: false,
  monthlyBudgetUsd: 25,
  minFollowers: 3000,
  minPostsPer30d: 4,
  refreshDays: 30,
  excludedCountries: ['DE', 'GB', 'CH'],
  hiddenRegions: ['US-CA', 'US-IL'],
  seedQueries: ['LinkedIn creators who write about outbound sales'],
  classifierModel: 'claude-opus-5-5',
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
        calls.push({ method: req.method ?? '', path, auth: req.headers.authorization, cookie: req.headers.cookie, body });
        const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { 'content-type': 'application/json', ...headers });
          res.end(JSON.stringify(payload));
        };
        if (path.startsWith('/vendors/me/discover/indexed-creators?')) return json(200, { creators: [{ id: 'ixc_1', kind: 'indexed' }], nextCursor: null, total: 1 });
        if (path === '/vendors/me/discover/indexed-creators/ixc_1?creatorIndex=1') return json(200, { creator: { id: 'ixc_1' } });
        if (path === '/vendors/me/creator-invites' && req.method === 'POST') {
          if (body?.indexedCreatorId === 'ixc_taken') return json(409, { error: 'already_invited' });
          return json(201, { invite: { id: 'cinv_1', status: 'held' } });
        }
        if (path === '/vendors/me/creator-invites' && req.method === 'GET') return json(200, { invites: [{ id: 'cinv_1' }] });
        if (path === '/vendors/me/creator-invites/cinv_1' && req.method === 'DELETE') {
          res.writeHead(204);
          return res.end();
        }
        if (path === '/creator-index/claim/preview') return json(200, { creator: { name: 'Jo' }, invites: [] });
        if (path === '/creator-index/claim') return json(200, { ok: true, created: true }, { 'set-cookie': 'op_network_creator_session=abc; Path=/; HttpOnly; Domain=network.test' });
        if (path.startsWith('/admin/')) {
          if (req.headers.authorization !== `Bearer ${NETWORK_ADMIN}`) return json(401, { error: 'unauthorized' });
          if (path === '/admin/creator-index/settings' && req.method === 'GET') {
            return json(200, { settings: SETTINGS, defaults: SETTINGS, classifierModels: ['claude-opus-5-5'], updatedAt: null, updatedByEmail: null, configured: { profiles: true, discovery: true } });
          }
          if (path === '/admin/creator-index/settings' && req.method === 'PUT') {
            const { updatedByEmail, ...settings } = body ?? {};
            return json(200, { settings, updatedAt: new Date().toISOString(), updatedByEmail, visibilityChanged: 2 });
          }
          if (path === '/admin/creator-index/stats') return json(200, { creators: { listed: 3 } });
          if (path.startsWith('/admin/creator-index/creators?')) return json(200, { creators: [] });
          if (path === '/admin/creator-index/creators/ixc_gone' && req.method === 'DELETE') return json(404, { error: 'not_found' });
          if (path === '/admin/creator-index/creators/hidden' && req.method === 'POST') return json(200, { changed: body?.ids ? (body.ids as string[]).length : 7 });
          if (path === '/admin/creator-index/blocked-domains' && req.method === 'POST') {
            if (body?.domain === 'gmail.com') return json(400, { error: 'shared_mail_domain' });
            return json(200, { domain: String(body?.domain).toLowerCase(), alreadyBlocked: false, removed: 2 });
          }
          if (path === '/admin/creator-index/blocked-domains/nowhere.test' && req.method === 'DELETE') return json(404, { error: 'not_found' });
          if (path.startsWith('/admin/creator-index/blocked-domains/') && req.method === 'DELETE') {
            res.writeHead(204);
            return res.end();
          }
          if (path === '/admin/creator-index/creators/ixc_1/contact' && req.method === 'GET') {
            return json(200, { contact: { address: 'hello@jorivera.co', foundOn: 'https://jorivera.substack.com/about', verified: true } });
          }
          if (path === '/admin/creator-index/creators/ixc_1/contact' && req.method === 'PUT') {
            if (body?.sourceUrl === 'https://elsewhere.test/') return json(422, { error: 'not_on_page' });
            return json(200, { creator: { id: 'ixc_1', contact: { masked: 'h••••@jorivera.co', foundOn: body?.sourceUrl, verified: true } } });
          }
          if (path === '/admin/creator-index/creators/ixc_1/location' && req.method === 'PUT') {
            if (body?.region === 'US-NY') return json(409, { error: 'state_from_profile' });
            return json(200, { creator: { id: 'ixc_1', region: body?.region, location: { text: body?.sourceUrl, from: 'ops' } } });
          }
          if (path.startsWith('/admin/creator-index/creators/') && req.method === 'DELETE') {
            res.writeHead(204);
            return res.end();
          }
          if (path === '/admin/creator-index/seeds') return json(200, { queued: 1, invalid: 0, duplicate: 0, suppressed: 0, member: 0 });
          // The Network starts runs in the background and answers at once.
          if (path === '/admin/creator-index/run/read') return json(202, { started: true });
          if (path === '/admin/creator-index/run/refresh') return json(409, { error: 'already_running' });
          if (path === '/admin/creator-index/outreach/run') {
            if (body?.dryRun) return json(200, { dryRun: true, enabled: true, mailerConfigured: true, sender: 'ops@openpartner.test', due: 2, candidates: 2, excluded: {}, countriesNotCleared: {}, targets: [] });
            if (body?.limit === 7) return json(409, { error: 'mailer_not_configured' });
            return json(202, { started: true });
          }
          if (path === '/admin/creator-index/outreach/sample') {
            const to = (body?.to ?? []) as string[];
            if (to.includes('busy@example.com')) return json(429, { error: 'rate_limited', retryAfterSec: 1200 });
            return json(200, { sender: 'ops@openpartner.test', senderName: 'Ops', style: body?.style ?? 'designed', subject: 'Claim your creator profile on OpenPartner', sent: to, failed: [] });
          }
          if (path === '/admin/creator-index/invites/run') {
            return json(200, { ran: true, dryRun: body?.dryRun, candidates: 1, sent: body?.dryRun ? 0 : 1, skipped: 0, failed: 0, expired: 0, unreachable: 0 });
          }
        }
        json(404, { error: 'not_found' });
      });
    }).listen(0, '127.0.0.1', () => {
      networkUrl = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
      process.env.NETWORK_URL = networkUrl;
      resolve();
    });
  });
});

const tenants: string[] = [];

afterAll(async () => {
  if (!skipIntegration) {
    for (const tenantId of tenants) {
      await db(TABLES.Session).where({ tenantId }).del();
      await db(TABLES.Config).where({ tenantId }).del();
      await db(TABLES.Admin).where({ tenantId }).del();
      await db(TABLES.Tenant).where({ id: tenantId }).del();
    }
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

/** A brand with a session and a Network membership, on a given plan. */
async function brand(opts: { plan?: TenantRow['billingPlan']; subscribed?: boolean; approvalStatus?: TenantRow['approvalStatus'] } = {}) {
  const tenantId = ulid();
  const slug = `ci${ulid().slice(-8).toLowerCase()}`;
  tenants.push(tenantId);
  await db(TABLES.Tenant).insert({
    id: tenantId,
    slug,
    displayName: 'Acme',
    status: 'active',
    approvalStatus: opts.approvalStatus ?? 'approved',
    billingPlan: opts.plan ?? null,
    // A Flex subscription with no mirrored status yet counts as active.
    stripeSubscriptionId: opts.subscribed ? `sub_${ulid()}` : null,
  });
  const adminId = ulid();
  await db<AdminRow>(TABLES.Admin).insert({ id: adminId, tenantId, email: `owner-${slug}@acme.test`, name: 'Owen Owner', activatedAt: new Date() });
  await db(TABLES.Config).insert({
    tenantId,
    key: 'network_membership',
    value: { enabled: true, networkUrl, vendorTokenCiphertext: encryptSecret('vntok_test_index'), scopedKeyId: null, autoEnroll: true } as unknown as never,
    updatedAt: new Date(),
  });
  const session = await createSession(db, { tenantId, principalKind: 'admin', principalId: adminId });
  return { slug, cookie: `op_session=${session.plaintext}` };
}

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

describe.skipIf(skipIntegration)('creator index: brand side', () => {
  it('searches only for Flex and Enterprise with an active plan, adding the flag itself', async () => {
    for (const b of [await brand(), await brand({ plan: 'revshare' }), await brand({ plan: 'flex', subscribed: false })]) {
      const r = await request(app).get(`/t/${b.slug}/admin/network/indexed-creators?q=sales`).set('Cookie', b.cookie);
      expect(r.status).toBe(402);
      expect(r.body.error).toBe('plan_required');
    }
    expect(calls).toHaveLength(0);

    // A self-hosted install never uses it, whatever plan a tenant row carries.
    const imported = await brand({ plan: 'enterprise' });
    process.env.OPENPARTNER_MODE = 'selfhost';
    try {
      expect((await request(app).get(`/t/${imported.slug}/admin/network/indexed-creators`).set('Cookie', imported.cookie)).status).toBe(402);
      const { runCreatorIndexInvitesJob } = await import('../scheduler.js');
      expect(await runCreatorIndexInvitesJob()).toEqual({ skipped: 'selfhost' });
    } finally {
      process.env.OPENPARTNER_MODE = 'revshare';
    }
    expect(calls).toHaveLength(0);

    for (const b of [await brand({ plan: 'flex', subscribed: true }), await brand({ plan: 'enterprise' })]) {
      const r = await request(app)
        .get(`/t/${b.slug}/admin/network/indexed-creators?q=sales&openToPartnerships=1&minEngagement=2.5&sort=engagement&creatorIndex=0&evil=1`)
        .set('Cookie', b.cookie);
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(1);
      const sent = new URL(`http://x${last(/^\/vendors\/me\/discover\/indexed-creators\?/)!.path}`).searchParams;
      expect(sent.get('creatorIndex')).toBe('1');
      expect(sent.get('q')).toBe('sales');
      expect(sent.get('openToPartnerships')).toBe('1');
      expect(sent.get('minEngagement')).toBe('2.5');
      expect(sent.get('sort')).toBe('engagement');
      expect(sent.get('evil')).toBeNull();
      expect(last(/indexed-creators/)!.auth).toBe('Bearer vntok_test_index');
    }
  });

  it('invites with the signed-in admin and only the invite fields, and passes the error code back', async () => {
    const b = await brand({ plan: 'flex', subscribed: true });
    const r = await request(app)
      .post(`/t/${b.slug}/admin/network/creator-invites`)
      .set('Cookie', b.cookie)
      .send({ indexedCreatorId: 'ixc_1', message: 'We would love to work with you.', creatorIndex: false, vendorId: 'other' });
    expect(r.status).toBe(201);
    expect(last('/vendors/me/creator-invites')!.body).toEqual({
      indexedCreatorId: 'ixc_1',
      message: 'We would love to work with you.',
      authorName: 'Owen Owner',
      authorEmail: `owner-${b.slug}@acme.test`,
      creatorIndex: true,
    });
    const taken = await request(app)
      .post(`/t/${b.slug}/admin/network/creator-invites`)
      .set('Cookie', b.cookie)
      .send({ indexedCreatorId: 'ixc_taken', message: 'We would love to work with you.' });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: 'already_invited' });
  });

  it('lists and withdraws invites on any plan, and keeps brands in review from inviting', async () => {
    const b = await brand({ plan: 'revshare' });
    expect((await request(app).get(`/t/${b.slug}/admin/network/creator-invites`).set('Cookie', b.cookie)).body).toEqual({ invites: [{ id: 'cinv_1' }] });
    expect((await request(app).delete(`/t/${b.slug}/admin/network/creator-invites/cinv_1`).set('Cookie', b.cookie)).status).toBe(204);
    const pending = await brand({ plan: 'enterprise', approvalStatus: 'pending' });
    const r = await request(app)
      .post(`/t/${pending.slug}/admin/network/creator-invites`)
      .set('Cookie', pending.cookie)
      .send({ indexedCreatorId: 'ixc_1', message: 'We would love to work with you.' });
    expect(r.status).toBe(403);
    expect(last('/vendors/me/creator-invites')?.method).not.toBe('POST');
  });
});

describe.skipIf(skipIntegration)('creator index: claim through the creator portal proxy', () => {
  it('relays the preview and the claim, and the claim’s session cookie without its Domain', async () => {
    const preview = await request(app).post('/creator-api/creator-index/claim/preview').send({ token: 't'.repeat(43) });
    expect(preview.status).toBe(200);
    expect(preview.body.creator).toEqual({ name: 'Jo' });
    const claim = await request(app).post('/creator-api/creator-index/claim').set('Cookie', 'op_network_creator_session=old').send({ token: 't'.repeat(43) });
    expect(claim.status).toBe(200);
    expect(String(claim.headers['set-cookie'])).toContain('op_network_creator_session=abc');
    expect(String(claim.headers['set-cookie'])).not.toContain('Domain=');
    expect(last('/creator-index/claim')!.cookie).toContain('op_network_creator_session=old');
  });
});

describe.skipIf(skipIntegration)('creator index: ops console', () => {
  it('reads settings with the admin key and saves them with the operator, audited', async () => {
    const cookie = await operator();
    const got = await request(app).get('/platform-admin/creator-index/settings').set('Cookie', cookie);
    expect(got.status).toBe(200);
    expect(got.body.configured).toEqual({ profiles: true, discovery: true });
    expect(last('/admin/creator-index/settings')!.auth).toBe(`Bearer ${NETWORK_ADMIN}`);

    const put = await request(app)
      .put('/platform-admin/creator-index/settings')
      .set('Cookie', cookie)
      .send({ ...SETTINGS, hiddenRegions: ['us-ca', 'US-IL', 'US-TX'], excludedCountries: ['de'] });
    expect(put.status).toBe(200);
    expect(put.body.visibilityChanged).toBe(2);
    expect(last('/admin/creator-index/settings')!.body).toMatchObject({ hiddenRegions: ['US-CA', 'US-IL', 'US-TX'], excludedCountries: ['DE'], updatedByEmail: OPS_EMAIL });
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'creator_index.settings', platformAdminEmail: OPS_EMAIL }).first();
    expect(audit).toBeTruthy();
    expect((await request(app).put('/platform-admin/creator-index/settings').set('Cookie', cookie).send({ ...SETTINGS, extra: 1 })).status).toBe(400);

    // Where to search, and whether to keep only creators who take partnerships.
    const sources = { storefronts: true, sponsorPages: false, people: true };
    const withSources = await request(app)
      .put('/platform-admin/creator-index/settings')
      .set('Cookie', cookie)
      .send({
        ...SETTINGS,
        discoverySources: sources,
        requirePartnershipSignal: false,
        readConcurrency: 12,
        contactEnrichment: { creatorData: false, ownDomain: true },
        memberStatsBudgetUsd: 15,
      });
    expect(withSources.status).toBe(200);
    expect(last('/admin/creator-index/settings')!.body).toMatchObject({
      discoverySources: sources,
      requirePartnershipSignal: false,
      readConcurrency: 12,
      contactEnrichment: { creatorData: false, ownDomain: true },
      memberStatsBudgetUsd: 15,
    });
    expect((await request(app).put('/platform-admin/creator-index/settings').set('Cookie', cookie).send({ ...SETTINGS, readConcurrency: 50 })).status).toBe(400);

    // The follower cap, and null for none.
    for (const maxFollowers of [500_000, null]) {
      const capped = await request(app).put('/platform-admin/creator-index/settings').set('Cookie', cookie).send({ ...SETTINGS, maxFollowers });
      expect(capped.status).toBe(200);
      expect(last('/admin/creator-index/settings')!.body).toMatchObject({ maxFollowers });
    }
    expect((await request(app).put('/platform-admin/creator-index/settings').set('Cookie', cookie).send({ ...SETTINGS, maxFollowers: 0 })).status).toBe(400);

    // The creator database source, and how many creators a run takes.
    const withDatabase = await request(app)
      .put('/platform-admin/creator-index/settings')
      .set('Cookie', cookie)
      .send({ ...SETTINGS, discoverySources: { ...sources, creatorDatabase: true }, creatorDatabasePerRun: 100 });
    expect(withDatabase.status).toBe(200);
    expect(last('/admin/creator-index/settings')!.body).toMatchObject({ discoverySources: { creatorDatabase: true }, creatorDatabasePerRun: 100 });
    expect((await request(app).put('/platform-admin/creator-index/settings').set('Cookie', cookie).send({ ...SETTINGS, creatorDatabasePerRun: 501 })).status).toBe(400);
    expect((await request(app).put('/platform-admin/creator-index/settings').set('Cookie', cookie).send({ ...SETTINGS, memberStatsBudgetUsd: -1 })).status).toBe(400);
    const partial = await request(app)
      .put('/platform-admin/creator-index/settings')
      .set('Cookie', cookie)
      .send({ ...SETTINGS, discoverySources: { people: true } });
    expect(partial.status).toBe(400);
  });

  it('lets support look and dry-run, and keeps writes and live runs to admins', async () => {
    const support = await operator('support');
    expect((await request(app).get('/platform-admin/creator-index/stats').set('Cookie', support)).body).toEqual({ creators: { listed: 3 } });
    expect((await request(app).post('/platform-admin/creator-index/invites/run').set('Cookie', support).send({ dryRun: true })).body).toMatchObject({ dryRun: true, sent: 0 });
    expect((await request(app).post('/platform-admin/creator-index/invites/run').set('Cookie', support).send({ dryRun: false })).status).toBe(403);
    expect((await request(app).post('/platform-admin/creator-index/run/read').set('Cookie', support)).status).toBe(403);
    expect((await request(app).delete('/platform-admin/creator-index/creators/ixc_1').set('Cookie', support)).status).toBe(403);

    const admin = await operator();
    expect((await request(app).post('/platform-admin/creator-index/run/read').set('Cookie', admin)).body).toEqual({ started: true });
    const busy = await request(app).post('/platform-admin/creator-index/run/refresh').set('Cookie', admin);
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({ error: 'already_running' });
    expect((await request(app).post('/platform-admin/creator-index/run/nope').set('Cookie', admin)).status).toBe(404);
    expect((await request(app).post('/platform-admin/creator-index/seeds').set('Cookie', admin).send({ urls: ['https://x.com/jo'] })).body).toMatchObject({ queued: 1 });
    expect((await request(app).delete('/platform-admin/creator-index/creators/ixc_1').set('Cookie', admin)).status).toBe(204);
    expect((await request(app).delete('/platform-admin/creator-index/creators/ixc_gone').set('Cookie', admin)).body).toEqual({ error: 'not_found' });
    expect((await request(app).post('/platform-admin/creator-index/invites/run').set('Cookie', admin).send({ dryRun: false })).body).toMatchObject({ sent: 1 });
  });
});

describe.skipIf(skipIntegration)('creator index: hiding creators', () => {
  it('hides the ones ticked or all a filter matches, admins only, audited, and passes the hidden filter on', async () => {
    const admin = await operator();
    const hide = (cookie: string, body: Record<string, unknown>) => request(app).post('/platform-admin/creator-index/creators/hidden').set('Cookie', cookie).send(body);
    expect((await hide(await operator('support'), { hidden: true, ids: ['ixc_1'] })).status).toBe(403);
    expect((await hide(admin, { hidden: true, ids: ['ixc_1', 'ixc_2'] })).body).toEqual({ changed: 2 });
    expect(last('/admin/creator-index/creators/hidden')).toMatchObject({ auth: `Bearer ${NETWORK_ADMIN}`, body: { hidden: true, ids: ['ixc_1', 'ixc_2'] } });
    const r = await hide(admin, { hidden: false, match: { minFollowers: '100000', hidden: 'yes' } });
    expect(r.body).toEqual({ changed: 7 });
    expect(last('/admin/creator-index/creators/hidden')?.body).toEqual({ hidden: false, match: { minFollowers: 100000, hidden: 'yes' } });
    const audits = await db(TABLES.PlatformAuditLog).whereIn('action', ['creator_index.hide', 'creator_index.unhide']).andWhere({ platformAdminEmail: OPS_EMAIL }).orderBy('createdAt');
    expect(audits.map((a) => [a.action, a.detail])).toEqual([
      ['creator_index.hide', { changed: 2, ids: 2 }],
      ['creator_index.unhide', { changed: 7, match: { minFollowers: 100000, hidden: 'yes' } }],
    ]);
    // Both, neither, or a filter the list doesn't have.
    expect((await hide(admin, { hidden: true, ids: ['ixc_1'], match: {} })).status).toBe(400);
    expect((await hide(admin, { hidden: true })).status).toBe(400);
    expect((await hide(admin, { hidden: true, match: { sort: 'reach' } })).status).toBe(400);

    await request(app).get('/platform-admin/creator-index/creators?hidden=yes&minFollowers=100000').set('Cookie', admin);
    expect(last(/^\/admin\/creator-index\/creators\?/)?.path).toBe('/admin/creator-index/creators?minFollowers=100000&hidden=yes');
  });
});

describe.skipIf(skipIntegration)('creator index: blocked domains', () => {
  it('blocks and unblocks a domain for admins only, audited by name, and passes the Network’s refusal back', async () => {
    const admin = await operator();
    const block = (cookie: string, domain: unknown) => request(app).post('/platform-admin/creator-index/blocked-domains').set('Cookie', cookie).send({ domain });
    expect((await block(await operator('support'), 'jo.co')).status).toBe(403);
    const r = await block(admin, ' Jo.co ');
    expect([r.status, r.body]).toEqual([200, { domain: 'jo.co', alreadyBlocked: false, removed: 2 }]);
    expect(last('/admin/creator-index/blocked-domains')).toMatchObject({ auth: `Bearer ${NETWORK_ADMIN}`, body: { domain: 'Jo.co' } });
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'creator_index.domain_block', platformAdminEmail: OPS_EMAIL }).first();
    expect(audit).toMatchObject({ targetType: 'email_domain', targetId: 'jo.co', detail: { removed: 2 } });
    expect([(await block(admin, 'gmail.com')).status, (await block(admin, 'gmail.com')).body]).toEqual([400, { error: 'shared_mail_domain' }]);
    expect((await block(admin, 42)).body).toEqual({ error: 'invalid_domain' });

    expect((await request(app).delete('/platform-admin/creator-index/blocked-domains/jo.co').set('Cookie', admin)).status).toBe(204);
    expect(last(/^\/admin\/creator-index\/blocked-domains\/jo\.co$/)?.method).toBe('DELETE');
    expect(await db(TABLES.PlatformAuditLog).where({ action: 'creator_index.domain_unblock', targetId: 'jo.co' }).first()).toBeTruthy();
    const gone = await request(app).delete('/platform-admin/creator-index/blocked-domains/nowhere.test').set('Cookie', admin);
    expect([gone.status, gone.body]).toEqual([404, { error: 'not_found' }]);
  });
});

describe.skipIf(skipIntegration)('creator index: addresses', () => {
  const PAGE = 'https://jorivera.substack.com/about';

  it('shows one address in full to admins only, uncached and audited', async () => {
    expect((await request(app).get('/platform-admin/creator-index/creators/ixc_1/contact').set('Cookie', await operator('support'))).status).toBe(403);
    const r = await request(app).get('/platform-admin/creator-index/creators/ixc_1/contact').set('Cookie', await operator());
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({ contact: { address: 'hello@jorivera.co', foundOn: PAGE, verified: true } });
    expect(last('/admin/creator-index/creators/ixc_1/contact')?.auth).toBe(`Bearer ${NETWORK_ADMIN}`);
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'creator_index.contact_view', platformAdminEmail: OPS_EMAIL }).first();
    expect(audit).toMatchObject({ targetType: 'indexed_creator', targetId: 'ixc_1' });
  });

  it('sets an address with the page it’s on, audits the page but not the address, and passes the Network’s refusal back', async () => {
    const admin = await operator();
    expect((await request(app).put('/platform-admin/creator-index/creators/ixc_1/contact').set('Cookie', await operator('support')).send({ email: 'hello@jorivera.co', sourceUrl: PAGE })).status).toBe(403);
    const r = await request(app).put('/platform-admin/creator-index/creators/ixc_1/contact').set('Cookie', admin).send({ email: ' hello@jorivera.co ', sourceUrl: PAGE });
    expect(r.status).toBe(200);
    expect(r.body.creator.contact).toEqual({ masked: 'h••••@jorivera.co', foundOn: PAGE, verified: true });
    expect(last('/admin/creator-index/creators/ixc_1/contact')?.body).toEqual({ email: 'hello@jorivera.co', sourceUrl: PAGE });
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'creator_index.contact_set', platformAdminEmail: OPS_EMAIL }).first();
    expect(audit).toMatchObject({ targetId: 'ixc_1' });
    expect(JSON.stringify(audit.detail)).toContain(PAGE);
    expect(JSON.stringify(audit.detail)).not.toContain('hello@jorivera');

    const refused = await request(app).put('/platform-admin/creator-index/creators/ixc_1/contact').set('Cookie', admin).send({ email: 'hello@jorivera.co', sourceUrl: 'https://elsewhere.test/' });
    expect([refused.status, refused.body]).toEqual([422, { error: 'not_on_page' }]);
    expect((await request(app).put('/platform-admin/creator-index/creators/ixc_1/contact').set('Cookie', admin).send({ email: 'hello@jorivera.co' })).status).toBe(400);
  });

  it('passes the list’s filters on, and nothing else', async () => {
    const r = await request(app)
      .get('/platform-admin/creator-index/creators?q=jo&missing=address,state&sort=reach&minFollowers=10000&maxFollowers=50000&after=eyJ2IjoxfQ&extra=1')
      .set('Cookie', await operator('support'));
    expect(r.status).toBe(200);
    const url = new URL(`http://network${last(/^\/admin\/creator-index\/creators\?/)!.path}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'jo', missing: 'address,state', sort: 'reach', minFollowers: '10000', maxFollowers: '50000', after: 'eyJ2IjoxfQ' });
  });

  it('sets a state with the page that shows it, audits both, and passes the Network’s refusal back', async () => {
    const admin = await operator();
    expect((await request(app).put('/platform-admin/creator-index/creators/ixc_1/location').set('Cookie', await operator('support')).send({ region: 'US-TX', sourceUrl: PAGE })).status).toBe(403);
    const r = await request(app).put('/platform-admin/creator-index/creators/ixc_1/location').set('Cookie', admin).send({ region: 'US-TX', sourceUrl: ` ${PAGE} ` });
    expect(r.status).toBe(200);
    expect(r.body.creator).toEqual({ id: 'ixc_1', region: 'US-TX', location: { text: PAGE, from: 'ops' } });
    expect(last('/admin/creator-index/creators/ixc_1/location')?.body).toEqual({ region: 'US-TX', sourceUrl: PAGE });
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'creator_index.location_set', platformAdminEmail: OPS_EMAIL }).first();
    expect(audit).toMatchObject({ targetType: 'indexed_creator', targetId: 'ixc_1' });
    expect(JSON.stringify(audit.detail)).toContain('US-TX');
    expect(JSON.stringify(audit.detail)).toContain(PAGE);

    const refused = await request(app).put('/platform-admin/creator-index/creators/ixc_1/location').set('Cookie', admin).send({ region: 'US-NY', sourceUrl: PAGE });
    expect([refused.status, refused.body]).toEqual([409, { error: 'state_from_profile' }]);
    expect((await request(app).put('/platform-admin/creator-index/creators/ixc_1/location').set('Cookie', admin).send({ region: 'US-TX' })).status).toBe(400);
    expect((await request(app).put('/platform-admin/creator-index/creators/ixc_1/location').set('Cookie', admin).send({ region: 'US-TX', sourceUrl: `https://x.test/${'a'.repeat(200)}` })).status).toBe(400);
  });
});

describe.skipIf(skipIntegration)('creator index: the outreach email', () => {
  it('lets support preview a batch, keeps sending to admins, audits a send, and passes the Network’s refusal back', async () => {
    const support = await operator('support');
    const dry = await request(app).post('/platform-admin/creator-index/outreach/run').set('Cookie', support).send({ dryRun: true, limit: 25 });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, due: 2, candidates: 2 });
    expect(last('/admin/creator-index/outreach/run')).toMatchObject({ auth: `Bearer ${NETWORK_ADMIN}`, body: { dryRun: true, limit: 25, publicUrl: networkUrl } });
    // A body without dryRun is a preview, never a send.
    expect((await request(app).post('/platform-admin/creator-index/outreach/run').set('Cookie', support).send({})).status).toBe(200);
    expect(last('/admin/creator-index/outreach/run')!.body).toMatchObject({ dryRun: true, limit: 50 });
    expect((await request(app).post('/platform-admin/creator-index/outreach/run').set('Cookie', support).send({ dryRun: false })).status).toBe(403);

    const admin = await operator();
    calls.length = 0;
    expect((await request(app).post('/platform-admin/creator-index/outreach/run').set('Cookie', admin).send({ dryRun: false, limit: 101 })).status).toBe(400);
    expect(calls).toHaveLength(0);
    const sent = await request(app).post('/platform-admin/creator-index/outreach/run').set('Cookie', admin).send({ dryRun: false, limit: 10 });
    expect(sent.status).toBe(202);
    expect(sent.body).toEqual({ started: true });
    expect(last('/admin/creator-index/outreach/run')!.body).toEqual({ dryRun: false, limit: 10, publicUrl: networkUrl });
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'creator_index.outreach_run', platformAdminEmail: OPS_EMAIL }).orderBy('createdAt', 'desc').first();
    expect(audit?.detail).toEqual({ limit: 10 });

    const refused = await request(app).post('/platform-admin/creator-index/outreach/run').set('Cookie', admin).send({ dryRun: false, limit: 7 });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'mailer_not_configured' });
  });

  it('sends a sample for admins only, to the addresses typed, audited with them, and passes the Network’s limit back', async () => {
    const support = await operator('support');
    expect((await request(app).post('/platform-admin/creator-index/outreach/sample').set('Cookie', support).send({ to: ['seed@example.com'] })).status).toBe(403);

    const admin = await operator();
    calls.length = 0;
    for (const to of [[], ['not an address'], Array.from({ length: 21 }, (_, i) => `seed-${i}@example.com`)]) {
      expect((await request(app).post('/platform-admin/creator-index/outreach/sample').set('Cookie', admin).send({ to })).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
    const sent = await request(app).post('/platform-admin/creator-index/outreach/sample').set('Cookie', admin).send({ to: [' Seed-1@Example.com', 'seed-2@example.com'] });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ sent: ['seed-1@example.com', 'seed-2@example.com'], failed: [] });
    // No style asked for: none sent, and the Network uses the batches' one.
    expect(last('/admin/creator-index/outreach/sample')).toMatchObject({ auth: `Bearer ${NETWORK_ADMIN}` });
    expect(last('/admin/creator-index/outreach/sample')!.body).toEqual({ to: ['seed-1@example.com', 'seed-2@example.com'], publicUrl: networkUrl });
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'creator_index.outreach_sample', platformAdminEmail: OPS_EMAIL }).orderBy('createdAt', 'desc').first();
    expect(audit?.detail).toEqual({ to: ['seed-1@example.com', 'seed-2@example.com'], style: 'designed', sent: 2, failed: 0 });

    const plain = await request(app).post('/platform-admin/creator-index/outreach/sample').set('Cookie', admin).send({ to: ['seed@example.com'], style: 'plain' });
    expect(plain.body).toMatchObject({ style: 'plain' });
    expect(last('/admin/creator-index/outreach/sample')!.body).toEqual({ to: ['seed@example.com'], style: 'plain', publicUrl: networkUrl });
    expect((await request(app).post('/platform-admin/creator-index/outreach/sample').set('Cookie', admin).send({ to: ['seed@example.com'], style: 'fancy' })).status).toBe(400);

    const limited = await request(app).post('/platform-admin/creator-index/outreach/sample').set('Cookie', admin).send({ to: ['busy@example.com'] });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
  });

  it('passes the outreach switch through with the settings', async () => {
    const cookie = await operator();
    const put = await request(app).put('/platform-admin/creator-index/settings').set('Cookie', cookie).send({ ...SETTINGS, outreachEnabled: true });
    expect(put.status).toBe(200);
    expect(last('/admin/creator-index/settings')!.body).toMatchObject({ outreachEnabled: true });
  });

  it('passes the outreach style through with the settings, and leaves it out when the console does', async () => {
    const cookie = await operator();
    expect((await request(app).put('/platform-admin/creator-index/settings').set('Cookie', cookie).send({ ...SETTINGS, outreachStyle: 'plain' })).status).toBe(200);
    expect(last('/admin/creator-index/settings')!.body).toMatchObject({ outreachStyle: 'plain' });
    expect((await request(app).put('/platform-admin/creator-index/settings').set('Cookie', cookie).send(SETTINGS)).status).toBe(200);
    expect(last('/admin/creator-index/settings')!.body).not.toHaveProperty('outreachStyle');
    expect((await request(app).put('/platform-admin/creator-index/settings').set('Cookie', cookie).send({ ...SETTINGS, outreachStyle: 'fancy' })).status).toBe(400);
  });
});

describe.skipIf(skipIntegration)('creator index: the hourly cron', () => {
  it('triggers the invite email with the Network URL as the link base', async () => {
    const { runCreatorIndexInvitesJob } = await import('../scheduler.js');
    const result = await runCreatorIndexInvitesJob();
    expect(result).toMatchObject({ sent: 1 });
    expect(last('/admin/creator-index/invites/run')!.body).toEqual({ dryRun: false, publicUrl: networkUrl });
  });
});
