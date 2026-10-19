/**
 * Unified /signin (multi-tenant): which mail goes out, from which context.
 *
 *   1. A brand admin's sign-in link is sent in the platform mail context
 *      (DEFAULT_TENANT_ID), never the matched Admin row's tenant — a brand
 *      with its own mail provider must not carry OpenPartner's sign-in mail.
 *   2. No admin matched: an ops-console address is told to use
 *      /platform/login; "Add another account" from a signed-in browser is
 *      told there's no brand account; anything else stays silent.
 *
 * Skipped when DATABASE_URL is unset, like the rest of the integration suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type MagicLinkTokenRow, type TenantRow } from '@openpartner/db';
import type { Mailer, Message, SendContext } from '../mailer.js';

process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.PLATFORM_ADMIN_EMAILS = 'ops-signin@openpartner.test';
delete process.env.NETWORK_URL; // no creator forward during tests

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { __setMailerForTests } = await import('../mailer.js');
const { createPlatformSession, PLATFORM_SESSION_COOKIE } = await import('../platform-sessions.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const TENANT = ulid();
const ADMIN_EMAIL = `admin-${TENANT.slice(-8).toLowerCase()}@signin.test`;
const OPS_EMAIL = 'ops-signin@openpartner.test';
const SESSION_EMAIL = `switcher-${TENANT.slice(-8).toLowerCase()}@signin.test`;
const CLEAN_EMAILS = [ADMIN_EMAIL, OPS_EMAIL, SESSION_EMAIL];

class CapturingMailer implements Mailer {
  readonly sent: Array<{ ctx: SendContext; msg: Message }> = [];
  async send(ctx: SendContext, msg: Message): Promise<void> {
    this.sent.push({ ctx, msg });
  }
}

let mailer: CapturingMailer;

beforeAll(async () => {
  if (skipIntegration) return;
  await db<TenantRow>(TABLES.Tenant).insert({ id: TENANT, slug: `signin-${TENANT.slice(-8).toLowerCase()}`, displayName: 'Signin Brand', status: 'active' });
  await db(TABLES.Admin).insert({ id: ulid(), tenantId: TENANT, email: ADMIN_EMAIL, name: 'Ada', activatedAt: new Date() });
});

beforeEach(() => {
  mailer = new CapturingMailer();
  __setMailerForTests(mailer);
});

afterEach(() => {
  __setMailerForTests(null);
});

afterAll(async () => {
  if (!skipIntegration) {
    await db(TABLES.MagicLinkToken).whereIn('email', CLEAN_EMAILS).del();
    await db(TABLES.PlatformSession).whereIn('email', CLEAN_EMAILS).del();
    await db(TABLES.Admin).where({ tenantId: TENANT }).del();
    await db(TABLES.Tenant).where({ id: TENANT }).del();
  }
  await db.destroy();
});

async function signedInCookie(): Promise<string> {
  const session = await createPlatformSession(db, SESSION_EMAIL);
  return `${PLATFORM_SESSION_COOKIE}=${session.plaintext}`;
}

describe.skipIf(skipIntegration)('unified /signin', () => {
  it('sends a brand admin their link in the platform mail context, not their brand’s', async () => {
    const res = await request(app).post('/signin').send({ email: ADMIN_EMAIL.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(mailer.sent).toHaveLength(1);
    const { ctx, msg } = mailer.sent[0]!;
    expect(ctx.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(msg.to).toBe(ADMIN_EMAIL);
    expect(msg.tag).toBe('platform_signin');
    expect(msg.platform).toBe(true);
    expect(msg.text).toMatch(/\/auth\/magic\?token=/);
  });

  it('issues an add-account link in the platform context too', async () => {
    const res = await request(app).post('/signin').send({ email: ADMIN_EMAIL, add: true });
    expect(res.status).toBe(200);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.ctx.tenantId).toBe(DEFAULT_TENANT_ID);
    const latest = await db<MagicLinkTokenRow>(TABLES.MagicLinkToken)
      .where({ email: ADMIN_EMAIL })
      .orderBy('createdAt', 'desc')
      .first();
    expect(latest?.purpose).toBe('platform_add_account');
  });

  it('points an ops-console address with no brand at /platform/login', async () => {
    const res = await request(app).post('/signin').send({ email: OPS_EMAIL });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(mailer.sent).toHaveLength(1);
    const { ctx, msg } = mailer.sent[0]!;
    expect(ctx.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(msg.to).toBe(OPS_EMAIL);
    expect(msg.tag).toBe('signin_no_account');
    expect(msg.platform).toBe(true);
    expect(msg.text).toContain('http://localhost:5673/platform/login');
    expect(msg.html).toContain('http://localhost:5673/platform/login');
    // No sign-in link of any kind was issued.
    expect(await db(TABLES.MagicLinkToken).where({ email: OPS_EMAIL })).toHaveLength(0);
  });

  it('tells an address added from a signed-in browser that it has no brand account', async () => {
    const email = `nobody-${ulid().slice(-8).toLowerCase()}@signin.test`;
    const res = await request(app).post('/signin').set('Cookie', await signedInCookie()).send({ email, add: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(mailer.sent).toHaveLength(1);
    const { ctx, msg } = mailer.sent[0]!;
    expect(ctx.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(msg.to).toBe(email);
    expect(msg.tag).toBe('signin_no_account');
    expect(msg.text).toContain('http://localhost:5673/signup');
    expect(msg.text).not.toContain('/platform/login');
    // Nothing about the browser that asked leaks to the address.
    expect(msg.text).not.toContain(SESSION_EMAIL);
  });

  it('stays silent for an unknown address on a plain sign-in', async () => {
    const res = await request(app).post('/signin').send({ email: `nobody-${ulid().slice(-8).toLowerCase()}@signin.test` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mailer.sent).toHaveLength(0);
  });

  it('stays silent for add=true without a live platform session', async () => {
    const email = `nobody-${ulid().slice(-8).toLowerCase()}@signin.test`;
    const bare = await request(app).post('/signin').send({ email, add: true });
    expect(bare.status).toBe(200);
    const forged = await request(app)
      .post('/signin')
      .set('Cookie', `${PLATFORM_SESSION_COOKIE}=opsplat_${'0'.repeat(48)}`)
      .send({ email, add: true });
    expect(forged.status).toBe(200);
    expect(mailer.sent).toHaveLength(0);
  });
});
