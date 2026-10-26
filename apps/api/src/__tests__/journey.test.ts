/**
 * The customer journey (journey.ts, routes/journey.ts): every partner
 * touch linked to a customer, their events, and for one conversion who got
 * credit and why.
 *
 *   - touches in order, link and code, each with its verdict for the
 *     conversion, and who every model would credit over the same touches
 *   - why a touch didn't count: outside its window, after the sale,
 *     flagged, partner revoked, a code that gives way to a link
 *   - a renewal says which conversion it kept the partner from
 *   - the record stays the truth: a click linked since is shown, and the
 *     decision says it no longer matches
 *   - admin only; strict response shapes
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import * as S from '../openapi/schemas.js';
import { expectShape } from './openapi-strict.js';

const ADMIN_KEY = 'op_test_journey_0123456789abcdefghijkl';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const T = DEFAULT_TENANT_ID;
const DAY = 86_400_000;
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

const TABLES_TO_CLEAN = [
  TABLES.TrackingIssue,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.ClickLanding,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.ApiKey,
  TABLES.Program,
  TABLES.Partner,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const admin = (path: string, token = ADMIN_KEY) => request(app).get(path).set('Authorization', `Bearer ${token}`);

async function program(o: { windowDays?: number; model?: string; couponsYieldToLinks?: boolean; name?: string } = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId: T,
    name: o.name ?? `Program ${id.slice(-4)}`,
    commissionRule: JSON.stringify([{ type: 'percent', value: 10, recurring: true }]),
    destinationUrl: 'https://brand.example/',
    attributionWindowDays: o.windowDays ?? 30,
    attributionModel: o.model ?? 'last_click',
    couponsYieldToLinks: o.couponsYieldToLinks ?? false,
  });
  return id;
}

async function partner(name: string): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({ id, tenantId: T, email: `p${id.toLowerCase()}@x.test`, name });
  return id;
}

/** `partnerId`'s link click `daysAgo` days ago, linked to `userId` now (or `linkedAt`). */
async function linkClick(
  userId: string,
  partnerId: string,
  programId: string,
  daysAgo: number,
  extra: { linkedAt?: Date; fraudFlag?: string; referer?: string; landed?: boolean } = {},
): Promise<string> {
  const linkId = ulid();
  const clickId = ulid();
  const ts = new Date(Date.now() - daysAgo * DAY);
  await db(TABLES.Link).insert({ id: linkId, tenantId: T, partnerId, programId, linkKey: `lk-${linkId}` });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: T,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://brand.example/pricing',
    referer: extra.referer ?? null,
    userAgent: SAFARI,
    country: 'GB',
    fraudFlag: extra.fraudFlag ?? null,
    ts,
  });
  if (extra.landed) await db(TABLES.ClickLanding).insert({ clickId, tenantId: T, landedAt: new Date(ts.getTime() + 2000), host: 'brand.example' });
  await db(TABLES.Identity).insert({ id: ulid(), tenantId: T, clickId, userId, stitchedAt: extra.linkedAt ?? new Date(ts.getTime() + 60_000) });
  return clickId;
}

async function coupon(partnerId: string, programId: string): Promise<string> {
  const code = `CODE${ulid().slice(-8)}`;
  await db(TABLES.Coupon).insert({ id: `cpn_${ulid()}`, tenantId: T, partnerId, programId, code });
  return code;
}

