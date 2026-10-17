/**
 * Brand setup reminders, creator-reminder proxying, one-click unsubscribe,
 * the operator switches, and marketplace policy warnings.
 *
 * Multi-tenant mode (the reminders + ops console are hosted-only). Brands
 * are seeded directly so each test controls signup age, admin sign-in, and
 * setup progress; a capturing mailer records what would have been sent, and
 * a tiny in-process server stands in for the Network.
 *
 * Skipped when DATABASE_URL is unset, like the rest of the integration suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type PlatformAdminRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_setupreminders_0123456789abcdef01';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.PLATFORM_OPS_EMAIL = 'ops-inbox@openpartner.test';
delete process.env.NETWORK_URL;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { __setMailerForTests } = await import('../mailer.js');
const { runBrandSetupReminders } = await import('../brand-setup-reminders.js');
const { brandSetupFor } = await import('../brand-setup.js');
const { unsubscribeToken, readUnsubscribeToken, isOptedOut } = await import('../email-optout.js');
const { getNotificationSettings } = await import('../platform-settings.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import('../platform-admin-sessions.js');
import type { Mailer, Message } from '../mailer.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const DAY = 24 * 60 * 60 * 1000;

class CapturingMailer implements Mailer {
  readonly sent: Message[] = [];
  async send(_ctx: unknown, msg: Message): Promise<void> {
    this.sent.push(msg);
  }
}
let mailer: CapturingMailer;

const createdTenants: string[] = [];
const createdOperators: string[] = [];

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}

/** Seed a live brand with one admin. `ageDays` backdates signup. */
async function seedBrand(opts: {
  ageDays: number;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  adminSignedIn?: boolean;
  adminEmail?: string;
}): Promise<{ id: string; slug: string; adminEmail: string }> {
  const id = ulid();
  const slug = `sr${rnd()}`;
  const createdAt = new Date(Date.now() - opts.ageDays * DAY);
  const adminEmail = opts.adminEmail ?? `owner-${rnd()}@brand.test`;
  await db(TABLES.Tenant).insert({
    id,
    slug,
    displayName: `Brand ${slug}`,
    status: opts.approvalStatus === 'rejected' ? 'suspended' : 'active',
    approvalStatus: opts.approvalStatus ?? 'pending',
    createdAt,
  });
  await db(TABLES.Admin).insert({
    id: ulid(),
    tenantId: id,
    email: adminEmail,
    name: 'Owner',
    activatedAt: opts.adminSignedIn === false ? null : createdAt,
  });
  createdTenants.push(id);
  return { id, slug, adminEmail };
}

