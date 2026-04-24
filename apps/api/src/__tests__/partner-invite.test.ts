/**
 * Partner invite + magic-link signin happy paths.
 *
 * Uses MAIL_TRANSPORT=dev so the magic link lands in the DevMessage
 * table where the test can read it back instead of hitting Postmark.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_invite_admin_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.MAIL_TRANSPORT = 'dev';
process.env.PORTAL_URL = 'http://localhost:5673';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const TABLES_TO_CLEAN = [
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.DevMessage,
  TABLES.ApiKey,
  TABLES.Partner,
];

const app = createApp({ enableLogger: false });

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) {
    await db(t).del();
  }
});

/**
 * Fish the magic-link token out of a dev email body — emails carry the
 * URL `http://localhost:5673/auth/magic?token=<opml_...>`.
 */
function extractToken(body: string): string {
  const match = /token=([^\s&"]+)/.exec(body);
  if (!match) throw new Error(`no token in body:\n${body}`);
  return decodeURIComponent(match[1]!);
}

describe.skipIf(skipIntegration)('partner invite + signin', () => {
  it('admin invite creates a pending partner + sends an email; verify activates + issues session', async () => {
    const created = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'gracie@example.com', name: 'Gracie' });
    expect(created.status).toBe(201);
    expect(created.body.invited).toBe(true);
    expect(created.body.activatedAt).toBeNull();

    // No admin-visible credential in the response.
    expect(created.body).not.toHaveProperty('plaintext');
    expect(created.body).not.toHaveProperty('apiKey');

    const mailbox = await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`);
    const invite = mailbox.body.messages.find(
      (m: { to: string; metadata?: { purpose?: string } }) =>
        m.to === 'gracie@example.com' && m.metadata?.purpose === 'partner_invite',
    );
    expect(invite).toBeDefined();

    const token = extractToken(invite.body);
    const verify = await request(app).post('/auth/magic/verify').send({ token });
    expect(verify.status).toBe(200);
    expect(verify.body.role).toBe('partner');
    expect(verify.body.partner.email).toBe('gracie@example.com');

    // Session cookie set; partner.activatedAt stamped.
    const setCookie = verify.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie).toBeTruthy();
    const cookie = setCookie![0]!.split(';')[0]!;
    expect(cookie.startsWith('op_session=')).toBe(true);

    const activated = await db(TABLES.Partner).where({ id: created.body.id }).first();
    expect((activated as { activatedAt: Date | null }).activatedAt).not.toBeNull();

    // whoami with the cookie resolves to the partner
    const who = await request(app).get('/auth/whoami').set('Cookie', cookie);
    expect(who.status).toBe(200);
    expect(who.body.role).toBe('partner');
    expect(who.body.partnerId).toBe(created.body.id);
  });

  it('magic-link tokens are single-use — second verify 400s', async () => {
    await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'dup@example.com', name: 'Dup' });

    const mailbox = await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`);
    const token = extractToken(mailbox.body.messages[0].body);

    const first = await request(app).post('/auth/magic/verify').send({ token });
    expect(first.status).toBe(200);

    const second = await request(app).post('/auth/magic/verify').send({ token });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_or_expired_token');
  });

  it('returning-partner /auth/signin emails a signin link when the partner is activated', async () => {
    // Invite + verify to activate.
    await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'return@example.com', name: 'Return' });
    let mailbox = await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`);
    const inviteToken = extractToken(mailbox.body.messages[0].body);
    await request(app).post('/auth/magic/verify').send({ token: inviteToken });

    // Clear so we can spot the signin email specifically.
    await db(TABLES.DevMessage).del();

    const signin = await request(app).post('/auth/signin').send({ email: 'return@example.com' });
    expect(signin.status).toBe(200);

    mailbox = await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`);
    const signinMsg = mailbox.body.messages.find(
      (m: { metadata?: { purpose?: string } }) => m.metadata?.purpose === 'partner_signin',
    );
    expect(signinMsg).toBeDefined();

    const signinToken = extractToken(signinMsg.body);
    const verify = await request(app).post('/auth/magic/verify').send({ token: signinToken });
    expect(verify.status).toBe(200);
  });

  it('signin for an unknown email silently returns ok (no user enumeration)', async () => {
    await db(TABLES.DevMessage).del();
    const res = await request(app).post('/auth/signin').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const mailbox = await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(mailbox.body.messages.length).toBe(0);
  });

  it('resend invite generates a fresh token and 409s once the partner is already activated', async () => {
    const created = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'resend@example.com', name: 'Resend' });
    const partnerId = created.body.id;

    const resend = await request(app)
      .post(`/partners/${partnerId}/invite`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(resend.status).toBe(200);

    // Two invite emails in the mailbox now.
    const mailbox = await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`);
    const invites = mailbox.body.messages.filter(
      (m: { to: string; metadata?: { purpose?: string } }) =>
        m.to === 'resend@example.com' && m.metadata?.purpose === 'partner_invite',
    );
    expect(invites.length).toBe(2);

    // Activate via the latest token, then resend should 409.
    const token = extractToken(invites[0].body);
    await request(app).post('/auth/magic/verify').send({ token });

    const after = await request(app)
      .post(`/partners/${partnerId}/invite`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(after.status).toBe(409);
    expect(after.body.error).toBe('already_activated');
  });
});