async function redeem(code: string, userId: string): Promise<string> {
  const res = await request(app)
    .post('/coupons/redeem')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({ code, eventType: 'invoice_paid', value: 100, currency: 'USD', externalEventId: `ord_${ulid()}`, userId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.eventId as string;
}

async function convert(userId: string, type = 'invoice_paid', ts?: Date): Promise<string> {
  const res = await request(app)
    .post('/attribution/events')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({ userId, type, value: 100, currency: 'USD', externalEventId: `evt_${ulid()}`, ...(ts ? { ts: ts.toISOString() } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.eventId as string;
}

interface JourneyBody {
  userId: string;
  touches: Array<{ clickId: string; kind: string; code: string | null; partner: { id: string; name: string | null }; browser: string | null; device: string | null; landedAt: string | null; referer: string | null }>;
  events: Array<{ id: string; type: string; corrective: boolean; credited: Array<{ partnerId: string; weight: number }> }>;
  selected: {
    eventId: string;
    status: string;
    source: string | null;
    model: string | null;
    candidates: number;
    fromEvent: { id: string } | null;
    touches: Array<{ clickId: string; verdict: string; weight: number | null; secondsBeforeEvent: number; linkedAfterEvent: boolean; pastWindow: boolean }>;
    recorded: Array<{ partnerId: string; weight: number; commissions: Array<{ amount: string; recruiter: boolean }> }>;
    matchesRecord: boolean;
    alternatives: Array<{ model: string; live: boolean; credits: Array<{ partnerId: string; weight: number }> }> | null;
  } | null;
  truncated: { touches: boolean; events: boolean };
}

async function journeyOf(eventId: string): Promise<JourneyBody> {
  const res = await admin(`/events/${eventId}/journey`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  // Strict: a field the route sends that the spec doesn't name fails here.
  expectShape(S.Journey, res.body, 'journey');
  return res.body as JourneyBody;
}

const verdictOf = (j: JourneyBody, clickId: string) => j.selected!.touches.find((t) => t.clickId === clickId)!;

// The first code redemption stamps the tenant's coupon integration as
// verified; put it back so later files see the tenant as it was.
let verifiedAtBefore: Date | null = null;

beforeAll(async () => {
  if (skipIntegration) return;
  const t = (await db(TABLES.Tenant).where({ id: T }).first('couponIntegrationVerifiedAt')) as
    | { couponIntegrationVerifiedAt: Date | null }
    | undefined;
  verifiedAtBefore = t?.couponIntegrationVerifiedAt ?? null;
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: T }).del();
    await db(TABLES.Tenant).where({ id: T }).update({ couponIntegrationVerifiedAt: verifiedAtBefore });
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: T }).del();
});

describe.skipIf(skipIntegration)('GET /events/:id/journey', () => {
  it('lists every touch in order, says which one won, and who each model would credit', async () => {
    const p = await program({ name: 'Refer & Earn' });
    const [ada, bob, cam] = [await partner('Ada'), await partner('Bob'), await partner('Cam')];
    const a = await linkClick('u1', ada, p, 20, { referer: 'https://ada.blog/review', landed: true });
    const b = await linkClick('u1', bob, p, 3);
    const eventId = await redeem(await coupon(cam, p), 'u1');

    const j = await journeyOf(eventId);
    expect(j.userId).toBe('u1');
    expect(j.touches.map((t) => [t.partner.name, t.kind])).toEqual([
      ['Ada', 'link'],
      ['Bob', 'link'],
      ['Cam', 'code'],
    ]);
    const [ta, , tc] = j.touches;
    expect(ta).toMatchObject({ referer: 'https://ada.blog/review', browser: expect.any(String), device: 'mobile' });
    expect(ta!.landedAt).not.toBeNull();
    expect(tc!.code).toMatch(/^CODE/);

    // Last click, the code at checkout wins; the links were in the window.
    const s = j.selected!;
    expect(s).toMatchObject({ eventId, status: 'credited', source: 'window', model: 'last_click', fromEvent: null, matchesRecord: true });
    expect(verdictOf(j, a)).toMatchObject({ verdict: 'in_window', weight: 0, linkedAfterEvent: false });
    expect(verdictOf(j, b).verdict).toBe('in_window');
    expect(verdictOf(j, tc!.clickId)).toMatchObject({ verdict: 'credited', weight: 1 });
    expect(Math.abs(verdictOf(j, tc!.clickId).secondsBeforeEvent)).toBeLessThan(60);
    expect(verdictOf(j, a).secondsBeforeEvent).toBeGreaterThan(19 * 86_400);
    expect(s.recorded).toHaveLength(1);
    expect(s.recorded[0]).toMatchObject({ partnerId: cam, weight: 1, commissions: [{ amount: '10.00', recruiter: false }] });

    const alt = Object.fromEntries(s.alternatives!.map((x) => [x.model, x]));
    expect(alt.last_click).toMatchObject({ live: true, credits: [{ partnerId: cam, weight: 1 }] });
    expect(alt.first_click).toMatchObject({ live: false, credits: [{ partnerId: ada, weight: 1 }] });
    expect(alt.linear!.credits.map((c) => c.weight)).toEqual([0.3333, 0.3333, 0.3333]);
    expect(Object.fromEntries(alt.position!.credits.map((c) => [c.partnerId, c.weight]))).toEqual({ [ada]: 0.4, [bob]: 0.2, [cam]: 0.4 });

    expect(j.events).toEqual([expect.objectContaining({ id: eventId, type: 'invoice_paid', corrective: false, credited: [{ partnerId: cam, partnerName: 'Cam', weight: 1 }] })]);
  });

  it('says why each touch did not count', async () => {
    const p = await program({ windowDays: 30 });
    const p2 = await program({ couponsYieldToLinks: true });
    const [old, fraud, gone, late, link, code] = await Promise.all(['Old', 'Fraud', 'Gone', 'Late', 'Link', 'Code'].map(partner));
    const tOld = await linkClick('u2', old!, p, 45);
    const tFraud = await linkClick('u2', fraud!, p, 5, { fraudFlag: 'velocity' });
    const tGone = await linkClick('u2', gone!, p, 4);
    await db(TABLES.Partner).where({ id: gone }).update({ revokedAt: new Date() });
    const tLink = await linkClick('u2', link!, p2, 2);
    const eventId = await redeem(await coupon(code!, p2), 'u2');
    // A click that came a day after the sale, linked to the customer later.
    const sale = (await db(TABLES.Event).where({ id: eventId }).first('ts')) as { ts: Date };
    const tLate = await linkClick('u2', late!, p, (Date.now() - sale.ts.getTime() - DAY) / DAY);

    const j = await journeyOf(eventId);
    const codeTouch = j.touches.find((t) => t.kind === 'code')!;
    expect(verdictOf(j, tOld).verdict).toBe('outside_window');
    expect(verdictOf(j, tFraud).verdict).toBe('flagged');
    expect(j.touches.find((t) => t.clickId === tFraud)).toMatchObject({ flagged: true });
    expect(verdictOf(j, tGone).verdict).toBe('partner_revoked');
    expect(verdictOf(j, tLate)).toMatchObject({ verdict: 'after_event', linkedAfterEvent: true });
    expect(verdictOf(j, tLate).secondsBeforeEvent).toBeLessThan(0);
    // The code's program gives way to a link click in the window.
    expect(verdictOf(j, codeTouch.clickId).verdict).toBe('yielded_to_link');
    expect(verdictOf(j, tLink)).toMatchObject({ verdict: 'credited', weight: 1 });
    expect(j.selected!.recorded.map((r) => r.partnerId)).toEqual([link]);
  });

  it('explains a conversion nobody got, and keeps the alternatives to window decisions', async () => {
    const p = await program({ windowDays: 30 });
    const ada = await partner('Ada');
    const t = await linkClick('u3', ada, p, 45);
    const eventId = await convert('u3');

    const s = (await journeyOf(eventId)).selected!;
    expect(s).toMatchObject({ status: 'outside_window', source: null, model: null, recorded: [], matchesRecord: true, alternatives: null });
    expect(s.touches).toEqual([expect.objectContaining({ clickId: t, verdict: 'outside_window', weight: null })]);
  });

  it('a renewal names the conversion it kept the partner from', async () => {
    const p = await program();
    const [ada, bob] = [await partner('Ada'), await partner('Bob')];
    await linkClick('u4', ada, p, 10);
    const first = await convert('u4', 'invoice_paid', new Date(Date.now() - 5 * DAY));
    const b = await linkClick('u4', bob, p, 2);
    const renewal = await convert('u4');

    const j = await journeyOf(renewal);
    expect(j.selected).toMatchObject({ status: 'credited', source: 'renewal', fromEvent: { id: first }, alternatives: null, matchesRecord: true });
    expect(verdictOf(j, b).verdict).toBe('in_window');
    expect(j.selected!.recorded.map((r) => r.partnerId)).toEqual([ada]);
    expect(j.events.map((e) => e.id)).toEqual([first, renewal]);
  });

  it('keeps the record as the truth when a click is linked after the sale', async () => {
    const p = await program();
    const [ada, bob] = [await partner('Ada'), await partner('Bob')];
    await linkClick('u5', ada, p, 6);
    const eventId = await convert('u5');
    // Bob's click came before the sale but reached the customer after it
    // was decided (a second device logging in, say).
    const b = await linkClick('u5', bob, p, 1, { linkedAt: new Date(Date.now() + 1000) });

    const j = await journeyOf(eventId);
    expect(j.selected!.recorded.map((r) => r.partnerId)).toEqual([ada]);
    expect(j.selected!.matchesRecord).toBe(false);
    expect(verdictOf(j, b)).toMatchObject({ verdict: 'credited', linkedAfterEvent: true });
  });

  it('shows a refund on the timeline without explaining it as a conversion', async () => {
    const p = await program();
    const ada = await partner('Ada');
    await linkClick('u6', ada, p, 2);
    await convert('u6');
    const refund = await convert('u6', 'refund');

    const j = await journeyOf(refund);
    expect(j.selected).toMatchObject({ status: 'corrective', touches: [], recorded: [], alternatives: null });
    expect(j.events.find((e) => e.id === refund)).toMatchObject({ corrective: true, credited: [] });
  });

  it('is admin only, and answers an unknown event as not found', async () => {
    const p = await program();
    const ada = await partner('Ada');
    await linkClick('u7', ada, p, 1);
    const eventId = await convert('u7');

    expect((await request(app).get(`/events/${eventId}/journey`)).status).toBe(401);
    const { createApiKeyRow } = await import('../auth.js');
    const partnerKey = (await createApiKeyRow(db, { tenantId: T, partnerId: ada, label: 'partner' })).plaintext;
    expect((await admin(`/events/${eventId}/journey`, partnerKey)).status).toBe(403);
    const scoped = (await createApiKeyRow(db, { tenantId: T, scopes: ['commissions:read', 'partners:read'], label: 'scoped' })).plaintext;
    expect((await admin(`/events/${eventId}/journey`, scoped)).status).toBe(403);

    const missing = await admin(`/events/${ulid()}/journey`);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'event_not_found' });
  });
});