async function seedProgram(tenantId: string): Promise<void> {
  await db(TABLES.Program).insert({
    id: ulid(),
    tenantId,
    name: 'Main',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl: 'https://brand.test',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
}

async function completeSetup(tenantId: string): Promise<void> {
  await seedProgram(tenantId);
  await db(TABLES.Tenant).where({ id: tenantId }).update({ couponIntegrationVerifiedAt: new Date() });
}

async function makeOperator(role: 'admin' | 'support'): Promise<string> {
  const admin: PlatformAdminRow = {
    id: ulid(),
    email: `${role}-${rnd()}@openpartner.test`,
    name: 'Ops',
    role,
    createdAt: new Date(),
    revokedAt: null,
  };
  await db<PlatformAdminRow>(TABLES.PlatformAdmin).insert(admin);
  createdOperators.push(admin.id);
  const session = await createPlatformAdminSession(db, admin);
  return `${PLATFORM_ADMIN_SESSION_COOKIE}=${session.plaintext}`;
}

/** Restrict a sweep's results to the brands this test seeded (other suites
 *  share the database). */
const mine = <T extends { tenantId?: string }>(rows: T[]) => rows.filter((r) => r.tenantId && createdTenants.includes(r.tenantId));

// ----- fake Network -----
interface NetCall { method: string; path: string; body: unknown }
let netServer: Server;
let netUrl = '';
let netCalls: NetCall[] = [];
let netReply: { status: number; body: unknown } = { status: 200, body: { ok: true } };

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    netServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        netCalls.push({
          method: req.method ?? '',
          path: req.url ?? '',
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
        });
        res.writeHead(netReply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(netReply.body));
      });
    }).listen(0, '127.0.0.1', () => {
      netUrl = `http://127.0.0.1:${(netServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  mailer = new CapturingMailer();
  __setMailerForTests(mailer);
  netCalls = [];
  netReply = { status: 200, body: { ok: true } };
});

afterEach(async () => {
  if (skipIntegration) return;
  delete process.env.NETWORK_URL;
  delete process.env.NETWORK_ADMIN_API_KEY;
  for (const id of createdTenants.splice(0)) {
    const admins = await db(TABLES.Admin).where({ tenantId: id }).select('email');
    await db(TABLES.EmailOptOut).whereIn('email', admins.map((a) => String(a.email).toLowerCase())).del();
    for (const t of [TABLES.Program, TABLES.Admin, TABLES.Config]) await db(t).where({ tenantId: id }).del();
    await db(TABLES.PlatformAuditLog).where({ targetId: id }).del();
    await db(TABLES.Tenant).where({ id }).del(); // BrandNotification cascades
  }
  await db(TABLES.PlatformSetting).where({ key: 'notifications' }).del();
});

afterAll(async () => {
  __setMailerForTests(null);
  if (netServer) await new Promise<void>((r) => netServer.close(() => r()));
  if (!skipIntegration && createdOperators.length) {
    await db(TABLES.PlatformAuditLog).whereIn('platformAdminId', createdOperators).del();
    await db(TABLES.PlatformAdminSession).whereIn('platformAdminId', createdOperators).del();
    await db(TABLES.PlatformAdmin).whereIn('id', createdOperators).del();
  }
});

// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('brand setup checklist', () => {
  it('lists what a fresh brand still has to do; partners only once approved', async () => {
    const b = await seedBrand({ ageDays: 3 });
    let setup = (await brandSetupFor(db, [b.id])).get(b.id)!;
    expect(setup.complete).toBe(false);
    expect(setup.steps.map((s) => s.key)).toEqual(['program', 'tracking']); // not on Network, not approved

    await db(TABLES.Tenant).where({ id: b.id }).update({ approvalStatus: 'approved' });
    setup = (await brandSetupFor(db, [b.id])).get(b.id)!;
    expect(setup.steps.map((s) => s.key)).toEqual(['program', 'tracking', 'partners']);

    await completeSetup(b.id);
    await db(TABLES.Tenant).where({ id: b.id }).update({ approvalStatus: 'pending' });
    setup = (await brandSetupFor(db, [b.id])).get(b.id)!;
    expect(setup.complete).toBe(true);
  });

  it('adds the marketplace step for an on-Network brand, done once a program is listed', async () => {
    const b = await seedBrand({ ageDays: 3 });
    await db(TABLES.Config).insert({ tenantId: b.id, key: 'network_membership', value: { enabled: true } as never, updatedAt: new Date() });
    await completeSetup(b.id);
    let setup = (await brandSetupFor(db, [b.id])).get(b.id)!;
    expect(setup.steps.find((s) => s.key === 'listing')?.done).toBe(false);
    await db(TABLES.Program).where({ tenantId: b.id }).update({ shareOnNetwork: true, networkOfferingId: 'off_1' });
    setup = (await brandSetupFor(db, [b.id])).get(b.id)!;
    expect(setup.complete).toBe(true);
  });

  it('the dashboard onboarding status reports tracking + approval state', async () => {
    const b = await seedBrand({ ageDays: 3 });
    const res = await request(app).get(`/t/${b.slug}/admin/onboarding-status`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.trackingInstalled).toBe(false);
    expect(res.body.approvalStatus).toBe('pending');
    expect(res.body.complete).toBe(false);
  });
});

describe.skipIf(skipIntegration)('brand setup reminders', () => {
  it('waits 2 days, sends step 1 with an unsubscribe header, then spaces steps 2 and 3', async () => {
    const young = await seedBrand({ ageDays: 1 });
    const b = await seedBrand({ ageDays: 3 });

    const preview = await runBrandSetupReminders(db, { tenantIds: createdTenants, dryRun: true });
    const due = mine(preview.eligible);
    expect(due.map((e) => e.tenantId)).toEqual([b.id]);
    expect(due[0]!.step).toBe(1);
    expect(due[0]!.missing.length).toBeGreaterThan(0);
    expect(mailer.sent).toHaveLength(0);
    expect(await db(TABLES.BrandNotification).where({ tenantId: b.id })).toHaveLength(0);

    await runBrandSetupReminders(db, { tenantIds: createdTenants });
    const msg = mailer.sent.find((m) => m.to === b.adminEmail)!;
    expect(msg).toBeDefined();
    expect(mailer.sent.find((m) => m.to === young.adminEmail)).toBeUndefined();
    expect(msg.platform).toBe(true);
    expect(msg.subject).toContain('Finish setting up');
    expect(msg.headers?.['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:5673\/api\/email\/unsubscribe\?t=/);
    expect(msg.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(msg.text).toContain('review queue'); // pending brand is told it goes live on approval

    // Immediately again: nothing (step 2 waits 4 days after step 1).
    mailer.sent.length = 0;
    await runBrandSetupReminders(db, { tenantIds: createdTenants });
    expect(mailer.sent.find((m) => m.to === b.adminEmail)).toBeUndefined();

    const step2 = mine((await runBrandSetupReminders(db, { tenantIds: createdTenants, dryRun: true, now: new Date(Date.now() + 4.1 * DAY) })).eligible);
    expect(step2.find((e) => e.tenantId === b.id)?.step).toBe(2);
    await runBrandSetupReminders(db, { tenantIds: createdTenants, now: new Date(Date.now() + 4.1 * DAY) });
    // Step 3 waits 7 days after step 2.
    const early = mine((await runBrandSetupReminders(db, { tenantIds: createdTenants, dryRun: true, now: new Date(Date.now() + 10 * DAY) })).eligible);
    expect(early.find((e) => e.tenantId === b.id)).toBeUndefined();
    await runBrandSetupReminders(db, { tenantIds: createdTenants, now: new Date(Date.now() + 11.2 * DAY) });
    expect((await db(TABLES.BrandNotification).where({ tenantId: b.id })).map((r) => r.step).sort()).toEqual([1, 2, 3]);

    // No fourth.
    const after = mine((await runBrandSetupReminders(db, { tenantIds: createdTenants, dryRun: true, now: new Date(Date.now() + 60 * DAY) })).eligible);
    expect(after.find((e) => e.tenantId === b.id)).toBeUndefined();
  });

  it('skips complete brands, unconfirmed admins, rejected brands, and opted-out addresses', async () => {
    const complete = await seedBrand({ ageDays: 5 });
    await completeSetup(complete.id);
    const unconfirmed = await seedBrand({ ageDays: 5, adminSignedIn: false });
    const rejected = await seedBrand({ ageDays: 5, approvalStatus: 'rejected' });
    const optedOut = await seedBrand({ ageDays: 5 });
    await request(app).post(`/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(optedOut.adminEmail, 'brand_setup'))}`);
    const ok = await seedBrand({ ageDays: 5, approvalStatus: 'approved' });

    const ids = mine((await runBrandSetupReminders(db, { tenantIds: createdTenants, dryRun: true })).eligible).map((e) => e.tenantId);
    expect(ids).toEqual([ok.id]);
    for (const b of [complete, unconfirmed, rejected, optedOut]) expect(ids).not.toContain(b.id);
  });

  it('a failed send releases its claim so the next run retries', async () => {
    const b = await seedBrand({ ageDays: 3 });
    mailer.send = async (_ctx, msg) => {
      if (msg.to === b.adminEmail) throw new Error('smtp down');
    };
    const r = await runBrandSetupReminders(db, { tenantIds: createdTenants });
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(await db(TABLES.BrandNotification).where({ tenantId: b.id })).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('one-click unsubscribe', () => {
  it('GET confirms without opting out; POST (link or RFC 8058 one-click) opts out; bad tokens 400', async () => {
    const email = `Someone-${rnd()}@Brand.test`;
    const t = unsubscribeToken(email, 'brand_setup');
    expect(readUnsubscribeToken(t)).toEqual({ email: email.toLowerCase(), scope: 'brand_setup' });

    const page = await request(app).get(`/email/unsubscribe?t=${encodeURIComponent(t)}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<form method="post"');
    expect(await isOptedOut(db, email, 'brand_setup')).toBe(false);

    const oneClick = await request(app)
      .post(`/email/unsubscribe?t=${encodeURIComponent(t)}`)
      .type('form')
      .send('List-Unsubscribe=One-Click');
    expect(oneClick.status).toBe(200);
    expect(await isOptedOut(db, email, 'brand_setup')).toBe(true);
    // Idempotent.
    expect((await request(app).post(`/email/unsubscribe?t=${encodeURIComponent(t)}`)).status).toBe(200);

    const tampered = `${Buffer.from('brand_setup:victim@brand.test').toString('base64url')}.${t.split('.')[1]}`;
    expect((await request(app).post(`/email/unsubscribe?t=${encodeURIComponent(tampered)}`)).status).toBe(400);
    expect(await isOptedOut(db, 'victim@brand.test', 'brand_setup')).toBe(false);
    expect((await request(app).get('/email/unsubscribe?t=garbage')).status).toBe(400);

    await db(TABLES.EmailOptOut).where({ email: email.toLowerCase() }).del();
  });
});

