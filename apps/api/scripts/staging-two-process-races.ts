/**
 * TWO-PROCESS lease races — the one gap every prior staging run left open
 * (docs/audit-remaining-work.md §3: "the leases are single-process only so
 * far"). Every scenario here runs GENUINELY CONCURRENT OS processes with
 * separate DB connections against the same local Postgres, and — where
 * money moves — real Stripe TEST MODE, so the exactly-once claims are
 * proven against real interleaving rather than one event loop's polite
 * scheduling.
 *
 *   A  two executors race ONE fresh payout intent end-to-end
 *      → exactly one transfer exists at Stripe, paid exactly once
 *   A2 two executors race the reconcile+finalize of ONE held intent whose
 *      transfer already exists → finalized exactly once, never doubled
 *   B  two workers race the webhook inbox claim on the same 40 events
 *      → every event is claimed by exactly one worker
 *   C  two recovery apply-loops race the same 24 pending dispose requests
 *      → every request settles exactly once, attempts === 1
 *
 * REQUIRES a test-mode key; refuses live keys and non-local DATABASE_URL;
 * TRUNCATES product tables. Tops up the test-mode platform balance itself
 * (tok_bypassPending) so transfers never fail on balance.
 *
 *   cd apps/api
 *   set -a && . ../../.env && set +a
 *   export OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS=1 OPENPARTNER_TENANCY=single
 *   export STAGING_READY_ACCT=acct_...   # onboarded, transfers: active
 *   pnpm exec tsx scripts/staging-two-process-races.ts
 *
 * The same file is its own worker: the parent spawns `tsx <this file>`
 * with RACE_WORKER set, and each worker writes its outcomes as JSON to
 * RACE_OUT for the parent to aggregate. Workers rendezvous on ready-files
 * before racing, so a cold tsx start cannot hand one process the whole
 * workload (round 14).
 *
 * SCOPE, honestly (round 14): this harness proves MONEY-exactly-once and
 * claim-exactly-once under real process concurrency. It does not
 * discriminate every internal fence (e.g. an intent→posted CAS removed
 * while the frozen idempotency key still yields one transfer, or a stale
 * stamp after an expired inbox lease) — those interleavings need staged
 * seams and are owned by the unit suites (payout-transfer-intent /
 * funding-races / operator-recovery tests). The two layers together are
 * the claim; neither alone is.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';
import type { CommissionRow, PayoutRow } from '@openpartner/db';
import { db } from '../src/db.js';
import { runPayouts } from '../src/payouts.js';
import { executePayoutTransfers } from '../src/payout-transfers.js';
import { claimInboxEvent, stampInboxOutcome } from '../src/funding/inbox.js';
import { applyRecoveryRequests } from '../src/operator-recovery.js';

const TENANT = DEFAULT_TENANT_ID;
const READY_ACCT = process.env.STAGING_READY_ACCT!;
const SCRIPT = fileURLToPath(import.meta.url);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: undefined as never });

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass += 1; console.log(`    ok   ${label}`); }
  else {
    fail += 1; failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`    FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function note(s: string) { console.log(`    note ${s}`); }

async function reset() {
  await db(TABLES.OperatorRecoveryRequest).del();
  await db(TABLES.StripeWebhookInbox).del();
  await db(TABLES.Commission).del();
  await db(TABLES.Payout).del();
  await db(TABLES.Attribution).del();
  await db(TABLES.Event).del();
  // Identity precedes Click: its clickId FK does not cascade, so a
  // leftover Identity from another suite made this wipe fail HALFWAY
  // (round 14) — a partially-erased shared dev DB.
  await db(TABLES.Identity).del();
  await db(TABLES.Click).del();
  await db(TABLES.Link).del();
  await db(TABLES.Coupon).del();
  await db(TABLES.PartnerProgram).del();
  await db(TABLES.PartnerCommission).del();
  await db(TABLES.Program).del();
  await db(TABLES.Partner).del();
}

async function seedPartner(): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id, tenantId: TENANT, email: `p${id}@x.test`, name: 'Race P',
    stripeConnectAccountId: READY_ACCT, metadata: { stripe: { payoutsEnabled: true } },
  });
  return id;
}

async function seedApproved(partnerId: string, amount = '11.00'): Promise<string> {
  const programId = ulid();
  await db(TABLES.Program).insert({
    id: programId, tenantId: TENANT, name: 'prog',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl: 'https://x.test', attributionWindowDays: 60, attributionModel: 'last_click',
  });
  const clickId = ulid();
  await db(TABLES.Click).insert({
    id: clickId, tenantId: TENANT, partnerId, programId, landingUrl: 'https://x.test/', ts: new Date(),
  });
  const eventId = ulid();
  await db(TABLES.Event).insert({
    id: eventId, tenantId: TENANT, userId: `u-${clickId}`, type: 'invoice_paid',
    value: amount, currency: 'USD', ts: new Date(),
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
  return commissionId;
}

async function transfersForGroup(group: string): Promise<Stripe.Transfer[]> {
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

const scratchFiles: string[] = [];

/** Spawn this same file as a worker and resolve with its parsed RACE_OUT. */
function spawnWorker(
  race: string,
  outFile: string,
  extraEnv: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', SCRIPT], {
      cwd: process.cwd(),
      shell: true, // Windows: resolve pnpm through the shell
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, RACE_WORKER: race, RACE_OUT: outFile, ...extraEnv },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`worker ${race} exited ${code}`));
      try { resolve(JSON.parse(readFileSync(outFile, 'utf8'))); }
      catch (e) { reject(e); }
    });
  });
}