describe.skipIf(skipIntegration)('GET /customers/:userId/journey', () => {
  it("explains the customer's latest conversion, or the one asked for", async () => {
    const p = await program();
    const ada = await partner('Ada');
    await linkClick('cust@example.com', ada, p, 9);
    const signup = await convert('cust@example.com', 'signup', new Date(Date.now() - 3 * DAY));
    const paid = await convert('cust@example.com');
    await convert('cust@example.com', 'refund');

    const latest = await admin(`/customers/${encodeURIComponent('cust@example.com')}/journey`);
    expect(latest.status).toBe(200);
    expectShape(S.Journey, latest.body, 'journey');
    // The refund is newer, but the latest conversion is what gets explained.
    expect(latest.body.selected.eventId).toBe(paid);
    expect(latest.body.events.map((e: { type: string }) => e.type)).toEqual(['signup', 'invoice_paid', 'refund']);

    const asked = await admin(`/customers/${encodeURIComponent('cust@example.com')}/journey?eventId=${signup}`);
    expect(asked.body.selected.eventId).toBe(signup);
  });

  it('refuses another customer’s event, an unknown customer and an overlong id', async () => {
    const p = await program();
    const ada = await partner('Ada');
    await linkClick('u8', ada, p, 1);
    await linkClick('u9', ada, p, 1);
    const theirs = await convert('u9');

    const other = await admin(`/customers/u8/journey?eventId=${theirs}`);
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: 'event_not_found' });
    const nobody = await admin('/customers/nobody/journey');
    expect(nobody.status).toBe(404);
    expect(nobody.body).toEqual({ error: 'customer_not_found' });
    expect((await admin(`/customers/${'x'.repeat(513)}/journey`)).status).toBe(400);
  });

  it('explains the latest conversion even behind more refunds than the list holds', async () => {
    const p = await program();
    const ada = await partner('Ada');
    await linkClick('u12', ada, p, 2);
    const paid = await convert('u12', 'invoice_paid', new Date(Date.now() - DAY));
    // 201 newer corrective events: past the 200 the journey lists.
    await db(TABLES.Event).insert(
      Array.from({ length: 201 }, (_, i) => ({
        id: ulid(),
        tenantId: T,
        userId: 'u12',
        type: 'refund',
        value: '-1.00',
        currency: 'USD',
        metadata: {},
        ts: new Date(Date.now() - 1000 * (i + 1)),
      })),
    );

    const res = await admin('/customers/u12/journey');
    expect(res.status).toBe(200);
    expectShape(S.Journey, res.body, 'journey');
    expect(res.body.selected).toMatchObject({ eventId: paid, status: 'credited' });
    expect(res.body.truncated.events).toBe(true);
    // The newest 200, plus the conversion being explained.
    expect(res.body.events).toHaveLength(201);
    expect(res.body.events[0].id).toBe(paid);
  });

  it("sums a partner's touches under each model, and counts the model's input", async () => {
    const p = await program({ model: 'linear' });
    const [ada, bob] = [await partner('Ada'), await partner('Bob')];
    await linkClick('u13', ada, p, 9);
    await linkClick('u13', ada, p, 5);
    await linkClick('u13', bob, p, 1);
    const eventId = await convert('u13');

    const s = (await journeyOf(eventId)).selected!;
    expect(s).toMatchObject({ model: 'linear', candidates: 3 });
    const linear = s.alternatives!.find((a) => a.model === 'linear')!;
    expect(linear.live).toBe(true);
    expect(linear.credits).toEqual([
      { partnerId: ada, partnerName: 'Ada', weight: 0.6667 },
      { partnerId: bob, partnerName: 'Bob', weight: 0.3333 },
    ]);
    // Linear writes one row per click: Ada's two thirds are two rows.
    expect(s.recorded.map((r) => r.partnerId).sort()).toEqual([ada, ada, bob].sort());
    expect(s.matchesRecord).toBe(true);
  });

  it('a customer linked to a click but with no events has touches and no decision', async () => {
    const p = await program();
    const ada = await partner('Ada');
    await linkClick('u10', ada, p, 1);
    const res = await admin('/customers/u10/journey');
    expect(res.status).toBe(200);
    expectShape(S.Journey, res.body, 'journey');
    expect(res.body).toMatchObject({ events: [], selected: null });
    expect(res.body.touches).toHaveLength(1);
  });
});

describe.skipIf(skipIntegration)('commission rows name their event', () => {
  it('GET /commissions carries eventId, so the portal can open the journey', async () => {
    const p = await program();
    const ada = await partner('Ada');
    await linkClick('u11', ada, p, 1);
    const eventId = await convert('u11');
    const res = await admin('/commissions');
    expect(res.status).toBe(200);
    expectShape(S.CommissionListItem, res.body.commissions[0], 'commission');
    expect(res.body.commissions.map((c: { eventId: string }) => c.eventId)).toEqual([eventId]);
  });
});
