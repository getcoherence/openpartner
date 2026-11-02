/**
 * Test clicks (test-clicks.ts):
 *
 * POST /admin/tracking-health/test-click
 *   - admins only; a single-use link whose token is stored only as a hash
 *   - refused for another brand's program, a blocked, ended or scheduled
 *     one, a brand whose links are paused, and past the daily allowance
 *
 * GET /admin/tracking-health/test-click/:id, through each step:
 *   - waiting for the link, then the link expiring unopened
 *   - opened (the router's claim, mirrored here: the router has its own
 *     tests), waiting for the landing, then missing it with the script fix
 *   - the landing and the signup reported over the public endpoints, which
 *     answer `test: true` and write no ClickLanding, Identity or Click
 *   - a signup without a landing passes (the click reached the site
 *     another way); a signup that never comes gets the linking fix
 *   - a conversion call naming it links it and records nothing
 *   - a program whose links go straight to Stripe's checkout skips the
 *     landing, and waits for the checkout (stripe-webhook.test.ts sends one)
 *   - steps after the window aren't recorded; another brand can't read it
 *
 * TrackingIssue doesn't count a test click id as an unknown click, and the
 * purge deletes test clicks past retention.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type TrackingIssueKind } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { LINKING_FIX, SCRIPT_FIX_ADD } from '../setup-checks.js';
import { PRIVACY_SIGNAL_FIX, TEST_CLICK, purgeTestClicks, recordTestLink, testClickResult } from '../test-clicks.js';
import { noteTrackingIssue } from '../tracking-issues.js';

const ADMIN_KEY = 'op_test_test_clicks_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const T = DEFAULT_TENANT_ID;
const OTHER_TENANT_ID = '01J000000TESTCLICKSOTHER00';

const TABLES_TO_CLEAN = [
  TABLES.TestClick,
  TABLES.TrackingIssue,
  TABLES.ClickLanding,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Program,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };
const SECOND = 1000;
const HOUR = 3_600_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function program(o: { tenantId?: string; destinationUrl?: string; startsAt?: Date; endsAt?: Date; blockedAt?: Date } = {}) {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId: o.tenantId ?? T,
    name: 'Main',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
    destinationUrl: o.destinationUrl ?? 'https://brand.example/signup',
    startsAt: o.startsAt ?? null,
    endsAt: o.endsAt ?? null,
    blockedAt: o.blockedAt ?? null,
  });
  return id;
}

async function create(programId: string) {
  return request(app).post('/admin/tracking-health/test-click').set(admin).send({ programId });
}

/** What the router does when the link is opened (apps/router handleTestClick). */
async function claim(path: string, at = new Date(), destination = (id: string) => `https://brand.example/signup?cref=${id}`): Promise<string> {
  const clickId = ulid();
  const n = await db(TABLES.TestClick)
    .where({ tokenHash: sha256(path.slice('/_test/'.length)), clickedAt: null })
    .where('expiresAt', '>', at)
    .update({ clickId, clickedAt: at, destination: destination(clickId) });
  expect(n).toBe(1);
  return clickId;
}

async function started(): Promise<{ id: string; clickId: string }> {
  const res = await create(await program());
  expect(res.status).toBe(201);
  return { id: res.body.id, clickId: await claim(res.body.path) };
}

async function result(id: string) {
  const res = await request(app).get(`/admin/tracking-health/test-click/${id}`).set(admin);
  expect(res.status).toBe(200);
  return res.body as NonNullable<Awaited<ReturnType<typeof testClickResult>>>;
}

const statuses = (r: { steps: Array<{ id: string; status: string }> }) => r.steps.map((s) => `${s.id}:${s.status}`);

async function cleanup() {
  for (const t of TABLES_TO_CLEAN) await db(t).whereIn('tenantId', [T, OTHER_TENANT_ID]).del();
  await db(TABLES.Tenant).whereIn('id', [T, OTHER_TENANT_ID]).update({ trackingTestPassedAt: null });
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db(TABLES.Tenant)
    .insert({ id: OTHER_TENANT_ID, slug: 'test-clicks-other', displayName: 'Other brand', status: 'active' })
    .onConflict('id')
    .ignore();
});