function outPath(tag: string): string {
  const p = `${process.env.TEMP ?? '/tmp'}/race-${tag}-${process.pid}-${ulid()}.json`;
  scratchFiles.push(p);
  return p;
}

/** Spawn BOTH workers for a race with a ready-file rendezvous: each writes
 *  its ready marker, then waits (bounded) for the sibling's before racing,
 *  so tsx cold-start skew cannot hand one process the whole workload. */
function spawnPair(
  race: string,
  tag: string,
  extraEnv: Record<string, string> = {},
): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  const ready1 = outPath(`${tag}-r1`);
  const ready2 = outPath(`${tag}-r2`);
  return Promise.all([
    spawnWorker(race, outPath(`${tag}-1`), { ...extraEnv, RACE_READY_SELF: ready1, RACE_READY_PEER: ready2 }),
    spawnWorker(race, outPath(`${tag}-2`), { ...extraEnv, RACE_READY_SELF: ready2, RACE_READY_PEER: ready1 }),
  ]);
}

/** Worker side of the rendezvous. Proceeds after 20s even if the sibling
 *  never shows — a dead sibling must not hang the run. */
async function awaitBarrier(): Promise<void> {
  const self = process.env.RACE_READY_SELF;
  const peer = process.env.RACE_READY_PEER;
  if (!self || !peer) return;
  writeFileSync(self, 'ready');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !existsSync(peer)) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ------------------------------------------------------------ worker bodies

async function workerIntentRace(): Promise<void> {
  // Hammer the executor for a fixed window. Every safety property must
  // hold whatever the interleaving — the parent asserts the outcome.
  const until = Date.now() + 30_000;
  let passes = 0;
  while (Date.now() < until) {
    await executePayoutTransfers(db, { tenantId: TENANT });
    passes += 1;
    const payout = (await db<PayoutRow>(TABLES.Payout)
      .where({ tenantId: TENANT })
      .first()) as PayoutRow | undefined;
    const state = (payout?.metadata as { transferState?: string } | null)?.transferState;
    if (state === 'confirmed' || state === 'canceled' || state === 'duplicate_review') break;
    await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 100)));
  }
  writeFileSync(process.env.RACE_OUT!, JSON.stringify({ passes }));
}

