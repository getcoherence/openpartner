/**
 * "Hold for review" partner signup (partner_signup policy require_review).
 *
 * Regression: signup used to email the applicant a partner_invite magic
 * link, and /auth/magic/verify activates a pending partner on any
 * partner_invite link — so clicking the "confirm your address" email
 * approved the applicant. Now:
 *   - signup sends no link; the applicant gets an acknowledgement and every
 *     active admin gets a review request;
 *   - verify refuses any link for an applicant still pending review;
 *   - POST /partners/:id/invite is the approval: it records it and sends
 *     the link, which then activates.
 *
 * Skipped if DATABASE_URL isn't set.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { issueMagicLink } from '../auth-sessions.js';
import { __setMailerForTests, type Mailer, type Message } from '../mailer.js';

const ADMIN_KEY = 'op_test_signup_review_0123456789abcdef012';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.OPENPARTNER_TENANCY = 'single';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const TABLES_TO_CLEAN = [
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.NetworkOutbox,
  TABLES.Coupon,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.Payout,
  TABLES.Partner,
];

class CapturingMailer implements Mailer {
  readonly sent: Message[] = [];
  async send(_ctx: unknown, msg: Message): Promise<void> {
    this.sent.push(msg);
  }
  to(addr: string): Message[] {
    return this.sent.filter((m) => m.to === addr);
  }
}

let mailer: CapturingMailer;
const adminIds: string[] = [];

async function setPolicy(policy: 'auto_approve' | 'require_review'): Promise<void> {
  await db(TABLES.Config)
    .insert({ tenantId: DEFAULT_TENANT_ID, key: 'partner_signup', value: { policy } as unknown as never, updatedAt: new Date() })
    .onConflict(['tenantId', 'key'])
    .merge({ value: { policy } as unknown as never, updatedAt: new Date() });
}

async function seedAdmin(email: string, state: { activated: boolean; revoked?: boolean }): Promise<void> {
  const id = ulid();
  adminIds.push(id);
  await db(TABLES.Admin).insert({
    id,
    tenantId: DEFAULT_TENANT_ID,
    email,
    name: email.split('@')[0],
    activatedAt: state.activated ? new Date() : null,
    revokedAt: state.revoked ? new Date() : null,
  });
}

function signup(email: string, profile?: Record<string, unknown>) {
  return request(app).post('/partner-signup').send({ email, name: 'Applicant', ...(profile ? { profile } : {}) });
}

function tokenFrom(msg: Message | undefined): string {
  const match = /token=([^\s&"]+)/.exec(msg?.text ?? '');
  if (!match) throw new Error('no magic-link token in message');
  return decodeURIComponent(match[1]!);
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

beforeEach(async () => {
  mailer = new CapturingMailer();
  __setMailerForTests(mailer);
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID }).whereIn('key', ['partner_signup', 'network_membership']).del();
});

afterEach(async () => {
  __setMailerForTests(null);
  if (skipIntegration) return;
  if (adminIds.length) await db(TABLES.Admin).whereIn('id', adminIds.splice(0)).del();
});

afterAll(async () => {
  if (!skipIntegration) await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'partner_signup' }).del();
  await db.destroy();
});

describe.skipIf(skipIntegration)('partner signup held for review', () => {
  it('sends no sign-in link: the applicant is acknowledged and every active admin is asked to review', async () => {
    await setPolicy('require_review');
    await seedAdmin('owner@brand.test', { activated: true });
    await seedAdmin('ops@brand.test', { activated: true });
    await seedAdmin('former@brand.test', { activated: true, revoked: true });
    await seedAdmin('invited@brand.test', { activated: false });

    // A forged review state in the public profile is dropped.
    const res = await signup('applicant@x.test', { bio: 'hi', review: { status: 'approved' } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_review');

    const partner = await db(TABLES.Partner).where({ email: 'applicant@x.test' }).first();
    expect(partner.activatedAt).toBeNull();
    expect(partner.metadata).toMatchObject({ bio: 'hi', review: { status: 'pending' } });
    expect(await db(TABLES.MagicLinkToken).where({ principalId: partner.id })).toHaveLength(0);

    const ack = mailer.to('applicant@x.test');
    expect(ack).toHaveLength(1);
    expect(ack[0]!.metadata?.purpose).toBe('partner_application_received');
    expect(ack[0]!.text).not.toContain('/auth/magic');

    for (const admin of ['owner@brand.test', 'ops@brand.test']) {
      const [notice] = mailer.to(admin);
      expect(notice?.metadata?.purpose).toBe('partner_application');
      expect(notice?.text).toContain('applicant@x.test');
      expect(notice?.text).toContain('http://localhost:5673/admin/partners');
    }
    expect(mailer.to('former@brand.test')).toHaveLength(0);
    expect(mailer.to('invited@brand.test')).toHaveLength(0);
  });

  it('a sign-in link cannot activate or sign in an applicant still pending review', async () => {
    await setPolicy('require_review');
    await signup('applicant@x.test');
    const partner = await db(TABLES.Partner).where({ email: 'applicant@x.test' }).first();
    // The kind of link the old signup sent.
    const issued = await issueMagicLink(db, {
      tenantId: DEFAULT_TENANT_ID,
      email: partner.email,
      purpose: 'partner_invite',
      principalKind: 'partner',
      principalId: partner.id,
    });

    const res = await request(app).post('/auth/magic/verify').send({ token: issued.plaintext });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('pending_review');
    expect((await db(TABLES.Partner).where({ id: partner.id }).first()).activatedAt).toBeNull();
    expect(await db(TABLES.Session).where({ principalId: partner.id })).toHaveLength(0);
  });

  it('approving records it and sends the link, which then activates the partner', async () => {
    await setPolicy('require_review');
    await signup('applicant@x.test');
    const partner = await db(TABLES.Partner).where({ email: 'applicant@x.test' }).first();

    const approve = await request(app).post(`/partners/${partner.id}/invite`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(approve.status).toBe(200);
    expect(approve.body).toEqual({ ok: true, approved: true });
    const approved = await db(TABLES.Partner).where({ id: partner.id }).first();
    expect(approved.metadata.review).toMatchObject({ status: 'approved', appliedAt: expect.any(String), approvedAt: expect.any(String) });

    const invite = mailer.to('applicant@x.test').find((m) => m.metadata?.purpose === 'partner_invite');
    const verify = await request(app).post('/auth/magic/verify').send({ token: tokenFrom(invite) });
    expect(verify.status).toBe(200);
    expect(verify.body.role).toBe('partner');
    expect((await db(TABLES.Partner).where({ id: partner.id }).first()).activatedAt).not.toBeNull();
  });

  it('auto-approve is unchanged: the signup link signs the partner in, and no admin is notified', async () => {
    await setPolicy('auto_approve');
    await seedAdmin('owner@brand.test', { activated: true });

    const res = await signup('creator@x.test');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    const invite = mailer.to('creator@x.test').find((m) => m.metadata?.purpose === 'partner_invite');
    const verify = await request(app).post('/auth/magic/verify').send({ token: tokenFrom(invite) });
    expect(verify.status).toBe(200);
    expect(mailer.to('owner@brand.test')).toHaveLength(0);
    const partner = await db(TABLES.Partner).where({ email: 'creator@x.test' }).first();
    expect(partner.metadata).not.toHaveProperty('review');
  });
});
