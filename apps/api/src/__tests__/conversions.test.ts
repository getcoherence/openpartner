/**
 * One-call conversion reporting.
 *
 * A lender reporting a funded loan, or a CRM, holds the click id the
 * destination URL handed it but never saw an identify(). Before this it had
 * to call /attribution/identify and then /attribution/events. These lock in:
 *
 * POST /attribution/conversions
 *   - stitches the click (to the caller's userId, or the click's own
 *     synthetic user) and records + attributes the event in one call
 *   - the click must exist in this tenant and not be fraud-flagged
 *   - idempotent on externalEventId (required), sharing the per-tenant key
 *     namespace with /attribution/events; a retry replays, a reused key 409s
 *   - events:write scoped keys are enough
 *
 * GET /postback
 *   - authenticated by the tenant's conversion postback token only, never an
 *     API key, and the token authenticates nothing else
 *   - optional IP allowlist; rotation and revocation kill the old URL
 *   - tiny 200 (or a pixel), HEAD records nothing, the token never reaches
 *     the request log
 */

import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { clickUserId } from '../conversion-ingest.js';
import { ipAllowed, rotatePostbackToken, verifyPostbackToken } from '../conversion-postback.js';
import { POSTBACK_BODIES, postbackBody, type ConversionOutcome } from '../routes/conversions.js';

const ADMIN_KEY = 'op_test_conversions_0123456789abcdef012345';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const OTHER_TENANT_ID = '01J000000CONVERSIONSOTHER0';

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.Payout,
  TABLES.WebhookDelivery,
  TABLES.WebhookEndpoint,
  TABLES.ApiKey,
  TABLES.ConversionPostbackToken,
  TABLES.PartnerCommission,
  TABLES.Partner,
  TABLES.Config,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await db(TABLES.Tenant)
    .insert({ id: OTHER_TENANT_ID, slug: 'conversions-other', displayName: 'Other brand', status: 'active' })
    .onConflict('id')
    .ignore();
});

