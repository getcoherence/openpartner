/**
 * A test click (test-clicks.ts) is excluded from everything that reads
 * clicks, because it is never a Click. With real partner traffic in the
 * same program (clicks landed, linked, attributed and paid a commission,
 * plus a velocity-flagged one), a full test (opened, landed, linked to a
 * signup) leaves every reader's answer exactly as it was:
 *
 *   admin      GET /admin/overview, /programs/stats, /admin/clicks/flagged
 *              (the fraud queue), /metrics (the flagged count),
 *              /admin/tracking-health (the funnel), /flags, /setup
 *   partner    GET /partners/:id/dashboard, /timeseries, /breakdowns,
 *              /customers, /events, /funnel, /referrals, /coupons
 *   customer   GET /customers/<tester>/journey
 *
 * and adds no Click, ClickLanding, Identity, Attribution, Commission or
 * TrackingIssue row. The tester buying afterwards (with no partner's code)
 * credits nobody.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_test_click_excl_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';
process.env.OPENPARTNER_MODE = 'selfhost';

const T = DEFAULT_TENANT_ID;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const TABLES_TO_CLEAN = [
  TABLES.TestClick,
  TABLES.TrackingIssue,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.ClickLanding,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.Partner,
];
const COUNTED = [
  TABLES.Click,
  TABLES.ClickLanding,
  TABLES.Identity,
  TABLES.Attribution,
  TABLES.Commission,
  TABLES.TrackingIssue,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };

let programId = '';
let partnerId = '';

async function cleanup() {
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: T }).del();
}

/** Every reader's answer, minus the clock. */
async function readers(): Promise<Record<string, unknown>> {
  const paths = [
    '/admin/overview',
    `/admin/overview?programId=${programId}`,
    '/programs/stats',
    '/admin/clicks/flagged',
    '/metrics',
    '/admin/tracking-health',
    `/admin/tracking-health?programId=${programId}`,
    '/admin/tracking-health/flags',
    '/admin/tracking-health/setup',
    `/partners/${partnerId}/dashboard`,
    `/partners/${partnerId}/timeseries`,
    `/partners/${partnerId}/breakdowns`,
    `/partners/${partnerId}/customers`,
    `/partners/${partnerId}/events`,
    `/partners/${partnerId}/funnel`,
    `/partners/${partnerId}/referrals`,
    `/partners/${partnerId}/coupons`,
    '/customers/tester-1/journey',
  ];
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const res = await request(app).get(path).set(admin);
    expect([path, res.status]).not.toEqual([path, 500]);
    out[path] = { status: res.status, body: withoutClock(res.type === 'application/json' ? res.body : res.text) };
  }
  for (const table of COUNTED) {
    const [row] = await db(table).where({ tenantId: T }).count({ n: '*' });
    out[table] = Number(row!.n);
  }
  return out;
}

const CLOCK_KEYS = new Set(['computedAt', 'since', 'until', 'baselineSince', 'recentSince']);
function withoutClock(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutClock);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !CLOCK_KEYS.has(k)).map(([k, x]) => [k, withoutClock(x)]));
  }
  // /metrics is text; its process gauges move between scrapes.
  if (typeof v === 'string' && v.includes('# TYPE')) return v.split('\n').filter((l) => /click/i.test(l)).join('\n');
  return v;
}

beforeAll(async () => {
  if (skipIntegration) return;
  await cleanup();
  programId = ulid();
  partnerId = ulid();
  const linkId = ulid();
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: T,
    name: 'Main',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
    // A host that never resolves: the setup checks' fetch fails the same
    // way on both reads.
    destinationUrl: 'https://brand.invalid/signup',
  });
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: T, name: 'Ada', email: `ada-${partnerId}@partner.test` });
  await db(TABLES.PartnerProgram).insert({ id: ulid(), tenantId: T, partnerId, programId, source: 'admin' });
  await db(TABLES.Link).insert({ id: linkId, tenantId: T, partnerId, programId, linkKey: `ada-${linkId}` });

  // Real traffic, two days old: a click that landed, was linked and paid;
  // one that only landed; one that didn't; one velocity-flagged.
  const ts = new Date(Date.now() - 2 * 86_400_000);
  const ids = [ulid(), ulid(), ulid(), ulid()];
  await db(TABLES.Click).insert(
    ids.map((id, i) => ({
      id,
      tenantId: T,
      linkId,
      partnerId,
      programId,
      landingUrl: `https://brand.invalid/signup?cref=${id}`,
      userAgent: CHROME,
      fraudFlag: i === 3 ? 'velocity' : null,
      ts,
    })),
  );
  await db(TABLES.ClickLanding).insert(ids.slice(0, 2).map((clickId) => ({ clickId, tenantId: T, host: 'brand.invalid' })));
  expect((await request(app).post('/attribution/identify').send({ cref: ids[0], userId: 'customer-1' })).status).toBe(200);
  const paid = await request(app)
    .post('/attribution/events')
    .set(admin)
    .send({ userId: 'customer-1', type: 'invoice_paid', value: 100, currency: 'usd' });
  expect(paid.status).toBeLessThan(300);
  expect(await db(TABLES.Commission).where({ tenantId: T })).toHaveLength(1);
});

afterAll(async () => {
  if (!skipIntegration) await cleanup();
  await db.destroy();
});

describe.skipIf(skipIntegration)('a test click is out of every count', () => {
  it('leaves every reader as it was, and credits nobody for the tester', async () => {
    const before = await readers();

    const created = await request(app).post('/admin/tracking-health/test-click').set(admin).send({ programId });
    expect(created.status).toBe(201);
    // The router's claim (apps/router handleTestClick).
    const clickId = ulid();
    const token = created.body.path.slice('/_test/'.length);
    await db(TABLES.TestClick)
      .where({ tokenHash: createHash('sha256').update(token).digest('hex'), clickedAt: null })
      .update({ clickId, clickedAt: new Date(), destination: `https://brand.invalid/signup?cref=${clickId}` });
    expect((await request(app).post('/attribution/landing').set('Origin', 'https://brand.invalid').send({ cref: clickId })).body.test).toBe(true);
    expect((await request(app).post('/attribution/identify').send({ cref: clickId, userId: 'tester-1' })).body.test).toBe(true);
    const r = await request(app).get(`/admin/tracking-health/test-click/${created.body.id}`).set(admin);
    expect(r.body.state).toBe('passed');

    expect(await readers()).toEqual(before);

    // The tester goes on to buy: an event of the brand's, credited to nobody.
    const bought = await request(app)
      .post('/attribution/events')
      .set(admin)
      .send({ userId: 'tester-1', type: 'invoice_paid', value: 50, currency: 'usd' });
    expect(bought.status).toBeLessThan(300);
    expect(await db(TABLES.Attribution).where({ tenantId: T })).toHaveLength(1);
    expect(await db(TABLES.Commission).where({ tenantId: T })).toHaveLength(1);
  });
});
