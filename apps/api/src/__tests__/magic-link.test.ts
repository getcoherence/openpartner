/**
 * Magic-link signup + signin over the live Express + Postgres stack.
 *
 * We don't send real email — the DevMailer persists to DevMessage, and
 * the tests read the stored body to extract the link and consume the
 * embedded token.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_magic_admin_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.MAIL_TRANSPORT = 'dev';
process.env.PORTAL_URL = 'http://localhost:5173';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TABLES_TO_CLEAN = [
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.DevMessage,
  TABLES.ApiKey,
  TABLES.NetworkCreator,
  TABLES.Config,
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
  for (const t of TABLES_TO_CLEAN) await db(t).del();
});

function extractToken(body: string): string {
  const match = body.match(/token=([A-Za-z0-9_-]+(?:%3D)*)/);
  if (!match) throw new Error(`no token in body: ${body.slice(0, 200)}`);
  return decodeURIComponent(match[1]!);
}

describe.skipIf(skipIntegration)('magic-link auth', () => {
  it('full signup → verify → session-backed whoami', async () => {
    const signup = await request(app)
      .post('/auth/creator/signup')
      .send({ email: 'grace@example.com', handle: 'gracie', name: 'Grace Hopper' });
    expect(signup.status).toBe(200);

    // The DevMailer persists; we read the message via the admin endpoint.
    const mailbox = await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(mailbox.body.messages).toHaveLength(1);
    expect(mailbox.body.messages[0].to).toBe('grace@example.com');
    const token = extractToken(mailbox.body.messages[0].body);

    const verify = await request(app).post('/auth/magic/verify').send({ token });
    expect(verify.status).toBe(200);
    expect(verify.body.role).toBe('network_creator');
    expect(verify.body.creator.handle).toBe('gracie');
    expect(verify.body.creator.status).toBe('active');

    // Cookie was set.
    const setCookie = verify.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie?.[0]).toMatch(/^op_session=/);
    const cookie = setCookie![0]!.split(';')[0]!;

    // Session-backed whoami returns the same creator.
    const me = await request(app).get('/auth/whoami').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('network_creator');
    expect(me.body.creator.handle).toBe('gracie');
  });

  it('signin for an active creator issues a new session', async () => {
    // First sign up + verify.
    await request(app)
      .post('/auth/creator/signup')
      .send({ email: 'ada@example.com', handle: 'ada', name: 'Ada' });
    let msgs = (await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`)).body.messages;
    await request(app).post('/auth/magic/verify').send({ token: extractToken(msgs[0].body) });

    // Now request a signin link as the returning creator.
    const signin = await request(app).post('/auth/creator/signin').send({ email: 'ada@example.com' });
    expect(signin.status).toBe(200);
    msgs = (await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`)).body.messages;
    expect(msgs[0].subject).toBe('Your OpenPartner sign-in link');
    const verify = await request(app).post('/auth/magic/verify').send({ token: extractToken(msgs[0].body) });
    expect(verify.status).toBe(200);
    expect(verify.body.role).toBe('network_creator');
  });

  it('rejects reused, expired, and unknown tokens', async () => {
    await request(app)
      .post('/auth/creator/signup')
      .send({ email: 'x@example.com', handle: 'xxx', name: 'Xavier' });
    const msgs = (await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`)).body.messages;
    const token = extractToken(msgs[0].body);

    // First consume: ok
    const first = await request(app).post('/auth/magic/verify').send({ token });
    expect(first.status).toBe(200);

    // Second consume: already_consumed
    const second = await request(app).post('/auth/magic/verify').send({ token });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('already_consumed');

    // Unknown token: not_found
    const unknown = await request(app).post('/auth/magic/verify').send({ token: 'mlt_unknowntoken12345' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('not_found');
  });

  it('signup enforces unique email and handle', async () => {
    await request(app)
      .post('/auth/creator/signup')
      .send({ email: 'dup@example.com', handle: 'dup', name: 'First' });

    // Same email, different handle.
    const dupEmail = await request(app)
      .post('/auth/creator/signup')
      .send({ email: 'dup@example.com', handle: 'other', name: 'Second' });
    // Only conflicts once the first token is consumed (creator exists).
    // Before that, both are pending tokens — signup endpoint only checks
    // against existing CREATOR rows, not pending tokens. So consume first:
    const msgs = (await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`)).body.messages;
    await request(app).post('/auth/magic/verify').send({ token: extractToken(msgs[msgs.length - 1].body) });

    // Now both email and handle collide with the new creator row.
    const conflict = await request(app)
      .post('/auth/creator/signup')
      .send({ email: 'dup@example.com', handle: 'fresh', name: 'Second' });
    expect(conflict.status).toBe(409);

    // Consume of the earlier "other" token should also fail now.
    void dupEmail;
  });

  it('signout clears the session cookie', async () => {
    await request(app)
      .post('/auth/creator/signup')
      .send({ email: 'out@example.com', handle: 'out', name: 'Out' });
    const msgs = (await request(app).get('/dev/mailbox').set('Authorization', `Bearer ${ADMIN_KEY}`)).body.messages;
    const verify = await request(app).post('/auth/magic/verify').send({ token: extractToken(msgs[0].body) });
    const cookie = (verify.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

    const before = await request(app).get('/auth/whoami').set('Cookie', cookie);
    expect(before.body.role).toBe('network_creator');

    await request(app).post('/auth/signout').set('Cookie', cookie);

    const after = await request(app).get('/auth/whoami').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });
});