afterAll(async () => {
  if (!skipIntegration) {
    // Leave nothing behind: a later file that deletes Partner without
    // knowing about Link would trip over this file's last links.
    for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
    for (const t of [TABLES.Event, TABLES.Click, TABLES.Link, TABLES.Program, TABLES.Partner]) {
      await db(t).where({ tenantId: OTHER_TENANT_ID }).del();
    }
    await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
});

describe.skipIf(skipIntegration)('POST /attribution/conversions', () => {
  it('stitches the click to its own user and records + attributes the conversion in one call', async () => {
    const { clickId, partnerId } = await seedClick();

    const res = await postConversion({
      clickId,
      type: 'loan_funded',
      value: 5000,
      currency: 'usd',
      externalEventId: 'loan-881:funded',
      metadata: { loanId: 'loan-881' },
    });

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBeUndefined();
    expect(res.body.userId).toBe(clickUserId(clickId));
    expect(res.body.attribution.status).toBe('attributed');
    expect(res.body.attribution.touches).toHaveLength(1);
    expect(res.body.attribution.touches[0]).toMatchObject({ clickId, partnerId, weight: 1 });

    const identity = await db(TABLES.Identity).where({ clickId, userId: clickUserId(clickId) }).first();
    expect(identity?.tenantId).toBe(DEFAULT_TENANT_ID);
    const event = await db(TABLES.Event).where({ id: res.body.eventId }).first();
    expect(event).toMatchObject({
      type: 'loan_funded',
      value: '5000.00',
      currency: 'USD',
      externalEventId: 'loan-881:funded',
      metadata: { loanId: 'loan-881' },
    });
    const commissions = await commissionsFor(res.body.eventId);
    expect(commissions.map((c) => c.amount)).toEqual(['500.00']);
  });

  it("stitches the caller's own userId when given, so later /attribution/events for it attribute too", async () => {
    const { clickId, partnerId } = await seedClick();
    const userId = `lead-${ulid()}`;

    const res = await postConversion({ clickId, userId, type: 'application_submitted', externalEventId: `app-${ulid()}` });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(userId);
    expect(await db(TABLES.Identity).where({ clickId, userId }).first()).toBeTruthy();

    const later = await request(app)
      .post('/attribution/events')
      .set(admin)
      .send({ userId, type: 'loan_funded', value: 1000, externalEventId: `fund-${ulid()}` });
    expect(later.body.attribution.status).toBe('attributed');
    expect(later.body.attribution.touches[0].partnerId).toBe(partnerId);
  });

  it('every conversion for a click lands on the one synthetic user (first-only rules fire once)', async () => {
    const { clickId } = await seedClick({
      commissionRule: [{ trigger: 'first', eventType: 'loan_funded', type: 'fixed', value: 250 }],
    });
    const ts = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
    const a = await postConversion({ clickId, type: 'loan_funded', value: 1000, externalEventId: `a-${ulid()}`, ts: ts(2000) });
    const b = await postConversion({ clickId, type: 'loan_funded', value: 2000, externalEventId: `b-${ulid()}`, ts: ts(1000) });
    expect(a.body.userId).toBe(b.body.userId);
    expect((await commissionsFor(a.body.eventId)).map((c) => c.amount)).toEqual(['250.00']);
    expect(await commissionsFor(b.body.eventId)).toHaveLength(0);
    expect(await db(TABLES.Identity).where({ clickId })).toHaveLength(1);
  });

  it('a retry replays the original result and commissions once', async () => {
    const { clickId } = await seedClick();
    const body = { clickId, type: 'loan_funded', value: 5000, externalEventId: `loan-${ulid()}` };

    const first = await postConversion(body);
    const retry = await postConversion(body);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, replayed: true, eventId: first.body.eventId, userId: first.body.userId });
    expect(retry.body.attribution).toEqual(first.body.attribution);
    await expectRowCounts(body.externalEventId, { events: 1, attributions: 1, commissions: 1 });
  });

  it('a burst of concurrent duplicates records and commissions exactly once', async () => {
    const { clickId } = await seedClick();
    const body = { clickId, type: 'loan_funded', value: 5000, externalEventId: `loan-${ulid()}` };

    const responses = await Promise.all(Array.from({ length: 5 }, () => postConversion(body).then((r) => r)));
    for (const r of responses) expect(r.status).toBe(200);
    expect(new Set(responses.map((r) => r.body.eventId)).size).toBe(1);
    expect(responses.filter((r) => !r.body.replayed)).toHaveLength(1);
    await expectRowCounts(body.externalEventId, { events: 1, attributions: 1, commissions: 1 });
    expect(await db(TABLES.Identity).where({ clickId })).toHaveLength(1);
  }, 20_000);

  it('reusing a key for another click or another conversion is a 409, and stitches nothing', async () => {
    const { clickId } = await seedClick();
    const other = await seedClick();
    const externalEventId = `loan-${ulid()}`;
    const first = await postConversion({ clickId, type: 'loan_funded', value: 5000, externalEventId });

    for (const changed of [
      { clickId: other.clickId, type: 'loan_funded', value: 5000, externalEventId },
      { clickId, type: 'loan_funded', value: 6000, externalEventId },
      { clickId, userId: `u-${ulid()}`, type: 'loan_funded', value: 5000, externalEventId },
    ]) {
      const res = await postConversion(changed);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'external_event_id_conflict', eventId: first.body.eventId });
    }
    expect(await db(TABLES.Identity).where({ clickId: other.clickId })).toHaveLength(0);
  });

  it('shares the key namespace with /attribution/events', async () => {
    const { clickId } = await seedClick();
    const externalEventId = `in_${ulid()}`;
    await request(app).post('/attribution/events').set(admin).send({ userId: 'someone', type: 'invoice_paid', value: 10, externalEventId });

    const res = await postConversion({ clickId, type: 'invoice_paid', value: 10, externalEventId });
    expect(res.status).toBe(409);
  });

  it("404s a click that doesn't exist, or belongs to another tenant", async () => {
    const missing = await postConversion({ clickId: ulid(), type: 'loan_funded', externalEventId: `x-${ulid()}` });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'click_not_found', detail: 'No click with this id in this tenant.' });

    const foreign = await seedClick({ tenantId: OTHER_TENANT_ID });
    const res = await postConversion({ clickId: foreign.clickId, type: 'loan_funded', externalEventId: `x-${ulid()}` });
    expect(res.status).toBe(404);
    expect(await db(TABLES.Identity).where({ clickId: foreign.clickId })).toHaveLength(0);
    expect(await db(TABLES.Event).where({ tenantId: DEFAULT_TENANT_ID })).toHaveLength(0);
  });

  it('refuses a fraud-flagged click and records nothing; a retry of an earlier success still replays', async () => {
    const flagged = await seedClick({ fraudFlag: 'velocity' });
    const res = await postConversion({ clickId: flagged.clickId, type: 'loan_funded', externalEventId: `x-${ulid()}` });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'click_flagged', fraudFlag: 'velocity' });
    expect(await db(TABLES.Identity).where({ clickId: flagged.clickId })).toHaveLength(0);
    expect(await db(TABLES.Event).where({ tenantId: DEFAULT_TENANT_ID })).toHaveLength(0);

    const { clickId } = await seedClick();
    const body = { clickId, type: 'loan_funded', value: 100, externalEventId: `x-${ulid()}` };
    const first = await postConversion(body);
    await db(TABLES.Click).where({ id: clickId }).update({ fraudFlag: 'velocity' });
    const retry = await postConversion(body);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ replayed: true, eventId: first.body.eventId });
  });

  it('requires externalEventId (a numeric id is its string) and validates the body', async () => {
    const { clickId } = await seedClick();
    expect((await postConversion({ clickId, type: 'loan_funded' })).status).toBe(400);
    expect((await postConversion({ clickId, type: 'loan_funded', externalEventId: '' })).status).toBe(400);
    expect((await postConversion({ clickId, type: 'loan_funded', value: -1, externalEventId: 'x' })).status).toBe(400);

    const numeric = await postConversion({ clickId, type: 'loan_funded', externalEventId: 7001 });
    const asString = await postConversion({ clickId, type: 'loan_funded', externalEventId: '7001' });
    expect(numeric.status).toBe(200);
    expect(asString.body).toMatchObject({ replayed: true, eventId: numeric.body.eventId });
  });

  it('accepts an events:write scoped key; refuses a key without it and a partner key', async () => {
    const { clickId, partnerId } = await seedClick();
    const scoped = await mintScopedKey(['events:write']);
    const ok = await request(app)
      .post('/attribution/conversions')
      .set('Authorization', `Bearer ${scoped}`)
      .send({ clickId, type: 'loan_funded', externalEventId: `x-${ulid()}` });
    expect(ok.status).toBe(200);

    const wrongScope = await mintScopedKey(['partners:read']);
    const denied = await request(app)
      .post('/attribution/conversions')
      .set('Authorization', `Bearer ${wrongScope}`)
      .send({ clickId, type: 'loan_funded', externalEventId: `x-${ulid()}` });
    expect(denied.status).toBe(403);

    const partnerKey = await request(app).post(`/partners/${partnerId}/api-keys`).set(admin).send({});
    const asPartner = await request(app)
      .post('/attribution/conversions')
      .set('Authorization', `Bearer ${partnerKey.body.plaintext}`)
      .send({ clickId, type: 'loan_funded', externalEventId: `x-${ulid()}` });
    expect(asPartner.status).toBe(403);
  });
});