async function workerInboxRace(): Promise<void> {
  const eventIds: string[] = JSON.parse(process.env.RACE_EVENT_IDS!);
  let claimed = 0;
  const claimedIds: string[] = [];
  for (const eventId of eventIds) {
    const res = await claimInboxEvent(db, eventId, 'payment_intent.succeeded');
    if (res.status === 'claimed') {
      claimed += 1;
      claimedIds.push(eventId);
      // Simulate handler work inside the lease, then stamp — the window
      // where the sibling must answer 'held', never 'claimed'.
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20)));
      await stampInboxOutcome(db, eventId, 'processed', res.token);
    }
  }
  writeFileSync(process.env.RACE_OUT!, JSON.stringify({ claimed, claimedIds }));
}

async function workerRecoveryRace(): Promise<void> {
  let processed = 0;
  let applied = 0;
  for (let i = 0; i < 4; i += 1) {
    const result = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    processed += result.processed;
    applied += result.applied.length;
    await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 60)));
  }
  writeFileSync(process.env.RACE_OUT!, JSON.stringify({ processed, applied }));
}

// -------------------------------------------------------------- scenarios

async function raceAFreshIntent() {
  console.log('\n[A] Two processes race one FRESH intent — exactly one transfer, paid once');
  await reset();
  const partnerId = await seedPartner();
  const commissionId = await seedApproved(partnerId);
  const planned = await db.transaction(async (trx) => runPayouts(trx, TENANT));
  const payoutId = planned.payouts[0]?.payoutId;
  check('A: intent planned', !!payoutId, JSON.stringify(planned.skippedUnfunded ?? []));
  if (!payoutId) return;

  const [w1, w2] = await spawnPair('intent', 'a');
  console.log(`    (worker passes: ${w1.passes} + ${w2.passes})`);

  const transfers = await transfersForGroup(payoutId);
  check('A: EXACTLY ONE transfer at Stripe', transfers.length === 1, `got ${transfers.length}`);
  const payout = (await db<PayoutRow>(TABLES.Payout).where({ id: payoutId }).first()) as PayoutRow;
  const meta = payout.metadata as { transferState?: string };
  if (meta.transferState === 'posted') {
    // A legitimate landing (round 14): a Stripe attempt that stalls past
    // the workers' window leaves the intent safely posted under its warm
    // lease — the 180s cooldown means neither worker may touch it again,
    // and a later scheduler tick finalizes. One transfer + held-not-doubled
    // IS the exactly-once property; finalization timing is not.
    note('intent still posted at window end (slow Stripe attempt) — safe hold, one transfer, finalization belongs to a later tick');
    check('A: held safely, nothing doubled', transfers.length === 1 && payout.status !== 'paid',
      `${payout.status}`);
  } else {
    check('A: payout confirmed + paid once', meta.transferState === 'confirmed' && payout.status === 'paid',
      `${meta.transferState}/${payout.status}`);
    check('A: recorded transfer is THE transfer',
      transfers.length === 1 && payout.stripeTransferId === transfers[0]!.id,
      `${payout.stripeTransferId} vs ${transfers[0]?.id}`);
    const commission = (await db<CommissionRow>(TABLES.Commission)
      .where({ id: commissionId }).first()) as CommissionRow;
    check('A: commission paid exactly once, still claimed by this payout',
      commission.status === 'paid' && commission.payoutId === payoutId,
      `${commission.status}/${commission.payoutId}`);
  }
}

