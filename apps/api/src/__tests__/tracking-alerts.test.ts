/**
 * The daily Tracking health alert (tracking-alerts.ts), with the flags
 * themselves stubbed (tracking-flags.test.ts covers those):
 *
 *   - a new flag is emailed once to every activated, unrevoked admin; a
 *     run that still sees it only refreshes it
 *   - an episode unseen for three days closes; a flag that returns within
 *     the cooldown of its last email opens quietly, after it is emailed
 *   - a failed send closes its new episodes unsent, and the next run
 *     emails them
 *   - nothing happens when the brand turned the email off or has no admin
 *   - the scheduler job runs it per active tenant
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type TrackingAlertRow } from '@openpartner/db';
import { db } from '../db.js';
import { __setMailerForTests, type Message } from '../mailer.js';
import type { FastSalesFlag, LinkageDropFlag, TrackingFlag } from '../tracking-flags.js';

const stub = vi.hoisted(() => ({ flags: [] as unknown[] }));
vi.mock('../tracking-flags.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tracking-flags.js')>();
  return {
    ...actual,
    computeTrackingFlags: vi.fn(async () => ({
      computedAt: new Date().toISOString(),
      windows: {
        linkage: { baselineSince: '', recentSince: '', until: '' },
        sales: { baselineSince: '', recentSince: '', until: '' },
      },
      flags: stub.flags,
    })),
  };
});

const { sweepTenantTrackingAlerts, saveTrackingAlertSettings, TRACKING_ALERTS_CONFIG_KEY } = await import('../tracking-alerts.js');
const { runTrackingAlertsJob } = await import('../scheduler.js');
const { describeFlag } = await import('../tracking-flags.js');

process.env.PORTAL_URL = 'https://portal.alerts.test';
process.env.OPENPARTNER_TENANCY = 'single';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const T = DEFAULT_TENANT_ID;
const DAY = 86_400_000;
const D0 = new Date('2026-10-26T06:40:00.000Z');
const day = (n: number) => new Date(D0.getTime() + n * DAY);

const SAFARI: LinkageDropFlag = {
  kind: 'linkage_drop',
  subject: 'Mobile Safari|mobile|landed',
  browser: 'Mobile Safari',
  device: 'mobile',
  metric: 'landed',
  recent: { clicks: 150, hits: 30, rate: 0.2 },
  baseline: { clicks: 310, hits: 240, rate: 0.7742 },
};
const DEAL_BAR: FastSalesFlag = {
  kind: 'fast_sales',
  subject: 'pa_dealbar',
  partnerId: 'pa_dealbar',
  partnerName: 'Deal Bar',
  reason: 'mostly_instant',
  recent: { sales: 6, medianSeconds: 20, fast: 5, fastShare: 0.8333 },
  baseline: null,
};

let sent: Message[] = [];
/** Every send fails, or only these recipients'. */
let failSends: boolean | Set<string> = false;
const adminIds: string[] = [];

async function cleanup() {
  await db(TABLES.TrackingAlert).where({ tenantId: T }).del();
  await db(TABLES.Config).where({ tenantId: T, key: TRACKING_ALERTS_CONFIG_KEY }).del();
  if (adminIds.length) await db(TABLES.Admin).whereIn('id', adminIds).del();
  adminIds.length = 0;
}

async function admin(email: string, o: { activated?: boolean; revoked?: boolean } = {}) {
  const id = ulid();
  adminIds.push(id);
  await db(TABLES.Admin).insert({
    id,
    tenantId: T,
    email,
    name: email,
    activatedAt: o.activated === false ? null : new Date(),
    revokedAt: o.revoked ? new Date() : null,
  });
}

const flag = (...flags: TrackingFlag[]) => {
  stub.flags = flags;
};
const episodes = () =>
  db<TrackingAlertRow>(TABLES.TrackingAlert).where({ tenantId: T }).orderBy('openedAt').orderBy('id');

beforeAll(async () => {
  __setMailerForTests({
    send: async (_ctx, msg) => {
      if (failSends === true || (failSends instanceof Set && failSends.has(msg.to))) throw new Error('smtp down');
      sent.push(msg);
    },
  });
  if (!skipIntegration) await cleanup();
});

afterAll(async () => {
  __setMailerForTests(null);
  if (!skipIntegration) await cleanup();
  await db.destroy();
});

beforeEach(async () => {
  sent = [];
  failSends = false;
  stub.flags = [];
  if (skipIntegration) return;
  await cleanup();
  await admin('owner@brand.test');
  await admin('ops@brand.test');
  await admin('gone@brand.test', { revoked: true });
  await admin('invited@brand.test', { activated: false });
});

