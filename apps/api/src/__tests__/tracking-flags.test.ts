/**
 * Tracking health flags (tracking-flags.ts) and their routes:
 *
 *   linkage_drop
 *     - a browser whose clicks stopped landing, or being linked to a
 *       customer, within a day is flagged per metric against its own
 *       four weeks before
 *     - clicks younger than a day, landings later than a day, flagged
 *       clicks and bots are left out
 *     - too few clicks, or a drop that could be chance, isn't flagged
 *   fast_sales
 *     - most recent sales within a minute of the click (no history needed)
 *     - a median that collapsed against the partner's own baseline, but
 *       not a slow partner who merely got faster
 *     - coupon redemptions' synthetic clicks, renewals and conversions
 *       without a value are left out; too few sales isn't flagged
 *   routes
 *     - GET /admin/tracking-health/flags, admin-only
 *     - GET|POST /config/tracking-alerts, on by default
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { computeTrackingFlags, describeFlag, formatDuration, type FastSalesFlag, type LinkageDropFlag } from '../tracking-flags.js';
import { TRACKING_ALERTS_CONFIG_KEY } from '../tracking-alerts.js';

const ADMIN_KEY = 'op_test_tracking_flags_0123456789abcdef0';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const TABLES_TO_CLEAN = [
  TABLES.TrackingAlert,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.ClickLanding,
  TABLES.Click,
  TABLES.Link,
  TABLES.Program,
  TABLES.Partner,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const IOS_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';
const EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T = DEFAULT_TENANT_ID;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let programId = '';

async function cleanup() {
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: T }).del();
  await db(TABLES.Config).where({ tenantId: T, key: TRACKING_ALERTS_CONFIG_KEY }).del();
}

async function insertAll(table: string, rows: object[]) {
  for (let i = 0; i < rows.length; i += 500) await db(table).insert(rows.slice(i, i + 500));
}

async function partner(name: string): Promise<{ id: string; linkId: string }> {
  const id = ulid();
  const linkId = ulid();
  await db(TABLES.Partner).insert({ id, tenantId: T, name, email: `${id.toLowerCase()}@partner.test` });
  await db(TABLES.Link).insert({ id: linkId, tenantId: T, partnerId: id, programId, linkKey: `lk-${linkId}` });
  return { id, linkId };
}

beforeAll(async () => {
  if (skipIntegration) return;
  await cleanup();
});

afterAll(async () => {
  if (!skipIntegration) await cleanup();
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  await cleanup();
  programId = ulid();
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: T,
    name: 'Main',
    attributionModel: 'last_click',
    attributionWindowDays: 90,
    commissionRule: { type: 'percent', value: 10 },
    destinationUrl: 'https://brand.example/',
  });
});

describe.skipIf(skipIntegration)('linkage_drop', () => {
  /** `n` link clicks spread evenly from `from` to `to` days ago. The first
   *  `landed` land a minute after the click, the next `lateLanded` two days
   *  after; the first `linked` are linked to a customer an hour after. */
  async function clicks(
    p: { id: string; linkId: string },
    o: { ua: string; n: number; from: number; to: number; landed?: number; lateLanded?: number; linked?: number; fraud?: string },
  ) {
    const rows: object[] = [];
    const landings: object[] = [];
    const identities: object[] = [];
    for (let i = 0; i < o.n; i++) {
      const id = ulid();
      const ts = ago(o.from + ((o.to - o.from) * (i + 0.5)) / o.n);
      rows.push({
        id,
        tenantId: T,
        linkId: p.linkId,
        partnerId: p.id,
        programId,
        landingUrl: 'https://brand.example/',
        userAgent: o.ua,
        fraudFlag: o.fraud ?? null,
        ts,
      });
      const landed = o.landed ?? 0;
      if (i < landed) landings.push({ clickId: id, tenantId: T, landedAt: new Date(ts.getTime() + 60_000), host: 'brand.example' });
      else if (i < landed + (o.lateLanded ?? 0)) {
        landings.push({ clickId: id, tenantId: T, landedAt: new Date(ts.getTime() + 2 * DAY), host: 'brand.example' });
      }
      if (i < (o.linked ?? 0)) {
        identities.push({ id: ulid(), tenantId: T, clickId: id, userId: `u_${id}`, stitchedAt: new Date(ts.getTime() + HOUR) });
      }
    }
    await insertAll(TABLES.Click, rows);
    await insertAll(TABLES.ClickLanding, landings);
    await insertAll(TABLES.Identity, identities);
  }

  it('flags a browser whose clicks stopped landing and being linked, against its own four weeks before', async () => {
    const p = await partner('Mixed traffic');
    // Mobile Safari: 80% landed and ~19% linked before; 20% and ~7% now.
    await clicks(p, { ua: IOS_SAFARI, n: 300, from: 9, to: 35, landed: 240, linked: 60 });
    // Landed two days late: not a landing within a day.
    await clicks(p, { ua: IOS_SAFARI, n: 10, from: 9, to: 35, lateLanded: 10 });
    await clicks(p, { ua: IOS_SAFARI, n: 150, from: 1.5, to: 7.5, landed: 30, linked: 10 });
    // Not measured yet: younger than a day, none landed.
    await clicks(p, { ua: IOS_SAFARI, n: 100, from: 0.1, to: 0.5 });
    // Flagged as fraud: left out, though they all landed.
    await clicks(p, { ua: IOS_SAFARI, n: 50, from: 1.5, to: 7.5, landed: 50, fraud: 'velocity' });

    // Chrome: no change. Firefox: a collapse, but too few recent clicks.
    // Edge: a dip that isn't a 40% fall. Bots: never flagged.
    await clicks(p, { ua: CHROME, n: 300, from: 9, to: 35, landed: 240, linked: 60 });
    await clicks(p, { ua: CHROME, n: 150, from: 1.5, to: 7.5, landed: 120, linked: 30 });
    await clicks(p, { ua: FIREFOX, n: 300, from: 9, to: 35, landed: 240 });
    await clicks(p, { ua: FIREFOX, n: 60, from: 1.5, to: 7.5 });
    await clicks(p, { ua: EDGE, n: 300, from: 9, to: 35, landed: 240 });
    await clicks(p, { ua: EDGE, n: 150, from: 1.5, to: 7.5, landed: 105 });
    await clicks(p, { ua: BOT, n: 300, from: 9, to: 35, landed: 240 });
    await clicks(p, { ua: BOT, n: 150, from: 1.5, to: 7.5 });

    const { flags, windows } = await computeTrackingFlags(db, T, { now: NOW });
    expect(windows.linkage).toEqual({
      baselineSince: ago(36).toISOString(),
      recentSince: ago(8).toISOString(),
      until: ago(1).toISOString(),
    });
    const linkage = flags.filter((f): f is LinkageDropFlag => f.kind === 'linkage_drop');
    expect(linkage).toEqual([
      {
        kind: 'linkage_drop',
        subject: 'Mobile Safari|mobile|landed',
        browser: 'Mobile Safari',
        device: 'mobile',
        metric: 'landed',
        recent: { clicks: 150, hits: 30, rate: 0.2 },
        baseline: { clicks: 310, hits: 240, rate: 0.7742 },
      },
      {
        kind: 'linkage_drop',
        subject: 'Mobile Safari|mobile|linked',
        browser: 'Mobile Safari',
        device: 'mobile',
        metric: 'linked',
        recent: { clicks: 150, hits: 10, rate: 0.0667 },
        baseline: { clicks: 310, hits: 60, rate: 0.1935 },
      },
    ]);
    expect(describeFlag(linkage[0]!)).toBe(
      'Mobile Safari (mobile): 20% of partner clicks reached a page running the script within a day last week, down from 77% over the four weeks before (150 clicks).',
    );
  });

  it("doesn't flag a fall in a rate the baseline barely had", async () => {
    const p = await partner('Rare links');
    // 15 links in the baseline, none now: under the 20 a baseline needs.
    await clicks(p, { ua: CHROME, n: 300, from: 9, to: 35, linked: 15 });
    await clicks(p, { ua: CHROME, n: 150, from: 1.5, to: 7.5 });
    expect((await computeTrackingFlags(db, T, { now: NOW })).flags).toEqual([]);
  });
});

