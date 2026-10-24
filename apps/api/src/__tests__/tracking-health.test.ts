/**
 * GET /admin/tracking-health (tracking-health.ts), on one seeded program:
 *
 *   - the funnel counts partner-link clicks only (not coupon redemptions),
 *     leaves out fraud flags and bots, and follows each click through
 *     landing, stitch and credit
 *   - unattributed conversions get the first reason the engine stops at:
 *     no partner click, only excluded clicks, outside the window, or other;
 *     corrective events never appear
 *   - a coupon that took credit from another partner's in-window link
 *     click is counted
 *   - Stripe catch-up recoveries, dropped input and last-seen signals
 *   - admin-only, a bounded window, a program that must exist
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { trackingHealth } from '../tracking-health.js';

const ADMIN_KEY = 'op_test_tracking_health_0123456789abcdef0';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const TABLES_TO_CLEAN = [
  TABLES.TrackingIssue,
  TABLES.ClickLanding,
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

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const IOS_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const DAY = 86_400_000;
const T = DEFAULT_TENANT_ID;
const ago = (days: number) => new Date(Date.now() - days * DAY);

interface Seeded {
  programId: string;
  otherProgramId: string;
}

async function seed(): Promise<Seeded> {
  const partnerA = ulid();
  const partnerB = ulid();
  const programId = ulid();
  const otherProgramId = ulid();
  const linkA = ulid();
  await db(TABLES.Partner).insert([
    { id: partnerA, tenantId: T, name: 'A', email: `a-${partnerA}@example.com` },
    { id: partnerB, tenantId: T, name: 'B', email: `b-${partnerB}@example.com` },
  ]);
  for (const id of [programId, otherProgramId]) {
    await db(TABLES.Program).insert({
      id,
      tenantId: T,
      name: id === programId ? 'Main' : 'Other',
      attributionModel: 'last_click',
      attributionWindowDays: 30,
      commissionRule: { type: 'percent', value: 10 },
      destinationUrl: 'https://brand.example/',
    });
  }
  await db(TABLES.Link).insert({ id: linkA, tenantId: T, partnerId: partnerA, programId, linkKey: `lk-${linkA}` });

  const click = async (fields: { ua?: string; ts?: Date; fraudFlag?: string; coupon?: string; partnerId?: string }) => {
    const id = ulid();
    await db(TABLES.Click).insert({
      id,
      tenantId: T,
      linkId: fields.coupon ? null : linkA,
      partnerId: fields.partnerId ?? partnerA,
      programId,
      landingUrl: fields.coupon ? `coupon://${fields.coupon}` : 'https://brand.example/',
      userAgent: fields.ua ?? CHROME,
      fraudFlag: fields.fraudFlag ?? null,
      ts: fields.ts ?? ago(2),
    });
    return id;
  };
  const stitch = (clickId: string, userId: string) => db(TABLES.Identity).insert({ id: ulid(), tenantId: T, clickId, userId });
  const event = async (userId: string, type: string, value: string | null, currency = 'USD', metadata = {}) => {
    const id = ulid();
    await db(TABLES.Event).insert({ id, tenantId: T, userId, type, value, currency, ts: ago(1), metadata });
    return id;
  };
  const credit = (eventId: string, clickId: string, partnerId = partnerA) =>
    db(TABLES.Attribution).insert({ id: ulid(), tenantId: T, eventId, clickId, partnerId, programId, model: 'last_click', weight: '1.0000' });

  // The funnel: landed + stitched + credited, landed only, nothing.
  const c1 = await click({ ua: CHROME });
  const c2 = await click({ ua: IOS_SAFARI });
  await click({ ua: IOS_SAFARI });
  const flagged = await click({ fraudFlag: 'velocity' });
  await click({ ua: BOT });
  await db(TABLES.ClickLanding).insert([
    { clickId: c1, tenantId: T, host: 'www.brand.example' },
    { clickId: c2, tenantId: T, host: 'www.brand.example' },
  ]);
  await stitch(c1, 'user_a');
  await credit(await event('user_a', 'invoice_paid', '100.00'), c1);

  // no_click: an organic customer. A refund (corrective) never shows.
  await event('user_organic', 'invoice_paid', '50.00');
  await event('user_organic', 'refund', '-50.00');
  // excluded: stitched only to a flagged click.
  await stitch(flagged, 'user_flagged');
  await event('user_flagged', 'signup', null);
  // outside_window: a 40-day-old click on a 30-day program. Not in the
  // funnel either: it predates the window.
  const old = await click({ ts: ago(40) });
  await stitch(old, 'user_old');
  await event('user_old', 'invoice_paid', '70.00', 'EUR');
  // other: a usable in-window click and still no credit.
  const usable = await click({ ua: IOS_SAFARI });
  await stitch(usable, 'user_other');
  await event('user_other', 'signup', null);

  // A coupon took the sale from partner A's link click.
  const linkClick = await click({ ua: CHROME, ts: ago(3) });
  const couponClick = await click({ coupon: 'BCODE', partnerId: partnerB, ts: ago(1) });
  await stitch(linkClick, 'user_coupon');
  await stitch(couponClick, 'user_coupon');
  await credit(await event('user_coupon', 'invoice_paid', '80.00'), couponClick, partnerB);

  // Recovered by the Stripe catch-up (and attributed: it isn't a miss).
  const recovered = await event('user_a', 'invoice_paid', '100.00', 'USD', { stripeEventId: 'evt_1', recoveredBy: 'stripe_catchup' });
  await credit(recovered, c1);

  await db(TABLES.TrackingIssue).insert({
    tenantId: T,
    day: new Date().toISOString().slice(0, 10),
    kind: 'identify_unknown_click',
    count: 2,
    sampleRef: 'nope',
  });
  return { programId, otherProgramId };
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: T }).del();
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: T }).del();
});

describe.skipIf(skipIntegration)('trackingHealth', () => {
  it('follows link clicks through landing, stitch and credit, without flags, bots or coupons', async () => {
    await seed();
    const report = await trackingHealth(db, T, { days: 30 });
    // c1, c2, the unlanded Safari click, the "other" user's click and the
    // coupon customer's link click. The flagged one and the bot are out.
    expect(report.funnel).toEqual({ clicks: 5, landed: 2, stitched: 3, converted: 1, flagged: 1, bots: 1 });
    expect(report.landingReported).toBe(true);
    const safari = report.byBrowser.find((b) => b.browser === 'Mobile Safari');
    expect(safari).toEqual({ browser: 'Mobile Safari', device: 'mobile', clicks: 3, landed: 1, stitched: 1, converted: 0 });
    const chrome = report.byBrowser.find((b) => b.browser === 'Chrome');
    expect(chrome).toMatchObject({ device: 'desktop', clicks: 2, landed: 1, stitched: 2, converted: 1 });
  });

  it('gives each unattributed conversion the first reason the engine stops at', async () => {
    await seed();
    const { unattributed } = await trackingHealth(db, T, { days: 30 });
    expect(unattributed.events).toBe(4);
    expect(unattributed.byReason).toEqual([
      { reason: 'no_click', events: 1, value: [{ currency: 'USD', amount: 50 }] },
      { reason: 'excluded', events: 1, value: [] },
      { reason: 'outside_window', events: 1, value: [{ currency: 'EUR', amount: 70 }] },
      { reason: 'other', events: 1, value: [] },
    ]);
  });

  it('counts coupon overrides, catch-up recoveries, dropped input and last signals', async () => {
    await seed();
    const report = await trackingHealth(db, T, { days: 30 });
    expect(report.coupons.overrodeLink).toBe(1);
    expect(report.stripe.recovered).toBe(1);
    expect(report.issues).toEqual([expect.objectContaining({ kind: 'identify_unknown_click', count: 2, sampleRef: 'nope' })]);
    expect(report.signals.lastLandingAt).not.toBeNull();
    expect(report.signals.lastStitchAt).not.toBeNull();
    expect(report.signals.lastStripeEventAt).not.toBeNull();
    expect(report.signals.lastPostbackAt).toBeNull();
  });

  it('filters clicks and coupon credits to one program, and reports nothing landed before any landing', async () => {
    const { otherProgramId } = await seed();
    const report = await trackingHealth(db, T, { days: 30, programId: otherProgramId });
    expect(report.funnel.clicks).toBe(0);
    expect(report.coupons.overrodeLink).toBe(0);
    // Account-wide on purpose.
    expect(report.unattributed.events).toBe(4);

    await db(TABLES.ClickLanding).where({ tenantId: T }).del();
    expect((await trackingHealth(db, T, { days: 30 })).landingReported).toBe(false);
  });

  it('a 7-day window drops the clicks and conversions before it', async () => {
    await seed();
    await db(TABLES.Event).where({ tenantId: T, userId: 'user_organic' }).update({ ts: ago(10) });
    const report = await trackingHealth(db, T, { days: 7 });
    expect(report.unattributed.byReason.find((r) => r.reason === 'no_click')).toBeUndefined();
    expect(report.window.days).toBe(7);
  });
});

describe.skipIf(skipIntegration)('GET /admin/tracking-health', () => {
  it('is admin-only, bounds the window, and wants a real program', async () => {
    await seed();
    expect((await request(app).get('/admin/tracking-health')).status).toBe(401);
    const admin = { Authorization: `Bearer ${ADMIN_KEY}` };
    const ok = await request(app).get('/admin/tracking-health?days=30').set(admin);
    expect(ok.status).toBe(200);
    expect(ok.body.funnel.clicks).toBe(5);
    expect((await request(app).get('/admin/tracking-health?days=365').set(admin)).status).toBe(400);
    const missing = await request(app).get('/admin/tracking-health?programId=nope').set(admin);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('program_not_found');
  });
});
