/**
 * Partner portal access (partner-portal-access.ts): a headless program's
 * partners can be kept out of the hosted partner portal, and the runtime
 * key such a program deploys can be limited to creating partners.
 *
 * Covers the four gaps an Oct 2026 end-to-end check of an in-app
 * "Refer & earn" setup found:
 *   1. POST /auth/signin emailed any active partner; now portalAccess=false
 *      sends nothing, answers like an unknown email, and kills sessions.
 *   2. partner.activated never fired for sendInvite:false partners.
 *   3. partners:write was the only way to create partners, and it can also
 *      invite and revoke; partners:create can't.
 *   4. (docs) — covered by the OpenAPI snapshot and docs/headless-referral.md.
 *
 * dispatchEvent is mocked so the webhook assertions read exact payloads.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_portal_access_0123456789abcdef01';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';
process.env.PORTAL_URL = 'http://localhost:5673';

vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn() };
});

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { createSession, issueMagicLink } = await import('../auth-sessions.js');
const { __setMailerForTests } = await import('../mailer.js');
const { dispatchEvent } = await import('../webhook-dispatcher.js');
const { sweepCampaignEndNotifications } = await import('../campaign-end-notifications.js');
type Mailer = import('../mailer.js').Mailer;
type Message = import('../mailer.js').Message;

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

// Children before Partner / Program so FK constraints don't fire.
const TABLES_TO_CLEAN = [
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.ApiKey,
  TABLES.NetworkOutbox,
  TABLES.PartnerNetworkConsent,
  TABLES.Coupon,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.Program,
  TABLES.Partner,
];
const CONFIG_KEYS = ['partner_access', 'network_membership'];

class CapturingMailer implements Mailer {
  readonly sent: Message[] = [];
  async send(_ctx: unknown, msg: Message): Promise<void> {
    this.sent.push(msg);
  }
  to(address: string): Message[] {
    return this.sent.filter((m) => m.to === address);
  }
}
let mailer: CapturingMailer;

async function wipe(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID }).whereIn('key', CONFIG_KEYS).del();
}

const asAdmin = (key = ADMIN_KEY) => ({
  post: (path: string, body: object = {}) => request(app).post(path).set('Authorization', `Bearer ${key}`).send(body),
  patch: (path: string, body: object) => request(app).patch(path).set('Authorization', `Bearer ${key}`).send(body),
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${key}`),
});
const admin = asAdmin();

async function scopedKey(scopes: string[]): Promise<ReturnType<typeof asAdmin>> {
  const key = await createApiKeyRow(db, { tenantId: DEFAULT_TENANT_ID, scopes, label: 'test' });
  return asAdmin(key.plaintext);
}

async function createHeadless(email: string, extra: object = {}): Promise<{ id: string; portalAccess: boolean }> {
  const res = await admin.post('/partners', { email, name: 'Headless', sendInvite: false, programIds: [], ...extra });
  expect(res.status).toBe(201);
  return res.body as { id: string; portalAccess: boolean };
}

async function sessionCookieFor(partnerId: string): Promise<string> {
  const session = await createSession(db, { tenantId: DEFAULT_TENANT_ID, principalKind: 'partner', principalId: partnerId });
  return `op_session=${session.plaintext}`;
}

function dispatched(event: string): Array<Record<string, unknown>> {
  return vi
    .mocked(dispatchEvent)
    .mock.calls.filter(([, e]) => e === event)
    .map(([, , payload]) => payload as Record<string, unknown>);
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

beforeEach(async () => {
  mailer = new CapturingMailer();
  __setMailerForTests(mailer);
  vi.mocked(dispatchEvent).mockClear();
  if (!skipIntegration) await wipe();
});

afterEach(() => {
  __setMailerForTests(null);
});

afterAll(async () => {
  if (!skipIntegration) await wipe();
  await db.destroy();
});

describe.skipIf(skipIntegration)('portal sign-in for a partner without portal access', () => {
  it('sends nothing and answers exactly as for an unknown email', async () => {
    await createHeadless('locked@example.com', { portalAccess: false });

    const locked = await request(app).post('/auth/signin').send({ email: 'locked@example.com' });
    const unknown = await request(app).post('/auth/signin').send({ email: 'nobody@example.com' });
    expect(locked.status).toBe(unknown.status);
    expect(locked.body).toEqual(unknown.body);
    expect(locked.body).toEqual({ ok: true });
    expect(mailer.sent).toEqual([]);
    expect(await db(TABLES.MagicLinkToken).where({ tenantId: DEFAULT_TENANT_ID })).toEqual([]);

    // Control: the same partner with access gets a link.
    await createHeadless('open@example.com', { portalAccess: true });
    await request(app).post('/auth/signin').send({ email: 'open@example.com' });
    expect(mailer.to('open@example.com').map((m) => m.tag)).toEqual(['partner_signin']);
  });

  it('rejects an existing session once access is off, however it was turned off', async () => {
    const viaApi = await createHeadless('a@example.com', { portalAccess: true });
    const cookie = await sessionCookieFor(viaApi.id);
    expect((await request(app).get('/auth/whoami').set('Cookie', cookie)).status).toBe(200);

    const off = await admin.patch(`/partners/${viaApi.id}`, { portalAccess: false });
    expect(off.status).toBe(200);
    expect(off.body.portalAccess).toBe(false);
    expect((await request(app).get('/auth/whoami').set('Cookie', cookie)).status).toBe(401);
    // Ended, not just refused: turning access back on doesn't revive it.
    expect((await admin.patch(`/partners/${viaApi.id}`, { portalAccess: true })).body.portalAccess).toBe(true);
    expect((await request(app).get('/auth/whoami').set('Cookie', cookie)).status).toBe(401);

    // A change that bypasses the API (an import, a DB edit) is enforced at
    // session lookup.
    const direct = await createHeadless('b@example.com', { portalAccess: true });
    const directCookie = await sessionCookieFor(direct.id);
    await db(TABLES.Partner).where({ id: direct.id }).update({ portalAccess: false });
    expect((await request(app).get(`/partners/${direct.id}`).set('Cookie', directCookie)).status).toBe(401);
  });

  it("spends unused sign-in links when access is turned off, and refuses any that slip through", async () => {
    const partner = await createHeadless('c@example.com', { portalAccess: true });
    const link = () =>
      issueMagicLink(db, {
        tenantId: DEFAULT_TENANT_ID,
        email: 'c@example.com',
        purpose: 'partner_signin',
        principalKind: 'partner',
        principalId: partner.id,
      });

    const before = await link();
    await admin.patch(`/partners/${partner.id}`, { portalAccess: false });
    const spent = await request(app).post('/auth/magic/verify').send({ token: before.plaintext });
    expect(spent.status).toBe(400);
    expect(spent.body.error).toBe('invalid_or_expired_token');

    const after = await link();
    const refused = await request(app).post('/auth/magic/verify').send({ token: after.plaintext });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('portal_access_disabled');
    expect(refused.headers['set-cookie']).toBeUndefined();
    expect(await db(TABLES.Session).where({ principalId: partner.id })).toEqual([]);
  });
});

describe.skipIf(skipIntegration)('setting portal access', () => {
  it('POST /partners takes portalAccess, but not with an invite', async () => {
    const headless = await createHeadless('d@example.com', { portalAccess: false });
    expect(headless.portalAccess).toBe(false);
    expect((await db(TABLES.Partner).where({ id: headless.id }).first()).portalAccess).toBe(false);

    const contradictory = await admin.post('/partners', { email: 'e@example.com', name: 'E', portalAccess: false });
    expect(contradictory.status).toBe(400);
    expect(contradictory.body.error).toBe('invite_requires_portal_access');
    expect(await db(TABLES.Partner).where({ email: 'e@example.com' }).first()).toBeUndefined();
    expect(mailer.sent).toEqual([]);

    // Defaults with no tenant setting: everyone keeps today's behaviour.
    const invited = await admin.post('/partners', { email: 'f@example.com', name: 'F', programIds: [] });
    expect(invited.body.portalAccess).toBe(true);
    expect((await createHeadless('g@example.com')).portalAccess).toBe(true);
  });

  it('the tenant default applies to partners created without an invite, and only to them', async () => {
    expect((await admin.get('/config/partner-access')).body).toEqual({ uninvitedPortalAccess: true });
    const saved = await admin.post('/config/partner-access', { uninvitedPortalAccess: false });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ uninvitedPortalAccess: false });
    // Omitted fields keep their value.
    expect((await admin.post('/config/partner-access', {})).body).toEqual({ uninvitedPortalAccess: false });
    expect((await admin.post('/config/partner-access', { uninvitedPortalAccess: 'no' })).status).toBe(400);

    expect((await createHeadless('h@example.com')).portalAccess).toBe(false);
    expect((await createHeadless('i@example.com', { portalAccess: true })).portalAccess).toBe(true);
    const invited = await admin.post('/partners', { email: 'j@example.com', name: 'J', programIds: [] });
    expect(invited.body.portalAccess).toBe(true);
    expect(mailer.to('j@example.com').map((m) => m.tag)).toEqual(['partner_invite']);

    // CSV import adds partners without an invite too.
    const imported = await request(app)
      .post('/import/partners-csv')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .set('content-type', 'text/csv')
      .send('email,name\nk@example.com,K\n');
    expect(imported.status).toBe(200);
    expect((await db(TABLES.Partner).where({ email: 'k@example.com' }).first()).portalAccess).toBe(false);

    // Portal-only: a partner session can't read or change the setting.
    const partner = await createHeadless('l@example.com', { portalAccess: true });
    const cookie = await sessionCookieFor(partner.id);
    expect((await request(app).get('/config/partner-access').set('Cookie', cookie)).status).toBe(403);
    expect((await request(app).post('/config/partner-access').set('Cookie', cookie).send({ uninvitedPortalAccess: true })).status).toBe(403);
  });

  it('a creator the Network provisions keeps portal access whatever the default', async () => {
    await admin.post('/config/partner-access', { uninvitedPortalAccess: false });
    const key = await createApiKeyRow(db, {
      tenantId: DEFAULT_TENANT_ID,
      scopes: ['partners:write', 'partners:read', 'links:write', 'commissions:read', 'clicks:write'],
      label: 'network_federation',
    });
    // Registered as the federation key, Network not offered (so nothing is pushed).
    const membership = { enabled: false, networkUrl: 'http://network.invalid', vendorTokenCiphertext: null, scopedKeyId: key.id, autoEnroll: false };
    await db(TABLES.Config).insert({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership', value: membership as never, updatedAt: new Date() });

    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${key.plaintext}`)
      .send({ email: 'creator@example.com', name: 'Creator', sendInvite: false, programIds: [], metadata: { source: 'openpartner_network', networkCreatorId: 'crt_1' } });
    expect(res.status).toBe(201);
    expect(res.body.portalAccess).toBe(true);
  });

  it('PATCH /partners/:id needs partners:write, takes only known fields, 404s on a stranger', async () => {
    const partner = await createHeadless('m@example.com', { portalAccess: false });
    const writer = await scopedKey(['partners:write']);
    const on = await writer.patch(`/partners/${partner.id}`, { portalAccess: true });
    expect(on.status).toBe(200);
    expect(on.body.portalAccess).toBe(true);

    const creator = await scopedKey(['partners:create']);
    const denied = await creator.patch(`/partners/${partner.id}`, { portalAccess: false });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: 'forbidden_scope', required: 'partners:write' });

    const cookie = await sessionCookieFor(partner.id);
    expect((await request(app).patch(`/partners/${partner.id}`).set('Cookie', cookie).send({ portalAccess: false })).status).toBe(403);

    const unknownField = await admin.patch(`/partners/${partner.id}`, { name: 'Renamed' });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error).toBe('invalid_body');
    expect((await admin.patch('/partners/missing', { portalAccess: true })).status).toBe(404);
    expect((await db(TABLES.Partner).where({ id: partner.id }).first()).portalAccess).toBe(true);
  });
});

describe.skipIf(skipIntegration)('email to a partner without portal access', () => {
  it('no invite: POST /partners/:id/invite refuses, and an applicant stays unapproved', async () => {
    const id = ulid();
    await db(TABLES.Partner).insert({
      id,
      tenantId: DEFAULT_TENANT_ID,
      email: 'applicant@example.com',
      name: 'Applicant',
      metadata: { review: { status: 'pending', appliedAt: new Date().toISOString() } },
      activatedAt: null,
      portalAccess: false,
    });
    const res = await admin.post(`/partners/${id}/invite`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('portal_access_disabled');
    expect(mailer.sent).toEqual([]);
    const row = await db(TABLES.Partner).where({ id }).first();
    expect(row.metadata.review.status).toBe('pending');
  });

  it('a revoke notifies them only when asked to', async () => {
    const silent = await createHeadless('n@example.com', { portalAccess: false });
    const quiet = await admin.post(`/partners/${silent.id}/revoke`, {});
    expect(quiet.status).toBe(200);
    expect(quiet.body.notified).toBe(false);

    const asked = await createHeadless('o@example.com', { portalAccess: false });
    expect((await admin.post(`/partners/${asked.id}/revoke`, { notify: true })).body.notified).toBe(true);

    // Unchanged for a partner with access: notified unless notify:false.
    const regular = await createHeadless('p@example.com', { portalAccess: true });
    expect((await admin.post(`/partners/${regular.id}/revoke`, {})).body.notified).toBe(true);

    expect(mailer.sent.map((m) => m.to).sort()).toEqual(['o@example.com', 'p@example.com']);
  });

  it("no program-ending notice, which links into the portal", async () => {
    const programId = `prg_${ulid()}`;
    await db(TABLES.Program).insert({
      id: programId,
      tenantId: DEFAULT_TENANT_ID,
      name: 'Ending',
      commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 10 }]),
      destinationUrl: 'https://brand.test/',
      attributionWindowDays: 60,
      attributionModel: 'last_click',
      endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    for (const [email, portalAccess] of [['q@example.com', false], ['r@example.com', true]] as const) {
      const p = await createHeadless(email, { portalAccess });
      await db(TABLES.Link).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, partnerId: p.id, programId, linkKey: `k-${p.id}` });
    }
    await sweepCampaignEndNotifications();
    const partnerNotices = mailer.sent.filter((m) => m.tag === 'campaign_ending_partner').map((m) => m.to);
    expect(partnerNotices).toEqual(['r@example.com']);
  });
});

describe.skipIf(skipIntegration)('partner.activated for partners created active', () => {
  it('fires right after partner.created, with invited: false', async () => {
    const partner = await createHeadless('s@example.com', { portalAccess: false });
    const [created] = dispatched('partner.created');
    expect(created).toMatchObject({ partnerId: partner.id, invited: false, portalAccess: false });
    const activated = dispatched('partner.activated');
    expect(activated).toHaveLength(1);
    expect(activated[0]).toEqual({
      partnerId: partner.id,
      email: 's@example.com',
      name: 'Headless',
      activatedAt: (created as { activatedAt: string }).activatedAt,
      invited: false,
    });
    const order = vi.mocked(dispatchEvent).mock.calls.map(([, e]) => e);
    expect(order.indexOf('partner.created')).toBeLessThan(order.indexOf('partner.activated'));
  });

  it('an invited partner fires it once, when they accept', async () => {
    const created = await admin.post('/partners', { email: 't@example.com', name: 'Invitee', programIds: [] });
    expect(dispatched('partner.activated')).toEqual([]);

    const token = /token=([^\s&"]+)/.exec(mailer.to('t@example.com')[0]!.text)![1]!;
    expect((await request(app).post('/auth/magic/verify').send({ token: decodeURIComponent(token) })).status).toBe(200);
    const activated = dispatched('partner.activated');
    expect(activated).toHaveLength(1);
    expect(activated[0]).toMatchObject({ partnerId: created.body.id, invited: true });
  });
});

describe.skipIf(skipIntegration)('the partners:create scope', () => {
  it('creates partners without an invite, and nothing more', async () => {
    const creator = await scopedKey(['partners:create']);
    const ok = await creator.post('/partners', { email: 'u@example.com', name: 'U', sendInvite: false, programIds: [] });
    expect(ok.status).toBe(201);

    // The invite is the default, so leaving sendInvite out is refused too.
    for (const body of [
      { email: 'v@example.com', name: 'V' },
      { email: 'v@example.com', name: 'V', sendInvite: true },
      { email: 'v@example.com', name: 'V', sendInvite: false, commissionSnapshot: { commissionType: 'percent', commissionValue: 100 } },
      { email: 'v@example.com', name: 'V', sendInvite: false, programCommissions: [] },
    ]) {
      const res = await creator.post('/partners', body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body).toMatchObject({ error: 'forbidden_scope', required: 'partners:write' });
    }
    expect(await db(TABLES.Partner).where({ email: 'v@example.com' }).first()).toBeUndefined();

    const id = ok.body.id as string;
    for (const path of [`/partners/${id}/invite`, `/partners/${id}/revoke`, '/import/partners-csv']) {
      const res = await creator.post(path, {});
      expect(res.status, path).toBe(403);
      expect(res.body.error, path).toBe('forbidden_scope');
    }
    expect(mailer.sent).toEqual([]);
    expect((await db(TABLES.Partner).where({ id }).first()).revokedAt).toBeNull();

    // partners:write keeps everything it had.
    const writer = await scopedKey(['partners:write']);
    const invited = await writer.post('/partners', { email: 'w@example.com', name: 'W', programIds: [] });
    expect(invited.status).toBe(201);
    expect(invited.body.invited).toBe(true);
  });
});
