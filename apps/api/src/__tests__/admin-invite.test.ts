/**
 * Admin persona flow: first-run install, admin-to-admin invite, revoke
 * guardrails. Uses a capturing mailer so we can read the magic-link
 * URLs without Postmark.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { __setMailerForTests, type Mailer, type Message } from '../mailer.js';

const ADMIN_KEY = 'op_test_admin_persona_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.OPENPARTNER_TENANCY = 'single';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

// Order matters: child tables before Partner / Admin so FK constraints
// don't fire when wiping rows another test file may have left behind.
const TABLES_TO_CLEAN = [
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.ApiKey,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.Payout,
  TABLES.Program,
  TABLES.Partner,
  TABLES.Admin,
  TABLES.Config,
];

const app = createApp({ enableLogger: false });

class CapturingMailer implements Mailer {
  readonly sent: Message[] = [];
  async send(_ctx: unknown, msg: Message): Promise<void> {
    this.sent.push(msg);
  }
  findFor(to: string, purpose?: string): Message | undefined {
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

describe.skipIf(skipIntegration)('admin personas', () => {
  it('install → first admin accepts → program settings persisted', async () => {
    // Status probe reports needsSetup=true with zero admins.
    const status = await request(app).get('/install/status');
    expect(status.status).toBe(200);
    expect(status.body.needsSetup).toBe(true);

    const setup = await request(app).post('/install').send({
      adminName: 'Ada Admin',
      adminEmail: 'ada@example.com',
      programName: 'Acme Partners',
      supportEmail: 'support@acme.com',
    });
    expect(setup.status).toBe(200);

    // Invite email landed.
    const invite = mailer.findFor('ada@example.com', 'admin_invite');
    expect(invite).toBeDefined();
    expect(invite!.subject).toContain('Acme Partners');

    // Activate.
    const token = extractToken(invite!.text);
    const verify = await request(app).post('/auth/magic/verify').send({ token });
    expect(verify.status).toBe(200);
    expect(verify.body.role).toBe('admin');
    expect(verify.body.admin.email).toBe('ada@example.com');
    const cookie = (verify.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

    // Status now reports installed.
    const statusAfter = await request(app).get('/install/status');
    expect(statusAfter.body.needsSetup).toBe(false);

    // /install 409s now — second installer can't take over.
    const second = await request(app).post('/install').send({
      adminName: 'Rogue',
      adminEmail: 'rogue@example.com',
      programName: 'Takeover',
    });
    expect(second.status).toBe(409);

    // Program settings were saved.
    const settings = await request(app).get('/config/program').set('Cookie', cookie);
    expect(settings.body.programName).toBe('Acme Partners');
    expect(settings.body.supportEmail).toBe('support@acme.com');

    // whoami via cookie resolves to admin with name.
    const who = await request(app).get('/auth/whoami').set('Cookie', cookie);
    expect(who.status).toBe(200);
    expect(who.body.role).toBe('admin');
    expect(who.body.admin.name).toBe('Ada Admin');
  });

  it('admin-to-admin invite + signin', async () => {
    // Bootstrap via env admin key (no install needed for this test).
    const create = await request(app)
      .post('/admins')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'two@example.com', name: 'Number Two' });
    expect(create.status).toBe(201);

    const invite = mailer.findFor('two@example.com', 'admin_invite');
    expect(invite).toBeDefined();

    const token = extractToken(invite!.text);
    const verify = await request(app).post('/auth/magic/verify').send({ token });
    expect(verify.status).toBe(200);
    expect(verify.body.admin.name).toBe('Number Two');

    // Returning signin sends an admin_signin email (not partner_signin).
    mailer.sent.length = 0;
    const signin = await request(app).post('/auth/signin').send({ email: 'two@example.com' });
    expect(signin.status).toBe(200);
    const signinMsg = mailer.findFor('two@example.com', 'admin_signin');
    expect(signinMsg).toBeDefined();
  });

  it('cannot revoke the last active admin', async () => {
    const create = await request(app)
      .post('/admins')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'lone@example.com', name: 'Lone' });
    const token = extractToken(mailer.findFor('lone@example.com')!.text);
    await request(app).post('/auth/magic/verify').send({ token });

    const res = await request(app)
      .post(`/admins/${create.body.id}/revoke`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_revoke_last_active_admin');
  });

  it('duplicate email → 409 email_taken', async () => {
    await request(app)
      .post('/admins')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'dup@example.com', name: 'First' });

    const dupe = await request(app)
      .post('/admins')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'dup@example.com', name: 'Second' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error).toBe('email_taken');
  });
});