describe.skipIf(skipIntegration)('ops console — notifications', () => {
  it('switches default off; only admin operators change them', async () => {
    expect(await getNotificationSettings(db)).toEqual({ brandSetupReminders: false, creatorProfileReminders: false });
    const support = await makeOperator('support');
    const denied = await request(app).put('/platform-admin/notifications').set('Cookie', support).send({ brandSetupReminders: true });
    expect(denied.status).toBe(403);

    const admin = await makeOperator('admin');
    const ok = await request(app).put('/platform-admin/notifications').set('Cookie', admin).send({ brandSetupReminders: true });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toEqual({ brandSetupReminders: true, creatorProfileReminders: false });
    const read = await request(app).get('/platform-admin/notifications').set('Cookie', support);
    expect(read.body.settings.brandSetupReminders).toBe(true);
  });

  it('support can preview a run but not send one; admin can send', async () => {
    const b = await seedBrand({ ageDays: 3 });
    const support = await makeOperator('support');
    const preview = await request(app).post('/platform-admin/notifications/brand-setup/run').set('Cookie', support).send({ dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.dryRun).toBe(true);
    expect(mine(preview.body.eligible as Array<{ tenantId?: string }>).map((e) => e.tenantId)).toContain(b.id);
    const send = await request(app).post('/platform-admin/notifications/brand-setup/run').set('Cookie', support).send({ dryRun: false });
    expect(send.status).toBe(403);
    expect(mailer.sent).toHaveLength(0);
  });

  it('manual setup reminder ignores timing but keeps the rules', async () => {
    const fresh = await seedBrand({ ageDays: 0 });
    const admin = await makeOperator('admin');
    const r = await request(app).post(`/platform-admin/brands/${fresh.id}/setup-reminder`).set('Cookie', admin).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, step: 1, to: fresh.adminEmail });
    expect(mailer.sent.find((m) => m.to === fresh.adminEmail)).toBeDefined();

    await completeSetup(fresh.id);
    const done = await request(app).post(`/platform-admin/brands/${fresh.id}/setup-reminder`).set('Cookie', admin).send({});
    expect(done.status).toBe(409);
    expect(done.body.error).toBe('setup_complete');
  });

  it('brand list carries setup progress + reminder history', async () => {
    const b = await seedBrand({ ageDays: 3 });
    const admin = await makeOperator('admin');
    await request(app).post(`/platform-admin/brands/${b.id}/setup-reminder`).set('Cookie', admin).send({});
    const list = await request(app).get('/platform-admin/brands?status=pending&limit=200').set('Cookie', admin);
    const row = (list.body.brands as Array<Record<string, unknown>>).find((x) => x.id === b.id)!;
    expect(row.setupComplete).toBe(false);
    expect((row.setupMissing as string[]).length).toBeGreaterThan(0);
    expect(row.setupRemindersSent).toBe(1);
  });

  it('creator reminders proxy to the Network and pass its refusal reason through', async () => {
    process.env.NETWORK_URL = netUrl;
    process.env.NETWORK_ADMIN_API_KEY = 'netadm_test_key_0123456789abcdef';
    const admin = await makeOperator('admin');

    netReply = { status: 200, body: { dryRun: true, eligible: [{ creatorId: 'crt_1', email: 'c@x.test', name: 'C', step: 1, missing: ['Add a profile photo'] }], sent: 0, failed: 0 } };
    const preview = await request(app).post('/platform-admin/notifications/creator-profile/run').set('Cookie', admin).send({ dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.eligible).toHaveLength(1);
    expect(netCalls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/admin/creator-reminders/run',
      body: { dryRun: true, publicUrl: netUrl },
    });

    netReply = { status: 409, body: { error: 'profile_complete' } };
    const refused = await request(app).post('/platform-admin/creators/crt_1/remind').set('Cookie', admin).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('profile_complete');

    netReply = { status: 200, body: { ok: true, step: 2 } };
    const sent = await request(app).post('/platform-admin/creators/crt_1/remind').set('Cookie', admin).send({});
    expect(sent.status).toBe(200);
    expect(sent.body.step).toBe(2);
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'creator.profile_reminder', targetId: 'crt_1' }).first();
    expect(audit).toBeDefined();
    await db(TABLES.PlatformAuditLog).where({ targetId: 'crt_1' }).del();
  });
});

