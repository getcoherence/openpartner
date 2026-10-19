/**
 * Bonuses (docs/bounties.md §2–§5): POST/GET /bonuses, and a bonus's
 * commission through holdback, approval, payouts and reversal.
 *
 * A bonus is paid through one Commission with no Attribution, so these
 * check it flows through the commission machinery unchanged while
 * announcing itself as bonus.* (never commission.*, whose payloads promise
 * a click and an event), and never shows up as a sale.
 *
 * dispatchEvent is mocked so the assertions read the exact payloads.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';

const ADMIN_KEY = 'op_test_bonuses_admin_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn() };
});

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { dispatchEvent } = await import('../webhook-dispatcher.js');
const { awardBonus } = await import('../bonuses.js');
const { saveNetworkMembership } = await import('../network-client.js');
const { runCommissionAutoApproveJob } = await import('../scheduler.js');
const { dispatchPayoutNotifications, runPayouts } = await import('../payouts.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const T = DEFAULT_TENANT_ID;
const DAY = 24 * 60 * 60 * 1000;

const TABLES_TO_CLEAN = [
  TABLES.PartnerCommission,
  TABLES.Commission,
  // After Commission (Commission.bonusId), before Partner and Program.
  TABLES.Bonus,
  TABLES.Payout,
  TABLES.ApiKey,
  TABLES.Program,
  TABLES.Partner,
];

async function clean(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).del();
  await db(TABLES.Config).where({ tenantId: T, key: 'network_membership' }).del();
}

async function seedPartner(opts: { revoked?: boolean } = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: T,
    name: 'Bonus Partner',
    email: `b-${id}@x.test`,
    ...(opts.revoked ? { revokedAt: new Date() } : {}),
  });
  return id;
}

async function seedProgram(opts: { holdbackDays?: number | null } = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId: T,
    name: 'Launch program',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl: 'https://x.test',
    holdbackDays: opts.holdbackDays ?? null,
  });
  return id;
}

function post(body: Record<string, unknown>, key = ADMIN_KEY) {
  return request(app).post('/bonuses').set('Authorization', `Bearer ${key}`).send(body);
}

function get(path: string, key = ADMIN_KEY) {
  return request(app).get(path).set('Authorization', `Bearer ${key}`);
}

/** Every dispatchEvent call for `event`, as payloads. */
function dispatched(event: string): Array<Record<string, unknown>> {
  return vi
    .mocked(dispatchEvent)
    .mock.calls.filter((c) => c[1] === event)
    .map((c) => c[2] as Record<string, unknown>);
}

function commissionEvents(): string[] {
  return vi
    .mocked(dispatchEvent)
    .mock.calls.map((c) => c[1] as string)
    .filter((e) => e.startsWith('commission.'));
}

/** Backdate a bonus's commission, as if awarded `days` ago. */
async function ageCommission(commissionId: string, days: number): Promise<void> {
  await db(TABLES.Commission).where({ id: commissionId }).update({ accruedAt: new Date(Date.now() - days * DAY) });
}

async function statusOf(commissionId: string): Promise<string | undefined> {
  return (await db(TABLES.Commission).where({ id: commissionId }).first())?.status;
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) await clean();
  await db.destroy();
});

beforeEach(async () => {
  vi.mocked(dispatchEvent).mockClear();
  if (skipIntegration) return;
  await clean();
});