describe.skipIf(skipIntegration)('fast_sales', () => {
  /** A customer's click and sale `afterSeconds` later, credited through it. */
  async function sale(
    p: { id: string; linkId: string },
    o: { clickDaysAgo: number; afterSeconds: number; value?: string | null; type?: string; coupon?: boolean },
  ): Promise<{ clickId: string; userId: string }> {
    const clickId = ulid();
    const userId = `u_${clickId}`;
    const clickTs = ago(o.clickDaysAgo);
    const eventTs = new Date(clickTs.getTime() + o.afterSeconds * 1000);
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: T,
      // A coupon redemption's synthetic click: no Link, stamped at the sale.
      linkId: o.coupon ? null : p.linkId,
      partnerId: p.id,
      programId,
      landingUrl: o.coupon ? 'coupon://SAVE10' : 'https://brand.example/',
      userAgent: o.coupon ? 'OpenPartner-CouponRedeem/1' : CHROME,
      ts: o.coupon ? eventTs : clickTs,
    });
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: T, clickId, userId, stitchedAt: clickTs });
    await credit(p, clickId, userId, eventTs, o.value === undefined ? '49.00' : o.value, o.type ?? 'invoice_paid');
    return { clickId, userId };
  }

  async function credit(p: { id: string }, clickId: string, userId: string, ts: Date, value: string | null = '49.00', type = 'invoice_paid') {
    const eventId = ulid();
    await db(TABLES.Event).insert({ id: eventId, tenantId: T, userId, type, value, currency: 'USD', ts, metadata: {} });
    await db(TABLES.Attribution).insert({
      id: ulid(),
      tenantId: T,
      eventId,
      clickId,
      partnerId: p.id,
      programId,
      model: 'last_click',
      weight: '1.0000',
      computedAt: ts,
    });
  }

  it('flags a partner whose recent sales mostly came within a minute of the click', async () => {
    const instant = await partner('Deal Bar');
    for (let i = 0; i < 5; i++) await sale(instant, { clickDaysAgo: 2 + i, afterSeconds: 20 });
    await sale(instant, { clickDaysAgo: 3, afterSeconds: 7200 });
    const steady = await partner('Steady Blog');
    for (let i = 0; i < 6; i++) await sale(steady, { clickDaysAgo: 2 + i, afterSeconds: 1800 });

    const { flags, windows } = await computeTrackingFlags(db, T, { now: NOW });
    expect(windows.sales).toEqual({ baselineSince: ago(104).toISOString(), recentSince: ago(14).toISOString(), until: NOW.toISOString() });
    expect(flags).toEqual([
      {
        kind: 'fast_sales',
        subject: instant.id,
        partnerId: instant.id,
        partnerName: 'Deal Bar',
        reason: 'mostly_instant',
        recent: { sales: 6, medianSeconds: 20, fast: 5, fastShare: 0.8333 },
        baseline: null,
      },
    ]);
    expect(describeFlag(flags[0]!)).toBe('Deal Bar: 5 of their 6 sales in the last two weeks came within a minute of their click.');
  });

  it("flags a median that collapsed against the partner's own history, not a slow one that sped up", async () => {
    const shifted = await partner('Shifted');
    for (let i = 0; i < 12; i++) await sale(shifted, { clickDaysAgo: 20 + i * 5, afterSeconds: 1800 });
    for (let i = 0; i < 6; i++) await sale(shifted, { clickDaysAgo: 2 + i, afterSeconds: 120 });
    // Two days down to three hours: a tenth, but nowhere near instant.
    const sped = await partner('Sped up');
    for (let i = 0; i < 12; i++) await sale(sped, { clickDaysAgo: 22 + i * 5, afterSeconds: 2 * 86_400 });
    for (let i = 0; i < 6; i++) await sale(sped, { clickDaysAgo: 2 + i, afterSeconds: 3 * 3600 });

    const { flags } = await computeTrackingFlags(db, T, { now: NOW });
    expect(flags).toEqual([
      {
        kind: 'fast_sales',
        subject: shifted.id,
        partnerId: shifted.id,
        partnerName: 'Shifted',
        reason: 'collapsed',
        recent: { sales: 6, medianSeconds: 120, fast: 0, fastShare: 0 },
        baseline: { sales: 12, medianSeconds: 1800, fast: 0, fastShare: 0 },
      },
    ]);
    expect(describeFlag(flags[0]!)).toBe(
      'Shifted: half of their 6 sales in the last two weeks came within 2 minutes of their click, against 30 minutes over the three months before.',
    );
  });

  it('leaves out coupon redemptions, renewals, conversions without a value, and partners with too few sales', async () => {
    // Coupon sales are stamped at checkout: zero seconds by construction.
    const codes = await partner('Codes');
    for (let i = 0; i < 6; i++) await sale(codes, { clickDaysAgo: 2 + i, afterSeconds: 0, coupon: true });
    // Signups a few seconds after the click are ordinary.
    const signups = await partner('Signups');
    for (let i = 0; i < 6; i++) await sale(signups, { clickDaysAgo: 2 + i, afterSeconds: 5, value: null, type: 'signup' });
    // Four instant sales: under the five a flag needs.
    const few = await partner('Few');
    for (let i = 0; i < 4; i++) await sale(few, { clickDaysAgo: 2 + i, afterSeconds: 5 });

    // Five instant first sales, plus renewals that would read as slow:
    // through those clicks inside the window, and through clicks whose first
    // sale was before it. None of the renewals is a sale here.
    const renewing = await partner('Renewing');
    for (let i = 0; i < 5; i++) {
      const s = await sale(renewing, { clickDaysAgo: 8 + i, afterSeconds: 10 });
      await credit(renewing, s.clickId, s.userId, ago(2 + i));
    }
    for (let i = 0; i < 3; i++) {
      const s = await sale(renewing, { clickDaysAgo: 200 + i, afterSeconds: 3600 });
      for (const d of [60, 30, 3]) await credit(renewing, s.clickId, s.userId, ago(d + i));
    }

    const { flags } = await computeTrackingFlags(db, T, { now: NOW });
    expect(flags).toEqual([
      expect.objectContaining({
        kind: 'fast_sales',
        partnerName: 'Renewing',
        reason: 'mostly_instant',
        recent: { sales: 5, medianSeconds: 10, fast: 5, fastShare: 1 },
        baseline: null,
      }),
    ]);
    expect((flags[0] as FastSalesFlag).partnerId).toBe(renewing.id);
  });

  it("doesn't let a re-run under another model hide a click's first live sale", async () => {
    const shadowed = await partner('Shadowed');
    const clicks: string[] = [];
    for (let i = 0; i < 5; i++) clicks.push((await sale(shadowed, { clickDaysAgo: 2 + i, afterSeconds: 15 })).clickId);
    // An old sale whose live (first-computed) model credited another
    // partner's click; a later linear re-run also credited one of
    // Shadowed's clicks. That shadow row isn't a sale through the click.
    const other = await partner('Other');
    const old = await sale(other, { clickDaysAgo: 150, afterSeconds: 3600 });
    const [oldEvent] = await db(TABLES.Attribution).where({ tenantId: T, clickId: old.clickId }).pluck('eventId');
    await db(TABLES.Attribution).insert({
      id: ulid(),
      tenantId: T,
      eventId: oldEvent,
      clickId: clicks[0],
      partnerId: shadowed.id,
      programId,
      model: 'linear',
      weight: '0.5000',
      computedAt: new Date(),
    });

    const { flags } = await computeTrackingFlags(db, T, { now: NOW });
    expect(flags).toEqual([
      expect.objectContaining({ partnerName: 'Shadowed', recent: { sales: 5, medianSeconds: 15, fast: 5, fastShare: 1 } }),
    ]);
  });
});