// The request names no program: the click does. A tenant's keys (and its
// postback token) report for every program in it, as documented.
describe.skipIf(skipIntegration)('conversions are scoped to the tenant, not a program', () => {
  it("credits a click from any of the tenant's programs, to that click's program", async () => {
    const shop = await seedClick({ programName: 'Shop' });
    const loans = await seedClick({ programName: 'Loans', commissionRule: [{ trigger: 'every', type: 'fixed', value: 40 }] });

    for (const click of [shop, loans]) {
      const res = await postConversion({ clickId: click.clickId, type: 'sale', value: 100, externalEventId: `s-${ulid()}` });
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('attributed');
      const attribution = await db(TABLES.Attribution).where({ eventId: res.body.eventId }).first();
      expect(attribution).toMatchObject({ programId: click.programId, partnerId: click.partnerId });
    }
  });
});

describe.skipIf(skipIntegration)('the response says what the conversion came to', () => {
  const STAGES = [
    { trigger: 'every', eventType: 'approved', type: 'fixed', value: 25 },
    { trigger: 'first', eventType: 'loan_funded', type: 'fixed', value: 400 },
  ];

  it('attributed: credited and earning', async () => {
    const { clickId } = await seedClick({ commissionRule: STAGES });
    const res = await postConversion({ clickId, type: 'approved', externalEventId: `l-${ulid()}:approved` });
    expect(res.body).toMatchObject({ outcome: 'attributed', attribution: { status: 'attributed', commission: 'accrued' } });
    expect(res.body).not.toHaveProperty('reason');
  });

  it('no_matching_rule: a typo’d stage name is recorded and credited, and pays nothing', async () => {
    const { clickId } = await seedClick({ commissionRule: STAGES });
    const body = { clickId, type: 'funded', value: 5000, externalEventId: `l-${ulid()}:funded` };
    const res = await postConversion(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'no_matching_rule', attribution: { status: 'attributed', commission: 'no_matching_rule' } });
    expect(await commissionsFor(res.body.eventId)).toHaveLength(0);

    // A retry hears the same thing.
    const retry = await postConversion(body);
    expect(retry.body).toMatchObject({ replayed: true, outcome: 'no_matching_rule' });
  });

  it('attributed no_commission: the rule takes the type, but a first-only rule already paid', async () => {
    const { clickId } = await seedClick({ commissionRule: STAGES });
    await postConversion({ clickId, type: 'loan_funded', value: 5000, externalEventId: `l-${ulid()}:funded` });
    const second = await postConversion({ clickId, type: 'loan_funded', value: 5000, externalEventId: `l-${ulid()}:funded` });
    expect(second.body).toMatchObject({ outcome: 'attributed', reason: 'no_commission', attribution: { commission: 'none' } });
  });

  it('not_attributed outside_window: a click older than the program’s window', async () => {
    const { clickId } = await seedClick({ clickAgeMs: 90 * 24 * 60 * 60 * 1000 });
    const body = { clickId, type: 'sale', value: 10, externalEventId: `s-${ulid()}` };
    const res = await postConversion(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'not_attributed', reason: 'outside_window', attribution: { status: 'outside_window' } });

    // Which miss it was isn't stored, so a replay says only not_attributed.
    const retry = await postConversion(body);
    expect(retry.body.outcome).toBe('not_attributed');
    expect(retry.body).not.toHaveProperty('reason');
  });

  it('GET /postback answers the same words as text, still 200', async () => {
    const token = await mintPostbackToken();
    const fire = (clickId: string, type: string) =>
      request(app).get('/postback').query({ click_id: clickId, type, txn_id: `T-${ulid()}`, token });

    const staged = await seedClick({ commissionRule: STAGES });
    expect((await fire(staged.clickId, 'approved')).text).toBe('ok attributed');
    const typo = await fire(staged.clickId, 'funded');
    expect([typo.status, typo.text]).toEqual([200, 'ok no_matching_rule']);
    await fire(staged.clickId, 'loan_funded');
    expect((await fire(staged.clickId, 'loan_funded')).text).toBe('ok attributed no_commission');

    const old = await seedClick({ clickAgeMs: 90 * 24 * 60 * 60 * 1000 });
    const late = await fire(old.clickId, 'sale');
    expect([late.status, late.text]).toEqual([200, 'ok not_attributed outside_window']);

    const revoked = await seedClick();
    await db(TABLES.Partner).where({ id: revoked.partnerId }).update({ revokedAt: new Date() });
    expect((await fire(revoked.clickId, 'sale')).text).toBe('ok not_attributed no_click');
  });

  it('every outcome maps to a documented postback body', () => {
    const outcomes: ConversionOutcome[] = [
      { outcome: 'attributed' },
      { outcome: 'attributed', reason: 'no_commission' },
      { outcome: 'no_matching_rule' },
      { outcome: 'not_attributed' },
      { outcome: 'not_attributed', reason: 'outside_window' },
      { outcome: 'not_attributed', reason: 'no_click' },
      { outcome: 'not_attributed', reason: 'no_identity' },
      { outcome: 'not_attributed', reason: 'corrective' },
    ];
    expect(outcomes.map(postbackBody).sort()).toEqual([...POSTBACK_BODIES].sort());
  });
});

