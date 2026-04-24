/**
 * Partner invite + magic-link signin happy paths.
 *
 * Uses an in-memory capturing mailer injected via __setMailerForTests so
 * the suite can read the magic-link URL without hitting Postmark.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { __setMailerForTests, type Mailer, type Message } from '../mailer.js';

const ADMIN_KEY = 'op_test_invite_admin_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.PORTAL_URL = 'http://localhost:5673';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const TABLES_TO_CLEAN = [
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.ApiKey,
  TABLES.Partner,
];

const app = createApp({ enableLogger: false });

class CapturingMailer implements Mailer {
  readonly sent: Message[] = [];
  async send(msg: Message): Promise<void> {
    this.sent.push(msg);
  }
  findFor(to: string, purpose?: string): Message | undefined {
    // Matches either metadata.purpose or tag — the /auth/signin path
    // for revoked partners sets purpose to
    // 'partner_revoked_signin_attempt' but keeps tag='partner_revoked'.
    return this.sent.find(
      (m) =>
        m.to === to &&
        (purpose == null || m.metadata?.purpose === purpose || m.tag === purpose),
    );
  }
}

let mailer: CapturingMailer;

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

beforeEach(async () => {
  mailer = new CapturingMailer();
  __setMailerForTests(mailer);
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) {
    await db(t).del();
  }
});

afterEach(() => {
  __setMailerForTests(null);
});

afterAll(async () => {
  await db.destroy();
});

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

    expect(created.body).not.toHaveProperty('plaintext');
    expect(created.body).not.toHaveProperty('apiKey');

    const invite = mailer.findFor('gracie@example.com', 'partner_invite');
    expect(invite).toBeDefined();

    const token = extractToken(invite!.text);
    const verify = await request(app).post('/auth/magic/verify').send({ token });
    expect(verify.status).toBe(200);
    expect(verify.body.role).toBe('partner');
    expect(verify.body.partner.email).toBe('gracie@example.com');

    const setCookie = verify.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie).toBeTruthy();
    const cookie = setCookie![0]!.split(';')[0]!;
    expect(cookie.startsWith('op_session=')).toBe(true);

    const activated = await db(TABLES.Partner).where({ id: created.body.id }).first();
    expect((activated as { activatedAt: Date | null }).activatedAt).not.toBeNull();

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

    const token = extractToken(mailer.findFor('dup@example.com')!.text);

    const first = await request(app).post('/auth/magic/verify').send({ token });
    expect(first.status).toBe(200);

    const second = await request(app).post('/auth/magic/verify').send({ token });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_or_expired_token');
  });

  it('returning-partner /auth/signin emails a signin link when the partner is activated', async () => {
    await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'return@example.com', name: 'Return' });
    const inviteToken = extractToken(mailer.findFor('return@example.com', 'partner_invite')!.text);
    await request(app).post('/auth/magic/verify').send({ token: inviteToken });

    mailer.sent.length = 0;

    const signin = await request(app).post('/auth/signin').send({ email: 'return@example.com' });
    expect(signin.status).toBe(200);

    const signinMsg = mailer.findFor('return@example.com', 'partner_signin');
    expect(signinMsg).toBeDefined();

    const signinToken = extractToken(signinMsg!.text);
    const verify = await request(app).post('/auth/magic/verify').send({ token: signinToken });
    expect(verify.status).toBe(200);
  });

  it('signin for an unknown email silently returns ok (no user enumeration)', async () => {
    const res = await request(app).post('/auth/signin').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mailer.sent.length).toBe(0);
  });

  it('admin can revoke an active partner — sessions die, reinstate undoes it', async () => {
    // Invite + activate.
    const created = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'rev@example.com', name: 'Rev' });
    const partnerId = created.body.id;
    const token = extractToken(mailer.findFor('rev@example.com', 'partner_invite')!.text);
    const verify = await request(app).post('/auth/magic/verify').send({ token });
    const cookie = (verify.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

    const before = await request(app).get('/auth/whoami').set('Cookie', cookie);
    expect(before.status).toBe(200);

    mailer.sent.length = 0;
    const revoke = await request(app)
      .post(`/partners/${partnerId}/revoke`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ reason: 'Ending our partnership — thanks for your work' });
    expect(revoke.status).toBe(200);
    expect(revoke.body.notified).toBe(true);

    // Notification email fired with the reason in the body.
    const notice = mailer.findFor('rev@example.com', 'partner_revoked');
    expect(notice).toBeDefined();
    expect(notice!.text).toContain('suspended');
    expect(notice!.text).toContain('Ending our partnership');

    // Session killed.
    const after = await request(app).get('/auth/whoami').set('Cookie', cookie);
    expect(after.status).toBe(401);

    // Second revoke → 409.
    const dupe = await request(app)
      .post(`/partners/${partnerId}/revoke`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(dupe.status).toBe(409);

    // Reinstate + sign-in works again.
    const reinstate = await request(app)
      .post(`/partners/${partnerId}/reinstate`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(reinstate.status).toBe(200);

    mailer.sent.length = 0;
    const signin = await request(app).post('/auth/signin').send({ email: 'rev@example.com' });
    expect(signin.status).toBe(200);
    expect(mailer.findFor('rev@example.com', 'partner_signin')).toBeDefined();
  });

  it('revoke with notify=false does not email the partner', async () => {
    const created = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'silent@example.com', name: 'Silent' });
    const partnerId = created.body.id;
    const token = extractToken(mailer.findFor('silent@example.com')!.text);
    await request(app).post('/auth/magic/verify').send({ token });

    mailer.sent.length = 0;
    const revoke = await request(app)
      .post(`/partners/${partnerId}/revoke`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ notify: false, reason: 'Investigating fraud' });
    expect(revoke.status).toBe(200);
    expect(revoke.body.notified).toBe(false);
    expect(mailer.sent.length).toBe(0);
  });

  it('signin for a revoked partner sends the suspension notice, not a magic link', async () => {
    // Invite + activate + revoke.
    const created = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'after@example.com', name: 'After' });
    const token = extractToken(mailer.findFor('after@example.com')!.text);
    await request(app).post('/auth/magic/verify').send({ token });
    await request(app)
      .post(`/partners/${created.body.id}/revoke`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ reason: 'Program closed', notify: false });

    mailer.sent.length = 0;
    const signin = await request(app).post('/auth/signin').send({ email: 'after@example.com' });
    expect(signin.status).toBe(200);
    expect(signin.body.ok).toBe(true);

    // Partner gets the suspension notice (with reason), not a signin link.
    const notice = mailer.findFor('after@example.com', 'partner_revoked');
    expect(notice).toBeDefined();
    expect(notice!.text).toContain('Program closed');
    expect(mailer.findFor('after@example.com', 'partner_signin')).toBeUndefined();
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

    const invites = mailer.sent.filter(
      (m) => m.to === 'resend@example.com' && m.metadata?.purpose === 'partner_invite',
    );
    expect(invites.length).toBe(2);

    // Activate via the first token, then resend should 409.
    const token = extractToken(invites[0]!.text);
    await request(app).post('/auth/magic/verify').send({ token });

    const after = await request(app)
      .post(`/partners/${partnerId}/invite`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(after.status).toBe(409);
    expect(after.body.error).toBe('already_activated');
  });
});
