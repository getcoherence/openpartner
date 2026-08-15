/**
 * Direct-Connect payout staging matrix (docs/direct-connect-payouts.md §
 * "Staging checklist before trusting it with real money") executed against
 * REAL Stripe TEST MODE.
 *
 * Not a unit test, and deliberately not in __tests__: the whole point is that
 * a Stripe mock cannot tell us how Stripe actually behaves — how idempotency
 * replay behaves, what a real 4xx looks like, what listing returns.
 *
 * WHAT THIS DOES NOT PROVE. It does not exercise the lease against a genuinely
 * concurrent in-flight POST: the injected failures happen after the real
 * request has fully returned. An earlier version of this header claimed it
 * covered round 5's lease-vs-request-budget property; it never did, and that
 * property turned out to be unprovable anyway (round 6 — stripe-node's timeout
 * is socket-inactivity, so no cooldown bounds a request). Scenario 7 races two
 * executors over one intent, which is the closest this gets to concurrency.
 *
 * REQUIRES A TEST-MODE KEY. It refuses to run against sk_live. It also needs
 * available platform balance; top up in test mode with:
 *   stripe post /v1/charges -d amount=200000 -d currency=usd -d source=tok_bypassPending
 *
 * It TRUNCATES the product tables of whatever DATABASE_URL points at. Point
 * it at a local database, never prod.
 *
 *   cd apps/api
 *   set -a && . ../../.env && set +a
 *   export OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS=1 OPENPARTNER_TENANCY=single
 *   export STAGING_READY_ACCT=acct_...    # onboarded, transfers: active
 *   export STAGING_UNREADY_ACCT=acct_...  # not onboarded — scenario 6
 *   pnpm exec tsx scripts/staging-direct-connect.ts
 *
 * Exit code is 0 only if every assertion passed.
 */

import Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';
import { db } from '../src/db.js';
import { runPayouts } from '../src/payouts.js';
import { executePayoutTransfers, releaseIntentForRetry } from '../src/payout-transfers.js';

const TENANT = DEFAULT_TENANT_ID;
const READY_ACCT = process.env.STAGING_READY_ACCT!;
const UNREADY_ACCT = process.env.STAGING_UNREADY_ACCT!;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: undefined as never });

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`    ok   ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`    FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function reset() {
  await db(TABLES.Commission).del();
  await db(TABLES.Payout).del();
  await db(TABLES.Attribution).del();
  await db(TABLES.Event).del();
  await db(TABLES.Click).del();
  await db(TABLES.Link).del();
  await db(TABLES.Program).del();
  await db(TABLES.Partner).del();
}

async function seedPartner(acct: string | null, payoutsEnabled = true): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: TENANT,
    email: `p${id}@x.test`,
    name: 'Staging P',
    stripeConnectAccountId: acct,
    metadata: acct ? { stripe: { payoutsEnabled } } : {},
  });
  return id;
}

async function seedApproved(partnerId: string, n: number, amount = '12.00'): Promise<string[]> {
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
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId, tenantId: TENANT, partnerId, programId,
      landingUrl: 'https://x.test/', ts: new Date(),
    });
    const eventId = ulid();
    await db(TABLES.Event).insert({
      id: eventId, tenantId: TENANT, userId: `u-${clickId}`,
      type: 'invoice_paid', value: amount, currency: 'USD', ts: new Date(),
    });
    const attributionId = ulid();
    await db(TABLES.Attribution).insert({
      id: attributionId, tenantId: TENANT, eventId, partnerId, programId,
      clickId, model: 'last_click', weight: '1.0000',
    });
    const commissionId = ulid();
    await db(TABLES.Commission).insert({
      id: commissionId, tenantId: TENANT, attributionId, partnerId,
      amount, currency: 'USD', status: 'approved',
    });
    ids.push(commissionId);
  }
  return ids;
}

async function plan() {
  return db.transaction(async (trx) => runPayouts(trx, TENANT));
}

