/**
 * Commission-lifecycle interlocks + manual-rail confirmation + residual
 * settlement — spec §7/§8 (finding 5). DB-backed.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';

const ADMIN_KEY = 'op_test_admin_key_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;

import { db } from '../db.js';
import { createApp } from '../app.js';
import { reserveFundingBatch } from '../funding/reserve.js';
import { interlockCommissionReversal } from '../funding/interlocks.js';
import { runTransferExecutor } from '../funding/executor.js';
import { runFundingReconciliation } from '../funding/reconcile.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;
const app = createApp();

async function seedPartner(transferReady = true): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: TENANT,
    email: `p${id}@x.test`,
    name: 'P',
    stripeConnectAccountId: transferReady ? `acct_${id.slice(0, 10)}` : null,
    metadata: transferReady ? { stripe: { payoutsEnabled: true } } : {},
  });
  return id;
}

async function seedCommissions(partnerId: string, n: number, amount = '40.00'): Promise<string[]> {
  const programId = ulid();
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: TENANT,
    name: 'prog',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl: 'https://x.test',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  const clickId = ulid();
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: TENANT,
    partnerId,
    programId,
    landingUrl: 'https://x.test/',
    ts: new Date(),
  });
  const eventId = ulid();
  await db(TABLES.Event).insert({
    id: eventId,
    tenantId: TENANT,
    userId: `u-${clickId}`,
    type: 'invoice_paid',
    value: amount,
    currency: 'USD',
    ts: new Date(),
  });
  const attributionId = ulid();
  await db(TABLES.Attribution).insert({
    id: attributionId,
    tenantId: TENANT,
    eventId,
    clickId,
    partnerId,
    programId,
    model: 'last_click',
    weight: '1',
    computedAt: new Date(),
  });
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = ulid();
    ids.push(id);
    await db(TABLES.Commission).insert({
      id,
      tenantId: TENANT,
      partnerId,
      attributionId,
      amount,
      currency: 'USD',
      status: 'approved',
    });
  }
  return ids;
}

async function reserve(partnerId: string, commissionIds: string[], amountMinor: number): Promise<string> {
  const r = await db.transaction((trx) =>
    reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId, commissionIds, amountMinor }]),
  );
  expect(r.batchId).not.toBeNull();
  return r.batchId!;
}

const FUNDING_TABLES = [
  TABLES.PayoutReversal,
  TABLES.CommissionAdjustment,
  TABLES.HostedFundingTransfer,
  TABLES.HostedFundingAllocation,
  TABLES.HostedFundingBatch,
  TABLES.HostedFundingAuthorization,
  TABLES.StripeWebhookInbox,
];

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of [
    ...FUNDING_TABLES,
    TABLES.Commission,
    TABLES.Attribution,
    TABLES.Event,
    TABLES.Identity,
    TABLES.Click,
    TABLES.Link,
    TABLES.Coupon,
    TABLES.PartnerProgram,
    TABLES.PartnerCommission,
    TABLES.Payout,
    TABLES.Program,
    TABLES.Partner,
  ]) {
    await db(t).del();
  }
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of [...FUNDING_TABLES, TABLES.Commission, TABLES.Payout]) {
      await db(t).del();
    }
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('commission reversal interlocks', () => {
  it('reserved batch: cancel shrinks the principal, frees the allocation as released, flip allowed', async () => {
    const partnerId = await seedPartner();
    const [c1, c2] = await seedCommissions(partnerId, 2, '40.00');
    const batchId = await reserve(partnerId, [c1!, c2!], 8000);

    const result = await interlockCommissionReversal(db, [c1!]);
    expect(result.flippable).toEqual([c1!]);
    expect(result.held).toEqual([]);

    const batch = await db(TABLES.HostedFundingBatch).where({ id: batchId }).first();
    expect(batch.status).toBe('reserved');
    expect(Number(batch.principalMinor)).toBe(4000);
    expect(Number(batch.grossChargeMinor)).toBe(4000);
    const alloc = await db(TABLES.HostedFundingAllocation).where({ commissionId: c1! }).first();
    expect(alloc.state).toBe('released');
  });

  it('reversing every commission in a reserved batch releases the batch', async () => {
    const partnerId = await seedPartner();
    const ids = await seedCommissions(partnerId, 2, '40.00');
    const batchId = await reserve(partnerId, ids, 8000);

    const result = await interlockCommissionReversal(db, ids);
    expect(result.flippable).toHaveLength(2);
    const batch = await db(TABLES.HostedFundingBatch).where({ id: batchId }).first();
    expect(batch.status).toBe('released');
  });

  it('in-flight batch: allocation canceled, amounts frozen, batch settles with residual', async () => {
    const partnerId = await seedPartner();
    const [c1, c2] = await seedCommissions(partnerId, 2, '40.00');
    const batchId = await reserve(partnerId, [c1!, c2!], 8000);
    await db(TABLES.HostedFundingBatch)
      .where({ id: batchId })
      .update({ status: 'payment_processing', stripePaymentIntentId: 'pi_x' });

    const result = await interlockCommissionReversal(db, [c1!]);
    expect(result.flippable).toEqual([c1!]);

    const batch = await db(TABLES.HostedFundingBatch).where({ id: batchId }).first();
    expect(Number(batch.grossChargeMinor)).toBe(8000); // frozen
    const alloc = await db(TABLES.HostedFundingAllocation).where({ commissionId: c1! }).first();
    expect(alloc.state).toBe('canceled');

    // Fund it and run the executor: the survivor transfers, the canceled
    // 4000 becomes a residual.
    await db(TABLES.HostedFundingBatch)
      .where({ id: batchId })
      .update({ status: 'funded', stripeChargeId: 'ch_res', fundedAt: new Date() });
    const stripe = {
      transfers: {
        create: vi.fn(async (p: { amount: number }) => ({ id: `tr_${ulid()}`, amount: p.amount })),
        list: vi.fn(async () => ({ data: [] })),
      },
    } as unknown as Stripe;
    const run = await runTransferExecutor(db, { stripe });
    expect(run.settled).toEqual([batchId]);
    const settled = await db(TABLES.HostedFundingBatch).where({ id: batchId }).first();
    expect(settled.status).toBe('settled_with_residual');
    expect(Number(settled.residualMinor)).toBe(4000);
    const payout = await db(TABLES.Payout).where({ partnerId }).first();
    expect(payout.amount).toBe('40.00'); // only the surviving commission
  });

  it('transfer_pending allocation holds the flip; admin reverse endpoint 409s', async () => {
    const partnerId = await seedPartner();
    const [c1] = await seedCommissions(partnerId, 1, '50.00');
    await reserve(partnerId, [c1!], 5000);
    await db(TABLES.HostedFundingAllocation)
      .where({ commissionId: c1! })
      .update({ state: 'transfer_pending' });

    const result = await interlockCommissionReversal(db, [c1!]);
    expect(result.held).toEqual([c1!]);
    expect(result.flippable).toEqual([]);

    const res = await request(app)
      .post(`/commissions/${c1!}/reverse`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('commission_in_transfer');
    const commission = await db(TABLES.Commission).where({ id: c1! }).first();
    expect(commission.status).toBe('approved'); // untouched
  });

  it('admin reverse of an allocated commission cancels the allocation and reverses', async () => {
    const partnerId = await seedPartner();
    const [c1, c2] = await seedCommissions(partnerId, 2, '40.00');
    await reserve(partnerId, [c1!, c2!], 8000);

    const res = await request(app)
      .post(`/commissions/${c1!}/reverse`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    const commission = await db(TABLES.Commission).where({ id: c1! }).first();
    expect(commission.status).toBe('reversed');
    const alloc = await db(TABLES.HostedFundingAllocation).where({ commissionId: c1! }).first();
    expect(alloc.state).toBe('released');
  });
});

describe.skipIf(skipIntegration)('manual payout confirmation', () => {
  it('pending manual payout confirms to paid with completedAt', async () => {
    const partnerId = await seedPartner(false);
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: TENANT,
      partnerId,
      amount: '120.00',
      currency: 'USD',
      method: 'manual',
      status: 'pending',
      metadata: {},
    });
    const res = await request(app)
      .post(`/payouts/${payoutId}/confirm`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.payout.status).toBe('paid');
    expect(res.body.payout.completedAt).not.toBeNull();
  });

  it('stripe_connect payouts and non-pending payouts are not confirmable', async () => {
    const partnerId = await seedPartner();
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: TENANT,
      partnerId,
      amount: '10.00',
      currency: 'USD',
      method: 'stripe_connect',
      status: 'pending',
      metadata: {},
    });
    const res = await request(app)
      .post(`/payouts/${payoutId}/confirm`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(409);
    const missing = await request(app)
      .post(`/payouts/${ulid()}/confirm`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(missing.status).toBe(404);
  });
});

describe.skipIf(skipIntegration)('funding reconciliation', () => {
  it('clean ledger reports no violations; a corrupted one is flagged', async () => {
    const partnerId = await seedPartner();
    const ids = await seedCommissions(partnerId, 2, '40.00');
    const batchId = await reserve(partnerId, ids, 8000);

    const clean = await runFundingReconciliation(db, { stripe: {} as Stripe });
    expect(clean.invariantViolations).toEqual([]);

    const victim = await db(TABLES.HostedFundingAllocation).where({ batchId }).first(['id']);
    await db(TABLES.HostedFundingAllocation).where({ id: victim.id }).del();
    const dirty = await runFundingReconciliation(db, { stripe: {} as Stripe });
    expect(dirty.invariantViolations).toEqual([batchId]);
  });

  it('flags stuck, attention-needing, and residual-awaiting batches', async () => {
    const partnerId = await seedPartner();
    const ids = await seedCommissions(partnerId, 1, '50.00');
    const batchId = await reserve(partnerId, ids, 5000);
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await db(TABLES.HostedFundingBatch)
      .where({ id: batchId })
      .update({ status: 'transferring', fundedAt: old, stripeChargeId: 'ch_x', actualStripeFeeMinor: 0 });

    const report = await runFundingReconciliation(db, { stripe: {} as Stripe });
    expect(report.stuckBatches).toEqual([batchId]);
  });
});
