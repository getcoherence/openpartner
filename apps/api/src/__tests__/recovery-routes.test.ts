/**
 * Operator-recovery API (decision B, audit handoff §0.4): validation, the
 * duplicate-pending guard, the inline apply, and tenant scoping of the
 * target lookup. The apply loop's own behavior is covered in
 * operator-recovery.test.ts — here the subject is the HTTP surface.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';

const ADMIN_KEY = 'op_test_admin_key_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;

// The inline apply reaches the module-level Stripe client — mock it so the
// dispose path sees an empty transfer group and settles synchronously.
vi.mock('../stripe.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../stripe.js')>();
  return {
    ...original,
    stripe: {
      transfers: {
        list: vi.fn(async () => ({ data: [], has_more: false })),
        retrieve: vi.fn(async () => {
          throw Object.assign(new Error('no such transfer'), { code: 'resource_missing' });
        }),
      },
    },
  };
});

import { db } from '../db.js';
import { createApp } from '../app.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;
const app = createApp();

async function seedHeldPayout(): Promise<string> {
  const partnerId = ulid();
  await db(TABLES.Partner).insert({
    id: partnerId,
    tenantId: TENANT,
    email: `p${partnerId}@x.test`,
    name: 'P',
    stripeConnectAccountId: `acct_${partnerId.slice(0, 10)}`,
    metadata: { stripe: { payoutsEnabled: true } },
  });
  const payoutId = ulid();
  await db(TABLES.Payout).insert({
    id: payoutId,
    tenantId: TENANT,
    partnerId,
    amount: '50.00',
    currency: 'USD',
    status: 'pending',
    method: 'stripe_connect',
    metadata: JSON.stringify({
      transferState: 'reconcile_required',
      amountMinor: 5000,
      destinationAccountId: `acct_${partnerId.slice(0, 10)}`,
      mode: 'selfhost',
      attempts: 1,
      postedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    }),
  });
  return payoutId;
}

function post(path: string, body: object) {
  return request(app)
    .post(path)
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .set('content-type', 'application/json')
    .send(body);
}

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of [TABLES.OperatorRecoveryRequest, TABLES.Commission, TABLES.Payout, TABLES.Partner]) {
    await db(t).del();
  }
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of [TABLES.OperatorRecoveryRequest, TABLES.Payout, TABLES.Partner]) {
      await db(t).del();
    }
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('operator-recovery API', () => {
  it('requires admin auth', async () => {
    const res = await request(app)
      .post(`/payouts/${ulid()}/recovery`)
      .send({ kind: 'dispose_intent', reason: 'x' });
    expect(res.status).toBe(401);
  });

  it('404s on a payout that does not exist in this tenant', async () => {
    const res = await post(`/payouts/${ulid()}/recovery`, {
      kind: 'dispose_intent',
      reason: 'x',
    });
    expect(res.status).toBe(404);
    // and no request row was written
    expect(await db(TABLES.OperatorRecoveryRequest).first()).toBeUndefined();
  });

  it('rejects an unknown kind and a malformed disposition', async () => {
    const payoutId = await seedHeldPayout();
    expect((await post(`/payouts/${payoutId}/recovery`, { kind: 'force_release_batch', reason: 'x' })).status).toBe(400);
    expect(
      (
        await post(`/payouts/${payoutId}/recovery`, {
          kind: 'resolve_duplicate_review',
          keptTransferId: 'tr_x',
          allReversed: true, // both dispositions at once
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(`/payouts/${payoutId}/recovery`, { kind: 'resolve_duplicate_review' })).status, // neither
    ).toBe(400);
    expect(
      (await post(`/payouts/${payoutId}/recovery`, { kind: 'release_intent_for_retry' })).status, // no generation
    ).toBe(400);
  });

  it('creates, inline-applies, and reports the outcome synchronously', async () => {
    const payoutId = await seedHeldPayout();
    const res = await post(`/payouts/${payoutId}/recovery`, {
      kind: 'dispose_intent',
      reason: 'confirmed nothing at stripe',
      note: 'incident 2026-08-14',
    });
    expect(res.status).toBe(201);
    expect(res.body.request.status).toBe('applied');
    expect(res.body.request.outcome).toBe('disposed');
    expect(res.body.request.requestedBy).toBe('env_admin_key');
    expect(res.body.request.recheckDueAt).not.toBeNull();
    // the durable row exists and the payout actually moved
    const row = await db(TABLES.OperatorRecoveryRequest).where({ id: res.body.request.id }).first();
    expect(row.status).toBe('applied');
    const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
    expect((payout.metadata as { transferState?: string }).transferState).toBe('canceled');
  });

  it('409s a second pending request for the same target + kind', async () => {
    const payoutId = await seedHeldPayout();
    // Park a pending row directly (as if the inline apply had answered
    // cannot_verify and left it for the scheduler).
    const firstId = ulid();
    await db(TABLES.OperatorRecoveryRequest).insert({
      id: firstId,
      tenantId: TENANT,
      rail: 'direct_connect',
      kind: 'dispose_intent',
      targetId: payoutId,
      params: JSON.stringify({ reason: 'first' }),
      requestedBy: 'someone@x.test',
      status: 'pending',
    });
    const res = await post(`/payouts/${payoutId}/recovery`, {
      kind: 'dispose_intent',
      reason: 'second',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('request_already_pending');
    expect(res.body.requestId).toBe(firstId);
  });

  it('lists the tenant’s requests, filterable by target', async () => {
    const payoutId = await seedHeldPayout();
    await post(`/payouts/${payoutId}/recovery`, { kind: 'dispose_intent', reason: 'x' });
    const res = await request(app)
      .get(`/recovery-requests?targetId=${payoutId}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].targetId).toBe(payoutId);
    // operational plumbing stays internal
    expect(res.body.requests[0].leaseToken).toBeUndefined();
  });
});