afterAll(async () => {
  if (!skipIntegration) {
    await cleanup();
    await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (!skipIntegration) await cleanup();
});

describe.skipIf(skipIntegration)('POST /admin/tracking-health/test-click', () => {
  it('makes a single-use link whose token is kept only as a hash', async () => {
    const pid = await program();
    const before = Date.now();
    const res = await create(pid);
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'id', 'path']);
    expect(res.body.path).toMatch(/^\/_test\/[A-Za-z0-9_-]{43}$/);
    const ttl = new Date(res.body.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan((TEST_CLICK.linkTtlMinutes - 1) * 60_000);
    expect(ttl).toBeLessThanOrEqual(TEST_CLICK.linkTtlMinutes * 60_000 + 5_000);

    const token = res.body.path.slice('/_test/'.length);
    const row = await db(TABLES.TestClick).where({ id: res.body.id }).first();
    expect(row).toMatchObject({ tenantId: T, programId: pid, tokenHash: sha256(token), clickId: null, clickedAt: null });
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('is for admins, and needs a program', async () => {
    const pid = await program();
    expect((await request(app).post('/admin/tracking-health/test-click').send({ programId: pid })).status).toBe(401);
    const bad = await request(app).post('/admin/tracking-health/test-click').set(admin).send({});
    expect(bad.status).toBe(400);
    expect(await db(TABLES.TestClick).where({ tenantId: T })).toEqual([]);
  });

  it('refuses another brand’s program, and one that isn’t running', async () => {
    const cases: Array<[Promise<string>, number, string]> = [
      [Promise.resolve(ulid()), 404, 'program_not_found'],
      [program({ tenantId: OTHER_TENANT_ID }), 404, 'program_not_found'],
      [program({ blockedAt: new Date() }), 409, 'program_not_active'],
      [program({ endsAt: new Date(Date.now() - HOUR) }), 409, 'program_not_active'],
      [program({ startsAt: new Date(Date.now() + HOUR) }), 409, 'program_not_active'],
    ];
    for (const [pid, status, error] of cases) {
      const res = await create(await pid);
      expect([res.status, res.body.error]).toEqual([status, error]);
    }
    expect(await db(TABLES.TestClick).whereIn('tenantId', [T, OTHER_TENANT_ID])).toEqual([]);
  });

  it('refuses while the brand’s links record no clicks', async () => {
    const pid = await program();
    await db(TABLES.Tenant).where({ id: T }).update({ pendingDeletionAt: new Date() });
    try {
      const res = await create(pid);
      expect([res.status, res.body.error]).toEqual([409, 'links_paused']);
    } finally {
      await db(TABLES.Tenant).where({ id: T }).update({ pendingDeletionAt: null });
    }
  });

  it('works for a brand still in review, which verifies its tracking this way', async () => {
    const pid = await program();
    const was = await db(TABLES.Tenant).where({ id: T }).first('approvalStatus');
    await db(TABLES.Tenant).where({ id: T }).update({ approvalStatus: 'pending' });
    try {
      expect((await create(pid)).status).toBe(201);
    } finally {
      await db(TABLES.Tenant).where({ id: T }).update({ approvalStatus: was.approvalStatus });
    }
  });

  it(`allows ${TEST_CLICK.perDay} a day`, async () => {
    const pid = await program();
    const rows = Array.from({ length: TEST_CLICK.perDay }, (_, i) => ({
      id: ulid(),
      tenantId: T,
      programId: pid,
      tokenHash: sha256(`seed-${i}`),
      // One from more than a day ago doesn't count.
      createdAt: new Date(Date.now() - (i === 0 ? 25 * HOUR : HOUR)),
      expiresAt: new Date(Date.now() + HOUR),
    }));
    await db(TABLES.TestClick).insert(rows);
    expect((await create(pid)).status).toBe(201);
    const res = await create(pid);
    expect([res.status, res.body.error]).toEqual([429, 'too_many_test_clicks']);
  });

  it('holds the allowance against requests that arrive together', async () => {
    const pid = await program();
    await db(TABLES.TestClick).insert(
      Array.from({ length: TEST_CLICK.perDay - 1 }, (_, i) => ({
        id: ulid(),
        tenantId: T,
        programId: pid,
        tokenHash: sha256(`together-${i}`),
        createdAt: new Date(Date.now() - HOUR),
        expiresAt: new Date(Date.now() + HOUR),
      })),
    );
    const results = await Promise.all(Array.from({ length: 5 }, () => create(pid)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 429, 429, 429, 429]);
    const [row] = await db(TABLES.TestClick).where({ tenantId: T }).count({ n: '*' });
    expect(Number(row!.n)).toBe(TEST_CLICK.perDay);
  });
});

describe.skipIf(skipIntegration)('GET /admin/tracking-health/test-click/:id', () => {
  it('waits for the link, then says it expired unopened', async () => {
    const res = await create(await program());
    const waiting = await result(res.body.id);
    expect(waiting.state).toBe('waiting');
    expect(statuses(waiting)).toEqual(['click:waiting', 'landing:pending', 'identify:pending']);
    expect(waiting.steps.every((s) => s.fix === null)).toBe(true);
    expect(waiting.program).toMatchObject({ name: 'Main' });

    await db(TABLES.TestClick).where({ id: res.body.id }).update({ expiresAt: new Date(Date.now() - SECOND) });
    const expired = await result(res.body.id);
    expect(expired.state).toBe('expired');
    expect(statuses(expired)).toEqual(['click:missing', 'landing:pending', 'identify:pending']);
    expect(expired.steps[0]!.fix).toContain(`within ${TEST_CLICK.linkTtlMinutes} minutes`);
  });

  it('once opened, waits for the landing, then gives the script fix', async () => {
    const { id, clickId } = await started();
    const opened = await result(id);
    expect(opened.state).toBe('waiting');
    expect(opened.destination).toBe(`https://brand.example/signup?cref=${clickId}`);
    expect(statuses(opened)).toEqual(['click:done', 'landing:waiting', 'identify:waiting']);

    await db(TABLES.TestClick)
      .where({ id })
      .update({ clickedAt: new Date(Date.now() - (TEST_CLICK.landingGraceSeconds + 5) * SECOND) });
    const late = await result(id);
    expect(late.state).toBe('waiting');
    expect(statuses(late)).toEqual(['click:done', 'landing:missing', 'identify:waiting']);
    expect(late.steps[1]!.fix).toContain('?cref=');
    expect(late.steps[1]!.fix).toContain(SCRIPT_FIX_ADD);
    expect(late.steps[1]!.fix).toContain(PRIVACY_SIGNAL_FIX);
  });

  it('records the landing and the signup from the public endpoints, and writes nothing else', async () => {
    const { id, clickId } = await started();

    const landed = await request(app).post('/attribution/landing').set('Origin', 'https://www.brand.example').send({ cref: clickId });
    expect(landed.status).toBe(200);
    expect(landed.body).toEqual({ ok: true, firstLanding: true, test: true });
    const again = await request(app).post('/attribution/landing').send({ cref: clickId });
    expect(again.body).toEqual({ ok: true, firstLanding: false, test: true });

    const mid = await result(id);
    expect(statuses(mid)).toEqual(['click:done', 'landing:done', 'identify:waiting']);
    expect(mid.steps[1]!.summary).toContain('www.brand.example');

    const identified = await request(app).post('/attribution/identify').send({ cref: clickId, userId: 'tester-1' });
    expect(identified.status).toBe(200);
    expect(identified.body).toEqual({ ok: true, identityId: null, firstStitch: true, backfilledAttributions: 0, test: true });
    const twice = await request(app).post('/attribution/identify').send({ cref: clickId, userId: 'tester-2' });
    expect(twice.body.firstStitch).toBe(false);

    const done = await result(id);
    expect(done.state).toBe('passed');
    expect(statuses(done)).toEqual(['click:done', 'landing:done', 'identify:done']);
    expect(done.steps.every((s) => s.fix === null)).toBe(true);
    expect(done.steps[2]).toMatchObject({ title: 'Linked to a customer', summary: 'Your site linked it to a signup or login.' });
    expect((await db(TABLES.TestClick).where({ id }).first()).linkedVia).toBe('identify');
    // The pass verifies the brand's tracking (tracking-verification.ts), once.
    const tenant = await db(TABLES.Tenant).where({ id: T }).first('trackingTestPassedAt');
    expect(tenant.trackingTestPassedAt).toBeInstanceOf(Date);

    for (const table of [TABLES.Click, TABLES.ClickLanding, TABLES.Identity, TABLES.TrackingIssue]) {
      expect(await db(table).where({ tenantId: T })).toEqual([]);
    }
    expect(JSON.stringify(await db(TABLES.TestClick).where({ id }).first())).not.toContain('tester-1');
  });

  it('passes a signup without a landing: the click reached the site another way', async () => {
    const { id, clickId } = await started();
    await request(app).post('/attribution/identify').send({ cref: clickId, userId: 'tester-1' });
    const r = await result(id);
    expect(r.state).toBe('passed');
    expect(r.steps[1]).toMatchObject({ status: 'done', at: null });
  });

  it('passes on a conversion call naming it, which records nothing', async () => {
    const { id, clickId } = await started();
    const conversion = { clickId, type: 'loan_funded', value: 100, externalEventId: `loan-${clickId}` };
    const res = await request(app).post('/attribution/conversions').set(admin).send(conversion);
    expect([res.status, res.body]).toEqual([200, { ok: true, test: true }]);
    const again = await request(app).post('/attribution/conversions').set(admin).send(conversion);
    expect([again.status, again.body]).toEqual([200, { ok: true, test: true }]);

    const r = await result(id);
    expect(r.state).toBe('passed');
    expect(r.steps[2]).toMatchObject({ status: 'done', summary: 'A conversion call sent it.' });
    expect((await db(TABLES.Tenant).where({ id: T }).first('trackingTestPassedAt')).trackingTestPassedAt).toBeInstanceOf(Date);
    for (const table of [TABLES.Click, TABLES.Identity, TABLES.Event, TABLES.TrackingIssue]) {
      expect(await db(table).where({ tenantId: T })).toEqual([]);
    }
  });

  it('skips the landing when the link goes straight to Stripe’s checkout, and waits for the checkout', async () => {
    const res = await create(await program({ destinationUrl: 'https://buy.stripe.com/test_abc?client_reference_id={click_id}' }));
    expect(res.status).toBe(201);
    const opened = new Date(Date.now() - (TEST_CLICK.identifyGraceSeconds + 5) * SECOND);
    const clickId = await claim(res.body.path, opened, (cid) => `https://buy.stripe.com/test_abc?client_reference_id=${cid}`);

    // Still inside the longer wait a checkout gets.
    const waiting = await result(res.body.id);
    expect(statuses(waiting)).toEqual(['click:done', 'landing:skipped', 'identify:waiting']);
    expect(waiting.steps[2]!.summary).toContain('Complete the checkout');

    const late = (await testClickResult(db, T, res.body.id, new Date(opened.getTime() + (TEST_CLICK.checkoutGraceSeconds + 5) * SECOND)))!;
    expect(late.steps[2]).toMatchObject({ status: 'missing' });
    expect(late.steps[2]!.fix).toContain('client_reference_id={click_id}');

    // What the Stripe webhook does with a checkout carrying it.
    expect(await recordTestLink(db, T, clickId, 'checkout')).toEqual({ first: true });
    const done = await result(res.body.id);
    expect(done.state).toBe('passed');
    expect(done.steps[2]).toMatchObject({ status: 'done', summary: 'A Stripe checkout carried it.' });
  });

  it('gives the linking fix when no signup comes, and expires after the window', async () => {
    const { id, clickId } = await started();
    await request(app).post('/attribution/landing').send({ cref: clickId });
    await db(TABLES.TestClick)
      .where({ id })
      .update({ landedAt: new Date(Date.now() - (TEST_CLICK.identifyGraceSeconds + 5) * SECOND) });
    const late = await result(id);
    expect(late.state).toBe('waiting');
    expect(late.steps[2]).toMatchObject({ status: 'missing', fix: LINKING_FIX });

    const row = await db(TABLES.TestClick).where({ id }).first();
    const after = new Date(new Date(row.clickedAt).getTime() + (TEST_CLICK.stepWindowHours + 1) * HOUR);
    const over = (await testClickResult(db, T, id, after))!;
    expect(over.state).toBe('expired');
    expect(statuses(over)).toEqual(['click:done', 'landing:done', 'identify:missing']);
  });

  it('records no step after the window, and counts no issue for it', async () => {
    const { id, clickId } = await started();
    await db(TABLES.TestClick)
      .where({ id })
      .update({ clickedAt: new Date(Date.now() - (TEST_CLICK.stepWindowHours + 1) * HOUR) });
    const landed = await request(app).post('/attribution/landing').send({ cref: clickId });
    expect(landed.body).toEqual({ ok: true, firstLanding: false, test: true });
    const identified = await request(app).post('/attribution/identify').send({ cref: clickId, userId: 'tester-1' });
    expect(identified.body).toMatchObject({ ok: true, firstStitch: false, test: true });
    const row = await db(TABLES.TestClick).where({ id }).first();
    expect([row.landedAt, row.identifiedAt]).toEqual([null, null]);
    expect(await db(TABLES.TrackingIssue).where({ tenantId: T })).toEqual([]);
    expect((await result(id)).state).toBe('expired');
  });

  it('is the brand’s own: another brand finds neither the test nor its click', async () => {
    const { id, clickId } = await started();
    expect(await testClickResult(db, OTHER_TENANT_ID, id)).toBeNull();
    expect((await request(app).get(`/admin/tracking-health/test-click/${ulid()}`).set(admin)).status).toBe(404);
    expect((await request(app).get(`/admin/tracking-health/test-click/${id}`)).status).toBe(401);
    const { recordTestLanding } = await import('../test-clicks.js');
    expect(await recordTestLanding(db, OTHER_TENANT_ID, clickId, null)).toBeNull();
  });
});

describe.skipIf(skipIntegration)('tracking issues and retention', () => {
  it('doesn’t count a test click id as an unknown click', async () => {
    const { clickId } = await started();
    const kinds: TrackingIssueKind[] = ['identify_unknown_click', 'landing_unknown_click', 'conversion_unknown_click', 'stripe_unknown_click'];
    for (const kind of kinds) await noteTrackingIssue(db, T, kind, clickId);
    expect(await db(TABLES.TrackingIssue).where({ tenantId: T })).toEqual([]);

    // A click id nobody has still counts, and so does another brand's test.
    await noteTrackingIssue(db, T, 'stripe_unknown_click', ulid());
    await noteTrackingIssue(db, OTHER_TENANT_ID, 'identify_unknown_click', clickId);
    expect((await db(TABLES.TrackingIssue).whereIn('tenantId', [T, OTHER_TENANT_ID]).select('kind')).map((r) => r.kind).sort()).toEqual([
      'identify_unknown_click',
      'stripe_unknown_click',
    ]);
  });

  it(`deletes test clicks ${TEST_CLICK.retentionDays} days after they were made`, async () => {
    const pid = await program();
    const day = 24 * HOUR;
    const make = (daysAgo: number) => ({
      id: ulid(),
      tenantId: T,
      programId: pid,
      tokenHash: sha256(`retention-${daysAgo}`),
      createdAt: new Date(Date.now() - daysAgo * day),
      expiresAt: new Date(Date.now() - daysAgo * day + 30 * 60_000),
    });
    const old = make(TEST_CLICK.retentionDays + 1);
    const recent = make(TEST_CLICK.retentionDays - 1);
    await db(TABLES.TestClick).insert([old, recent]);
    expect(await purgeTestClicks(db)).toBe(1);
    expect((await db(TABLES.TestClick).where({ tenantId: T }).pluck('id'))).toEqual([recent.id]);
  });
});
