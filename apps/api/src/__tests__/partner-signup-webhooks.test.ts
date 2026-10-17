/**
 * Join-page signups (POST /partner-signup) fire the partner webhooks.
 *
 * Before, a partner who joined through the public join page fired no
 * partner.created, and one approved automatically never fired
 * partner.activated either: they are active from the moment they apply,
 * and magic-link verify only fires it for a partner not yet active. Now:
 *   - every signup fires partner.created with source 'join_page';
 *   - auto-approve follows it straight away with partner.activated
 *     (invited: false, they haven't signed in);
 *   - an applicant held for review fires partner.activated (invited: true,
 *     source 'join_page') on their first sign-in after approval.
 *
 * dispatchEvent is mocked so the assertions read exact payloads. The
 * delivered shapes are checked against the catalogue by
 * openapi-contract.test.ts.
 *
 * Skipped if DATABASE_URL isn't set.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_signup_webhooks_0123456789abcdef0';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';
process.env.PORTAL_URL = 'http://localhost:5673';

vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn() };
});

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { __setMailerForTests } = await import('../mailer.js');
const { dispatchEvent } = await import('../webhook-dispatcher.js');
type Mailer = import('../mailer.js').Mailer;
type Message = import('../mailer.js').Message;

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

// Children before Partner so FK constraints don't fire.
const TABLES_TO_CLEAN = [
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.NetworkOutbox,
  TABLES.PartnerNetworkConsent,
  TABLES.Coupon,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.Partner,
];
const CONFIG_KEYS = ['partner_signup', 'network_membership'];

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

async function setPolicy(policy: 'auto_approve' | 'require_review'): Promise<void> {
  await db(TABLES.Config)
    .insert({ tenantId: DEFAULT_TENANT_ID, key: 'partner_signup', value: { policy } as unknown as never, updatedAt: new Date() })
    .onConflict(['tenantId', 'key'])
    .merge({ value: { policy } as unknown as never, updatedAt: new Date() });
}

const APPLICATION = {
  websiteUrl: 'https://creator.example',
  socialUrls: ['https://instagram.com/creator'],
  audienceSize: '1k_10k',
  pitch: 'I run a weekly newsletter for designers and would feature the product in a deep-dive issue.',
};

function signup(email: string) {
  return request(app).post('/partner-signup').send({ email, name: 'Creator', application: APPLICATION });
}

function dispatched(event: string): Array<Record<string, unknown>> {
  return vi
    .mocked(dispatchEvent)
    .mock.calls.filter(([, e]) => e === event)
    .map(([, , payload]) => payload as Record<string, unknown>);
}

function linkIn(msg: Message | undefined): string {
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

describe.skipIf(skipIntegration)('join-page signups fire the partner webhooks', () => {
  it('auto-approve: partner.created, then partner.activated with invited: false, both source join_page', async () => {
    await setPolicy('auto_approve');
    const res = await signup('creator@x.test');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    const partner = await db(TABLES.Partner).where({ id: res.body.partnerId }).first();
    const activatedAt = (partner.activatedAt as Date).toISOString();

    expect(dispatched('partner.created')).toEqual([
      {
        partnerId: partner.id,
        email: 'creator@x.test',
        name: 'Creator',
        activatedAt,
        // The signup emailed them a sign-in link.
        invited: true,
        portalAccess: true,
        programIds: [],
        source: 'join_page',
      },
    ]);
    expect(dispatched('partner.activated')).toEqual([
      { partnerId: partner.id, email: 'creator@x.test', name: 'Creator', activatedAt, invited: false, source: 'join_page' },
    ]);
    const order = vi.mocked(dispatchEvent).mock.calls.map(([, e]) => e);
    expect(order).toEqual(['partner.created', 'partner.activated']);

    // Signing in with the emailed link doesn't fire it again.
    const invite = mailer.to('creator@x.test').find((m) => m.metadata?.purpose === 'partner_invite');
    expect((await request(app).post('/auth/magic/verify').send({ token: linkIn(invite) })).status).toBe(200);
    expect(dispatched('partner.activated')).toHaveLength(1);
  });

  it('review: partner.created on applying, partner.activated (invited: true) on the first sign-in after approval', async () => {
    await setPolicy('require_review');
    const res = await signup('applicant@x.test');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_review');

    expect(dispatched('partner.created')).toEqual([
      {
        partnerId: res.body.partnerId,
        email: 'applicant@x.test',
        name: 'Creator',
        activatedAt: null,
        // No link until an admin approves them.
        invited: false,
        portalAccess: true,
        programIds: [],
        source: 'join_page',
      },
    ]);
    expect(dispatched('partner.activated')).toEqual([]);

    // Approval sends the link but activates nothing yet.
    const approve = await request(app).post(`/partners/${res.body.partnerId}/invite`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(approve.status).toBe(200);
    expect(dispatched('partner.activated')).toEqual([]);
    expect(dispatched('partner.created')).toHaveLength(1);

    const invite = mailer.to('applicant@x.test').find((m) => m.metadata?.purpose === 'partner_invite');
    expect((await request(app).post('/auth/magic/verify').send({ token: linkIn(invite) })).status).toBe(200);
    expect(dispatched('partner.activated')).toEqual([
      {
        partnerId: res.body.partnerId,
        email: 'applicant@x.test',
        name: 'Creator',
        activatedAt: expect.any(String),
        invited: true,
        source: 'join_page',
      },
    ]);
  });

  it('fires before the email, so a mail failure still reports the partner', async () => {
    await setPolicy('auto_approve');
    __setMailerForTests({
      async send() {
        throw new Error('smtp down');
      },
    });
    const res = await signup('creator@x.test');
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('active_pending_email');
    expect(dispatched('partner.created')).toEqual([expect.objectContaining({ partnerId: res.body.partnerId, source: 'join_page' })]);
    expect(dispatched('partner.activated')).toEqual([expect.objectContaining({ partnerId: res.body.partnerId, source: 'join_page' })]);
  });

  it('an email that is already registered fires nothing', async () => {
    await setPolicy('auto_approve');
    expect((await signup('creator@x.test')).status).toBe(201);
    vi.mocked(dispatchEvent).mockClear();

    const again = await signup('creator@x.test');
    expect(again.body).toEqual({ ok: true, status: 'already_registered' });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