describe.skipIf(skipIntegration)('ops console — marketplace policy warning', () => {
  it('emails the brand admin in the platform voice and records it on the brand', async () => {
    const b = await seedBrand({ ageDays: 10, approvalStatus: 'approved' });
    const admin = await makeOperator('admin');
    const res = await request(app)
      .post(`/platform-admin/brands/${b.id}/policy-warning`)
      .set('Cookie', admin)
      .send({ details: 'Listing says: apply at partners.brand.test (Rewardful).', deadlineDays: 7 });
    expect(res.status).toBe(200);
    expect(res.body.sentTo).toBe(b.adminEmail);

    const msg = mailer.sent.find((m) => m.to === b.adminEmail)!;
    expect(msg.platform).toBe(true);
    expect(msg.subject).toContain('marketplace listing');
    expect(msg.text).toContain('partners.brand.test (Rewardful)');
    expect(msg.text).toMatch(/remove the listing/);

    const list = await request(app).get('/platform-admin/brands?status=approved&limit=200').set('Cookie', admin);
    const row = (list.body.brands as Array<Record<string, unknown>>).find((x) => x.id === b.id)!;
    expect(row.lastPolicyWarningAt).toBeTruthy();
    expect(row.policyWarningDeadline).toBeTruthy();
  });

  it('requires details and an admin operator', async () => {
    const b = await seedBrand({ ageDays: 10, approvalStatus: 'approved' });
    const admin = await makeOperator('admin');
    const short = await request(app).post(`/platform-admin/brands/${b.id}/policy-warning`).set('Cookie', admin).send({ details: 'bad' });
    expect(short.status).toBe(400);
    const support = await makeOperator('support');
    const denied = await request(app)
      .post(`/platform-admin/brands/${b.id}/policy-warning`)
      .set('Cookie', support)
      .send({ details: 'Listing points to another affiliate platform.' });
    expect(denied.status).toBe(403);
    expect(mailer.sent).toHaveLength(0);
  });
});