describe('formatDuration', () => {
  it('reads as seconds, minutes, hours or days', () => {
    expect(formatDuration(1)).toBe('1 second');
    expect(formatDuration(12)).toBe('12 seconds');
    expect(formatDuration(120)).toBe('2 minutes');
    expect(formatDuration(1800)).toBe('30 minutes');
    expect(formatDuration(9000)).toBe('2.5 hours');
    expect(formatDuration(3 * 86_400)).toBe('3 days');
  });
});

describe.skipIf(skipIntegration)('routes', () => {
  const admin = (r: request.Test) => r.set('Authorization', `Bearer ${ADMIN_KEY}`);

  it('serves the flags to admins only', async () => {
    const res = await admin(request(app).get('/admin/tracking-health/flags'));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['computedAt', 'flags', 'windows']);
    expect(Object.keys(res.body.windows).sort()).toEqual(['linkage', 'sales']);
    expect(res.body.flags).toEqual([]);
    expect((await request(app).get('/admin/tracking-health/flags')).status).toBe(401);
  });

  it('keeps the alert email on until an admin turns it off', async () => {
    expect((await admin(request(app).get('/config/tracking-alerts'))).body).toEqual({ email: true });
    const off = await admin(request(app).post('/config/tracking-alerts')).send({ email: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ email: false });
    // An empty body changes nothing.
    expect((await admin(request(app).post('/config/tracking-alerts')).send({})).body).toEqual({ email: false });
    expect((await admin(request(app).get('/config/tracking-alerts'))).body).toEqual({ email: false });

    const bad = await admin(request(app).post('/config/tracking-alerts')).send({ email: 'no' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_body');
    expect((await request(app).post('/config/tracking-alerts').send({ email: true })).status).toBe(401);
  });
});