async function transfersForGroup(group: string) {
  const out: Stripe.Transfer[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.transfers.list({
      transfer_group: group, limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]!.id;
  }
  return out;
}

async function payoutRow(id: string) {
  return db(TABLES.Payout).where({ id }).first() as Promise<
    { id: string; status: string; metadata: Record<string, unknown> } | undefined
  >;
}

// ---------------------------------------------------------------- scenarios

async function s1Happy() {
  console.log('\n[1] Happy path — one transfer, payout paid, commissions paid');
  await reset();
  const partnerId = await seedPartner(READY_ACCT);
  await seedApproved(partnerId, 2, '12.00');
  const { payouts } = await plan();
  check('planner produced one payout', payouts.length === 1, `got ${payouts.length}`);
  const payoutId = payouts[0]!.payoutId;

  const before = await payoutRow(payoutId);
  check("intent committed before any Stripe call", before?.metadata?.transferState === 'intent',
    String(before?.metadata?.transferState));
  const claimedBefore = await db(TABLES.Commission).where({ payoutId }).count<{ count: string }[]>('* as count');
  check('commissions frozen by the planner', Number(claimedBefore[0]!.count) === 2);

  const res = await executePayoutTransfers(db, { stripe });
  check('executor confirmed it', res.confirmed.length === 1, JSON.stringify(res));

  const after = await payoutRow(payoutId);
  check("payout status = paid", after?.status === 'paid', String(after?.status));
  check("transferState = confirmed", after?.metadata?.transferState === 'confirmed',
    String(after?.metadata?.transferState));

  const transfers = await transfersForGroup(payoutId);
  check('EXACTLY ONE transfer at Stripe', transfers.length === 1, `got ${transfers.length}`);
  check('transfer amount = 24.00 USD', transfers[0]?.amount === 2400, String(transfers[0]?.amount));
  check('stamped with our payout id', transfers[0]?.metadata?.openpartner_payout_id === payoutId);

  const paid = await db(TABLES.Commission).where({ payoutId, status: 'paid' }).count<{ count: string }[]>('* as count');
  check('both commissions marked paid', Number(paid[0]!.count) === 2);
  return payoutId;
}

async function s2CommitCrash() {
  console.log('\n[2] Injected commit failure — planner committed, executor never ran');
  await reset();
  const partnerId = await seedPartner(READY_ACCT);
  await seedApproved(partnerId, 1, '15.00');
  const { payouts } = await plan();
  const payoutId = payouts[0]!.payoutId;
  // Simulates the process dying between the planner's COMMIT and the
  // executor: the intent is durable, nothing was sent to Stripe.
  const mid = await payoutRow(payoutId);
  check('intent survived the "crash"', mid?.metadata?.transferState === 'intent');
  check('no transfer exists yet', (await transfersForGroup(payoutId)).length === 0);

  // A later scheduler tick picks it up.
  const res = await executePayoutTransfers(db, { stripe });
  check('recovery tick confirmed it', res.confirmed.length === 1, JSON.stringify(res));
  check('EXACTLY ONE transfer after recovery', (await transfersForGroup(payoutId)).length === 1);
  const after = await payoutRow(payoutId);
  check('payout paid', after?.status === 'paid');
}

async function s3AmbiguousTimeout() {
  console.log('\n[3] Injected timeout — Stripe SUCCEEDS, we never hear the answer');
  await reset();
  const partnerId = await seedPartner(READY_ACCT);
  await seedApproved(partnerId, 1, '17.00');
  const { payouts } = await plan();
  const payoutId = payouts[0]!.payoutId;

  // The dangerous shape: the transfer really is created, then the response
  // is lost. A network error carries no statusCode, so it must classify as
  // ambiguous — releasing the claims here is the double-pay.
  let realCreate = 0;
  const flaky = {
    ...stripe,
    transfers: {
      ...stripe.transfers,
      create: async (params: Stripe.TransferCreateParams, opts?: Stripe.RequestOptions) => {
        realCreate += 1;
        await stripe.transfers.create(params, opts); // really happens at Stripe
        const err = new Error('socket hang up') as Error & { type?: string };
        err.type = 'StripeConnectionError';
        throw err;
      },
      list: stripe.transfers.list.bind(stripe.transfers),
      retrieve: stripe.transfers.retrieve.bind(stripe.transfers),
    },
  } as unknown as Stripe;

  const res1 = await executePayoutTransfers(db, { stripe: flaky });
  check('classified AMBIGUOUS, not failed', res1.ambiguous.includes(payoutId), JSON.stringify(res1));
  check('the transfer really was created', realCreate === 1);

  const held = await payoutRow(payoutId);
  check('intent held as posted', held?.metadata?.transferState === 'posted',
    String(held?.metadata?.transferState));
  const stillClaimed = await db(TABLES.Commission).where({ payoutId }).whereNot({ status: 'paid' });
  check('commissions STILL claimed (not released)', stillClaimed.length === 1);

  // Immediate retry must be refused by the cooldown, not re-POSTed.
  const res2 = await executePayoutTransfers(db, { stripe });
  check('retry inside cooldown does not post', (await transfersForGroup(payoutId)).length === 1,
    `transfers=${(await transfersForGroup(payoutId)).length}`);

  // Past the cooldown (but inside Stripe's 24h window) the frozen key is
  // replayed — Stripe must return the SAME transfer, not create a second.
  const later = () => new Date(Date.now() + 5 * 60 * 1000);
  const res3 = await executePayoutTransfers(db, { stripe, now: later });
  const transfers = await transfersForGroup(payoutId);
  check('STILL exactly one transfer after key replay', transfers.length === 1, `got ${transfers.length}`);
  check('payout resolved to paid', (await payoutRow(payoutId))?.status === 'paid',
    JSON.stringify({ res2: res2.processed, res3 }));
  return payoutId;
}

async function s4PastWindow() {
  console.log('\n[4] Past the 24h window — reconcile by listing, never re-POST');
  await reset();
  const partnerId = await seedPartner(READY_ACCT);
  await seedApproved(partnerId, 1, '19.00');
  const { payouts } = await plan();
  const payoutId = payouts[0]!.payoutId;

  // Post it for real, but lose the answer, so the intent stays `posted`.
  const flaky = {
    ...stripe,
    transfers: {
      ...stripe.transfers,
      create: async (p: Stripe.TransferCreateParams, o?: Stripe.RequestOptions) => {
        await stripe.transfers.create(p, o);
        const err = new Error('timeout') as Error & { type?: string };
        err.type = 'StripeConnectionError';
        throw err;
      },
      list: stripe.transfers.list.bind(stripe.transfers),
      retrieve: stripe.transfers.retrieve.bind(stripe.transfers),
    },
  } as unknown as Stripe;
  await executePayoutTransfers(db, { stripe: flaky });
  check('one transfer exists at Stripe', (await transfersForGroup(payoutId)).length === 1);

  // Now run 25h later. The key may be pruned, so a re-POST would create a
  // SECOND transfer; the executor must list instead.
  let created = 0;
  const counting = {
    ...stripe,
    transfers: {
      ...stripe.transfers,
      create: async (p: Stripe.TransferCreateParams, o?: Stripe.RequestOptions) => {
        created += 1;
        return stripe.transfers.create(p, o);
      },
      list: stripe.transfers.list.bind(stripe.transfers),
      retrieve: stripe.transfers.retrieve.bind(stripe.transfers),
    },
  } as unknown as Stripe;
  const res = await executePayoutTransfers(db, {
    stripe: counting,
    now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
  });
  check('did NOT call transfers.create', created === 0, `create called ${created}x`);
  check('resolved by reconcile', res.reconciled.includes(payoutId) || res.confirmed.length === 1,
    JSON.stringify(res));
  check('STILL exactly one transfer', (await transfersForGroup(payoutId)).length === 1);
  check('payout paid', (await payoutRow(payoutId))?.status === 'paid');
}

async function s5SetChange() {
  console.log('\n[5] Commission approved while an intent is open — no overlap');
  await reset();
  const partnerId = await seedPartner(READY_ACCT);
  await seedApproved(partnerId, 1, '21.00');
  const { payouts: first } = await plan();
  const p1 = first[0]!.payoutId;

  // New commission approved while p1 is still an open intent.
  await seedApproved(partnerId, 1, '31.00');
  const { payouts: second } = await plan();
  check('a SECOND, separate intent was planned', second.length === 1, JSON.stringify(second));
  const p2 = second[0]!.payoutId;
  check('the two intents are distinct', p1 !== p2);

  const claimed1 = await db(TABLES.Commission).where({ payoutId: p1 });
  const claimed2 = await db(TABLES.Commission).where({ payoutId: p2 });
  check('first intent still holds exactly its own commission', claimed1.length === 1);
  check('second intent holds only the new one', claimed2.length === 1);
  check('no commission is in both', claimed1[0]!.id !== claimed2[0]!.id);

  await executePayoutTransfers(db, { stripe });
  const t1 = await transfersForGroup(p1);
  const t2 = await transfersForGroup(p2);
  check('one transfer per intent', t1.length === 1 && t2.length === 1, `${t1.length}/${t2.length}`);
  check('amounts are 21.00 and 31.00, no overlap',
    new Set([t1[0]?.amount, t2[0]?.amount]).size === 2 &&
    (t1[0]!.amount + t2[0]!.amount) === 5200,
    `${t1[0]?.amount} + ${t2[0]?.amount}`);
}

async function s6DefiniteFailure() {
  console.log('\n[6] Definite failure — unready destination, claims must be released');
  await reset();
  const partnerId = await seedPartner(UNREADY_ACCT);
  await seedApproved(partnerId, 1, '23.00');
  const { payouts } = await plan();
  if (payouts.length === 0) {
    // This used to report success here, which meant a misconfiguration
    // that stopped the planner producing anything at all looked exactly
    // like "Stripe definitively rejected the transfer". The whole point
    // of this scenario is the REAL 4xx, so not reaching Stripe is a
    // failure of the scenario, not a pass.
    check(
      'planner produced an intent to send (scenario requires reaching Stripe)',
      false,
      'planner returned no payout — check OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS / mode',
    );
    return;
  }
  const payoutId = payouts[0]!.payoutId;
  const res = await executePayoutTransfers(db, { stripe });
  const after = await payoutRow(payoutId);
  check('payout failed', after?.status === 'failed', `${after?.status} ${JSON.stringify(res)}`);
  check('no transfer at Stripe', (await transfersForGroup(payoutId)).length === 0);
  const released = await db(TABLES.Commission).whereNull('payoutId').where({ status: 'approved' });
  check('commissions RELEASED back to the pool', released.length === 1, `got ${released.length}`);
}

async function s7ConcurrentExecutors() {
  console.log('\n[7] Two executors racing ONE intent — the CAS is the only thing stopping them');
  await reset();
  const partnerId = await seedPartner(READY_ACCT);
  await seedApproved(partnerId, 1, '27.00');
  const { payouts } = await plan();
  const payoutId = payouts[0]!.payoutId;

  // Genuinely concurrent, against real Stripe. Both workers see an
  // `intent` row and both try to claim it; only one may post.
  const [a, b] = await Promise.all([
    executePayoutTransfers(db, { stripe }),
    executePayoutTransfers(db, { stripe }),
  ]);

  const transfers = await transfersForGroup(payoutId);
  check('EXACTLY ONE transfer despite two concurrent executors', transfers.length === 1,
    `got ${transfers.length}`);
  const confirmedBy = [...a.confirmed, ...b.confirmed].filter((c) => c.payoutId === payoutId);
  check('exactly one executor recorded it', confirmedBy.length === 1,
    JSON.stringify({ a: a.confirmed, b: b.confirmed }));
  check('payout paid', (await payoutRow(payoutId))?.status === 'paid');
  const paid = await db(TABLES.Commission).where({ payoutId, status: 'paid' });
  check('commission paid exactly once', paid.length === 1);
}

async function s8HoldNotRearm() {
  console.log('\n[8] Past the window with NOTHING at Stripe — must HOLD, never re-arm (round 6)');
  await reset();
  const partnerId = await seedPartner(READY_ACCT);
  await seedApproved(partnerId, 1, '29.00');
  const { payouts } = await plan();
  const payoutId = payouts[0]!.payoutId;

  // Claim it as posted 25h ago without ever contacting Stripe: this is
  // the shape of "we lost the response and nothing actually landed".
  await db(TABLES.Payout)
    .where({ id: payoutId })
    .update({
      metadata: db.raw(`"metadata" || ?::jsonb`, [
        JSON.stringify({
          transferState: 'posted',
          postedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
          leaseAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        }),
      ]),
    });

  let created = 0;
  const counting = {
    ...stripe,
    transfers: {
      ...stripe.transfers,
      create: async (p: Stripe.TransferCreateParams, o?: Stripe.RequestOptions) => {
        created += 1;
        return stripe.transfers.create(p, o);
      },
      list: stripe.transfers.list.bind(stripe.transfers),
      retrieve: stripe.transfers.retrieve.bind(stripe.transfers),
    },
  } as unknown as Stripe;

  // Several ticks. None may talk itself into posting.
  await executePayoutTransfers(db, { stripe: counting });
  await executePayoutTransfers(db, { stripe: counting });
  await executePayoutTransfers(db, { stripe: counting });

  check('never posted on its own', created === 0, `create called ${created}x`);
  check('no transfer at Stripe', (await transfersForGroup(payoutId)).length === 0);
  const held = await payoutRow(payoutId);
  check('HELD in reconcile_required', held?.metadata?.transferState === 'reconcile_required',
    String(held?.metadata?.transferState));
  check('still on generation 0 (no self-re-arm)',
    Number(held?.metadata?.keyGeneration ?? 0) === 0, String(held?.metadata?.keyGeneration));
  const stillClaimed = await db(TABLES.Commission).where({ payoutId });
  check('commissions stay frozen while held', stillClaimed.length === 1);

  // The operator is the only way forward, and then it posts once.
  // Pass the REAL client so the round-7 listing guard is exercised against
  // Stripe rather than skipped — this is the only place it runs for real.
  const outcome = await releaseIntentForRetry(db, payoutId, 0, 'staging-matrix', stripe);
  check('operator re-arm accepted', outcome === 'rearmed', String(outcome));
  await executePayoutTransfers(db, { stripe: counting });
  check('posts exactly once after operator authorisation', created === 1, `create called ${created}x`);

  // And now the REFUSAL, against real Stripe. This scenario only ever
  // tested acceptance, so removing the listing guard entirely produced the
  // same result (round 8). A transfer now genuinely exists in the group, so
  // a second re-arm attempt must be refused on positive evidence.
  await db(TABLES.Payout)
    .where({ id: payoutId })
    .update({
      metadata: db.raw(`"metadata" || ?::jsonb`, [
        JSON.stringify({ transferState: 'reconcile_required', keyGeneration: 1 }),
      ]),
    });
  const refused = await releaseIntentForRetry(db, payoutId, 1, 'staging-matrix', stripe);
  check('a second re-arm is REFUSED once a transfer exists', refused === 'transfer_exists',
    String(refused));
  check('one transfer at Stripe', (await transfersForGroup(payoutId)).length === 1);
  check('payout paid', (await payoutRow(payoutId))?.status === 'paid');
}

// -------------------------------------------------------------------- main

async function main() {
  // This script truncates tables and moves money. Both guards are hard stops:
  // a live key here would make real transfers, and a remote DATABASE_URL would
  // wipe someone's data.
  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test')) {
    console.error('REFUSING: STRIPE_SECRET_KEY is not a test-mode key.');
    process.exit(2);
  }
  const dbUrl = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1|postgres)[:/]/.test(dbUrl)) {
    console.error(`REFUSING: DATABASE_URL is not local — this script truncates tables.`);
    process.exit(2);
  }
  if (!READY_ACCT || !UNREADY_ACCT) {
    console.error('REFUSING: set STAGING_READY_ACCT and STAGING_UNREADY_ACCT.');
    process.exit(2);
  }

  console.log('Direct-Connect payout matrix — REAL Stripe test mode');
  console.log(`  ready destination:   ${READY_ACCT}`);
  console.log(`  unready destination: ${UNREADY_ACCT}`);

  await s1Happy();
  await s2CommitCrash();
  await s3AmbiguousTimeout();
  await s4PastWindow();
  await s5SetChange();
  await s6DefiniteFailure();
  await s7ConcurrentExecutors();
  await s8HoldNotRearm();

  console.log(`\n================ ${pass} passed, ${fail} failed ================`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  await reset();
  await db.destroy();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('DRIVER ERROR', e);
  await db.destroy();
  process.exit(2);
});
