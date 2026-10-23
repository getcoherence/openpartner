/**
 * Platform "forgot password" (POST /password/forgot) for an address with no
 * platform password to reset. A partner-only address used to get the same
 * silent 200 as a stranger and wait for a mail that never came; it now hears
 * which brands' partner portals reset its passwords. The rest must hold:
 *
 *   1. Brand admins still get the platform reset link, and nothing else.
 *   2. The notice lists only portals whose own "Forgot password" would mail
 *      this partner, issues no reset token, and goes out as platform mail.
 *   3. An unknown address hears nothing, the response never differs, and
 *      the per-address cap applies.
 *
 * Skipped when DATABASE_URL is unset, like the rest of the integration suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type TenantRow } from '@openpartner/db';
import type { Mailer, Message, SendContext } from '../mailer.js';

process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
delete process.env.PLATFORM_ADMIN_EMAILS;
delete process.env.NETWORK_URL;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { __setMailerForTests } = await import('../mailer.js');
const { passwordResetPartnerPortalsEmail } = await import('../email-templates.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

class CapturingMailer implements Mailer {
  readonly sent: Array<{ ctx: SendContext; msg: Message }> = [];
  async send(ctx: SendContext, msg: Message): Promise<void> {
    this.sent.push({ ctx, msg });
  }
}

let mailer: CapturingMailer;
const tenants: string[] = [];
const emails = new Set<string>();

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}
function address(tag: string): string {
  const e = `${tag}-${rnd()}@forgot-notice.test`;
  emails.add(e);
  return e;
}

async function makeTenant(fields: Partial<TenantRow> = {}): Promise<{ id: string; slug: string }> {
  const id = ulid();
  const slug = `fn${rnd()}`;
  await db(TABLES.Tenant).insert({ id, slug, displayName: `Brand ${slug}`, status: 'active', ...fields });
  tenants.push(id);
  return { id, slug };
}

async function makePartner(
  tenantId: string,
  email: string,
  overrides: Partial<{ portalAccess: boolean; revokedAt: Date | null; activatedAt: Date | null }> = {},
): Promise<void> {
  await db(TABLES.Partner).insert({
    id: ulid(),
    tenantId,
    email,
    name: 'Partner',
    activatedAt: 'activatedAt' in overrides ? overrides.activatedAt : new Date(),
    portalAccess: overrides.portalAccess ?? true,
    revokedAt: overrides.revokedAt ?? null,
  });
}

function forgot(email: string) {
  return request(app).post('/password/forgot').send({ email });
}

beforeEach(() => {
  mailer = new CapturingMailer();
  __setMailerForTests(mailer);
});

afterEach(() => {
  __setMailerForTests(null);
});

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const tenantId of tenants) {
      for (const table of [TABLES.MagicLinkToken, TABLES.Partner, TABLES.Admin, TABLES.Config]) {
        await db(table).where({ tenantId }).del();
      }
      await db(TABLES.Tenant).where({ id: tenantId }).del();
    }
    await db(TABLES.MagicLinkToken).whereIn('email', [...emails]).del();
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('POST /password/forgot for an address with no platform password', () => {
  it('still mails a brand admin the platform reset link, and no notice, even when also a partner', async () => {
    const brand = await makeTenant();
    const other = await makeTenant();
    const email = address('admin');
    await db(TABLES.Admin).insert({ id: ulid(), tenantId: brand.id, email, name: 'Admin', activatedAt: new Date() });
    await makePartner(other.id, email);

    expect((await forgot(email)).status).toBe(200);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.msg.tag).toBe('password_reset');
    expect(mailer.sent[0]!.msg.text).toContain('http://localhost:5673/reset-password?token=');
  });

  it('mails a partner-only address the portals that reset its passwords, and issues no reset token', async () => {
    const email = address('partner');
    const domain = `partners-${rnd()}.forgot-notice.test`;
    const white = await makeTenant({ customDomain: domain });
    await db(TABLES.Config).insert({
      tenantId: white.id,
      key: 'program_settings',
      value: { programName: 'Acme Partners' } as never,
      updatedAt: new Date(),
    });
    await makePartner(white.id, email);
    const plain = await makeTenant({ displayName: 'Beta Brand' });
    await makePartner(plain.id, email);
    // None of these portals would mail this partner a reset.
    const revoked = await makeTenant();
    await makePartner(revoked.id, email, { revokedAt: new Date() });
    const noPortal = await makeTenant();
    await makePartner(noPortal.id, email, { portalAccess: false });
    const notActivated = await makeTenant();
    await makePartner(notActivated.id, email, { activatedAt: null });
    const suspended = await makeTenant({ status: 'suspended' });
    await makePartner(suspended.id, email);
    const deleting = await makeTenant({ pendingDeletionAt: new Date() });
    await makePartner(deleting.id, email);

    expect((await forgot(email.toUpperCase())).status).toBe(200);

    expect(mailer.sent).toHaveLength(1);
    const { msg } = mailer.sent[0]!;
    expect(msg.to).toBe(email);
    expect(msg.tag).toBe('password_reset_partner_portals');
    expect(msg.subject).toBe('No OpenPartner admin password for this address');
    expect(msg.text).toContain("there's\nno OpenPartner admin password for this address");
    // Sorted by brand name; a white-label brand's portal is on its own domain.
    expect(msg.text).toContain(
      `Acme Partners\nhttps://${domain}/login\n\nBeta Brand\nhttp://localhost:5673/t/${plain.slug}/login\n`,
    );
    expect(msg.text).toContain('Network creator, sign in at the creator portal:\n\nhttp://localhost:5673/creator/login');
    for (const t of [revoked, noPortal, notActivated, suspended, deleting]) expect(msg.text).not.toContain(t.slug);
    expect(msg.html).toContain(`<a href="https://${domain}/login"`);
    expect(msg.html).toContain(`<a href="http://localhost:5673/creator/login"`);

    expect(msg.text).not.toContain('token=');
    expect(await db(TABLES.MagicLinkToken).where({ email })).toHaveLength(0);
  });

  it('sends the notice as platform mail, never through a brand’s mail context', async () => {
    const brand = await makeTenant();
    const email = address('context');
    await makePartner(brand.id, email);

    await forgot(email);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.ctx.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(mailer.sent[0]!.msg.platform).toBe(true);
  });

  it('mails nothing to an unknown address, or to one that is only a revoked partner', async () => {
    const brand = await makeTenant();
    const revoked = address('revoked');
    await makePartner(brand.id, revoked, { revokedAt: new Date() });

    expect((await forgot(address('stranger'))).status).toBe(200);
    expect((await forgot(revoked)).status).toBe(200);

    expect(mailer.sent).toHaveLength(0);
  });

  it('answers an admin, a partner, and an unknown address identically', async () => {
    const brand = await makeTenant();
    const admin = address('same-admin');
    const partner = address('same-partner');
    await db(TABLES.Admin).insert({ id: ulid(), tenantId: brand.id, email: admin, name: 'Admin', activatedAt: new Date() });
    await makePartner(brand.id, partner);

    const responses = [await forgot(admin), await forgot(partner), await forgot(address('same-stranger'))];

    expect(mailer.sent.map((s) => s.msg.tag)).toEqual(['password_reset', 'password_reset_partner_portals']);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.text).toBe(responses[0]!.text);
      expect(res.headers['content-type']).toBe(responses[0]!.headers['content-type']);
    }
  });

  it('caps the notice at 3 per address per window', async () => {
    const brand = await makeTenant();
    const email = address('flood');
    await makePartner(brand.id, email);

    for (let i = 0; i < 5; i++) expect((await forgot(email)).status).toBe(200);

    expect(mailer.sent.filter((s) => s.msg.to === email)).toHaveLength(3);
  });
});

describe('passwordResetPartnerPortalsEmail', () => {
  it('links only the portal URLs, never a brand name that looks like one', () => {
    const tmpl = passwordResetPartnerPortalsEmail({
      email: 'p@example.test',
      portals: [{ brandName: '<b>https://evil.example</b> & co', signinUrl: 'https://portal.example/login' }],
      creatorSigninUrl: 'https://app.example/creator/login',
    });
    expect(tmpl.html).toContain('&lt;b&gt;https://evil.example&lt;/b&gt; &amp; co');
    expect(tmpl.html).not.toContain('href="https://evil.example');
    expect(tmpl.html).toContain('<a href="https://portal.example/login"');
    expect(tmpl.html).toContain('<a href="https://app.example/creator/login"');
  });
});