describe.skipIf(skipIntegration)('GET /attribution/unmatched-event-types', () => {
  it('lists recent credited types that no rule takes, and clears once a rule does', async () => {
    const { clickId, programId } = await seedClick({
      programName: 'Lender A',
      commissionRule: [{ trigger: 'every', eventType: 'loan_funded', type: 'fixed', value: 400 }],
    });
    await postConversion({ clickId, type: 'funded', externalEventId: `l-1:${ulid()}` });
    await postConversion({ clickId, type: 'funded', externalEventId: `l-2:${ulid()}` });
    await postConversion({ clickId, type: 'loan_funded', externalEventId: `l-3:${ulid()}` });
    // OpenPartner's own types are expected to go unpaid (a payments-only rule
    // pays nothing on signups), so they're not listed.
    await postConversion({ clickId, type: 'signup', externalEventId: `su:${ulid()}` });
    // A miss credits no partner, so it has no rule to be checked against.
    const old = await seedClick({ clickAgeMs: 90 * 24 * 60 * 60 * 1000 });
    await postConversion({ clickId: old.clickId, type: 'apporved', externalEventId: `o:${ulid()}` });

    const res = await request(app).get('/attribution/unmatched-event-types').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.eventTypes).toEqual([
      { type: 'funded', events: 2, lastSeenAt: expect.any(String), programs: [{ id: programId, name: 'Lender A' }] },
    ]);

    const fixed = await request(app)
      .patch(`/programs/${programId}`)
      .set(admin)
      .send({
        commissionRule: [
          { trigger: 'every', eventType: 'loan_funded', type: 'fixed', value: 400 },
          { trigger: 'every', eventType: 'funded', type: 'fixed', value: 400 },
        ],
      });
    expect(fixed.status).toBe(200);
    expect((await request(app).get('/attribution/unmatched-event-types').set(admin)).body.eventTypes).toEqual([]);
  });

  it("checks each partner's own terms: an override without the type lists it", async () => {
    const { clickId, partnerId, programId } = await seedClick({ commissionRule: [{ trigger: 'every', eventType: 'approved', type: 'fixed', value: 25 }] });
    const override = await request(app)
      .put(`/partners/${partnerId}/programs/${programId}/commission`)
      .set(admin)
      .send({ commissionType: 'fixed', commissionValue: 400, commissionRules: [{ trigger: 'every', eventType: 'loan_funded', type: 'fixed', value: 400 }] });
    expect(override.status).toBe(200);
    await postConversion({ clickId, type: 'approved', externalEventId: `a:${ulid()}` });
    const res = await request(app).get('/attribution/unmatched-event-types').set(admin);
    expect(res.body.eventTypes.map((t: { type: string }) => t.type)).toEqual(['approved']);
  });

  it('is admin-only', async () => {
    const key = await mintScopedKey(['events:write']);
    expect((await request(app).get('/attribution/unmatched-event-types').set({ Authorization: `Bearer ${key}` })).status).toBe(403);
  });
});

