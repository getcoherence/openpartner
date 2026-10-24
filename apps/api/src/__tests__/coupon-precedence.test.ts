/**
 * Program.couponsYieldToLinks: who wins when a customer clicked one
 * partner's link and checked out with another partner's coupon code.
 *
 *   - off (default, today's behaviour): the redemption's click is stamped
 *     at checkout, so under last click the code wins
 *   - on: the link click inside the window wins; the code credits only
 *     when no link click is there
 *   - decided by the code's own program, not the link's
 *   - a link click outside the window doesn't take it
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { isCouponClick } from '../attribution.js';

const ADMIN_KEY = 'op_test_coupon_precedence_0123456789abcd';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const T = DEFAULT_TENANT_ID;
const DAY = 86_400_000;

const TABLES_TO_CLEAN = [
  TABLES.TrackingIssue,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.Program,
  TABLES.Partner,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
let verifiedAtBefore: Date | null = null;

async function program(couponsYieldToLinks = false): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId: T,
    name: `P ${id.slice(-4)}`,
    commissionRule: JSON.stringify({ type: 'percent', value: 10 }),
    destinationUrl: 'https://brand.example/',
    attributionWindowDays: 30,
    attributionModel: 'last_click',
    couponsYieldToLinks,
  });
  return id;
}

async function partner(): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({ id, tenantId: T, email: `p${id.toLowerCase()}@x.test`, name: 'Partner' });
  return id;
}

/** The customer clicked `partnerId`'s link `daysAgo` days ago. */
async function linkClick(userId: string, partnerId: string, programId: string, daysAgo: number): Promise<void> {
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Link).insert({ id: linkId, tenantId: T, partnerId, programId, linkKey: `lk-${linkId}` });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: T,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://brand.example/',
    ts: new Date(Date.now() - daysAgo * DAY),
  });
  await db(TABLES.Identity).insert({ id: ulid(), tenantId: T, clickId, userId });
}

async function coupon(partnerId: string, programId: string): Promise<string> {
  const code = `CODE${ulid().slice(-8)}`;
  await db(TABLES.Coupon).insert({ id: `cpn_${ulid()}`, tenantId: T, partnerId, programId, code });
  return code;
}

/** Redeem `code` for `userId` and return the partner credited. */
async function creditedFor(code: string, userId: string): Promise<string | undefined> {
  const res = await request(app)
    .post('/coupons/redeem')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({ code, eventType: 'invoice_paid', value: 100, currency: 'USD', externalEventId: `ord_${ulid()}`, userId });
  expect(res.status).toBe(201);
  const rows = await db(TABLES.Attribution).where({ eventId: res.body.eventId });
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0]?.partnerId;
}

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

describe('isCouponClick', () => {
  it('is a click with no Link and a coupon:// landing URL', () => {
    expect(isCouponClick({ linkId: null, landingUrl: 'coupon://SAVE10' })).toBe(true);
    expect(isCouponClick({ linkId: 'lnk_1', landingUrl: 'https://brand.example/' })).toBe(false);
    expect(isCouponClick({ linkId: null, landingUrl: 'https://brand.example/' })).toBe(false);
  });
});

describe.skipIf(skipIntegration)('coupon vs link precedence', () => {
  it('off (default): the code used at checkout beats the earlier link click', async () => {
    const p = await program();
    const [linkPartner, codePartner] = [await partner(), await partner()];
    await linkClick('u1', linkPartner, p, 3);
    expect(await creditedFor(await coupon(codePartner, p), 'u1')).toBe(codePartner);
  });

  it('on: the link click in the window wins', async () => {
    const p = await program(true);
    const [linkPartner, codePartner] = [await partner(), await partner()];
    await linkClick('u1', linkPartner, p, 3);
    expect(await creditedFor(await coupon(codePartner, p), 'u1')).toBe(linkPartner);
  });

  it('on: the code still credits when no link click is in the window', async () => {
    const p = await program(true);
    const [linkPartner, codePartner] = [await partner(), await partner()];
    // Outside the 30-day window.
    await linkClick('u1', linkPartner, p, 45);
    expect(await creditedFor(await coupon(codePartner, p), 'u1')).toBe(codePartner);
    // And with no link at all.
    expect(await creditedFor(await coupon(codePartner, p), 'u2')).toBe(codePartner);
  });

  it("decides who wins a customer, not who keeps them: renewals follow the first sale's winner", async () => {
    const p = await program(false);
    const [linkPartner, codePartner] = [await partner(), await partner()];
    await linkClick('u1', linkPartner, p, 3);
    // Off: the code wins the first payment.
    expect(await creditedFor(await coupon(codePartner, p), 'u1')).toBe(codePartner);
    // Turning it on later doesn't move the customer's renewals.
    await db(TABLES.Program).where({ id: p }).update({ couponsYieldToLinks: true });
    const renewal = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId: 'u1', type: 'invoice_paid', value: 100, currency: 'USD', externalEventId: `inv_${ulid()}` });
    expect(renewal.status).toBe(200);
    const rows = await db(TABLES.Attribution).where({ eventId: renewal.body.eventId });
    expect(rows.map((r) => r.partnerId)).toEqual([codePartner]);
  });

  it("follows the code's program, not the link's", async () => {
    const yields = await program(true);
    const competes = await program(false);
    const [linkPartner, codePartner] = [await partner(), await partner()];
    // The link's program yields; the code's doesn't: the code wins.
    await linkClick('u1', linkPartner, yields, 3);
    expect(await creditedFor(await coupon(codePartner, competes), 'u1')).toBe(codePartner);
    // The other way round: the code's program yields to the link.
    await linkClick('u2', linkPartner, competes, 3);
    expect(await creditedFor(await coupon(codePartner, yields), 'u2')).toBe(linkPartner);
  });
});

describe.skipIf(skipIntegration)('the program API', () => {
  it('creates with couponsYieldToLinks false by default and patches it', async () => {
    const admin = { Authorization: `Bearer ${ADMIN_KEY}` };
    const created = await request(app)
      .post('/programs')
      .set(admin)
      .send({ name: 'Precedence', destinationUrl: 'https://brand.example/', commissionRule: { type: 'percent', value: 10 } });
    expect(created.status).toBe(201);
    expect(created.body.couponsYieldToLinks).toBe(false);
    const patched = await request(app).patch(`/programs/${created.body.id}`).set(admin).send({ couponsYieldToLinks: true });
    expect(patched.status).toBe(200);
    expect(patched.body.couponsYieldToLinks).toBe(true);
  });
});