describe.skipIf(skipIntegration)('sweepTenantTrackingAlerts', () => {
  it('emails each active admin once when flags first appear, then only refreshes them', async () => {
    flag(SAFARI, DEAL_BAR);
    expect(await sweepTenantTrackingAlerts(db, T, { now: D0 })).toEqual({
      flags: 2,
      opened: 2,
      notified: 2,
      resolved: 0,
      emailed: true,
    });
    expect(sent.map((m) => m.to).sort()).toEqual(['ops@brand.test', 'owner@brand.test']);
    expect(sent[0]!.subject).toBe('Tracking health flagged 2 changes');
    expect(sent[0]!.text).toContain(`- ${describeFlag(SAFARI)}`);
    expect(sent[0]!.text).toContain(`- ${describeFlag(DEAL_BAR)}`);
    expect(sent[0]!.text).toContain('https://portal.alerts.test/admin/tracking-health');
    expect(sent[0]!.tag).toBe('tracking_flags');
    expect((await episodes()).map((e) => [e.kind, e.subject, e.notifiedAt?.toISOString(), e.resolvedAt])).toEqual([
      ['linkage_drop', 'Mobile Safari|mobile|landed', D0.toISOString(), null],
      ['fast_sales', 'pa_dealbar', D0.toISOString(), null],
    ]);

    sent = [];
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(1) })).toEqual({
      flags: 2,
      opened: 0,
      notified: 0,
      resolved: 0,
      emailed: false,
    });
    expect(sent).toEqual([]);
    const rows = await episodes();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.lastSeenAt.toISOString() === day(1).toISOString())).toBe(true);
  });

  it('closes an episode unseen for three days; a return inside the cooldown opens quietly, after it emails', async () => {
    flag(SAFARI);
    await sweepTenantTrackingAlerts(db, T, { now: D0 });
    expect(sent).toHaveLength(2);

    flag();
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(2) })).toMatchObject({ resolved: 0 });
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(4) })).toMatchObject({ resolved: 1 });

    // Back on day 5, five days after its email: open, but not emailed.
    sent = [];
    flag(SAFARI);
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(5) })).toMatchObject({ opened: 1, notified: 0, emailed: false });
    expect(sent).toEqual([]);

    // Gone again, then back on day 10: the last email was ten days ago.
    flag();
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(9) })).toMatchObject({ resolved: 1 });
    flag(SAFARI);
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(10) })).toMatchObject({ opened: 1, notified: 1, emailed: true });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.subject).toBe('Tracking health flagged a change');

    const rows = await episodes();
    expect(rows.map((r) => [r.openedAt.toISOString(), r.notifiedAt?.toISOString() ?? null, r.resolvedAt?.toISOString() ?? null])).toEqual([
      [D0.toISOString(), D0.toISOString(), day(4).toISOString()],
      [day(5).toISOString(), null, day(9).toISOString()],
      [day(10).toISOString(), day(10).toISOString(), null],
    ]);
  });

  it('closes the new episodes unsent when no admin could be emailed, and the next run sends it', async () => {
    flag(DEAL_BAR);
    failSends = true;
    const failed = await sweepTenantTrackingAlerts(db, T, { now: D0 });
    expect(failed).toEqual({
      flags: 1,
      opened: 1,
      notified: 0,
      resolved: 0,
      emailed: false,
      failedRecipients: 2,
      sendError: 'smtp down',
    });
    expect((await episodes()).map((r) => [r.notifiedAt, r.resolvedAt?.toISOString()])).toEqual([[null, D0.toISOString()]]);

    failSends = false;
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(1) })).toMatchObject({ opened: 1, notified: 1, emailed: true });
    expect(sent.map((m) => m.to).sort()).toEqual(['ops@brand.test', 'owner@brand.test']);
  });

  it("one admin's bounce doesn't keep the others from hearing, and nobody hears twice", async () => {
    flag(DEAL_BAR);
    failSends = new Set(['owner@brand.test']);
    expect(await sweepTenantTrackingAlerts(db, T, { now: D0 })).toMatchObject({
      notified: 1,
      emailed: true,
      failedRecipients: 1,
    });
    expect(sent.map((m) => m.to)).toEqual(['ops@brand.test']);

    failSends = false;
    sent = [];
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(1) })).toMatchObject({ opened: 0, emailed: false });
    expect(sent).toEqual([]);
  });

  it('does nothing when the brand turned the email off, or has no admin to tell', async () => {
    flag(SAFARI);
    await saveTrackingAlertSettings(db, T, { email: false });
    expect(await sweepTenantTrackingAlerts(db, T, { now: D0 })).toEqual({ skipped: 'disabled' });

    await saveTrackingAlertSettings(db, T, { email: true });
    await db(TABLES.Admin).whereIn('id', adminIds).update({ revokedAt: new Date() });
    expect(await sweepTenantTrackingAlerts(db, T, { now: D0 })).toEqual({ skipped: 'no_admins' });

    expect(sent).toEqual([]);
    expect(await episodes()).toEqual([]);
  });
});

describe.skipIf(skipIntegration)('runTrackingAlertsJob', () => {
  it('sweeps each active tenant in its own transaction', async () => {
    flag(SAFARI);
    const out = await runTrackingAlertsJob();
    const mine = out.find((t) => t.tenantId === T);
    expect(mine).toMatchObject({ ok: true, result: { flags: 1, opened: 1, notified: 1, emailed: true } });
    expect(sent.map((m) => m.to).sort()).toEqual(['ops@brand.test', 'owner@brand.test']);
  });
});