async function raceA2ReconcileDuel() {
  console.log('\n[A2] Two processes race the reconcile+finalize of one HELD intent');
  await reset();
  const partnerId = await seedPartner();
  const commissionId = await seedApproved(partnerId);
  const planned = await db.transaction(async (trx) => runPayouts(trx, TENANT));
  const payoutId = planned.payouts[0]?.payoutId;
  check('A2: intent planned', !!payoutId);
  if (!payoutId) return;

  // The transfer already exists at Stripe (generation 0, matching the
  // frozen intent), but the row believes it is still unresolved and past
  // the window — the exact state two reconciling executors fight over.
  const meta = (await db<PayoutRow>(TABLES.Payout).where({ id: payoutId }).first()) as PayoutRow;
  const amountMinor = (meta.metadata as { amountMinor?: number }).amountMinor!;
  const existing = await stripe.transfers.create({
    amount: amountMinor, currency: 'usd', destination: READY_ACCT,
    transfer_group: payoutId,
    metadata: {
      openpartner_payout_id: payoutId, openpartner_tenant_id: TENANT,
      openpartner_key_generation: '0', mode: 'staging',
    },
  });
  await db(TABLES.Payout).where({ id: payoutId }).update({
    metadata: db.raw(`"metadata" || ?::jsonb`, [JSON.stringify({
      transferState: 'reconcile_required',
      postedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    })]),
  });

  await spawnPair('intent', 'a2');

  const transfers = await transfersForGroup(payoutId);
  check('A2: STILL exactly one transfer (no re-post of a found payment)',
    transfers.length === 1, `got ${transfers.length}`);
  const payout = (await db<PayoutRow>(TABLES.Payout).where({ id: payoutId }).first()) as PayoutRow;
  check('A2: finalized once against the found transfer',
    payout.status === 'paid' && payout.stripeTransferId === existing.id,
    `${payout.status}/${payout.stripeTransferId}`);
  const commission = (await db<CommissionRow>(TABLES.Commission)
    .where({ id: commissionId }).first()) as CommissionRow;
  check('A2: commission paid exactly once', commission.status === 'paid', commission.status);
}

async function raceBInboxClaims() {
  console.log('\n[B] Two processes race the inbox claim on the same 40 events');
  await reset();
  const eventIds = Array.from({ length: 40 }, () => `evt_race_${ulid()}`);
  const [w1, w2] = await spawnPair('inbox', 'b', { RACE_EVENT_IDS: JSON.stringify(eventIds) });
  const c1 = new Set(w1.claimedIds as string[]);
  const c2 = new Set(w2.claimedIds as string[]);
  const both = eventIds.filter((id) => c1.has(id) && c2.has(id));
  const neither = eventIds.filter((id) => !c1.has(id) && !c2.has(id));
  console.log(`    (claims: worker1=${c1.size}, worker2=${c2.size})`);
  check('B: NO event was claimed by both processes', both.length === 0, both.join(','));
  check('B: every event was claimed by someone', neither.length === 0, neither.join(','));
  const rows = (await db(TABLES.StripeWebhookInbox)
    .whereIn('stripeEventId', eventIds)) as Array<{ outcome: string | null }>;
  check('B: every event processed exactly once (stamped)',
    rows.length === 40 && rows.every((r) => r.outcome === 'processed'),
    `${rows.length} rows, ${rows.filter((r) => r.outcome !== 'processed').length} unstamped`);
  check('B: contention was real (both processes won some claims)',
    c1.size > 0 && c2.size > 0, `${c1.size}/${c2.size}`);
}

