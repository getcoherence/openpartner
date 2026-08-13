/**
 * Hosted funding races — section H of docs/payout-funding-staging-runbook.md,
 * executed against REAL Stripe TEST MODE.
 *
 * Covers the three races the runbook calls "the ones that cost real money":
 * an ambiguous PaymentIntent create, a release racing a live PI, and the
 * webhook inbox lease. A mock cannot answer the question that matters here —
 * what Stripe actually does — so this drives the real API.
 *
 * REQUIRES A TEST-MODE KEY, and TRUNCATES the product tables of whatever
 * DATABASE_URL points at. Local database only.
 *
 *   cd apps/api
 *   set -a && . ../../.env && set +a
 *   export HOSTED_FUNDING_ENABLED=1 OPENPARTNER_TENANCY=single
 *   export STAGING_CUSTOMER=cus_...   # with a verified us_bank_account PM
 *   export STAGING_PM=pm_...          # attached, mandate established
 *   export STAGING_PARTNER_ACCT=acct_...
 *   pnpm exec tsx scripts/staging-funding-races.ts
 *
 * Fixture setup (one-off, test mode):
 *   stripe post /v1/customers -d name=... -d email=...
 *   stripe post /v1/payment_methods -d type=us_bank_account \
 *     -d "us_bank_account[account_number]=000123456789" \
 *     -d "us_bank_account[routing_number]=110000000" \
 *     -d "us_bank_account[account_holder_type]=individual" \
 *     -d "billing_details[name]=..." -d "billing_details[email]=..."
 *   stripe post /v1/setup_intents -d customer=cus_... -d payment_method=pm_... \
 *     -d "payment_method_types[]=us_bank_account" -d confirm=true \
 *     -d "mandate_data[customer_acceptance][type]=offline"
 *   stripe post /v1/setup_intents/seti_.../verify_microdeposits \
 *     -d "amounts[]=32" -d "amounts[]=45"
 */

import Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';
import type { HostedFundingBatchRow } from '@openpartner/db';
import { db } from '../src/db.js';
import { reserveFundingBatch } from '../src/funding/reserve.js';
import { runFundingCollector } from '../src/funding/collect.js';
import { releaseBatch } from '../src/funding/release.js';
import { claimInboxEvent, stampInboxOutcome, INBOX_CLAIM_LEASE_MS } from '../src/funding/inbox.js';
import { FUNDING_TERMS_VERSION } from '../src/funding/state.js';

const TENANT = DEFAULT_TENANT_ID;
const CUSTOMER = process.env.STAGING_CUSTOMER!;
const PM = process.env.STAGING_PM!;
const PARTNER_ACCT = process.env.STAGING_PARTNER_ACCT!;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: undefined as never });

let pass = 0;
let fail = 0;
const failures: string[] = [];
const notes: string[] = [];