describe.skipIf(skipIntegration)('GET /postback', () => {
  it('a multi-tenant URL without /t/<slug> is a plain-text 400, not a 500', async () => {
    process.env.OPENPARTNER_TENANCY = 'multi';
    try {
      const res = await request(app).get('/postback').query({ token: 'opcp_whatever', click_id: 'c', type: 't', txn_id: 'x' });
      expect(res.status).toBe(400);
      expect(res.text).toBe('tenant_slug_missing');
      expect(res.headers['content-type']).toMatch(/text\/plain/);
    } finally {
      process.env.OPENPARTNER_TENANCY = 'single';
    }
  });

  it('records the conversion with the postback token and answers a tiny ok', async () => {
    const { clickId, partnerId } = await seedClick();
    const token = await mintPostbackToken();

    const res = await request(app).get('/postback').query({
      click_id: clickId,
      type: 'loan_funded',
      amount: '1250.50',
      currency: 'eur',
      txn_id: 'LN-5521',
      token,
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok attributed');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['cache-control']).toBe('no-store');

    const event = await db(TABLES.Event).where({ externalEventId: 'LN-5521' }).first();
    expect(event).toMatchObject({
      userId: clickUserId(clickId),
      type: 'loan_funded',
      value: '1250.50',
      currency: 'EUR',
      metadata: { source: 'postback' },
    });
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);

    const stamped = await db(TABLES.ConversionPostbackToken).whereNull('revokedAt').first();
    expect(stamped?.lastUsedAt).not.toBeNull();
  });

  it('answers a 1×1 GIF with &pixel=1, and accepts the common parameter aliases', async () => {
    const { clickId } = await seedClick();
    const token = await mintPostbackToken();
    const res = await request(app)
      .get('/postback')
      .query({ cref: clickId, type: 'sale', value: '20', transaction_id: 'T-1', token, pixel: '1' })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
    expect((res.body as Buffer).subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(await db(TABLES.Event).where({ externalEventId: 'T-1', value: '20.00' }).first()).toBeTruthy();
  });

  it('a repeated postback (same txn_id) records once', async () => {
    const { clickId } = await seedClick();
    const token = await mintPostbackToken();
    const query = { click_id: clickId, type: 'loan_funded', amount: '100', txn_id: `T-${ulid()}`, token };
    for (let i = 0; i < 3; i += 1) expect((await request(app).get('/postback').query(query)).status).toBe(200);
    await expectRowCounts(query.txn_id, { events: 1, attributions: 1, commissions: 1 });
  });

  it('refuses a missing, wrong, rotated, revoked or API-key token before reading anything else', async () => {
    const { clickId } = await seedClick();
    const query = { click_id: clickId, type: 'loan_funded', txn_id: `T-${ulid()}` };

    expect((await request(app).get('/postback').query(query)).status).toBe(401);
    expect((await request(app).get('/postback').query({ ...query, token: 'opcp_nope' })).status).toBe(401);
    // A full admin key is not a postback token.
    expect((await request(app).get('/postback').query({ ...query, token: ADMIN_KEY })).status).toBe(401);
    // Unauthenticated callers learn nothing about the parameters.
    const bare = await request(app).get('/postback').query({ token: 'opcp_nope' });
    expect(bare.status).toBe(401);

    const old = await mintPostbackToken();
    const current = await mintPostbackToken();
    expect(current).not.toBe(old);
    expect((await request(app).get('/postback').query({ ...query, token: old })).text).toBe('invalid_token');
    expect((await request(app).get('/postback').query({ ...query, token: current })).status).toBe(200);

    const off = await request(app).delete('/conversion-postback/token').set(admin);
    expect(off.body).toEqual({ ok: true, revoked: true });
    expect((await request(app).get('/postback').query({ ...query, token: current })).status).toBe(401);
    expect((await request(app).get('/conversion-postback').set(admin)).body).toEqual({ token: null });
  });

  it("a token is only valid at its own tenant's URL", async () => {
    const { plaintext } = await rotatePostbackToken(db, OTHER_TENANT_ID);
    try {
      expect(await verifyPostbackToken(db, OTHER_TENANT_ID, plaintext)).toBeTruthy();
      expect(await verifyPostbackToken(db, DEFAULT_TENANT_ID, plaintext)).toBeNull();
      const { clickId } = await seedClick();
      const res = await request(app).get('/postback').query({ click_id: clickId, type: 'sale', txn_id: 't', token: plaintext });
      expect(res.status).toBe(401);
    } finally {
      await db(TABLES.ConversionPostbackToken).where({ tenantId: OTHER_TENANT_ID }).del();
    }
  });

  it('the postback token authenticates nothing but /postback', async () => {
    const token = await mintPostbackToken();
    const res = await request(app).get('/partners').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    const conv = await request(app)
      .post('/attribution/conversions')
      .set('Authorization', `Bearer ${token}`)
      .send({ clickId: ulid(), type: 'x', externalEventId: 'x' });
    expect(conv.status).toBe(401);
  });

  it('enforces the IP allowlist (the client IP from the trusted proxy hop)', async () => {
    const { clickId } = await seedClick();
    const token = await mintPostbackToken(['203.0.113.0/24', '2001:db8::1']);
    const query = { click_id: clickId, type: 'loan_funded', txn_id: `T-${ulid()}`, token };

    const blocked = await request(app).get('/postback').set('X-Forwarded-For', '198.51.100.7').query(query);
    expect(blocked.status).toBe(403);
    expect(blocked.text).toBe('ip_not_allowed');
    expect(await db(TABLES.Event).where({ externalEventId: query.txn_id })).toHaveLength(0);

    const allowed = await request(app).get('/postback').set('X-Forwarded-For', '203.0.113.9').query(query);
    expect(allowed.status).toBe(200);

    // Clearing the list admits any source again.
    const patch = await request(app).patch('/conversion-postback').set(admin).send({ ipAllowlist: [] });
    expect(patch.body.token.ipAllowlist).toEqual([]);
    const anywhere = await request(app)
      .get('/postback')
      .set('X-Forwarded-For', '198.51.100.7')
      .query({ ...query, txn_id: `T-${ulid()}` });
    expect(anywhere.status).toBe(200);
  });

  it('ipAllowed matches IPv4-mapped IPv6, single addresses and ranges', () => {
    expect(ipAllowed([], undefined)).toBe(true);
    expect(ipAllowed(['203.0.113.0/24'], '::ffff:203.0.113.20')).toBe(true);
    expect(ipAllowed(['203.0.113.5'], '203.0.113.5')).toBe(true);
    expect(ipAllowed(['203.0.113.5'], '203.0.113.6')).toBe(false);
    expect(ipAllowed(['2001:db8::/32'], '2001:db8:0:0:0:0:0:9')).toBe(true);
    expect(ipAllowed(['203.0.113.0/24'], undefined)).toBe(false);
  });

  it('validates allowlist entries and carries the list over on rotation', async () => {
    const bad = await request(app)
      .post('/conversion-postback/token')
      .set(admin)
      .send({ ipAllowlist: ['203.0.113.0/24', 'not-an-ip', '2130706433'] });
    expect(bad.status).toBe(400);
    expect(bad.body.detail.fieldErrors.ipAllowlist[0]).toMatch(/not-an-ip, 2130706433/);

    await mintPostbackToken(['203.0.113.0/24']);
    const rotated = await request(app).post('/conversion-postback/token').set(admin).send({});
    expect(rotated.status).toBe(201);
    expect(rotated.body.token.ipAllowlist).toEqual(['203.0.113.0/24']);
    expect(rotated.body.plaintext).toMatch(/^opcp_[0-9a-f]{48}$/);

    const summary = await request(app).get('/conversion-postback').set(admin);
    expect(summary.body.token).toMatchObject({ prefix: rotated.body.plaintext.slice(0, 13), ipAllowlist: ['203.0.113.0/24'] });
    expect(JSON.stringify(summary.body)).not.toContain(rotated.body.plaintext);
    expect(summary.body.token.tokenHash).toBeUndefined();
    expect(await db(TABLES.ConversionPostbackToken).whereNull('revokedAt')).toHaveLength(1);
  });

  it('managing the token is admin-only', async () => {
    const scoped = await mintScopedKey(['events:write']);
    const res = await request(app).post('/conversion-postback/token').set('Authorization', `Bearer ${scoped}`).send({});
    expect(res.status).toBe(403);
  });

  it('answers parameter problems with a plain-text code, and records nothing', async () => {
    const { clickId } = await seedClick();
    const token = await mintPostbackToken();

    const missing = await request(app).get('/postback').query({ token, type: 'sale' });
    expect(missing.status).toBe(400);
    expect(missing.text).toBe('invalid_parameters: click_id, txn_id');

    const badAmount = await request(app).get('/postback').query({ token, click_id: clickId, type: 'sale', txn_id: 't', amount: '12,50' });
    expect(badAmount.text).toBe('invalid_parameters: amount');

    const repeated = await request(app).get(`/postback?token=${token}&click_id=${clickId}&type=a&type=b&txn_id=t`);
    expect(repeated.status).toBe(400);
    expect(repeated.text).toBe('repeated_parameter');

    const unknownClick = await request(app).get('/postback').query({ token, click_id: ulid(), type: 'sale', txn_id: 't' });
    expect(unknownClick.status).toBe(404);
    expect(unknownClick.text).toBe('click_not_found');

    // An unfilled amount macro is no amount, not zero.
    const blankAmount = await request(app).get('/postback').query({ token, click_id: clickId, type: 'sale', txn_id: 'blank', amount: '' });
    expect(blankAmount.status).toBe(200);
    expect((await db(TABLES.Event).where({ externalEventId: 'blank' }).first())?.value).toBeNull();
    expect(await db(TABLES.Event).where({ tenantId: DEFAULT_TENANT_ID })).toHaveLength(1);
  });

  it('a HEAD (link checkers) records nothing', async () => {
    const { clickId } = await seedClick();
    const token = await mintPostbackToken();
    const res = await request(app).head('/postback').query({ token, click_id: clickId, type: 'sale', txn_id: 'head' });
    expect(res.status).toBe(405);
    expect(await db(TABLES.Event).where({ externalEventId: 'head' })).toHaveLength(0);
  });

  it('the request log never sees the token (or an Authorization header)', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logged = createApp({ logDestination: sink });
    const { clickId } = await seedClick();
    const token = await mintPostbackToken();

    await request(logged).get('/postback').query({ click_id: clickId, type: 'sale', txn_id: 'logged', token });
    await request(logged).get('/conversion-postback').set(admin);
    await new Promise((r) => setImmediate(r));

    const log = lines.join('');
    expect(log).toContain('/postback?');
    expect(log).toContain('token=[REDACTED]');
    expect(log).not.toContain(token);
    expect(log).not.toContain(token.slice(13));
    expect(log).not.toContain(ADMIN_KEY);
  });
});

// -------- helpers --------

function postConversion(body: Record<string, unknown>) {
  return request(app).post('/attribution/conversions').set(admin).send(body);
}

async function mintPostbackToken(ipAllowlist?: string[]): Promise<string> {
  const res = await request(app)
    .post('/conversion-postback/token')
    .set(admin)
    .send(ipAllowlist ? { ipAllowlist } : {});
  expect(res.status).toBe(201);
  return res.body.plaintext as string;
}

async function mintScopedKey(scopes: string[]): Promise<string> {
  const res = await request(app).post('/api-keys/scoped').set(admin).send({ scopes });
  expect(res.status).toBe(201);
  return res.body.plaintext as string;
}

async function commissionsFor(eventId: string) {
  const attributionIds = await db(TABLES.Attribution).where({ eventId }).pluck('id');
  return db(TABLES.Commission).whereIn('attributionId', attributionIds).orderBy('id');
}

async function expectRowCounts(
  externalEventId: string,
  expected: { events: number; attributions: number; commissions: number },
) {
  const eventIds = await db(TABLES.Event).where({ externalEventId, tenantId: DEFAULT_TENANT_ID }).pluck('id');
  const attributionIds = await db(TABLES.Attribution).whereIn('eventId', eventIds).pluck('id');
  const commissions = await db(TABLES.Commission).whereIn('attributionId', attributionIds);
  expect({ events: eventIds.length, attributions: attributionIds.length, commissions: commissions.length }).toEqual(
    expected,
  );
}

/** A click on a 10% program, inserted directly (the router isn't in this
 *  process). */
async function seedClick(
  opts: { tenantId?: string; fraudFlag?: string; commissionRule?: unknown; clickAgeMs?: number; programName?: string } = {},
): Promise<{ clickId: string; partnerId: string; programId: string }> {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId, name: 'Lender partner', email: `p-${partnerId}@example.com` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId,
    name: opts.programName ?? 'Loans',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify(opts.commissionRule ?? [{ trigger: 'every', type: 'percent', value: 10 }]),
    destinationUrl: 'https://lender.example.com/apply?ref={click_id}',
  });
  await db(TABLES.Link).insert({ id: linkId, tenantId, partnerId, programId, linkKey: `lk-${linkId}` });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId,
    linkId,
    partnerId,
    programId,
    landingUrl: `https://lender.example.com/apply?ref=${clickId}`,
    fraudFlag: opts.fraudFlag ?? null,
    ts: new Date(Date.now() - (opts.clickAgeMs ?? 60_000)),
  });
  return { clickId, partnerId, programId };
}