describe.skipIf(skipIntegration)('POST /bonuses', () => {
  it('pays a manual bonus: one approved commission with no attribution, announced as bonus.*', async () => {
    const partnerId = await seedPartner();
    const programId = await seedProgram();

    const res = await post({ partnerId, programId, amount: 50, currency: 'usd', note: 'Launch week winner' });
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBeUndefined();
    expect(res.body.bonus).toMatchObject({
      partnerId,
      programId,
      amount: '50.00',
      currency: 'USD',
      source: 'manual',
      bountyId: null,
      externalRef: null,
      note: 'Launch week winner',
      createdBy: 'admin_api_key',
    });
    expect(res.body.commission).toMatchObject({
      bonusId: res.body.bonus.id,
      attributionId: null,
      partnerId,
      amount: '50.00',
      currency: 'USD',
      status: 'approved',
      metadata: { rateType: 'fixed' },
    });
    expect(await db(TABLES.Commission).where({ bonusId: res.body.bonus.id })).toHaveLength(1);

    const expected = {
      bonusId: res.body.bonus.id,
      commissionId: res.body.commission.id,
      partnerId,
      programId,
      bountyId: null,
      source: 'manual',
      amount: '50.00',
      currency: 'USD',
      note: 'Launch week winner',
    };
    expect(dispatched('bonus.awarded')).toEqual([{ ...expected, status: 'approved' }]);
    expect(dispatched('bonus.approved')).toEqual([expected]);
    expect(commissionEvents()).toEqual([]);
  });

  it('hold: true leaves it accrued, and only bonus.awarded fires', async () => {
    const partnerId = await seedPartner();
    const res = await post({ partnerId, amount: 20, currency: 'USD', hold: true });
    expect(res.status).toBe(201);
    expect(res.body.commission.status).toBe('accrued');
    expect(dispatched('bonus.awarded')).toEqual([expect.objectContaining({ status: 'accrued', programId: null })]);
    expect(dispatched('bonus.approved')).toEqual([]);
  });

  it('replays an externalRef: the original bonus, nothing new written or announced', async () => {
    const partnerId = await seedPartner();
    const body = { partnerId, amount: 75.5, currency: 'USD', externalRef: 'contest-2026-10' };
    const first = await post(body);
    expect(first.status).toBe(201);
    vi.mocked(dispatchEvent).mockClear();

    const again = await post(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true });
    expect(again.body.bonus.id).toBe(first.body.bonus.id);
    expect(again.body.commission.id).toBe(first.body.commission.id);
    expect(await db(TABLES.Bonus).where({ partnerId })).toHaveLength(1);
    expect(await db(TABLES.Commission).where({ partnerId })).toHaveLength(1);
    expect(vi.mocked(dispatchEvent)).not.toHaveBeenCalled();
  });

  it('refuses an externalRef reused for a different amount', async () => {
    const partnerId = await seedPartner();
    const first = await post({ partnerId, amount: 10, currency: 'USD', externalRef: 'ref-1' });
    const clash = await post({ partnerId, amount: 11, currency: 'USD', externalRef: 'ref-1' });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ error: 'external_ref_conflict', bonusId: first.body.bonus.id });
    expect(await db(TABLES.Bonus).where({ partnerId })).toHaveLength(1);
  });

  it('two concurrent awards with one externalRef write one bonus', async () => {
    const partnerId = await seedPartner();
    const input = { partnerId, amount: 30, currency: 'USD', source: 'manual' as const, externalRef: 'race-1' };
    const [a, b] = await Promise.all([
      db.transaction((trx) => awardBonus(trx, T, input)),
      db.transaction((trx) => awardBonus(trx, T, input)),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.bonus.id).toBe(b.bonus.id);
    expect(await db(TABLES.Bonus).where({ partnerId })).toHaveLength(1);
    expect(await db(TABLES.Commission).where({ partnerId })).toHaveLength(1);
  });

  it('refuses an unknown partner or program, a revoked partner, and malformed amounts', async () => {
    const partnerId = await seedPartner();
    const revoked = await seedPartner({ revoked: true });

    expect((await post({ partnerId: ulid(), amount: 5, currency: 'USD' })).body.error).toBe('partner_not_found');
    expect((await post({ partnerId, programId: ulid(), amount: 5, currency: 'USD' })).body.error).toBe('program_not_found');
    const r = await post({ partnerId: revoked, amount: 5, currency: 'USD' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('partner_revoked');

    for (const amount of [0, -5, 1.005]) {
      const bad = await post({ partnerId, amount, currency: 'USD' });
      expect(bad.status, `amount ${amount}`).toBe(400);
    }
    expect((await post({ partnerId, amount: 5, currency: 'dollars' })).status).toBe(400);
    expect(await db(TABLES.Bonus)).toHaveLength(0);
  });

  it('needs bonuses:write on a scoped key, and a partner can never pay itself', async () => {
    const partnerId = await seedPartner();
    const reader = await createApiKeyRow(db, { tenantId: T, scopes: ['commissions:read'], label: 'reader' });
    const denied = await post({ partnerId, amount: 5, currency: 'USD' }, reader.plaintext);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: 'forbidden_scope', required: 'bonuses:write' });

    const writer = await createApiKeyRow(db, { tenantId: T, scopes: ['bonuses:write'], label: 'crm' });
    const ok = await post({ partnerId, amount: 5, currency: 'USD' }, writer.plaintext);
    expect(ok.status).toBe(201);
    expect(ok.body.bonus).toMatchObject({ source: 'manual', createdBy: writer.id });

    const partnerKey = await createApiKeyRow(db, { tenantId: T, partnerId, label: 'partner' });
    expect((await post({ partnerId, amount: 5, currency: 'USD' }, partnerKey.plaintext)).status).toBe(403);
  });

  it("the brand's Network federation key pays network bonuses, idempotent on the submission id", async () => {
    const partnerId = await seedPartner();
    const programId = await seedProgram();
    const federation = await createApiKeyRow(db, { tenantId: T, scopes: ['commissions:read', 'bonuses:write'], label: 'network_federation' });
    await saveNetworkMembership(db, T, { enabled: true, networkUrl: 'https://network.example.test', scopedKeyId: federation.id });

    const body = { partnerId, programId, amount: 40, currency: 'USD', externalRef: 'sub_123', note: 'Bounty: unboxing video' };
    const res = await post(body, federation.plaintext);
    expect(res.status).toBe(201);
    expect(res.body.bonus).toMatchObject({ source: 'network', externalRef: 'sub_123' });
    expect(res.body.commission.status).toBe('approved');

    // The same ref from an admin is a manual bonus: refs are per source.
    const manual = await post(body);
    expect(manual.status).toBe(201);
    expect(manual.body.bonus.id).not.toBe(res.body.bonus.id);
    expect(manual.body.bonus.source).toBe('manual');
  });
});