function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass += 1; console.log(`    ok   ${label}`); }
  else {
    fail += 1; failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`    FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function note(s: string) { notes.push(s); console.log(`    note ${s}`); }

async function reset() {
  await db(TABLES.HostedFundingAllocation).del();
  await db(TABLES.HostedFundingTransfer).del().catch(() => {});
  await db(TABLES.HostedFundingBatch).del();
  await db(TABLES.StripeWebhookInbox).del();
  await db(TABLES.Commission).del();
  await db(TABLES.Payout).del();
  await db(TABLES.Attribution).del();
  await db(TABLES.Event).del();
  await db(TABLES.Click).del();
  await db(TABLES.Link).del();
  await db(TABLES.Program).del();
  await db(TABLES.Partner).del();
  await db(TABLES.HostedFundingAuthorization).del();
  await db(TABLES.HostedBillingState).del().catch(() => {});
}

async function seedTenantFunding() {
  await db(TABLES.Tenant).where({ id: TENANT }).update({ stripeCustomerId: CUSTOMER });
  await db(TABLES.HostedFundingAuthorization).insert({
    id: ulid(), tenantId: TENANT, adminId: null,
    termsVersion: FUNDING_TERMS_VERSION,
    stripePaymentMethodId: PM, paymentMethodType: 'us_bank_account',
    acceptedAt: new Date(), revokedAt: null,
  });
  await db(TABLES.HostedBillingState)
    .insert({ tenantId: TENANT, subscriptionStatus: 'active', delinquentFundingCount: 0, updatedAt: new Date() })
    .onConflict('tenantId').merge();
}

/** A partner with enough approved commission to clear the $25 batch floor. */
async function seedBatch(amount = '60.00'): Promise<{ batchId: string; partnerId: string; commissionIds: string[] }> {
  const partnerId = ulid();
  await db(TABLES.Partner).insert({
    id: partnerId, tenantId: TENANT, email: `p${partnerId}@x.test`, name: 'P',
    stripeConnectAccountId: PARTNER_ACCT, metadata: { stripe: { payoutsEnabled: true } },
  });
  const programId = ulid();
  await db(TABLES.Program).insert({
    id: programId, tenantId: TENANT, name: 'prog',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl: 'https://x.test', attributionWindowDays: 60, attributionModel: 'last_click',
  });
  const clickId = ulid();
  await db(TABLES.Click).insert({ id: clickId, tenantId: TENANT, partnerId, programId, landingUrl: 'https://x.test/', ts: new Date() });
  const eventId = ulid();
  await db(TABLES.Event).insert({ id: eventId, tenantId: TENANT, userId: `u-${clickId}`, type: 'invoice_paid', value: amount, currency: 'USD', ts: new Date() });
  const attributionId = ulid();
  await db(TABLES.Attribution).insert({ id: attributionId, tenantId: TENANT, eventId, clickId, partnerId, programId, model: 'last_click', weight: '1', computedAt: new Date() });
  const commissionId = ulid();
  await db(TABLES.Commission).insert({
    id: commissionId, tenantId: TENANT, partnerId, attributionId,
    amount, currency: 'USD', status: 'approved',
  });
  const amountMinor = Math.round(Number(amount) * 100);
  const res = await db.transaction(async (trx) =>
    reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId, commissionIds: [commissionId], amountMinor }]));
  if (!res.batchId) throw new Error(`reserve failed: ${res.skipped}`);
  return { batchId: res.batchId, partnerId, commissionIds: [commissionId] };
}

/**
 * Deliver a signed event to the real /webhooks/stripe route and return the
 * HTTP status. Uses the same signing helper Stripe's own SDK exposes, so the
 * signature check is genuinely exercised.
 */
async function postSignedWebhook(payload: object): Promise<number> {
  const { createApp } = await import('../src/app.js');
  const request = (await import('supertest')).default;
  const app = createApp({ enableLogger: false });
  const body = JSON.stringify(payload);
  const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? '').split(',')[0]!.trim();
  const sig = stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  const res = await request(app)
    .post('/webhooks/stripe')
    .set('content-type', 'application/json')
    .set('stripe-signature', sig)
    .send(body);
  return res.status;
}

async function batchRow(id: string) {
  return db(TABLES.HostedFundingBatch).where({ id }).first() as Promise<HostedFundingBatchRow | undefined>;
}
async function allocStatuses(batchId: string): Promise<string[]> {
  const rows = await db(TABLES.HostedFundingAllocation).where({ batchId }).select('state');
  return (rows as Array<{ state: string }>).map((r) => r.state);
}
async function pisForBatch(batchId: string): Promise<Stripe.PaymentIntent[]> {
  // Search is eventually consistent; list+filter is authoritative for a
  // count assertion.
  const out: Stripe.PaymentIntent[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.paymentIntents.list({
      limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    out.push(...page.data.filter((p) => p.metadata?.openpartner_funding_batch_id === batchId));
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]!.id;
  }
  return out;
}

/** A client whose PI create really succeeds, then loses the response. */
function lostResponseStripe(onCreated?: (pi: Stripe.PaymentIntent) => void): Stripe {
  return {
    ...stripe,
    paymentIntents: {
      ...stripe.paymentIntents,
      create: async (p: Stripe.PaymentIntentCreateParams, o?: Stripe.RequestOptions) => {
        const pi = await stripe.paymentIntents.create(p, o);
        onCreated?.(pi);
        const err = new Error('socket hang up') as Error & { type?: string };
        err.type = 'StripeConnectionError';
        throw err;
      },
      search: stripe.paymentIntents.search.bind(stripe.paymentIntents),
      retrieve: stripe.paymentIntents.retrieve.bind(stripe.paymentIntents),
      cancel: stripe.paymentIntents.cancel.bind(stripe.paymentIntents),
      confirm: stripe.paymentIntents.confirm.bind(stripe.paymentIntents),
    },
  } as unknown as Stripe;
}

// ------------------------------------------------------------------- H1/H2

async function h1AmbiguousCreate() {
  console.log('\n[H1] Ambiguous PI create — response lost after Stripe made the intent');
  await reset(); await seedTenantFunding();
  const { batchId } = await seedBatch();

  let createdPi: Stripe.PaymentIntent | undefined;
  await runFundingCollector(db, { stripe: lostResponseStripe((pi) => { createdPi = pi; }) });

  check('Stripe really created a PaymentIntent', !!createdPi, 'none created');
  const b1 = await batchRow(batchId);
  check('batch went funding_failed', b1?.status === 'funding_failed', String(b1?.status));
  check('no PI stamped on the batch', !b1?.stripePaymentIntentId, String(b1?.stripePaymentIntentId));
  const pis1 = await pisForBatch(batchId);
  check('exactly one PI exists at Stripe', pis1.length === 1, `got ${pis1.length}`);

  // Make the retry due, then let the collector run with a healthy client.
  // It must SEARCH and adopt, never blind-create a second intent.
  await db(TABLES.HostedFundingBatch).where({ id: batchId })
    .update({ updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });

  // Stripe's Search API is eventually consistent (~up to a minute). Give it
  // a bounded window rather than asserting on a race we don't control.
  let searchable = false;
  for (let i = 0; i < 24; i += 1) {
    const found = await stripe.paymentIntents.search({
      query: `metadata['openpartner_funding_batch_id']:'${batchId}'`, limit: 1,
    });
    if (found.data.length > 0) { searchable = true; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  check('the PI became findable via Stripe search', searchable,
    'search never indexed it within 120s');
  if (searchable) note('Stripe search indexing took up to ~seconds-to-a-minute — the retry path depends on it');

  let blindCreates = 0;
  const counting = {
    ...stripe,
    paymentIntents: {
      ...stripe.paymentIntents,
      create: async (p: Stripe.PaymentIntentCreateParams, o?: Stripe.RequestOptions) => {
        blindCreates += 1;
        return stripe.paymentIntents.create(p, o);
      },
      search: stripe.paymentIntents.search.bind(stripe.paymentIntents),
      retrieve: stripe.paymentIntents.retrieve.bind(stripe.paymentIntents),
      cancel: stripe.paymentIntents.cancel.bind(stripe.paymentIntents),
      confirm: stripe.paymentIntents.confirm.bind(stripe.paymentIntents),
    },
  } as unknown as Stripe;
  await runFundingCollector(db, { stripe: counting });

  const b2 = await batchRow(batchId);
  check('retry ADOPTED the existing PI (stamped)', !!b2?.stripePaymentIntentId, 'still unstamped');
  check('adopted the SAME intent Stripe already had',
    b2?.stripePaymentIntentId === createdPi?.id,
    `${b2?.stripePaymentIntentId} vs ${createdPi?.id}`);

  // THE money property, and the only one guaranteed here.
  const pis2 = await pisForBatch(batchId);
  check('STILL exactly one PI at Stripe', pis2.length === 1, `got ${pis2.length}`);

  // Whether the retry reached that state by SEARCHING or by re-POSTing the
  // frozen key is not deterministic, and asserting "search" was wrong: this
  // scenario backdates the DB row 25h but the real idempotency key was
  // minted seconds ago, so Stripe still replays it. When the search index
  // has not caught up the retry re-POSTs, Stripe returns the SAME intent,
  // and one PI still exists — safe, just a different route.
  //
  // The genuine post-window behaviour (key pruned, so only a search can
  // save us) CANNOT be exercised without waiting out Stripe's real
  // retention. That gap is honest and is recorded in the runbook.
  if (blindCreates === 0) {
    check('retry resolved by SEARCH, no POST at all', true);
  } else {
    note(`retry re-POSTed the frozen key (search index was cold) — Stripe replayed it and one PI still exists; the true post-window path is NOT covered here`);
  }
}

// --------------------------------------------------------------------- H5/H6

async function h5ReleaseWithUnstampedPi() {
  console.log('\n[H5] Release with a live, UNSTAMPED PI — must terminalize before freeing');
  await reset(); await seedTenantFunding();
  const { batchId } = await seedBatch();

  let createdPi: Stripe.PaymentIntent | undefined;
  await runFundingCollector(db, { stripe: lostResponseStripe((pi) => { createdPi = pi; }) });
  check('a real PI exists but is unstamped', !!createdPi && !(await batchRow(batchId))?.stripePaymentIntentId);

  for (let i = 0; i < 24; i += 1) {
    const f = await stripe.paymentIntents.search({
      query: `metadata['openpartner_funding_batch_id']:'${batchId}'`, limit: 1,
    });
    if (f.data.length > 0) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const b = (await batchRow(batchId))!;
  const outcome = await releaseBatch(db, stripe, b, 'staging release test');
  const after = await batchRow(batchId);
  const allocs = await allocStatuses(batchId);

  console.log(`    (release outcome: ${JSON.stringify(outcome)}, batch=${after?.status})`);
  const pi = createdPi ? await stripe.paymentIntents.retrieve(createdPi.id) : undefined;
  console.log(`    (PI status at Stripe: ${pi?.status})`);

  // Three legitimate landings, depending on what the PI did while we looked:
  //   - terminalized (canceled) → safe to free
  //   - still alive (processing) → must NOT free
  //   - already succeeded → the payment WINS the release (that is H11), and
  //     the batch must go funded with the charge id stamped, not bare-CAS'd
  // `requires_payment_method` is NOT terminal — that PI can still be
  // confirmed and take the money. Treating it as dead here would have let a
  // "freed the allocations while the PI was still live" implementation pass
  // (round-6 review of this script).
  if (pi && pi.status === 'canceled') {
    check('H5: PI terminalized before allocations freed', true);
    check('H5: allocations released only after that', allocs.every((s) => s === 'released'), allocs.join(','));
  } else if (outcome === 'pi_not_terminal') {
    // Round 6: the search index had not caught up, so the release refused
    // to act. That is correct, and it is not the end of the story — the
    // batch must be RESUMABLE. Follow it through rather than asserting a
    // single snapshot, which is what made this scenario flaky.
    note('search was cold, so the release held — following it through to a terminal state');
    check('held rather than freed', allocs.every((s) => s !== 'released'), allocs.join(','));

    let indexed = false;
    for (let i = 0; i < 36; i += 1) {
      const f = await stripe.paymentIntents.search({
        query: `metadata['openpartner_funding_batch_id']:'${batchId}'`, limit: 1,
      });
      if (f.data.length > 0) { indexed = true; break; }
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!indexed) {
      // Do NOT quietly pass. Stripe never made the intent findable within
      // three minutes, so the resume path genuinely could not run — that is
      // a fact about the rail worth seeing, not a test to paper over.
      note(`Stripe search NEVER indexed this PI within 180s — the resume path could not be exercised. The batch is correctly still held; a real deployment would wait for the daily stuck-release alert.`);
      check('still held, allocations still reserved (the safe state)',
        allocs.every((s) => s !== 'released'), allocs.join(','));
      return;
    }

    await runFundingCollector(db, { stripe });
    const resolved = await batchRow(batchId);
    const resolvedAllocs = await allocStatuses(batchId);
    check('the collector resumed it once Stripe was answerable',
      resolved?.status !== 'release_requested', String(resolved?.status));
    if (resolved?.status === 'funded' || resolved?.status === 'transferring') {
      check('H11: charge id stamped (not a bare CAS to funded)', !!resolved?.stripeChargeId,
        `chargeId=${resolved?.stripeChargeId}`);
      check('H11: fundedAt stamped', !!resolved?.fundedAt, String(resolved?.fundedAt));
    } else {
      check('released only after the PI was terminalized',
        resolvedAllocs.every((s) => s === 'released'), resolvedAllocs.join(','));
    }
  } else if (pi && pi.status === 'succeeded') {
    note(`test-mode ACH settled immediately (PI ${pi.status}) — this exercises H11, payment wins the release`);
    check('H11: allocations NOT released — the money arrived',
      allocs.every((s) => s !== 'released'), allocs.join(','));
    check('H11: batch not left as released', after?.status !== 'released', String(after?.status));
    check('H11: charge id stamped (not a bare CAS to funded)',
      !!after?.stripeChargeId, `chargeId=${after?.stripeChargeId} status=${after?.status}`);
    check('H11: fundedAt stamped', !!after?.fundedAt, String(after?.fundedAt));
  } else {
    check('H5: allocations NOT freed while the PI is still alive',
      allocs.every((s) => s !== 'released'), `allocs=${allocs.join(',')} pi=${pi?.status}`);
    check('H5: batch did not silently go released',
      after?.status !== 'released', String(after?.status));
    note(`ACH PI in '${pi?.status}' cannot be canceled — release correctly refused to free. Batch=${after?.status}`);
  }
}

async function h6SearchDown() {
  console.log('\n[H6] Stripe search unavailable — "don\'t know" must not free anything');
  await reset(); await seedTenantFunding();
  const { batchId } = await seedBatch();

  await runFundingCollector(db, { stripe: lostResponseStripe() });
  const b = (await batchRow(batchId))!;

  const searchDown = {
    ...stripe,
    paymentIntents: {
      ...stripe.paymentIntents,
      search: async () => { throw new Error('search unavailable (injected)'); },
      retrieve: stripe.paymentIntents.retrieve.bind(stripe.paymentIntents),
      cancel: stripe.paymentIntents.cancel.bind(stripe.paymentIntents),
      create: stripe.paymentIntents.create.bind(stripe.paymentIntents),
      confirm: stripe.paymentIntents.confirm.bind(stripe.paymentIntents),
    },
  } as unknown as Stripe;

  const outcome = await releaseBatch(db, searchDown, b, 'staging search-down test');
  const allocs = await allocStatuses(batchId);
  const after = await batchRow(batchId);
  console.log(`    (outcome: ${JSON.stringify(outcome)}, batch=${after?.status})`);
  check('allocations stayed RESERVED on "don\'t know"',
    allocs.length > 0 && allocs.every((s) => s !== 'released'), allocs.join(','));
  check('batch not marked released', after?.status !== 'released', String(after?.status));
}

// ----------------------------------------------------------------- H7/H8/H9

async function h7h8h9Inbox() {
  console.log('\n[H7/H8/H9] Webhook inbox lease — held is NOT done');
  await reset();
  const evtId = `evt_staging_${ulid()}`;

  const first = await claimInboxEvent(db, evtId, 'payment_intent.succeeded');
  check('H8: first delivery claims it', first.status === 'claimed', first.status);

  const concurrent = await claimInboxEvent(db, evtId, 'payment_intent.succeeded');
  check('H8: concurrent delivery is HELD, not done', concurrent.status === 'held', concurrent.status);

  // Through the REAL HTTP route, not the helper. This block used to infer
  // "→409" from `status === 'held'`, which is our own return value — a route
  // regression that turned a held event into a 2xx would have passed while
  // Stripe silently stopped redelivering. The status code is the property
  // that matters, so assert the status code.
  const httpStatus = await postSignedWebhook({
    id: evtId,
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'pi_staging_held',
        object: 'payment_intent',
        metadata: { openpartner_funding_batch_id: 'batch_that_does_not_matter' },
      },
    },
  });
  check('H9: a redelivery inside the lease really returns 409 over HTTP',
    httpStatus === 409, `got HTTP ${httpStatus}`);

  // H7/H9: the worker dies without stamping an outcome. After the lease
  // expires, the next delivery must PROCESS it — not treat it as replayed.
  const row = await db(TABLES.StripeWebhookInbox).where({ stripeEventId: evtId }).first() as { outcome: string | null };
  check('H7: crashed handler left outcome NULL', row?.outcome === null, String(row?.outcome));

  const afterLease = await claimInboxEvent(db, evtId, 'payment_intent.succeeded', {
    now: new Date(Date.now() + INBOX_CLAIM_LEASE_MS + 1000),
  });
  check('H7/H9: delivery after the lease TAKES OVER and processes',
    afterLease.status === 'claimed', afterLease.status);

  // Only a stamped outcome is terminal.
  if (afterLease.status === 'claimed') {
    await stampInboxOutcome(db, evtId, 'processed', afterLease.token);
  }
  const done = await claimInboxEvent(db, evtId, 'payment_intent.succeeded');
  check('a genuine duplicate after completion is DONE (ack it)', done.status === 'done', done.status);

  // The stale predecessor must not be able to stamp over the new owner.
  const stale = await stampInboxOutcome(db, evtId, 'stale_overwrite', first.status === 'claimed' ? first.token : 'x');
  const finalRow = await db(TABLES.StripeWebhookInbox).where({ stripeEventId: evtId }).first() as { outcome: string };
  check('a resurrected predecessor cannot overwrite the new owner\'s outcome',
    finalRow.outcome === 'processed', `${finalRow.outcome} (stamp returned ${JSON.stringify(stale)})`);
}

async function h5bEmptySearchHolds() {
  console.log('\n[H5b] Empty search is NOT proof of absence (round 6)');
  await reset(); await seedTenantFunding();
  const { batchId } = await seedBatch();

  // A real PI exists at Stripe, but the row never got its id stamped AND
  // the search index has not caught up — the exact window that used to free
  // the allocations while the brand could still be debited.
  let createdPi: Stripe.PaymentIntent | undefined;
  await runFundingCollector(db, { stripe: lostResponseStripe((pi) => { createdPi = pi; }) });
  check('a real PI exists, unstamped', !!createdPi && !(await batchRow(batchId))?.stripePaymentIntentId);

  // Force the "index has not caught up" case deterministically.
  const blindSearch = {
    ...stripe,
    paymentIntents: {
      ...stripe.paymentIntents,
      search: async () => ({ data: [] }) as unknown as Stripe.ApiSearchResult<Stripe.PaymentIntent>,
      retrieve: stripe.paymentIntents.retrieve.bind(stripe.paymentIntents),
      cancel: stripe.paymentIntents.cancel.bind(stripe.paymentIntents),
      create: stripe.paymentIntents.create.bind(stripe.paymentIntents),
      confirm: stripe.paymentIntents.confirm.bind(stripe.paymentIntents),
    },
  } as unknown as Stripe;

  const b = (await batchRow(batchId))!;
  const outcome = await releaseBatch(db, blindSearch, b, 'staging empty-search test');
  const allocs = await allocStatuses(batchId);
  const after = await batchRow(batchId);

  check('release refused on an empty search', outcome === 'pi_not_terminal', String(outcome));
  check('allocations stayed reserved', allocs.every((s) => s === 'reserved'), allocs.join(','));
  check('batch held in release_requested', after?.status === 'release_requested', String(after?.status));

  // And the live PI really is still alive — i.e. freeing would have been wrong.
  const live = createdPi ? await stripe.paymentIntents.retrieve(createdPi.id) : undefined;
  check('the PI it could not see was genuinely still live',
    !!live && live.status !== 'canceled', String(live?.status));
}

// --------------------------------------------------------------------- main

async function main() {
  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test')) {
    console.error('REFUSING: STRIPE_SECRET_KEY is not a test-mode key.'); process.exit(2);
  }
  if (!/@(localhost|127\.0\.0\.1|postgres)[:/]/.test(process.env.DATABASE_URL ?? '')) {
    console.error('REFUSING: DATABASE_URL is not local — this script truncates tables.'); process.exit(2);
  }
  if (process.env.HOSTED_FUNDING_ENABLED !== '1') {
    console.error('REFUSING: set HOSTED_FUNDING_ENABLED=1.'); process.exit(2);
  }
  if (!CUSTOMER || !PM || !PARTNER_ACCT) {
    console.error('REFUSING: set STAGING_CUSTOMER, STAGING_PM, STAGING_PARTNER_ACCT.'); process.exit(2);
  }

  console.log('Hosted funding races (runbook section H) — REAL Stripe test mode');
  await h1AmbiguousCreate();
  await h5ReleaseWithUnstampedPi();
  await h5bEmptySearchHolds();
  await h6SearchDown();
  await h7h8h9Inbox();

  console.log(`\n================ ${pass} passed, ${fail} failed ================`);
  if (failures.length) { console.log('Failures:'); for (const f of failures) console.log(`  - ${f}`); }
  if (notes.length) { console.log('Notes:'); for (const n of notes) console.log(`  - ${n}`); }
  await reset();
  await db.destroy();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('DRIVER ERROR', e);
  await db.destroy();
  process.exit(2);
});
