/**
 * Hosted funding races — section H of docs/payout-funding-staging-runbook.md,
 * executed against REAL Stripe TEST MODE.
 *
 * Covers the races the runbook calls "the ones that cost real money":
 * ambiguous PaymentIntent creates (H1/H2/H3), a release racing a live PI
 * (H4/H5/H5b/H6/H10/H11), the webhook inbox lease (H7/H8/H9), and the
 * mid-batch freeze (H12). A mock cannot answer the question that matters
 * here — what Stripe actually does — so this drives the real API.
 * STAGING_SCENARIOS=h2,h12 runs a subset.
 *
 * Two honest limits, so nobody re-finds them: Stripe test clocks do NOT
 * move idempotency-key retention, so the true "key pruned" state cannot be
 * forced — H2 proves our side (search alone suffices) instead. And
 * test-mode ACH declines fail only asynchronously, so H3's synchronous
 * error-with-intent shape is staged around a REAL unconfirmed PI.
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

/** A client whose PI search deterministically returns `piId` — the probe
 *  that separates "search was cold" (legitimate hold; Stripe search is
 *  not monotonic even after one warm read — observed live, round 13)
 *  from "the resume never ran" (the regression under test). */
function warmSearchStripe(piId: string, batchId: string): Stripe {
  return {
    ...stripe,
    paymentIntents: {
      ...stripe.paymentIntents,
      // Honors the QUERY: only a search actually asking about this batch
      // gets the PI. An argument-blind stub would mask a query-scoping
      // regression (wrong metadata key, constant batch id) by answering
      // every search correctly anyway (round 14).
      search: async (params: Stripe.PaymentIntentSearchParams) =>
        (params?.query?.includes(batchId)
          ? { data: [await stripe.paymentIntents.retrieve(piId)], has_more: false }
          : { data: [], has_more: false }) as unknown as Stripe.ApiSearchResult<Stripe.PaymentIntent>,
      retrieve: stripe.paymentIntents.retrieve.bind(stripe.paymentIntents),
      cancel: stripe.paymentIntents.cancel.bind(stripe.paymentIntents),
      create: stripe.paymentIntents.create.bind(stripe.paymentIntents),
      confirm: stripe.paymentIntents.confirm.bind(stripe.paymentIntents),
    },
  } as unknown as Stripe;
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

// ------------------------------------------------- H2/H3/H4/H10/H12 (2026-08-14)

/**
 * H2 — past the idempotency window, the SEARCH alone must carry the retry.
 *
 * Stripe test clocks do not move idempotency-key retention, so the true
 * "key pruned" state cannot be forced (H1's honest note). What CAN be
 * proven deterministically is our side of the property: once the DB row
 * says the window has passed, the retry must not need `create` at all —
 * so it runs against a client whose create THROWS, and only a pure
 * search-adopt can pass.
 */
async function h2PastWindowSearchOnly() {
  console.log('\n[H2] Past the window — retry must resolve by search alone (create forbidden)');
  await reset(); await seedTenantFunding();
  const { batchId } = await seedBatch();

  let createdPi: Stripe.PaymentIntent | undefined;
  await runFundingCollector(db, { stripe: lostResponseStripe((pi) => { createdPi = pi; }) });
  check('ambiguous create staged (PI exists, unstamped)',
    !!createdPi && !(await batchRow(batchId))?.stripePaymentIntentId);

  let indexed = false;
  for (let i = 0; i < 36; i += 1) {
    const f = await stripe.paymentIntents.search({
      query: `metadata['openpartner_funding_batch_id']:'${batchId}'`, limit: 1,
    });
    if (f.data.length > 0) { indexed = true; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!indexed) {
    note('Stripe search never indexed the PI within 180s — H2 cannot run this attempt; the safe hold is asserted instead');
    check('batch still holds (not released, not double-created)',
      (await pisForBatch(batchId)).length === 1);
    return;
  }

  // Make the retry due AND past the window on our side.
  await db(TABLES.HostedFundingBatch).where({ id: batchId })
    .update({ updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });

  const createForbidden = {
    ...stripe,
    paymentIntents: {
      ...stripe.paymentIntents,
      create: async () => { throw new Error('H2 VIOLATION: create called on the past-window retry'); },
      search: stripe.paymentIntents.search.bind(stripe.paymentIntents),
      retrieve: stripe.paymentIntents.retrieve.bind(stripe.paymentIntents),
      cancel: stripe.paymentIntents.cancel.bind(stripe.paymentIntents),
      confirm: stripe.paymentIntents.confirm.bind(stripe.paymentIntents),
    },
  } as unknown as Stripe;
  await runFundingCollector(db, { stripe: createForbidden });

  const after = await batchRow(batchId);
  check('H2: retry ADOPTED the existing PI purely by search',
    after?.stripePaymentIntentId === createdPi?.id,
    `stamped=${after?.stripePaymentIntentId} expected=${createdPi?.id}`);
  check('H2: create was never needed',
    !(after?.failureReason ?? '').includes('H2 VIOLATION'), String(after?.failureReason));
  // Adoption must ADVANCE the batch, not just stamp an id — an adopt that
  // left the row funding_failed would pass the id assertion while the
  // money sat unrecovered (round-12 review of this script). EXCEPT when
  // the adopted PI is already CANCELED: production deliberately stays put
  // and lets the release protocol own terminalization (round 13).
  const adoptedPi = createdPi ? await stripe.paymentIntents.retrieve(createdPi.id) : undefined;
  if (adoptedPi?.status === 'canceled') {
    note('adopted PI was already canceled — staying funding_failed for the release protocol is the correct landing');
    check('H2: batch left for the release protocol', after?.status === 'funding_failed',
      String(after?.status));
  } else {
    check('H2: the batch actually progressed past funding_failed',
      ['payment_processing', 'funded', 'transferring', 'settled', 'settled_with_residual'].includes(
        after?.status ?? ''),
      String(after?.status));
  }
  const pis = await pisForBatch(batchId);
  check('H2: STILL exactly one PI at Stripe', pis.length === 1, `got ${pis.length}`);
}

/**
 * H3 — a create that fails WITH an intent attached. The PI is REAL; the
 * error shape is staged (stripe-node attaches `payment_intent` to
 * confirm-time payment failures, but test-mode ACH declines only fail
 * asynchronously, so no fixture can produce the synchronous shape — an
 * honest gap, noted). The property under test is ours: the failed PI's id
 * is stamped from the error, and the retry CONFIRMS that intent (fbpc:
 * key) — never a second create.
 */
async function h3CreateFailsWithIntent() {
  console.log('\n[H3] Create fails WITH an intent — retry confirms it, never re-creates');
  await reset(); await seedTenantFunding();
  const { batchId } = await seedBatch();

  let createdPi: Stripe.PaymentIntent | undefined;
  const confirmFails = {
    ...stripe,
    paymentIntents: {
      ...stripe.paymentIntents,
      create: async (p: Stripe.PaymentIntentCreateParams, o?: Stripe.RequestOptions) => {
        // Real PI, unconfirmed — the state a confirm-time decline leaves.
        const params = { ...p };
        delete (params as { confirm?: boolean }).confirm;
        delete (params as { off_session?: boolean }).off_session;
        const pi = await stripe.paymentIntents.create(params, o);
        createdPi = pi;
        const err = new Error('Your bank account could not be debited (staged decline)') as Error & {
          type?: string; payment_intent?: Stripe.PaymentIntent;
        };
        err.type = 'StripeInvalidRequestError';
        err.payment_intent = pi;
        throw err;
      },
      search: stripe.paymentIntents.search.bind(stripe.paymentIntents),
      retrieve: stripe.paymentIntents.retrieve.bind(stripe.paymentIntents),
      cancel: stripe.paymentIntents.cancel.bind(stripe.paymentIntents),
      confirm: stripe.paymentIntents.confirm.bind(stripe.paymentIntents),
    },
  } as unknown as Stripe;
  await runFundingCollector(db, { stripe: confirmFails });

  const b1 = await batchRow(batchId);
  check('H3: batch funding_failed', b1?.status === 'funding_failed', String(b1?.status));
  check('H3: the FAILED intent id was stamped from the error',
    !!createdPi && b1?.stripePaymentIntentId === createdPi.id,
    `stamped=${b1?.stripePaymentIntentId}`);

  // Retry due now. Count what the retry does at the money API.
  await db(TABLES.HostedFundingBatch).where({ id: batchId })
    .update({ updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
  let creates = 0; let confirms = 0; let confirmKey = '';
  const counting = {
    ...stripe,
    paymentIntents: {
      ...stripe.paymentIntents,
      create: async (p: Stripe.PaymentIntentCreateParams, o?: Stripe.RequestOptions) => {
        creates += 1; return stripe.paymentIntents.create(p, o);
      },
      confirm: async (id: string, p?: Stripe.PaymentIntentConfirmParams, o?: Stripe.RequestOptions) => {
        confirms += 1; confirmKey = o?.idempotencyKey ?? '';
        return stripe.paymentIntents.confirm(id, p, o);
      },
      search: stripe.paymentIntents.search.bind(stripe.paymentIntents),
      retrieve: stripe.paymentIntents.retrieve.bind(stripe.paymentIntents),
      cancel: stripe.paymentIntents.cancel.bind(stripe.paymentIntents),
    },
  } as unknown as Stripe;
  await runFundingCollector(db, { stripe: counting });

  const b2 = await batchRow(batchId);
  check('H3: retry CONFIRMED the same intent', confirms === 1, `confirms=${confirms}`);
  check('H3: per-attempt fbpc key used', confirmKey.startsWith(`fbpc:${batchId}:`), confirmKey);
  check('H3: no second create', creates === 0, `creates=${creates}`);
  check('H3: same PI still stamped', b2?.stripePaymentIntentId === createdPi?.id,
    String(b2?.stripePaymentIntentId));
  // The confirm must MOVE the batch — a retry whose funding_failed →
  // payment_processing CAS was dropped would confirm at Stripe and leave
  // the ledger behind (round-12 review of this script). EXCEPT when the
  // real confirm itself REJECTS: staying funding_failed with the attempt
  // recorded is then the correct landing (round 13).
  const advanced = ['payment_processing', 'funded', 'transferring', 'settled', 'settled_with_residual']
    .includes(b2?.status ?? '');
  let confirmRejected =
    b2?.status === 'funding_failed' && confirms === 1 && Number(b2?.fundingAttempts) >= 2;
  if (confirmRejected && createdPi) {
    // Status + attempt count alone cannot tell "the confirm rejected"
    // from "the confirm SUCCEEDED and the follow-up CAS failed" — the
    // second leaves money in flight with the ledger behind (round 14).
    // The PI itself is the discriminator: a genuine rejection leaves it
    // unadvanced.
    const live = await stripe.paymentIntents.retrieve(createdPi.id);
    confirmRejected =
      live.status === 'requires_payment_method' || live.status === 'requires_confirmation';
    if (!confirmRejected) {
      note(`PI advanced to '${live.status}' while the batch stayed funding_failed — that is a ledger left behind, not a rejection`);
    } else {
      note('the real confirm rejected — funding_failed with the attempt recorded is the correct landing');
    }
  }
  check('H3: confirm either advanced the batch or GENUINELY rejected (PI unadvanced)',
    advanced || confirmRejected,
    `status=${b2?.status} confirms=${confirms} attempts=${b2?.fundingAttempts}`);
  const pis = await pisForBatch(batchId);
  check('H3: exactly one PI at Stripe', pis.length === 1, `got ${pis.length}`);
}

/**
 * H4 — release racing an in-flight create. The create has left for Stripe
 * (the PI is real) but its response has not returned when a release claims
 * the batch. Two genuinely interleaved async flows against real Stripe.
 */
async function h4ReleaseVsInflightCreate() {
  console.log('\n[H4] Release vs in-flight create — the orphan must be canceled or frozen loudly');
  await reset(); await seedTenantFunding();
  const { batchId } = await seedBatch();

  let createdPi: Stripe.PaymentIntent | undefined;
  let releaseOutcome: string | undefined;
  let releaseDone: Promise<void> = Promise.resolve();
  const gated = {
    ...stripe,
    paymentIntents: {
      ...stripe.paymentIntents,
      create: async (p: Stripe.PaymentIntentCreateParams, o?: Stripe.RequestOptions) => {
        const pi = await stripe.paymentIntents.create(p, o);
        createdPi = pi;
        // The response is now "in flight". Run the release START TO FINISH
        // while the collector is still awaiting this create.
        releaseDone = (async () => {
          const b = (await batchRow(batchId))!;
          releaseOutcome = await releaseBatch(db, stripe, b, 'H4 staged release');
        })();
        await releaseDone;
        return pi;
      },
      search: stripe.paymentIntents.search.bind(stripe.paymentIntents),
      retrieve: stripe.paymentIntents.retrieve.bind(stripe.paymentIntents),
      cancel: stripe.paymentIntents.cancel.bind(stripe.paymentIntents),
      confirm: stripe.paymentIntents.confirm.bind(stripe.paymentIntents),
    },
  } as unknown as Stripe;
  await runFundingCollector(db, { stripe: gated });
  await releaseDone;
  note(`release outcome while the create was in flight: ${releaseOutcome}`);

  const after = await batchRow(batchId);
  const pi = createdPi ? await stripe.paymentIntents.retrieve(createdPi.id) : undefined;
  const allocs = await allocStatuses(batchId);
  console.log(`    (batch=${after?.status}, PI=${pi?.status}, allocs=${allocs.join(',')})`);

  if (pi?.status === 'canceled') {
    // The orphan was canceled — the batch may finish releasing now.
    check('H4: orphan PI canceled, never stamped on a released batch',
      after?.status !== 'released' || !after?.stripePaymentIntentId,
      `status=${after?.status} pi=${after?.stripePaymentIntentId}`);
    // The resume can only finish once the canceled PI is FINDABLE: an
    // empty search is not absence (round 6), so the release correctly
    // holds until Stripe's index catches up. Asserting a single
    // post-cancel tick was this test's own round-6 mistake — wait for
    // the index, THEN resume.
    let indexed = false;
    for (let i = 0; i < 36; i += 1) {
      const f = await stripe.paymentIntents.search({
        query: `metadata['openpartner_funding_batch_id']:'${batchId}'`, limit: 1,
      });
      if (f.data.length > 0) { indexed = true; break; }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!indexed) {
      note('search never indexed the canceled orphan within 180s — the hold is the asserted safe state');
      const heldAllocs = await allocStatuses(batchId);
      check('H4: held safely until the index catches up',
        heldAllocs.every((s) => s === 'reserved'), heldAllocs.join(','));
      return;
    }
    // Resume with bounded ticks — one warm read does NOT make the next
    // search warm (non-monotonic, observed live) — then, if still held,
    // probe with a deterministically warm search so a genuine
    // scan-regression cannot hide behind index timing (round 13).
    let final: HostedFundingBatchRow | undefined;
    for (let i = 0; i < 12; i += 1) {
      await runFundingCollector(db, { stripe });
      final = await batchRow(batchId);
      if (final?.status !== 'release_requested') break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (final?.status === 'release_requested' && createdPi) {
      note('search stayed cold through the resume window — probing with a deterministically warm search');
      await runFundingCollector(db, { stripe: warmSearchStripe(createdPi.id, batchId) });
      final = await batchRow(batchId);
    }
    const finalAllocs = await allocStatuses(batchId);
    check('H4: batch reached released with allocations freed',
      final?.status === 'released' && finalAllocs.every((s) => s === 'released'),
      `status=${final?.status} allocs=${finalAllocs.join(',')}`);
  } else {
    // Stripe refused the cancel (ACH debit already processing/succeeded).
    // The compensation must have frozen the batch loudly, or the payment
    // legitimately won the release — never a silent free.
    check('H4: allocations NOT freed while the debit lives',
      allocs.every((s) => s !== 'released'), allocs.join(','));
    if (after?.status === 'recovery_required') {
      check('H4: failureReason names the orphan',
        (after.failureReason ?? '').includes('orphan_payment_intent'), String(after.failureReason));
      return;
    }
    // Follow through to a DECISIVE landing. Accepting a release_requested
    // snapshot here let a no-op compensation pass (round-12 review of this
    // script): a live PI with a forever-held batch is exactly that
    // regression, so keep ticking until the state decides — released (PI
    // terminal), frozen loudly, or payment won.
    let final: HostedFundingBatchRow | undefined;
    let livePi: Stripe.PaymentIntent | undefined;
    for (let i = 0; i < 36; i += 1) {
      await runFundingCollector(db, { stripe });
      final = await batchRow(batchId);
      livePi = createdPi ? await stripe.paymentIntents.retrieve(createdPi.id) : undefined;
      if (final?.status === 'released' || final?.status === 'recovery_required' ||
          final?.status === 'funded' || final?.status === 'transferring') break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    const finalAllocs = await allocStatuses(batchId);
    if (final?.status === 'released') {
      check('H4: released only after the PI terminalized', livePi?.status === 'canceled',
        String(livePi?.status));
      check('H4: allocations freed with the release',
        finalAllocs.every((s) => s === 'released'), finalAllocs.join(','));
    } else if (final?.status === 'recovery_required') {
      check('H4: frozen loudly with the orphan named',
        (final.failureReason ?? '').includes('orphan_payment_intent'), String(final.failureReason));
    } else if (final?.status === 'funded' || final?.status === 'transferring') {
      check('H4/H11: payment won — charge id stamped', !!final?.stripeChargeId,
        String(final?.stripeChargeId));
      check('H4/H11: allocations NOT freed', finalAllocs.every((s) => s !== 'released'),
        finalAllocs.join(','));
    } else if (livePi?.status === 'processing') {
      note(`PI stayed 'processing' for the whole window — held is the only safe landing this run (batch=${final?.status})`);
      check('H4: still held, nothing freed', finalAllocs.every((s) => s !== 'released'),
        finalAllocs.join(','));
    } else {
      check('H4: batch stuck while its PI is terminal — compensation failed', false,
        `status=${final?.status} pi=${livePi?.status}`);
    }
  }
}

/**
 * H10 — a release stopped halfway (search down) leaves a resumable batch,
 * and the NEXT collector tick finishes the job once Stripe answers.
 */
async function h10ReleaseStoppedHalfwayResumes() {
  console.log('\n[H10] Release stopped halfway — held safely, resumed by the next tick');
  await reset(); await seedTenantFunding();
  const { batchId } = await seedBatch();

  let createdPi: Stripe.PaymentIntent | undefined;
  await runFundingCollector(db, { stripe: lostResponseStripe((pi) => { createdPi = pi; }) });

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
  const b = (await batchRow(batchId))!;
  const halted = await releaseBatch(db, searchDown, b, 'H10 staged timeout release');
  const mid = await batchRow(batchId);
  const midAllocs = await allocStatuses(batchId);
  check('H10: release halted with pi_not_terminal', halted === 'pi_not_terminal', String(halted));
  check('H10: batch sits release_requested', mid?.status === 'release_requested', String(mid?.status));
  check('H10: allocations still reserved', midAllocs.every((s) => s === 'reserved'), midAllocs.join(','));

  let indexed = false;
  for (let i = 0; i < 36; i += 1) {
    const f = await stripe.paymentIntents.search({
      query: `metadata['openpartner_funding_batch_id']:'${batchId}'`, limit: 1,
    });
    if (f.data.length > 0) { indexed = true; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!indexed) {
    note('search never indexed within 180s — resume not exercisable this run; the hold itself is the asserted safe state');
    return;
  }

  // Tick until decisive, bounded. A single resume tick was not a valid
  // probe: this script WATCHED one of its own searches succeed and the
  // collector's very next search return empty — Stripe's search is
  // eventually consistent per-REQUEST, not monotonic, so one warm read
  // proves nothing about the next. "Stuck" only means something after a
  // full window of ticks.
  let final: HostedFundingBatchRow | undefined;
  for (let i = 0; i < 36; i += 1) {
    await runFundingCollector(db, { stripe });
    final = await batchRow(batchId);
    if (final?.status !== 'release_requested') break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const finalAllocs = await allocStatuses(batchId);
  const pi = createdPi ? await stripe.paymentIntents.retrieve(createdPi.id) : undefined;
  console.log(`    (resumed: batch=${final?.status}, PI=${pi?.status})`);
  if (final?.status === 'released') {
    check('H10: resumed and released — PI terminal first',
      pi?.status === 'canceled', String(pi?.status));
    check('H10: allocations freed only on the resume',
      finalAllocs.every((s) => s === 'released'), finalAllocs.join(','));
  } else if (final?.status === 'funded' || final?.status === 'transferring') {
    check('H11 landing: payment won the resume — charge id stamped', !!final?.stripeChargeId,
      String(final?.stripeChargeId));
    check('H11 landing: allocations NOT freed', finalAllocs.every((s) => s !== 'released'),
      finalAllocs.join(','));
  } else {
    // Held after the window. That is EITHER the legitimate cold-search /
    // processing-PI hold, OR the scan-regression this scenario exists to
    // catch. A terminal-PI heuristic could not tell them apart (search is
    // non-monotonic — a full window of cold reads is possible; round 13),
    // so probe with a deterministically warm search: if the resume is
    // alive it MUST act on this tick.
    check('H10: still held safely (no free while the PI lives)',
      finalAllocs.every((s) => s !== 'released'),
      `status=${final?.status} allocs=${finalAllocs.join(',')}`);
    if (final?.status === 'release_requested' && createdPi) {
      await runFundingCollector(db, { stripe: warmSearchStripe(createdPi.id, batchId) });
      const probed = await batchRow(batchId);
      const probedAllocs = await allocStatuses(batchId);
      const piNow = await stripe.paymentIntents.retrieve(createdPi.id);
      if (probed?.status === 'funded' || probed?.status === 'transferring') {
        check('H10/H11 (warm probe): payment won — charge id stamped', !!probed?.stripeChargeId,
          String(probed?.stripeChargeId));
      } else if (probed?.status === 'released') {
        check('H10 (warm probe): released with the PI terminal', piNow.status === 'canceled',
          piNow.status);
        check('H10 (warm probe): allocations freed', probedAllocs.every((s) => s === 'released'),
          probedAllocs.join(','));
      } else if (piNow.status === 'processing') {
        note('PI still processing — the hold remains the only safe landing');
        check('H10: nothing freed while the debit lives',
          probedAllocs.every((s) => s !== 'released'), probedAllocs.join(','));
      } else {
        check('H10: resume acted once the search was guaranteed warm', false,
          `status=${probed?.status} pi=${piNow.status}`);
      }
    }
  }
}

/** Two partners with approved commissions in ONE batch. */
async function seedBatchTwoPartners(): Promise<{ batchId: string; partnerIds: string[] }> {
  const candidates: Array<{ partnerId: string; commissionIds: string[]; amountMinor: number }> = [];
  const partnerIds: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const partnerId = ulid();
    partnerIds.push(partnerId);
    await db(TABLES.Partner).insert({
      id: partnerId, tenantId: TENANT, email: `p${partnerId}@x.test`, name: `P${i}`,
      stripeConnectAccountId: PARTNER_ACCT, metadata: { stripe: { payoutsEnabled: true } },
    });
    const programId = ulid();
    await db(TABLES.Program).insert({
      id: programId, tenantId: TENANT, name: `prog${i}`,
      commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
      destinationUrl: 'https://x.test', attributionWindowDays: 60, attributionModel: 'last_click',
    });
    const clickId = ulid();
    await db(TABLES.Click).insert({ id: clickId, tenantId: TENANT, partnerId, programId, landingUrl: 'https://x.test/', ts: new Date() });
    const eventId = ulid();
    await db(TABLES.Event).insert({ id: eventId, tenantId: TENANT, userId: `u-${clickId}`, type: 'invoice_paid', value: '60.00', currency: 'USD', ts: new Date() });
    const attributionId = ulid();
    await db(TABLES.Attribution).insert({ id: attributionId, tenantId: TENANT, eventId, clickId, partnerId, programId, model: 'last_click', weight: '1', computedAt: new Date() });
    const commissionId = ulid();
    await db(TABLES.Commission).insert({
      id: commissionId, tenantId: TENANT, partnerId, attributionId,
      amount: '60.00', currency: 'USD', status: 'approved',
    });
    candidates.push({ partnerId, commissionIds: [commissionId], amountMinor: 6000 });
  }
  const res = await db.transaction(async (trx) => reserveFundingBatch(trx, TENANT, 'usd', candidates));
  if (!res.batchId) throw new Error(`reserve failed: ${res.skipped}`);
  return { batchId: res.batchId, partnerIds };
}

/** Seed a two-partner batch and drive it to funded via the real rail.
 *  Returns undefined when test-mode ACH refuses to settle in time. */
async function fundTwoPartnerBatch(): Promise<{ batchId: string; funded: HostedFundingBatchRow } | undefined> {
  const { batchId } = await seedBatchTwoPartners();
  let funded: HostedFundingBatchRow | undefined;
  for (let i = 0; i < 36; i += 1) {
    await runFundingCollector(db, { stripe }); // webhookless: the poll backstop confirms
    funded = await batchRow(batchId);
    if (funded?.status === 'funded' || funded?.status === 'transferring') break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!(funded?.status === 'funded' || funded?.status === 'transferring')) return undefined;
  return { batchId, funded: funded! };
}

/**
 * H12 — the funding charge is refunded while the executor is mid-batch.
 * The refund is REAL (test mode), the webhook delivery is the real signed
 * route, and the executor must stop before the second partner.
 *
 * A CONTROL batch runs first: the executor must pay BOTH partners when
 * nothing freezes. Without it, an executor that unconditionally stopped
 * after one partner would pass every freeze assertion below (round-12
 * review of this script) — the control is what makes "one transfer" mean
 * "the freeze stopped it".
 */
async function h12FreezeMidTransfer() {
  console.log('\n[H12] Batch frozen mid-transfer — refund lands between partners, executor stops');
  const { runTransferExecutor } = await import('../src/funding/executor.js');

  await reset(); await seedTenantFunding();
  const control = await fundTwoPartnerBatch();
  if (!control) {
    note('control batch never funded within 180s — test-mode ACH did not settle; H12 not exercisable this run');
    return;
  }
  let controlTransfers = 0;
  const countingTransfers = {
    ...stripe,
    transfers: {
      ...stripe.transfers,
      create: async (p: Stripe.TransferCreateParams, o?: Stripe.RequestOptions) => {
        controlTransfers += 1;
        return stripe.transfers.create(p, o);
      },
      list: stripe.transfers.list.bind(stripe.transfers),
      retrieve: stripe.transfers.retrieve.bind(stripe.transfers),
    },
  } as unknown as Stripe;
  await runTransferExecutor(db, { stripe: countingTransfers });
  check('H12 control: BOTH partners paid when nothing freezes', controlTransfers === 2,
    `got ${controlTransfers}`);

  await reset(); await seedTenantFunding();
  const frozen = await fundTwoPartnerBatch();
  if (!frozen) {
    note('freeze batch never funded within 180s — test-mode ACH did not settle; H12 not exercisable this run');
    return;
  }
  const { batchId } = frozen;
  const funded = frozen.funded;
  check('H12: batch funded with charge stamped', !!funded?.stripeChargeId, String(funded?.stripeChargeId));
  let transfersCreated = 0;
  const refundMidway = {
    ...stripe,
    transfers: {
      ...stripe.transfers,
      create: async (p: Stripe.TransferCreateParams, o?: Stripe.RequestOptions) => {
        const t = await stripe.transfers.create(p, o);
        transfersCreated += 1;
        if (transfersCreated === 1) {
          // Between partner 1 and partner 2: refund the funding charge for
          // REAL and deliver the genuine refunded charge through the
          // signed webhook route — the freeze must land before the
          // executor reads the batch for partner 2.
          await stripe.refunds.create({ charge: funded!.stripeChargeId! });
          const charge = await stripe.charges.retrieve(funded!.stripeChargeId!);
          const status = await postSignedWebhook({
            id: `evt_staging_${ulid()}`,
            type: 'charge.refunded',
            created: Math.floor(Date.now() / 1000),
            data: { object: charge },
          });
          note(`charge.refunded webhook answered HTTP ${status}`);
        }
        return t;
      },
      list: stripe.transfers.list.bind(stripe.transfers),
      retrieve: stripe.transfers.retrieve.bind(stripe.transfers),
    },
  } as unknown as Stripe;
  await runTransferExecutor(db, { stripe: refundMidway });

  const after = await batchRow(batchId);
  check('H12: exactly ONE transfer left the batch', transfersCreated === 1, `got ${transfersCreated}`);
  check('H12: batch frozen as funding_disputed', after?.status === 'funding_disputed', String(after?.status));
  const intents = (await db(TABLES.HostedFundingTransfer).where({ batchId })) as Array<{
    partnerId: string; state: string; stripeTransferId: string | null;
  }>;
  const posted = intents.filter((t) => t.stripeTransferId != null);
  check('H12: at most one intent row carries a transfer', posted.length <= 1,
    intents.map((t) => `${t.partnerId}:${t.state}`).join(','));
  note(`intent rows after freeze: ${intents.map((t) => `${t.state}${t.stripeTransferId ? '(posted)' : ''}`).join(', ') || 'none'}`);
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
  // STAGING_SCENARIOS=h2,h12 runs a subset; default runs everything.
  const only = (process.env.STAGING_SCENARIOS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const want = (name: string) => only.length === 0 || only.includes(name);
  if (want('h1')) await h1AmbiguousCreate();
  if (want('h2')) await h2PastWindowSearchOnly();
  if (want('h3')) await h3CreateFailsWithIntent();
  if (want('h4')) await h4ReleaseVsInflightCreate();
  if (want('h5')) await h5ReleaseWithUnstampedPi();
  if (want('h5b')) await h5bEmptySearchHolds();
  if (want('h6')) await h6SearchDown();
  if (want('h7')) await h7h8h9Inbox();
  if (want('h10')) await h10ReleaseStoppedHalfwayResumes();
  if (want('h12')) await h12FreezeMidTransfer();

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