describe.skipIf(skipIntegration)("a bonus's commission", () => {
  it('the CHECK constraint refuses a commission with neither or both sources', async () => {
    const partnerId = await seedPartner();
    const res = await post({ partnerId, amount: 5, currency: 'USD' });
    const base = { tenantId: T, partnerId, amount: '1.00', currency: 'USD', status: 'accrued' };
    await expect(db(TABLES.Commission).insert({ ...base, id: ulid(), attributionId: null, bonusId: null })).rejects.toThrow(
      /commission_source_exactly_one/,
    );
    // One commission per bonus.
    await expect(db(TABLES.Commission).insert({ ...base, id: ulid(), bonusId: res.body.bonus.id })).rejects.toThrow(
      /Commission_bonusId_unique/,
    );
  });

  it('commission lists label it a bonus, with its note, program and holdback', async () => {
    const partnerId = await seedPartner();
    const programId = await seedProgram({ holdbackDays: 14 });
    const res = await post({ partnerId, programId, amount: 25, currency: 'USD', note: 'Top referrer', hold: true });

    for (const path of ['/commissions', `/partners/${partnerId}/commissions`]) {
      const list = await get(path);
      expect(list.status).toBe(200);
      const row = list.body.commissions.find((c: { id: string }) => c.id === res.body.commission.id);
      expect(row, path).toMatchObject({
        source: 'bonus',
        bonus: { id: res.body.bonus.id, source: 'manual', note: 'Top referrer', bountyId: null },
        attributionId: null,
        programId,
        campaignName: 'Launch program',
        holdbackDays: 14,
      });
      expect(row.matureAt).not.toBeNull();
    }
  });

  it("holds through Bonus.programId's holdback: manual approve refuses until it matures", async () => {
    const partnerId = await seedPartner();
    const programId = await seedProgram({ holdbackDays: 30 });
    const res = await post({ partnerId, programId, amount: 25, currency: 'USD', hold: true });
    const id = res.body.commission.id as string;

    const early = await request(app).post(`/commissions/${id}/approve`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ error: 'holdback_active', holdbackDays: 30 });

    await ageCommission(id, 31);
    vi.mocked(dispatchEvent).mockClear();
    const ok = await request(app).post(`/commissions/${id}/approve`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(ok.status).toBe(200);
    await vi.waitFor(() => expect(dispatched('bonus.approved')).toHaveLength(1));
    expect(dispatched('bonus.approved')[0]).toMatchObject({ bonusId: res.body.bonus.id, commissionId: id, programId });
    expect(commissionEvents()).toEqual([]);
  });

  it('the auto-approve job approves a matured held bonus and fires bonus.approved, not commission.approved', async () => {
    const partnerId = await seedPartner();
    const programId = await seedProgram({ holdbackDays: 7 });
    const matured = await post({ partnerId, programId, amount: 25, currency: 'USD', hold: true });
    const waiting = await post({ partnerId, programId, amount: 10, currency: 'USD', hold: true });
    // No program and no partner holdback: waits for an admin.
    const unheld = await post({ partnerId, amount: 5, currency: 'USD', hold: true });
    await ageCommission(matured.body.commission.id, 8);
    await ageCommission(unheld.body.commission.id, 400);
    vi.mocked(dispatchEvent).mockClear();

    const result = await runCommissionAutoApproveJob();
    expect(result.find((r) => r.tenantId === T)).toMatchObject({ approvedCount: 1 });
    expect(await statusOf(matured.body.commission.id)).toBe('approved');
    expect(await statusOf(waiting.body.commission.id)).toBe('accrued');
    expect(await statusOf(unheld.body.commission.id)).toBe('accrued');

    await vi.waitFor(() => expect(dispatched('bonus.approved')).toHaveLength(1));
    expect(dispatched('bonus.approved')[0]).toMatchObject({
      bonusId: matured.body.bonus.id,
      commissionId: matured.body.commission.id,
      source: 'manual',
    });
    expect(commissionEvents()).toEqual([]);
  });

  it("a held bonus with no program takes the partner's own holdback", async () => {
    const partnerId = await seedPartner();
    await db(TABLES.PartnerCommission).insert({
      id: `pcm_${ulid()}`,
      partnerId,
      tenantId: T,
      programId: null,
      commissionType: 'percent',
      commissionValue: '20',
      recurring: false,
      holdbackDays: 10,
      source: 'amendment',
    });
    const res = await post({ partnerId, amount: 15, currency: 'USD', hold: true });
    await runCommissionAutoApproveJob();
    expect(await statusOf(res.body.commission.id)).toBe('accrued');

    await ageCommission(res.body.commission.id, 11);
    await runCommissionAutoApproveJob();
    expect(await statusOf(res.body.commission.id)).toBe('approved');
  });

  it('manual reverse fires bonus.reversed with reason manual', async () => {
    const partnerId = await seedPartner();
    const res = await post({ partnerId, amount: 25, currency: 'USD', note: 'Oops' });
    vi.mocked(dispatchEvent).mockClear();

    const rev = await request(app)
      .post(`/commissions/${res.body.commission.id}/reverse`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(rev.status).toBe(200);
    await vi.waitFor(() => expect(dispatched('bonus.reversed')).toHaveLength(1));
    expect(dispatched('bonus.reversed')[0]).toEqual({
      bonusId: res.body.bonus.id,
      commissionId: res.body.commission.id,
      partnerId,
      programId: null,
      bountyId: null,
      source: 'manual',
      amount: '25.00',
      currency: 'USD',
      note: 'Oops',
      reason: 'manual',
    });
    expect(commissionEvents()).toEqual([]);
  });

  it('a payout run pays it: payout.created lists it and bonus.paid carries the payout', async () => {
    const partnerId = await seedPartner();
    const res = await post({ partnerId, amount: 60, currency: 'USD' });
    const tenant = await db(TABLES.Tenant).where({ id: T }).first();
    await db(TABLES.Tenant).where({ id: T }).update({ payoutRailPreference: 'manual', payoutThresholdCents: 0 });
    try {
      vi.mocked(dispatchEvent).mockClear();
      const run = await db.transaction((trx) => runPayouts(trx, T));
      const payout = run.payouts.find((p) => p.partnerId === partnerId);
      expect(payout).toMatchObject({ method: 'manual', amount: 60, currency: 'USD' });
      expect(await statusOf(res.body.commission.id)).toBe('paid');

      dispatchPayoutNotifications(T, run.pendingNotifications);
      await vi.waitFor(() => expect(dispatched('bonus.paid')).toHaveLength(1));
      expect(dispatched('payout.created')[0]).toMatchObject({ commissionIds: [res.body.commission.id] });
      expect(dispatched('bonus.paid')[0]).toMatchObject({
        bonusId: res.body.bonus.id,
        commissionId: res.body.commission.id,
        payoutId: payout!.payoutId,
      });
      expect(commissionEvents()).toEqual([]);
    } finally {
      await db(TABLES.Tenant).where({ id: T }).update({
        payoutRailPreference: tenant?.payoutRailPreference ?? null,
        payoutThresholdCents: tenant?.payoutThresholdCents ?? null,
      });
    }
  });

  it('adds to earnings, but never to sales, leads or revenue', async () => {
    const partnerId = await seedPartner();
    const programId = await seedProgram();
    const other = await seedProgram();
    await post({ partnerId, programId, amount: 50, currency: 'USD' });

    const dash = await get(`/partners/${partnerId}/dashboard`);
    expect(dash.status).toBe(200);
    expect(dash.body).toMatchObject({ attributedEvents: 0, attributedRevenue: 0, commissionByStatus: { approved: 50 } });

    const earnings = async (q: string) => {
      const ts = await get(`/partners/${partnerId}/timeseries${q}`);
      expect(ts.status).toBe(200);
      const buckets = ts.body.buckets as Array<{ sales: number; leads: number; revenue: number; earnings: number }>;
      expect(buckets.every((b) => b.sales === 0 && b.leads === 0 && b.revenue === 0)).toBe(true);
      return buckets.reduce((s, b) => s + b.earnings, 0);
    };
    expect(await earnings('')).toBe(50);
    expect(await earnings(`?programId=${programId}`)).toBe(50);
    expect(await earnings(`?programId=${other}`)).toBe(0);
  });
});

describe.skipIf(skipIntegration)('GET /bonuses', () => {
  it('lists newest first with filters, and one bonus with its commission', async () => {
    const a = await seedPartner();
    const b = await seedPartner();
    const programId = await seedProgram();
    const first = await post({ partnerId: a, programId, amount: 5, currency: 'USD' });
    const second = await post({ partnerId: b, amount: 6, currency: 'EUR', hold: true });

    const all = await get('/bonuses');
    expect(all.status).toBe(200);
    expect(all.body.bonuses.map((x: { id: string }) => x.id)).toEqual([second.body.bonus.id, first.body.bonus.id]);
    expect(all.body.nextCursor).toBeNull();

    const byPartner = await get(`/bonuses?partnerId=${b}`);
    expect(byPartner.body.bonuses).toHaveLength(1);
    expect(byPartner.body.bonuses[0]).toMatchObject({
      id: second.body.bonus.id,
      currency: 'EUR',
      commission: { id: second.body.commission.id, status: 'accrued', payoutId: null, paidAt: null },
    });
    expect((await get(`/bonuses?programId=${programId}`)).body.bonuses).toHaveLength(1);
    expect((await get('/bonuses?source=network')).body.bonuses).toHaveLength(0);

    const page = await get('/bonuses?limit=1');
    expect(page.body.bonuses).toHaveLength(1);
    const rest = await get(`/bonuses?limit=1&cursor=${page.body.nextCursor}`);
    expect(rest.body.bonuses[0].id).toBe(first.body.bonus.id);

    const one = await get(`/bonuses/${first.body.bonus.id}`);
    expect(one.status).toBe(200);
    expect(one.body.bonus).toMatchObject({ id: first.body.bonus.id, commission: { status: 'approved' } });
    expect((await get(`/bonuses/${ulid()}`)).status).toBe(404);

    // The Network's read scope can list them.
    const reader = await createApiKeyRow(db, { tenantId: T, scopes: ['commissions:read'], label: 'reader' });
    expect((await get('/bonuses', reader.plaintext)).status).toBe(200);
  });
});

describe.skipIf(skipIntegration)('Network bounty authorization', () => {
  it('adds bonuses:write to an existing federation key, once, and says so', async () => {
    // A key from before Network bounties: the old federation scope set.
    const legacy = await createApiKeyRow(db, {
      tenantId: T,
      scopes: ['partners:write', 'partners:read', 'links:write', 'commissions:read', 'clicks:write'],
      label: 'network_federation',
    });
    await saveNetworkMembership(db, T, { enabled: true, networkUrl: 'https://network.example.test', scopedKeyId: legacy.id });

    const before = await get('/config/network');
    expect(before.body.bonusesAuthorized).toBe(false);
    const partnerId = await seedPartner();
    expect((await post({ partnerId, amount: 5, currency: 'USD' }, legacy.plaintext)).status).toBe(403);

    const res = await request(app).post('/config/network/authorize-bonuses').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.bonusesAuthorized).toBe(true);
    const again = await request(app).post('/config/network/authorize-bonuses').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(again.status).toBe(200);
    const key = await db(TABLES.ApiKey).where({ id: legacy.id }).first();
    expect(key.scopes.filter((s: string) => s === 'bonuses:write')).toHaveLength(1);

    // Same key, no re-issue: the Network can pay now.
    const paid = await post({ partnerId, amount: 5, currency: 'USD' }, legacy.plaintext);
    expect(paid.status).toBe(201);
    expect(paid.body.bonus.source).toBe('network');
  });

  it('409s with no Network connection, and a scoped key cannot widen a key', async () => {
    const res = await request(app).post('/config/network/authorize-bonuses').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('network_not_connected');

    const scoped = await createApiKeyRow(db, { tenantId: T, scopes: ['bonuses:write'], label: 'x' });
    const denied = await request(app)
      .post('/config/network/authorize-bonuses')
      .set('Authorization', `Bearer ${scoped.plaintext}`);
    expect(denied.status).toBe(403);
  });
});