async function raceCRecoveryClaims() {
  console.log('\n[C] Two recovery apply-loops race the same 24 pending requests');
  await reset();
  // 24 held intents, each with a pending dispose request. Empty transfer
  // groups at Stripe, so every dispose verifies clean and applies.
  const requestIds: string[] = [];
  for (let i = 0; i < 24; i += 1) {
    const partnerId = await seedPartner();
    await seedApproved(partnerId);
  }
  const planned = await db.transaction(async (trx) => runPayouts(trx, TENANT));
  check('C: 24 intents planned', planned.payouts.length === 24, String(planned.payouts.length));
  for (const p of planned.payouts) {
    await db(TABLES.Payout).where({ id: p.payoutId }).update({
      metadata: db.raw(`"metadata" || ?::jsonb`, [JSON.stringify({
        transferState: 'reconcile_required',
        postedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      })]),
    });
    const id = ulid();
    requestIds.push(id);
    await db(TABLES.OperatorRecoveryRequest).insert({
      id, tenantId: TENANT, rail: 'direct_connect', kind: 'dispose_intent',
      targetId: p.payoutId, params: JSON.stringify({ reason: 'two-process race' }),
      requestedBy: 'race@op.example', status: 'pending',
    });
  }

  const [w1, w2] = await spawnPair('recovery', 'c');
  console.log(`    (processed: worker1=${w1.processed}, worker2=${w2.processed})`);

  const rows = (await db(TABLES.OperatorRecoveryRequest)
    .whereIn('id', requestIds)) as Array<{ id: string; status: string; attempts: number; outcome: string | null }>;
  check('C: every request settled applied', rows.every((r) => r.status === 'applied'),
    rows.filter((r) => r.status !== 'applied').map((r) => `${r.id}:${r.status}/${r.outcome}`).join(','));
  check('C: every request claimed EXACTLY once (attempts === 1)',
    rows.every((r) => r.attempts === 1),
    rows.filter((r) => r.attempts !== 1).map((r) => `${r.id}:${r.attempts}`).join(','));
  check('C: work summed exactly once across processes',
    Number(w1.processed) + Number(w2.processed) === 24,
    `${w1.processed}+${w2.processed}`);
}

// -------------------------------------------------------------------- main

async function main() {
  // The refusals gate EVERY mode. Worker mode used to skip them (round
  // 14), which meant a hand-run `RACE_WORKER=intent` against a prod
  // DATABASE_URL with a live key would execute real payouts with no
  // guard in its way. Workers run the same money loops the parent does;
  // they refuse the same environments.
  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test')) {
    console.error('REFUSING: STRIPE_SECRET_KEY is not a test-mode key.'); process.exit(2);
  }
  if (!/@(localhost|127\.0\.0\.1|postgres)[:/]/.test(process.env.DATABASE_URL ?? '')) {
    console.error('REFUSING: DATABASE_URL is not local — this script truncates tables.'); process.exit(2);
  }
  if (!READY_ACCT) {
    console.error('REFUSING: set STAGING_READY_ACCT.'); process.exit(2);
  }

  if (process.env.RACE_WORKER) {
    // Worker mode: rendezvous with the sibling, run one body, exit.
    await awaitBarrier();
    if (process.env.RACE_WORKER === 'intent') await workerIntentRace();
    else if (process.env.RACE_WORKER === 'inbox') await workerInboxRace();
    else if (process.env.RACE_WORKER === 'recovery') await workerRecoveryRace();
    await db.destroy();
    return;
  }

  console.log('Two-process lease races — real processes, real Stripe test mode');
  // Balance for the direct transfers — top up only when actually low, so
  // repeated runs don't pile balance onto the shared test account.
  const balance = await stripe.balance.retrieve();
  const usd = balance.available.find((b) => b.currency === 'usd')?.amount ?? 0;
  if (usd < 20_000) {
    await stripe.charges.create({ amount: 200000, currency: 'usd', source: 'tok_bypassPending' });
  }

  try {
    await raceAFreshIntent();
    await raceA2ReconcileDuel();
    await raceBInboxClaims();
    await raceCRecoveryClaims();
  } finally {
    for (const f of scratchFiles) { try { unlinkSync(f); } catch { /* already gone */ } }
  }

  console.log(`\n================ ${pass} passed, ${fail} failed ================`);
  if (failures.length) { console.log('Failures:'); for (const f of failures) console.log(`  - ${f}`); }
  await reset();
  await db.destroy();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('DRIVER ERROR', e);
  await db.destroy();
  process.exit(2);
});
