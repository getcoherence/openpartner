/**
 * The daily Tracking health alert (tracking-alerts.ts), with the flags and
 * setup checks themselves stubbed (tracking-flags.test.ts and
 * setup-checks.test.ts cover those):
 *
 *   - a new flag is emailed once to every activated, unrevoked admin; a
 *     run that still sees it only refreshes it
 *   - a setup check is emailed when it turns failing, and again only once
 *     it has passed for three days and fails anew; one that waits or can't
 *     be checked never is
 *   - a brand's first run emails one list of whatever fails then
 *   - one email carries both: failing checks, then flags
 *   - checks that can't be computed don't hold the flags back, and their
 *     open episodes stay open
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
import type { SetupCheck } from '../setup-checks.js';

const stub = vi.hoisted(() => ({ flags: [] as unknown[], checks: [] as unknown[], checksFail: false }));
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

vi.mock('../setup-checks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../setup-checks.js')>();
  return {
    ...actual,
    computeSetupChecks: vi.fn(async () => {
      if (stub.checksFail) throw new Error('stripe down');
      return { computedAt: new Date().toISOString(), checks: stub.checks };
    }),
  };
});

const { sweepTenantTrackingAlerts, saveTrackingAlertSettings, TRACKING_ALERTS_CONFIG_KEY } = await import('../tracking-alerts.js');
const { runTrackingAlertsJob } = await import('../scheduler.js');
const { describeFlag } = await import('../tracking-flags.js');
const { describeSetupCheck } = await import('../setup-checks.js');

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

const DESTINATION: SetupCheck = {
  id: 'destination',
  title: 'Destination keeps the click',
  subject: 'prog_spring',
  program: { id: 'prog_spring', name: 'Spring' },
  status: 'fail',
  summary: 'The click is lost on the way: brand.example redirects to https://www.brand.example/ without ?cref=, so the page can’t tell which partner sent the visitor.',
  fix: 'Make the redirect keep the query string, or point the program’s destination at the final address (https://www.brand.example/).',
  detail: {},
};
const CODES: SetupCheck = {
  id: 'codes',
  title: 'Partner codes have their discount',
  subject: 'account',
  program: null,
  status: 'fail',
  summary: 'None of the 6 partner codes has its discount in your Stripe, so customers who enter them pay full price.',
  fix: 'OpenPartner tries again every hour.',
  detail: {},
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
/** Checks the stub returns; anything but `fail` is ignored by the job. */
const setup = (...checks: SetupCheck[]) => {
  stub.checks = checks;
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
  stub.checks = [];
  stub.checksFail = false;
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
      failingChecks: 0,
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
      failingChecks: 0,
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
      failingChecks: 0,
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

describe.skipIf(skipIntegration)('setup checks', () => {
  it('emails a check when it turns failing, then only refreshes it while it stays failing', async () => {
    setup({ ...DESTINATION, status: 'pass' });
    expect(await sweepTenantTrackingAlerts(db, T, { now: D0 })).toMatchObject({ failingChecks: 0, opened: 0, emailed: false });

    setup(DESTINATION);
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(1) })).toEqual({
      failingChecks: 1,
      flags: 0,
      opened: 1,
      notified: 1,
      resolved: 0,
      emailed: true,
    });
    expect(sent.map((m) => m.to).sort()).toEqual(['ops@brand.test', 'owner@brand.test']);
    expect(sent[0]!.subject).toBe('Tracking health: a setup check failing');
    expect(sent[0]!.text).toContain('Setup checks test each step of your tracking');
    expect(sent[0]!.text).toContain(`- ${describeSetupCheck(DESTINATION)}`);
    expect(sent[0]!.text).toContain('Spring: The click is lost on the way');
    expect(sent[0]!.text).not.toContain('compares each browser');
    expect(sent[0]!.metadata).toEqual({ purpose: 'tracking_flags', flagCount: '0', checkCount: '1' });
    expect((await episodes()).map((e) => [e.kind, e.subject])).toEqual([['setup_destination', 'prog_spring']]);

    sent = [];
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(2) })).toMatchObject({ opened: 0, emailed: false });
    expect(sent).toEqual([]);
  });

  it('emails it again after it passed for three days and fails anew, past the cooldown', async () => {
    setup(DESTINATION);
    await sweepTenantTrackingAlerts(db, T, { now: D0 });
    sent = [];
    setup({ ...DESTINATION, status: 'pass' });
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(4) })).toMatchObject({ resolved: 1 });
    setup(DESTINATION);
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(8) })).toMatchObject({ opened: 1, notified: 1, emailed: true });
    expect(sent).toHaveLength(2);
  });

  it("never emails a check that's waiting or can't be checked", async () => {
    setup({ ...DESTINATION, status: 'unknown' }, { ...CODES, status: 'waiting' });
    expect(await sweepTenantTrackingAlerts(db, T, { now: D0 })).toMatchObject({ failingChecks: 0, opened: 0, emailed: false });
    expect(sent).toEqual([]);
  });

  it('lists failing checks before flags in one email', async () => {
    setup(DESTINATION, CODES);
    flag(SAFARI);
    expect(await sweepTenantTrackingAlerts(db, T, { now: D0 })).toMatchObject({ failingChecks: 2, flags: 1, notified: 3, emailed: true });
    const text = sent[0]!.text;
    expect(sent[0]!.subject).toBe('Tracking health: 2 setup checks failing, a change flagged');
    expect(text).toContain('These have stopped passing:');
    expect(text).toContain('Tracking health also compares each browser');
    expect(text.indexOf(describeSetupCheck(CODES))).toBeLessThan(text.indexOf(describeFlag(SAFARI)));
    expect(text).toContain('You get one email when a check fails or a flag first appears');
  });

  it("still emails new flags when the checks can't be computed, and keeps their open episodes", async () => {
    setup(DESTINATION);
    await sweepTenantTrackingAlerts(db, T, { now: D0 });
    sent = [];

    stub.checksFail = true;
    flag(SAFARI);
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(5) })).toMatchObject({ failingChecks: 0, flags: 1, notified: 1, resolved: 0, emailed: true });
    expect(sent[0]!.subject).toBe('Tracking health flagged a change');
    expect((await episodes()).map((e) => [e.kind, e.resolvedAt])).toEqual([
      ['setup_destination', null],
      ['linkage_drop', null],
    ]);
  });

  it("emails a brand's first run with everything that fails then, once, and later only what turns failing", async () => {
    setup(DESTINATION, CODES);
    expect(await sweepTenantTrackingAlerts(db, T, { now: D0 })).toMatchObject({ failingChecks: 2, opened: 2, notified: 2, emailed: true });
    expect(sent[0]!.subject).toBe('Tracking health: 2 setup checks failing');
    expect(sent[0]!.text).toContain(describeSetupCheck(DESTINATION));
    expect(sent[0]!.text).toContain(describeSetupCheck(CODES));

    sent = [];
    expect(await sweepTenantTrackingAlerts(db, T, { now: day(1) })).toMatchObject({ opened: 0, emailed: false });
    expect(sent).toEqual([]);
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
