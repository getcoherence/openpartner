import { Router, raw } from 'express';
import type { Knex } from 'knex';
import Stripe from 'stripe';
import { ulid } from 'ulid';
import {
  DEFAULT_TENANT_ID,
  TABLES,
  type AttributionRow,
  type ClickRow,
  type CommissionRow,
  type CouponRow,
  type EventRow,
  type IdentityRow,
  type PartnerRow,
  type PayoutRow,
  type TenantRow,
} from '@openpartner/db';
import { appDb, db } from '../db.js';
import { attributeEvent } from '../attribution.js';
import { clickUserId } from '../conversion-ingest.js';
import { inferPlanFromPriceIds, persistMerchantSubscription, updateTenantPlanFromStripeSub } from './billing.js';
import {
  handleCancellationScheduleChanged,
  handleTenantSubscriptionEnded,
  notifyTenantInvoicePaymentFailed,
  subscriptionCancelScheduled,
} from '../billing-lifecycle.js';
import { applyWhiteLabelFromSubscription, subscriptionHasWhiteLabel, whiteLabelPriceId } from '../white-label-billing.js';
import { ensureCouponClickAndIdentity, findCouponByCode } from './coupons.js';
import { handleFundingEvent, InboxEventHeldError } from '../funding/webhook.js';
import { mirrorHostedBillingState, type MirroredSubscriptionStatus } from '../billing-plan.js';
import { interlockCommissionReversal, whereNotClaimedByOpenIntent } from '../funding/interlocks.js';
import { getMode } from '../stripe.js';
import { getTenancyMode } from '../tenancy.js';
import { dispatchCommissionEvents } from '../commission-events.js';

const stripeKey = process.env.STRIPE_SECRET_KEY;

// Webhook signing secrets, bound to the Stripe "Event destination" that
// issued them so a secret from one destination can't authorize an event
// family from the other (confused-deputy hardening — spec review #11):
//   - STRIPE_WEBHOOK_SECRET_PLATFORM → Destination A: platform-account events
//     (checkout.*, customer.*, invoice.*, charge.*, payment_intent.*)
//   - STRIPE_WEBHOOK_SECRET_CONNECT  → Destination B: connected-account events
//     (account.updated, transfer.*)
// Each accepts a comma-separated list (multiple endpoints / rotation).
// STRIPE_WEBHOOK_SECRET is the LEGACY combined var: when the split vars are
// unset it verifies BOTH families (unchanged behavior) and family
// enforcement is skipped for it. Migrate to the split vars to turn on
// enforcement — see docs/deploy-production.md.
function parseSecrets(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
const platformWebhookSecrets = parseSecrets(process.env.STRIPE_WEBHOOK_SECRET_PLATFORM);
const connectWebhookSecrets = parseSecrets(process.env.STRIPE_WEBHOOK_SECRET_CONNECT);
const legacyWebhookSecrets = parseSecrets(process.env.STRIPE_WEBHOOK_SECRET);
const anyWebhookSecret =
  platformWebhookSecrets.length + connectWebhookSecrets.length + legacyWebhookSecrets.length > 0;

if (
  legacyWebhookSecrets.length > 0 &&
  platformWebhookSecrets.length === 0 &&
  connectWebhookSecrets.length === 0
) {
  console.warn(
    '[stripe-webhook] using legacy STRIPE_WEBHOOK_SECRET for all event families; set ' +
      'STRIPE_WEBHOOK_SECRET_PLATFORM + STRIPE_WEBHOOK_SECRET_CONNECT to enable secret-family enforcement.',
  );
}

const stripe = stripeKey ? new Stripe(stripeKey) : null;

export const stripeWebhookRouter = Router();

type SecretFamily = 'platform' | 'connect' | 'legacy';

/** Verify the signature against each configured secret, returning which
 *  destination family the matching secret belongs to. */
function verifyWebhook(
  stripeClient: Stripe,
  body: Buffer,
  sig: string,
): { event: Stripe.Event; family: SecretFamily } | null {
  const groups: Array<[SecretFamily, string[]]> = [
    ['platform', platformWebhookSecrets],
    ['connect', connectWebhookSecrets],
    ['legacy', legacyWebhookSecrets],
  ];
  for (const [family, secrets] of groups) {
    for (const secret of secrets) {
      try {
        return { event: stripeClient.webhooks.constructEvent(body, sig, secret), family };
      } catch {
        // Not this secret — try the next.
      }
    }
  }
  return null;
}

// The destination family each handled event type must arrive on. Types not
// listed here are unconstrained (the handlers skip anything they don't map).
const PLATFORM_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.created',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  // transfer.* are PLATFORM-account events: we create Connect transfers with
  // the platform key (funding/executor.ts), so Stripe fires transfer.created
  // / transfer.updated / transfer.reversed on the platform account — they
  // arrive on Destination A, NOT the connected-account destination.
  // transfer.created is the round-10 orphan detector's feed; registered on
  // Destination A 2026-08-14.
  'transfer.created',
  'transfer.updated',
  'transfer.reversed',
]);
// Only account.updated is a genuine connected-account event (event.account
// set, delivered via the Connect destination).
const CONNECT_EVENT_TYPES = new Set(['account.updated']);
function expectedFamilyForType(type: string): SecretFamily | null {
  if (PLATFORM_EVENT_TYPES.has(type)) return 'platform';
  if (CONNECT_EVENT_TYPES.has(type)) return 'connect';
  return null;
}

/**
 * Stripe webhook → raw event log.
 *
 * Stripe events have no URL tenant — the webhook URL is platform-wide. We
 * resolve tenantId from event metadata (every Stripe object we create is
 * stamped with `openpartner_tenant_id`) with DB-backed fallbacks for objects
 * that pre-date the stamping. Once resolved, the actual writes happen inside
 * an `appDb.transaction(...)` with `SET LOCAL app.tenant_id` so RLS catches
 * any cross-tenant mistake as a second line of defense.
 *
 * Each Stripe event we care about becomes an immutable Event row, then goes
 * through the attribution engine. We map:
 *   - checkout.session.completed  → 'signup' (client_reference_id flow), plus
 *                                   'invoice_paid' for a paid one-time
 *                                   (mode=payment) session's amount_total
 *   - checkout.session.async_payment_succeeded
 *                                 → that 'invoice_paid', when a delayed
 *                                   payment method clears after completion
 *   - customer.created            → 'signup'
 *   - customer.subscription.created → 'subscription_created'
 *   - invoice.paid                → 'invoice_paid' (carries revenue)
 *
 * A Stripe Customer is tied to the user an Identity row names in one of
 * two ways:
 *   - Checkout `client_reference_id` (the cref): we stitch Identity.userId =
 *     the cus_ id ourselves, at checkout.session.completed or, when revenue
 *     arrives first, from the customer's completed Checkout Sessions.
 *   - customer metadata `openpartner_user_id`: the merchant's own userId,
 *     the one their app passed to identify().
 * A merchant can use both. When the Customer already carries their
 * openpartner_user_id at checkout, the cref is stitched to that id and the
 * metadata is left alone, so the user isn't split across two ids, and
 * each merchant userId gets one signup however many events report it.
 * The brand's end-customers only post here on a single-tenant self-host,
 * where STRIPE_SECRET_KEY is the brand's own account
 * (receivesBrandStripeEvents).
 */
stripeWebhookRouter.post(
  '/webhooks/stripe',
  raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || !anyWebhookSecret) {
      return res.status(503).json({ error: 'stripe_not_configured' });
    }

    const sig = req.header('stripe-signature');
    if (!sig) return res.status(400).json({ error: 'missing_signature' });

    const verified = verifyWebhook(stripe, req.body, sig);
    if (!verified) return res.status(400).json({ error: 'invalid_signature' });
    const { event, family } = verified;

    // Confused-deputy guard: a secret bound to one destination must not
    // authorize an event type belonging to the other (e.g. the Connect
    // secret carrying a forged checkout.session.completed). Skipped for the
    // legacy combined secret, which has no family binding. 2xx so Stripe
    // stops retrying a permanently-rejected event.
    if (family !== 'legacy') {
      const expected = expectedFamilyForType(event.type);
      if (expected !== null && expected !== family) {
        console.warn('[stripe-webhook] secret-family mismatch', {
          type: event.type,
          verifiedFamily: family,
          expectedFamily: expected,
        });
        return res.json({ ok: true, skipped: event.type, reason: 'secret_family_mismatch' });
      }
    }

    // Funding-pipeline events (PaymentIntents/charges/transfers stamped
    // with our funding metadata) are platform-money events, not merchant
    // conversion events — they route to the funding state machine on the
    // privileged pool and never reach attribution. Runs regardless of
    // HOSTED_FUNDING_ENABLED: a late webhook after a flag flip must still
    // land in the inbox and CAS safely.
    let funding: string | null;
    try {
      funding = await handleFundingEvent(db, stripe, event);
    } catch (err) {
      if (err instanceof InboxEventHeldError) {
        // Another worker is mid-handler on this event. 409 (not 2xx) so
        // Stripe redelivers: if that worker dies, this redelivery is the
        // only thing that will ever process the event.
        return res.status(409).json({ error: 'event_in_flight', eventId: event.id });
      }
      throw err;
    }
    if (funding) return res.json({ ok: true, funding });

    const tenantId = await resolveTenantForEvent(event, family);
    if (!tenantId) {
      // Genuinely unresolvable — most likely a connected-account event for
      // an account we don't recognize. 2xx so Stripe stops retrying.
      return res.json({ ok: true, skipped: event.type, reason: 'unresolved_tenant' });
    }

    // Commissions a full refund reversed inside the transaction below.
    // commission.reversed fires only once runInTenant has committed, so a
    // rollback never announces a reversal that didn't happen.
    let reversedCommissions: CommissionRow[] = [];
    const result = await runInTenant(tenantId, async (trx) => {
      const connectResult = await handleConnectEvent(trx, event!, tenantId);
      if (connectResult) return { connect: connectResult };

      // Coupon auto-redemption (single-tenant self-host only): if the event
      // carries a discount code that matches an OpenPartner Coupon in this
      // tenant, ensure the synthetic Click + Identity exist BEFORE the
      // standard attribution path runs. The next attributeEvent() call then
      // finds the click and credits the partner — same code path as a
      // clicked share-link conversion.
      const redeemed = await maybeRedeemStripeCoupons(trx, stripe!, event!, tenantId);
      if (redeemed) {
        console.log('[stripe-webhook] auto-redeemed coupons', { eventId: event!.id, redeemed: redeemed.codes });
      }

      const mapped = await mapStripeEvent(trx, stripe!, event!, tenantId, redeemed);
      // Usually one Event per Stripe event. A paid one-time checkout records
      // two: the signup, then its revenue.
      const conversions = mapped === null ? [] : Array.isArray(mapped) ? mapped : [mapped];
      if (conversions.length === 0) return { skipped: event!.type };
      reversedCommissions = conversions.flatMap((m) => m.reversedCommissions ?? []);

      const results = [];
      for (const m of conversions) results.push(await recordMappedEvent(trx, tenantId, event!, m));
      return results.length === 1 ? results[0]! : { ...results[0]!, events: results };
    });

    void dispatchCommissionEvents(tenantId, 'commission.reversed', reversedCommissions, { reason: 'refund' });
    res.json({ ok: true, ...result });
  },
);

const CORRECTIVE_EVENT_TYPES = new Set(['refund', 'dispute_created', 'invoice_payment_failed']);

/**
 * Insert one mapped Event and attribute it.
 *
 * Idempotency: a Stripe retry (5xx, timeout) re-delivers the same event.id.
 * Insert with ON CONFLICT DO NOTHING on the per-tenant (tenantId,
 * externalEventId) unique, then handle the dedupe path. The key is the
 * Stripe event id unless the mapping names its own (a checkout's revenue is
 * keyed on the session, which two different Stripe events can report).
 */
async function recordMappedEvent(
  trx: Knex.Transaction,
  tenantId: string,
  event: Stripe.Event,
  mapped: MappedEvent,
): Promise<Record<string, unknown>> {
  const eventId = ulid();
  const externalEventId = mapped.externalEventId ?? event.id;
  const inserted = await trx<EventRow>(TABLES.Event)
    .insert({
      id: eventId,
      tenantId,
      userId: mapped.userId,
      type: mapped.type,
      value: mapped.value != null ? mapped.value.toFixed(2) : null,
      currency: mapped.currency ?? 'USD',
      externalEventId,
      metadata: { stripeEventId: event.id, stripeType: event.type, ...(mapped.metadata ?? {}) },
      ts: new Date(event.created * 1000),
    })
    .onConflict(['tenantId', 'externalEventId'])
    .ignore()
    .returning('*');

  if (inserted.length === 0) {
    // Retry of a previously-processed event — the first delivery
    // already attributed it. Return 2xx so Stripe stops retrying.
    const existing = await trx<EventRow>(TABLES.Event).where({ tenantId, externalEventId }).first();
    return { idempotent: true, eventId: existing?.id };
  }

  // Corrective events (refund, dispute, payment_failed) are recorded for
  // the audit trail but don't drive new attribution rows — handling those
  // is done in mapStripeEvent before insertion (e.g. flipping the source
  // commissions to 'reversed').
  if (CORRECTIVE_EVENT_TYPES.has(mapped.type)) {
    return { eventId, corrective: mapped.type };
  }

  const attribution = await attributeEvent(trx, inserted[0] as EventRow);
  return { eventId, attribution };
}

/**
 * Run a callback inside an appDb transaction with `app.tenant_id` pinned to
 * the given tenant. Mirrors what tenantMiddleware does for HTTP requests, but
 * we can't use that here because Stripe webhooks have no URL tenant.
 */
async function runInTenant<T>(tenantId: string, fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  return appDb.transaction(async (trx) => {
    // tenantId is sourced from a DB lookup or our own metadata stamp on
    // the Stripe object — never directly user-controlled — and single-
    // quotes are escaped before inlining. Postgres SET LOCAL doesn't
    // accept bind params, so the inline interpolation is required.
    // nosemgrep: javascript.lang.security.audit.sqli.node-knex-sqli.node-knex-sqli
    await trx.raw(`set local app.tenant_id = '${tenantId.replace(/'/g, "''")}'`);
    return fn(trx);
  });
}

/**
 * Resolve which tenant an event belongs to. Strategy:
 *
 *   1. Read `openpartner_tenant_id` from the event object's metadata. Every
 *      Stripe object we create is stamped with this on construction, so for
 *      anything created post-multi-tenant deploy the lookup is constant-time.
 *   2. For events whose payload doesn't carry our metadata (older Connect
 *      accounts, transfers identified only by payoutId), fall back to DB
 *      lookup via the privileged `db` (cross-tenant scan).
 *   3. On a single-tenant self-host, a customer event or a Checkout
 *      Session neither step resolves belongs to the one tenant there is
 *      (unless a connected account sent it). A partner coupon may be the
 *      only thing tying it to a partner (maybeRedeemStripeCoupons).
 *      mapStripeEvent then decides whether it's attributable.
 *   4. If nothing yields a tenant, return null and the caller skips the
 *      event with 2xx so Stripe stops retrying.
 */
async function resolveTenantForEvent(event: Stripe.Event, family: SecretFamily): Promise<string | null> {
  // The openpartner_tenant_id metadata stamp is authoritative only for
  // objects WE create in our platform account (platform/legacy families).
  // A connected account can influence its own object metadata, so connect
  // events resolve purely from the connected-account id / our payout id
  // below — metadata may confirm a mapping, never establish one.
  if (family !== 'connect') {
    const obj = event.data.object as { metadata?: Record<string, string> | null };
    const direct = obj?.metadata?.openpartner_tenant_id;
    if (direct) return direct;
  }

  switch (event.type) {
    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      // Resolve by the connected-account id only (authoritative) — the link
      // is always established server-side at /connect/start, so we never need
      // (and must not trust) account.metadata to pick the tenant.
      const linked = await db<PartnerRow>(TABLES.Partner)
        .where({ stripeConnectAccountId: account.id })
        .first(['tenantId']);
      return linked?.tenantId ?? null;
    }
    case 'transfer.created':
    case 'transfer.updated':
    case 'transfer.reversed': {
      const transfer = event.data.object as Stripe.Transfer;
      // transfer_group FIRST, metadata as the legacy fallback (round 10).
      // The group is set at creation, immutable, and stamped with the
      // payout ULID; metadata is mutable, so preferring it let a FORGED
      // openpartner_payout_id redirect an event away from its real payout
      // into "unresolved tenant", acknowledged 2xx and lost. A group value
      // that is not one of our payout ids simply finds no row and the
      // event is skipped.
      const payoutId = transfer.transfer_group ?? transfer.metadata?.openpartner_payout_id;
      if (!payoutId) return null;
      const row = await db<PayoutRow>(TABLES.Payout).where({ id: payoutId }).first(['tenantId']);
      return row?.tenantId ?? null;
    }
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;
      // Merchant-subscription checkout (the brand subscribing to Flex /
      // Revshare via /admin/billing) stamps openpartner_tenant_id on
      // session metadata at create time. Prefer that — it's a constant-
      // time read with no DB round-trip.
      const metaTenantId = session.metadata?.openpartner_tenant_id;
      if (metaTenantId) return metaTenantId;
      // Rewardful-style merchant→customer checkout: tenant resolves via
      // the Click row identified by client_reference_id (the cref).
      if (session.client_reference_id) {
        const row = await db<ClickRow>(TABLES.Click)
          .where({ id: session.client_reference_id })
          .first(['tenantId']);
        if (row) return row.tenantId;
      }
      // A customer who typed a partner's code without clicking a partner
      // link has no cref. On a single-tenant self-host the session is the
      // one tenant's either way; mapStripeEvent skips it unless a partner
      // coupon was redeemed. Not a connected account's session (see the
      // customer events below).
      if (event.account) return null;
      return receivesBrandStripeEvents() ? DEFAULT_TENANT_ID : null;
    }
    case 'customer.created':
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'charge.refunded':
    case 'charge.dispute.created': {
      const customerId = extractCustomerId(event.data.object as { customer?: unknown; id?: string });
      if (!customerId) {
        // A guest one-time purchase (a mode=payment Checkout that created no
        // Customer) is refunded on a charge with no customer. On a
        // single-tenant self-host it's the one tenant's; mapStripeEvent
        // finds the purchase by its PaymentIntent, or skips the refund.
        if (event.type !== 'charge.refunded' || event.account) return null;
        return receivesBrandStripeEvents() ? DEFAULT_TENANT_ID : null;
      }
      // First, check whether this is a merchant-self-subscription
      // Customer (created by /billing/checkout). We persist the
      // customer id on Tenant.stripeCustomerId on first checkout,
      // so the lookup is a constant-time indexed read and avoids a
      // Stripe API roundtrip to inspect Customer.metadata.
      const tenantRow = await db('Tenant')
        .where({ stripeCustomerId: customerId })
        .first<{ id: string }>('id');
      if (tenantRow) return tenantRow.id;
      // Fallback: rewardful-style customer (came in through attribution).
      // Resolves via the Identity → Click chain — covers Customers
      // stitched at checkout.session.completed by the Rewardful path.
      const identity = await db(TABLES.Identity)
        .join(TABLES.Click, `${TABLES.Click}.id`, `${TABLES.Identity}.clickId`)
        .where(`${TABLES.Identity}.userId`, customerId)
        .first<{ tenantId: string }>(`${TABLES.Click}.tenantId as tenantId`);
      if (identity) return identity.tenantId;
      // The join above only finds customers already stitched by cus_ id. It
      // misses customers bridged by metadata.openpartner_user_id (Identity
      // holds the merchant's userId) and Checkout customers whose
      // checkout.session.completed hasn't been processed yet. On a
      // single-tenant self-host both belong to the one tenant; mapStripeEvent
      // resolves the user, or skips the event when nothing links it. Not
      // when event.account is set: that's a connected account's event
      // (delivered on the legacy combined secret), and its customers aren't
      // the brand's.
      if (event.account) return null;
      return receivesBrandStripeEvents() ? DEFAULT_TENANT_ID : null;
    }
    default:
      return null;
  }
}

/**
 * Is STRIPE_SECRET_KEY the brand's own Stripe account, so its end-customers'
 * events post here? Only on a single-tenant self-host. Hosted deployments
 * run on OpenPartner's billing account, and a multi-tenant self-host has one
 * key for many brands (same rule as rewardStripe in customer-rewards.ts).
 */
function receivesBrandStripeEvents(): boolean {
  return getMode() === 'selfhost' && getTenancyMode() === 'single';
}

/**
 * Pull a customer id out of an arbitrary Stripe event object — handles the
 * `customer` field being either a string id, an embedded Customer object,
 * a deleted-customer marker, or absent. For customer.* events the id is on
 * the object itself.
 */
function extractCustomerId(obj: { customer?: unknown; id?: string; object?: string }): string | null {
  if (obj.object === 'customer' && obj.id) return obj.id;
  const c = obj.customer;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && 'id' in c && typeof (c as { id: unknown }).id === 'string') {
    return (c as { id: string }).id;
  }
  return null;
}

interface TenantBillingIds {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

async function tenantBillingIds(trx: Knex.Transaction, tenantId: string): Promise<TenantBillingIds> {
  const row = await trx<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .first(['stripeCustomerId', 'stripeSubscriptionId']);
  return {
    stripeCustomerId: row?.stripeCustomerId ?? null,
    stripeSubscriptionId: row?.stripeSubscriptionId ?? null,
  };
}

/**
 * Is this event about the tenant's OWN billing — the Customer that
 * /billing/checkout created to subscribe the brand to OpenPartner? A
 * merchant end-customer's events resolve to the same tenant (via the
 * Identity chain), and must go through attribution, never the
 * tenant-billing state paths. The subscription-id fallback covers legacy /
 * concierge-provisioned tenants whose stripeCustomerId was never persisted
 * but whose subscription pointer is on file.
 */
function isOwnBilling(
  ids: TenantBillingIds,
  customerId: string | null,
  subscriptionId?: string,
): boolean {
  if (ids.stripeCustomerId && customerId && ids.stripeCustomerId === customerId) return true;
  if (subscriptionId && ids.stripeSubscriptionId && ids.stripeSubscriptionId === subscriptionId) return true;
  return false;
}

// Connect-side events. These don't produce attribution Events — they update
// Partner (onboarding progress) and Payout (transfer resolution) rows.
async function handleConnectEvent(
  trx: Knex.Transaction,
  event: Stripe.Event,
  tenantId: string,
): Promise<string | null> {
  switch (event.type) {
    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      // Resolve the target partner by the connected-account id — NEVER by
      // account.metadata. The partner↔account link is established
      // server-side at /connect/start (accounts.create → persist
      // stripeConnectAccountId), so the partner is always already linked by
      // the time account.updated fires. A Standard account can influence its
      // own metadata, so selecting the partner from
      // account.metadata.openpartner_partner_id would let one partner
      // re-point another's stripeConnectAccountId and hijack their payouts.
      const target = await trx<PartnerRow>(TABLES.Partner)
        .where({ stripeConnectAccountId: account.id })
        .first(['id']);
      if (!target) return 'account_updated_unlinked_account';
      await trx<PartnerRow>(TABLES.Partner)
        .where({ id: target.id })
        .update({
          metadata: trx.raw(
            `jsonb_set(coalesce("metadata", '{}'::jsonb), '{stripe}', ?::jsonb, true)`,
            [
              JSON.stringify({
                chargesEnabled: account.charges_enabled,
                payoutsEnabled: account.payouts_enabled,
                detailsSubmitted: account.details_submitted,
                updatedAt: new Date().toISOString(),
              }),
            ],
          ),
          updatedAt: new Date(),
        });
      return 'account_updated';
    }
    case 'checkout.session.completed': {
      // On a single-tenant self-host every Checkout Session here is one of
      // the brand's end-customers' (billing.ts refuses OpenPartner billing
      // in selfhost), and one without a cref still resolves to the tenant.
      // Persisting it would overwrite Tenant.stripeCustomerId /
      // stripeSubscriptionId with that customer's ids.
      if (receivesBrandStripeEvents()) return null;
      const session = event.data.object as Stripe.Checkout.Session;
      // Disambiguator: a Rewardful-style merchant→customer checkout carries
      // client_reference_id (the cref). Our merchant→OpenPartner subscription
      // checkout (created in billing.ts) doesn't. So presence of
      // client_reference_id means "skip the merchant-subscription path and
      // let mapStripeEvent do attribution."
      if (session.client_reference_id) return null;
      if (session.mode === 'subscription' && typeof session.customer === 'string' && typeof session.subscription === 'string') {
        // trialEndsAt + firstTrialActivatedAt are owned by signup — don't
        // touch them here. Stripe's sub.trial_end is always null now (we
        // stopped passing trial_period_days to Checkout) and overwriting
        // would clobber the signup-set in-product evaluation deadline.
        await persistMerchantSubscription(trx, tenantId, {
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
        });
        return 'merchant_subscription_persisted';
      }
      return null;
    }
    case 'customer.subscription.updated': {
      // Plan switch via Stripe Customer Portal. Detect the new plan from
      // the price IDs on the active items and update Tenant.billingPlan
      // to match. Only act when the price IDs are ones we recognize —
      // third-party additions (e.g. one-off line items) shouldn't
      // reclassify the tenant.
      const sub = event.data.object as Stripe.Subscription;
      // Only the tenant's OWN plan subscription (the Customer created by
      // /billing/checkout) may drive plan / white-label / mirror state.
      // Subscription events for a merchant's END-CUSTOMERS also resolve
      // to this tenant (via the Identity chain) — those must fall through
      // to the attribution path, not clobber the tenant's billing mirror.
      const ids = await tenantBillingIds(trx, tenantId);
      if (!isOwnBilling(ids, extractCustomerId(sub), sub.id)) return null;
      // Staleness: an updated may touch billing state ONLY when it refers to
      // the tenant's CURRENT subscription. Stripe guarantees no event
      // ordering, so after a cancel the pointer can be null (deleted already
      // cleared it) or point at a replacement sub — in both cases a
      // late/resent/out-of-order updated for the old sub must not resurrect
      // or overwrite state. A null pointer is only re-established by
      // checkout.session.completed on a real (re)subscribe, so an updated
      // never legitimately needs to adopt one from null (regardless of the
      // snapshot's status — an active stale snapshot is exactly the
      // resurrection case).
      if (ids.stripeSubscriptionId !== sub.id) {
        return ids.stripeSubscriptionId
          ? 'subscription_updated_stale_ignored'
          : 'subscription_updated_no_pointer_ignored';
      }
      const priceIds = sub.items.data.map((it) => it.price.id);
      const newPlan = inferPlanFromPriceIds(priceIds);
      if (newPlan) {
        await updateTenantPlanFromStripeSub(trx, tenantId, newPlan);
      }
      // White-label add-on: the subscription is the source of truth for
      // hosted flex/revshare tenants — mirror presence of the add-on price
      // onto Tenant.whiteLabel. Losing the add-on also revokes
      // custom-domain routing + the DO edge (spec §8.2). No-op when the
      // add-on price env isn't configured.
      let wl: 'enabled' | 'disabled' | 'unchanged' = 'unchanged';
      if (whiteLabelPriceId()) {
        wl = await applyWhiteLabelFromSubscription(trx, tenantId, subscriptionHasWhiteLabel(priceIds));
      }
      // Refresh subscriptionId so the local mirror reflects current
      // Stripe state. trialEndsAt stays untouched — it's signup-owned.
      await persistMerchantSubscription(trx, tenantId, {
        stripeSubscriptionId: sub.id,
      });
      // HostedBillingState mirror (spec §4 finding 13): hasActivePlan and
      // funding eligibility read this instead of live Stripe calls.
      await mirrorHostedBillingState(trx, tenantId, sub.status as MirroredSubscriptionStatus);
      // Cancellation (un)scheduling — previous_attributes carries the old
      // values only when they actually changed in this event, so this
      // fires on real transitions and alerts ops weeks before the
      // subscription actually ends. Both scheduling mechanisms count:
      // cancel_at_period_end (Customer Portal) and a bare cancel_at
      // (dashboard "cancel at a date" / Subscription Schedules). Redelivery
      // of the same event stays silent via the Config marker inside
      // handleCancellationScheduleChanged.
      const prev = event.data.previous_attributes as Partial<Stripe.Subscription> | undefined;
      let cancelNote: string | null = null;
      if (prev && ('cancel_at_period_end' in prev || 'cancel_at' in prev)) {
        const scheduledNow = subscriptionCancelScheduled(sub);
        const scheduledBefore =
          ('cancel_at_period_end' in prev ? !!prev.cancel_at_period_end : !!sub.cancel_at_period_end) ||
          ('cancel_at' in prev ? prev.cancel_at != null : sub.cancel_at != null);
        if (scheduledNow !== scheduledBefore) {
          cancelNote = await handleCancellationScheduleChanged(trx, tenantId, sub, scheduledNow);
        }
      }
      const parts = [
        newPlan ? `subscription_updated_plan_${newPlan}` : 'subscription_updated',
        ...(wl !== 'unchanged' ? [`white_label_${wl}`] : []),
        ...(cancelNote ? [cancelNote] : []),
      ];
      return parts.join('+');
    }
    case 'customer.subscription.deleted': {
      // Cancellation (manual via Portal or dunning exhaustion). The shared
      // transition clears the local subscription pointer, disables white-
      // label (revoking custom-domain routing + DO edge), mirrors
      // 'canceled', and alerts ops. Tenant stays active so the admin can
      // re-subscribe via /billing/checkout without losing data. The
      // conditional clear inside handleTenantSubscriptionEnded makes this
      // safe against retries and stale events for a since-replaced sub —
      // those return null and are acknowledged without touching state.
      const sub = event.data.object as Stripe.Subscription;
      const ids = await tenantBillingIds(trx, tenantId);
      if (!isOwnBilling(ids, extractCustomerId(sub), sub.id)) return null;
      const wl = await handleTenantSubscriptionEnded(trx, tenantId, 'webhook', sub.id);
      if (wl === null) return 'subscription_deleted_stale_ignored';
      return `subscription_deleted_${sub.status}${wl !== 'unchanged' ? `+white_label_${wl}` : ''}`;
    }
    case 'invoice.payment_failed': {
      // Dunning on the tenant's own OpenPartner invoice → ops alert (and
      // short-circuit: our own billing invoice is not a merchant
      // conversion event). A merchant end-customer's failed invoice falls
      // through to the attribution audit path instead. Deduped per
      // (invoice, attempt) inside so Stripe redeliveries don't re-mail.
      const invoice = event.data.object as Stripe.Invoice;
      const ids = await tenantBillingIds(trx, tenantId);
      if (!isOwnBilling(ids, extractCustomerId(invoice))) return null;
      const outcome = await notifyTenantInvoicePaymentFailed(trx, tenantId, invoice);
      return `tenant_invoice_payment_failed_${outcome}`;
    }
    case 'transfer.created': {
      // DETECTOR ONLY — no state is written. This closes the observation
      // gap behind the prove-absence limit (round 10): an operator action
      // taken on an empty listing (dispose, all-reversed resolution) is a
      // documented risk decision precisely because an unbounded in-flight
      // POST can still land afterwards. When it does, Stripe tells us —
      // this is where we listen. A transfer arriving for a payout that is
      // no longer expecting one is money moved outside the ledger, and it
      // must be LOUD; disposition stays with a human.
      const transfer = event.data.object as Stripe.Transfer;
      const payoutId = transfer.transfer_group ?? transfer.metadata?.openpartner_payout_id;
      if (!payoutId) return null;
      const payout = (await trx<PayoutRow>(TABLES.Payout)
        .where({ id: payoutId })
        .first()) as PayoutRow | undefined;
      if (!payout) return null;
      const state = (payout.metadata as { transferState?: string } | null)?.transferState;
      const benign =
        (state === 'posted' || state === 'reconcile_required' || state === 'intent') &&
        payout.stripeTransferId == null;
      if (benign || payout.stripeTransferId === transfer.id) {
        return 'transfer_created_observed';
      }
      console.error(
        `[payouts] ALERT: transfer ${transfer.id} was CREATED for payout ${payoutId} which is ${state ?? 'unknown'}/${payout.status} on transfer ${payout.stripeTransferId ?? 'none'} — money moved outside the ledger (a late POST landing after a disposition?); operator reconciliation required`,
      );
      return 'transfer_created_orphan';
    }
    case 'transfer.updated':
    case 'transfer.reversed': {
      const transfer = event.data.object as Stripe.Transfer;
      // transfer_group FIRST (round 10): it is immutable and stamped with
      // the payout ULID at creation. Preferring the MUTABLE metadata stamp
      // let a forged openpartner_payout_id redirect a reversal away from
      // its real payout. Metadata remains only as the fallback for
      // group-less transfers.
      const payoutId = transfer.transfer_group ?? transfer.metadata?.openpartner_payout_id;
      if (!payoutId) return null;
      const reversed = event.type === 'transfer.reversed' || (transfer.reversed ?? false);
      const partialOnly = !reversed && Number(transfer.amount_reversed ?? 0) > 0;

      // Serialize this whole decision against the executor's finalization.
      //
      // Round 7: the exact-id match and the metadata fallback below are two
      // statements, and the executor commits its finalization in its OWN
      // transaction. Without this lock the executor could stamp
      // `stripeTransferId` BETWEEN them — the first match missed because the
      // id was still null, the fallback then missed because it requires the
      // id to be null, and the event fell through to "unmatched" and was
      // acknowledged 2xx. A reversed transfer, a payout recorded paid, and
      // no second chance: exactly the hole the fallback was added to close,
      // reintroduced one statement later.
      //
      // Taking the row lock first means we either see the pre-finalization
      // state (and the fallback applies) or the post-finalization state (and
      // the exact-id match applies). There is no longer an in-between.
      const locked = (await trx<PayoutRow>(TABLES.Payout)
        .where({ id: payoutId })
        .forUpdate()
        .first()) as PayoutRow | undefined;

      // A PARTIAL reversal on the recorded transfer must never re-assert
      // `paid` (round 10): `transfer.updated` arrives with `reversed`
      // still false and a non-zero amount_reversed, and the write below
      // used to flip even a `failed` payout back to paid on it. Partial
      // reversals have no ledger representation on this rail yet
      // (documented gap) — so the rule is: never OVERWRITE status on one.
      // Say so loudly and leave the row exactly as it is.
      if (partialOnly && locked?.stripeTransferId === transfer.id) {
        console.error(
          `[payouts] ALERT: transfer ${transfer.id} on payout ${payoutId} is PARTIALLY reversed (${transfer.amount_reversed}/${transfer.amount}) — status left ${locked.status}; partial reversals need operator disposition on this rail`,
        );
        return 'transfer_partial_reversal_unrecorded';
      }

      // Apply ONLY to the transfer this payout actually recorded. A payout
      // can have several transfers in its group across key generations
      // (payout-transfers.ts) — without this, a reversal of a superseded
      // attempt would mark the CURRENT, legitimately paid payout failed,
      // and a stale `transfer.updated` could mark a pending one paid.
      const updated = partialOnly
        ? 0
        : await trx<PayoutRow>(TABLES.Payout)
            .where({ id: payoutId, stripeTransferId: transfer.id })
            .update({
              status: reversed ? 'failed' : 'paid',
              completedAt: reversed ? null : new Date(),
            });
      if (updated === 0 && reversed) {
        // NOT YET STAMPED is a different case from NOT OURS, and
        // collapsing them lost reversals (round-6 review).
        //
        // The executor posts the transfer and only writes
        // `stripeTransferId` when it finalizes. A reversal landing in that
        // gap matched nothing, was logged as "unmatched", and the event
        // was acknowledged — so the reversal was gone, and the executor
        // then recorded the payout `paid` from a create response that
        // still said `reversed: false`.
        //
        // The transfer carries what we need to identify it without the id:
        // `openpartner_payout_id` and `openpartner_key_generation` are
        // stamped at creation and are immutable. Match on those, fenced on
        // the generation, and terminalize the intent so the executor's
        // finalize CAS loses rather than overwriting this with `paid`.
        const stampedGeneration = transfer.metadata?.openpartner_key_generation ?? '0';
        const claimed = await trx<PayoutRow>(TABLES.Payout)
          .where({ id: payoutId })
          .whereNull('stripeTransferId')
          .whereRaw(`coalesce("metadata"->>'keyGeneration', '0') = ?`, [stampedGeneration])
          .whereRaw(`("metadata"->>'transferState') in ('posted','reconcile_required')`)
          .update({
            status: 'failed',
            completedAt: null,
            stripeTransferId: transfer.id,
            metadata: trx.raw(
              `"metadata" || ?::jsonb`,
              [JSON.stringify({ transferState: 'confirmed', lastError: `reversed_before_finalize:${transfer.id}` })],
            ),
          });
        if (claimed > 0) {
          console.error(
            `[payouts] transfer ${transfer.id} was reversed before payout ${payoutId} finalized — recorded failed from metadata; its commissions stay claimed for operator disposition`,
          );
          return 'transfer_reversed_before_finalize';
        }
      }
      // A payout parked in `duplicate_review` is a HUMAN's problem, and
      // this event changes what that human is looking at. Claiming or
      // terminalizing here would be wrong — other transfers in the group
      // may still hold money — but dropping the event as "unmatched" is
      // worse (round 9): the only reversal notification gets consumed
      // while an operator mid-resolution validates against a pre-reversal
      // listing, then records the reversed transfer as the kept one,
      // paid, with the money gone. So RECORD it and move the review
      // nonce; `resolveDuplicateReview` fences its commit on the nonce it
      // observed, so any resolution validated before this write loses its
      // CAS and must re-look.
      //
      // Two deliberate widenings relative to the fallback above: no
      // key-generation fence (a duplicate group spans generations by
      // construction, and every member's reversal is relevant to the
      // review), and PARTIAL reversals count — they arrive as
      // transfer.updated with `reversed` still false but a non-zero
      // amount_reversed, and a partially-reversed transfer can no longer
      // be the kept one.
      const reversalActivity = reversed || Number(transfer.amount_reversed ?? 0) > 0;
      if (updated === 0 && reversalActivity) {
        const lockedMeta = (locked?.metadata ?? {}) as {
          transferState?: string;
          reversedTransferIds?: unknown;
        };
        if (lockedMeta.transferState === 'duplicate_review') {
          // We hold the row lock, so this read-modify-write cannot race
          // another delivery; the state predicate below is belt-and-braces.
          const seen = Array.isArray(lockedMeta.reversedTransferIds)
            ? (lockedMeta.reversedTransferIds as unknown[]).filter(
                (v): v is string => typeof v === 'string',
              )
            : [];
          const reversedIds = seen.includes(transfer.id) ? seen : [...seen, transfer.id];
          // The nonce is a FRESH ulid, never the event id (round 10).
          // Connect events return before the event-id dedupe, so Stripe
          // REDELIVERING an old event would write its id back — an ABA
          // that let a resolution fenced on the older value commit against
          // a listing that predates a newer reversal. A value that never
          // repeats cannot be restored; a redelivery just forces one more
          // (cheap) re-verification.
          const recorded = await trx(TABLES.Payout)
            .where({ id: payoutId })
            .whereRaw(`("metadata"->>'transferState') = 'duplicate_review'`)
            .update({
              metadata: trx.raw(`"metadata" || ?::jsonb`, [
                JSON.stringify({
                  duplicateReviewNonce: ulid(),
                  reversedTransferIds: reversedIds,
                }),
              ]),
            });
          if (recorded > 0) {
            console.error(
              `[payouts] transfer ${transfer.id} saw reversal activity while payout ${payoutId} sits in duplicate_review — recorded on the review; any in-flight operator resolution re-verifies`,
            );
            return 'transfer_reversal_in_duplicate_review';
          }
        }
      }
      if (updated === 0) {
        // Either we never recorded this transfer, or the payout is on a
        // different one. Both mean a transfer exists that our ledger does
        // not own — exactly the state the executor's duplicate detection
        // is for, and worth saying out loud when it's a reversal.
        console.error(
          `[payouts] ${event.type} for transfer ${transfer.id} does not match the transfer recorded on payout ${payoutId} — not applied; check for duplicate transfers`,
        );
        return `${event.type.replace('.', '_')}_unmatched`;
      }
      return reversed ? 'transfer_reversed' : 'transfer_updated';
    }
    default:
      return null;
  }
}

interface MappedEvent {
  userId: string;
  type: string;
  value?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
  /** Idempotency key. Defaults to the Stripe event id. */
  externalEventId?: string;
  /** Rows a full refund flipped to 'reversed'. Not persisted on the
   *  Event; the webhook handler fires commission.reversed for them
   *  after commit. */
  reversedCommissions?: CommissionRow[];
}

// invoice.billing_reason values for invoices after a subscription's first.
const RENEWAL_BILLING_REASONS = new Set(['subscription_cycle', 'subscription_update', 'subscription_threshold']);

async function mapStripeEvent(
  trx: Knex.Transaction,
  stripe: Stripe,
  event: Stripe.Event,
  tenantId: string,
  redeemed: RedeemedCoupons | null,
): Promise<MappedEvent | MappedEvent[] | null> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      // Rewardful-style flow: merchant adds client_reference_id (the cref)
      // to Stripe Checkout. We stitch the resulting Stripe customer to that
      // click here, so subsequent invoice.paid / subscription events resolve
      // without an explicit op.identify() call from the merchant's app.
      const session = event.data.object as Stripe.Checkout.Session;
      const cref = session.client_reference_id;
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;

      // completed records the signup, plus a one-time session's revenue
      // when it's already paid. async_payment_succeeded (a delayed method —
      // SEPA, ACH, Bacs — clearing later) records only that revenue.
      const recordSignup = event.type === 'checkout.session.completed';
      const signup = (userId: string): MappedEvent | null => (recordSignup ? { userId, type: 'signup' } : null);
      const revenue = (userId: string) => checkoutPaymentRevenue(session, userId);

      // No partner link behind this session: no cref, or one that names no
      // click. A partner code redeemed on it still makes it a referred
      // signup. A one-time purchase by a customer already tied to a click
      // (an earlier checkout's stitch, or the merchant's metadata) is
      // credited the way invoice.paid credits a renewal.
      const withoutLink = async (): Promise<MappedEvent[] | null> => {
        if (redeemed) {
          return checkoutEvents(
            recordSignup ? await couponSignup(trx, tenantId, redeemed) : null,
            revenue(redeemed.userId),
          );
        }
        // Only where the brand's own customers check out, as in
        // stitchFromCompletedCheckouts. Anywhere else this is OpenPartner's
        // billing account, and the Stripe read would find nobody.
        if (!customerId || !receivesBrandStripeEvents() || !checkoutPaymentRevenue(session, customerId)) return null;
        const userId = await resolveUserIdFromCustomer(trx, stripe, customerId);
        if (!userId) return null;
        if (userId !== customerId) await lockMerchantUser(trx, tenantId, userId);
        return checkoutEvents(revenue(userId));
      };

      if (!cref) return withoutLink();

      if (!customerId) {
        // A guest checkout: mode=payment without a Customer, a Stripe
        // Payment Link's default. Key the user to the partner coupon's
        // guest user when a code was redeemed too, so both clicks share
        // it; otherwise to the click's own user, as
        // /attribution/conversions does without a userId.
        const userId = redeemed?.userId ?? clickUserId(cref);
        const stitch = await stitchCheckoutCustomer(trx, cref, userId);
        if (!stitch) return withoutLink();
        return checkoutEvents(signup(userId), revenue(userId));
      }

      // A merchant using both linking methods has already set their own
      // openpartner_user_id on the Customer. That id is the user: keying
      // this checkout to the cus_ id split them in two (invoices before
      // and after the metadata overwrite below landed under different
      // userIds, so first-invoice bonuses fired twice) and recorded a
      // second signup next to customer.created's. An openpartner_user_id
      // equal to the cus_ id is our own backfill from an earlier checkout.
      const fetched = await stripeReadOrNull('customers.retrieve', customerId, () =>
        stripe.customers.retrieve(customerId),
      );
      const customer = fetched && !fetched.deleted ? fetched : null;
      const metadataUserId = customer?.metadata?.openpartner_user_id;
      if (metadataUserId && metadataUserId !== customerId) {
        // Locked before the stitch so a concurrent customer.created or
        // invoice.paid for this user either sees our Identity or has
        // committed the Event our backlog pass below picks up.
        await lockMerchantUser(trx, tenantId, metadataUserId);
        const stitch = await stitchCheckoutCustomer(trx, cref, metadataUserId);
        if (!stitch) return withoutLink();
        // Events that beat this stitch (customer.created's signup, an
        // early invoice) were recorded under the merchant's id with no
        // click to credit.
        if (stitch.firstStitch) await attributeUnattributedEvents(trx, tenantId, metadataUserId);
        // The merchant's metadata stays as they set it. No tenant stamp
        // either: no later event reads one off the Customer.
        const signupDue = !(await signupRecorded(trx, tenantId, metadataUserId));
        return checkoutEvents(signupDue ? signup(metadataUserId) : null, revenue(metadataUserId));
      }

      const stitch = await stitchCheckoutCustomer(trx, cref, customerId);
      if (!stitch) return withoutLink();

      // Backfill metadata so the cheaper resolve path (metadata lookup)
      // works for downstream invoice.paid / subscription events. Best-
      // effort: if the API call fails (deleted customer, network blip),
      // resolveUserIdFromCustomer will fall back to the Identity table.
      try {
        await stripe.customers.update(customerId, {
          metadata: { openpartner_user_id: customerId, openpartner_tenant_id: stitch.click.tenantId },
        });
      } catch {
        // Non-fatal.
      }

      return checkoutEvents(signup(customerId), revenue(customerId));
    }
    case 'customer.created': {
      const customer = event.data.object as Stripe.Customer;
      const userId = customer.metadata?.openpartner_user_id;
      if (!userId) return null;
      // checkout.session.completed records this user's signup too when the
      // customer also checks out with a cref. One per merchant userId.
      if (userId !== customer.id) {
        await lockMerchantUser(trx, tenantId, userId);
        if (await signupRecorded(trx, tenantId, userId)) return null;
      }
      return { userId, type: 'signup' };
    }
    case 'customer.subscription.created': {
      const sub = event.data.object as Stripe.Subscription;
      const userId =
        sub.metadata?.openpartner_user_id ??
        (await resolveUserIdFromCustomer(trx, stripe, sub.customer)) ??
        (await stitchFromCompletedCheckouts(trx, stripe, sub.customer));
      if (!userId) return null;
      // Keyed to a merchant-set userId: wait out a concurrent checkout
      // stitch for this user, so attribution below sees its Identity.
      if (userId !== extractCustomerId(sub)) await lockMerchantUser(trx, tenantId, userId);
      return { userId, type: 'subscription_created' };
    }
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      // A renewal or plan change belongs to a subscription whose checkout
      // was stitched long ago, so a customer still unlinked here was never
      // referred. Skip the Checkout Sessions read that would otherwise run
      // on every renewal of every such customer.
      const fromCheckout = !RENEWAL_BILLING_REASONS.has(invoice.billing_reason ?? '');
      const userId =
        (await resolveUserIdFromCustomer(trx, stripe, invoice.customer)) ??
        (fromCheckout ? await stitchFromCompletedCheckouts(trx, stripe, invoice.customer) : null);
      if (!userId) return null;
      // As for customer.subscription.created.
      if (userId !== extractCustomerId(invoice)) await lockMerchantUser(trx, tenantId, userId);
      // `charge` was moved off the Invoice type in recent SDK versions, but the
      // webhook payload still carries it on older API versions and is useful
      // for refund lookups. Read it tolerantly.
      const rawCharge = (invoice as unknown as { charge?: string | { id: string } | null }).charge;
      const chargeId = typeof rawCharge === 'string' ? rawCharge : rawCharge?.id ?? null;
      // Same story for payment_intent. A one-time Checkout's post-payment
      // invoice is paid by the session's PaymentIntent, and its refund
      // charge may not name the invoice.
      const rawPaymentIntent = (invoice as unknown as { payment_intent?: string | { id: string } | null })
        .payment_intent;
      const paymentIntentId =
        typeof rawPaymentIntent === 'string' ? rawPaymentIntent : rawPaymentIntent?.id ?? null;
      return {
        userId,
        type: 'invoice_paid',
        value: invoice.amount_paid / 100,
        currency: invoice.currency?.toUpperCase() ?? 'USD',
        // Captured for refund/dispute lookup. Without these, charge.refunded
        // can't find the original Event to walk back to its Commissions.
        metadata: {
          stripeInvoiceId: invoice.id,
          ...(chargeId ? { stripeChargeId: chargeId } : {}),
          ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
        },
      };
    }
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId =
        typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null;
      // A guest one-time purchase has no Customer to resolve; its revenue
      // Event names the PaymentIntent.
      const userId =
        (await resolveUserIdFromCustomer(trx, stripe, charge.customer)) ??
        (await userIdForPaymentIntent(trx, paymentIntentId));
      if (!userId) return null;
      const rawInvoice = (charge as unknown as { invoice?: string | { id: string } | null }).invoice;
      const invoiceId = typeof rawInvoice === 'string' ? rawInvoice : rawInvoice?.id ?? null;

      // Stopgap for partial-refund over-clawback: the old path reversed 100%
      // of an invoice's commissions on ANY refund, and charge.amount_refunded
      // is cumulative — so a $1 refund on a $100 order wiped the whole
      // commission, and successive partials mis-stated. Only auto-reverse on
      // a FULL refund; partials are recorded for the audit trail and left for
      // manual handling (proportional clawback is a separate ledger change).
      // Commissions already 'paid' are flagged, not clawed back.
      //
      // "Full" is measured against what was actually COLLECTED
      // (charge.amount_captured), NOT the intended charge.amount: a $100 auth
      // captured for $60 and then fully refunded ($60) is a full refund even
      // though amount_refunded (6000) < amount (10000). Fall back to
      // charge.amount when amount_captured is absent.
      const captured = typeof charge.amount_captured === 'number' ? charge.amount_captured : null;
      const collected = captured ?? (typeof charge.amount === 'number' ? charge.amount : null);
      const isFullRefund = collected != null && collected > 0 && charge.amount_refunded >= collected;
      // The refunded revenue is the invoice's (a subscription charge) or the
      // PaymentIntent's (a one-time Checkout).
      const reversal =
        (invoiceId || paymentIntentId) && isFullRefund
          ? await reverseCommissionsForPayment(trx, { invoiceId, paymentIntentId })
          : { reversed: 0, reversedRows: [], alreadyPaid: 0, heldInTransfer: 0 };

      return {
        userId,
        type: 'refund',
        value: -(charge.amount_refunded / 100),
        currency: charge.currency?.toUpperCase() ?? 'USD',
        metadata: {
          stripeChargeId: charge.id,
          ...(invoiceId ? { stripeInvoiceId: invoiceId } : {}),
          ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
          amountRefunded: charge.amount_refunded,
          ...(collected != null ? { chargeCollected: collected } : {}),
          fullRefund: isFullRefund,
          // Surfaces a partial refund that needs manual commission handling.
          ...((invoiceId || paymentIntentId) && !isFullRefund ? { partialRefundReversalSkipped: true } : {}),
          reversedCommissions: reversal.reversed,
          alreadyPaidCommissions: reversal.alreadyPaid,
          ...(reversal.heldInTransfer > 0 ? { heldInTransferCommissions: reversal.heldInTransfer } : {}),
        },
        reversedCommissions: reversal.reversedRows,
      };
    }
    case 'charge.dispute.created': {
      // Disputes are flagged for admin review rather than auto-reversed —
      // disputes can be won, and clawing back commissions on every chargeback
      // would create a worse experience than the rare manual reversal.
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
      let userId: string | null = null;
      if (chargeId) {
        try {
          const charge = await stripe.charges.retrieve(chargeId);
          userId = await resolveUserIdFromCustomer(trx, stripe, charge.customer);
        } catch {
          // Charge might be deleted or inaccessible — log without attribution.
        }
      }
      if (!userId) return null;
      return {
        userId,
        type: 'dispute_created',
        value: -(dispute.amount / 100),
        currency: dispute.currency?.toUpperCase() ?? 'USD',
        metadata: {
          stripeDisputeId: dispute.id,
          ...(chargeId ? { stripeChargeId: chargeId } : {}),
          reason: dispute.reason,
          status: dispute.status,
        },
      };
    }
    case 'invoice.payment_failed': {
      // Recorded for audit but no commission reversal — invoice.paid wouldn't
      // have fired for this invoice in the first place, so there's nothing to
      // reverse. Useful when an admin is debugging "why didn't this convert?"
      const invoice = event.data.object as Stripe.Invoice;
      const userId = await resolveUserIdFromCustomer(trx, stripe, invoice.customer);
      if (!userId) return null;
      return {
        userId,
        type: 'invoice_payment_failed',
        value: -(invoice.amount_due / 100),
        currency: invoice.currency?.toUpperCase() ?? 'USD',
        metadata: {
          stripeInvoiceId: invoice.id,
          attemptCount: invoice.attempt_count,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Mark Commissions linked to a refunded payment as 'reversed'. Walks
 * Event → Attribution → Commission from the invoice_paid Event that
 * recorded the payment: an invoice's (metadata.stripeInvoiceId) or a
 * one-time Checkout's PaymentIntent (metadata.stripePaymentIntentId).
 * Only flips Commissions in 'accrued' or 'approved' status; 'paid'
 * Commissions stay paid (the partner has the money) and the count is
 * returned so the refund Event can record that admin attention is needed.
 * The flipped rows are returned too, for the caller's post-commit
 * commission.reversed dispatch.
 */
async function reverseCommissionsForPayment(
  trx: Knex.Transaction,
  payment: { invoiceId: string | null; paymentIntentId: string | null },
): Promise<{ reversed: number; reversedRows: CommissionRow[]; alreadyPaid: number; heldInTransfer: number }> {
  const none = { reversed: 0, reversedRows: [], alreadyPaid: 0, heldInTransfer: 0 };
  if (!payment.invoiceId && !payment.paymentIntentId) return none;
  // For the operator alerts below.
  const label = payment.invoiceId ? `invoice ${payment.invoiceId}` : `payment ${payment.paymentIntentId}`;
  const sourceEvents = await trx<EventRow>(TABLES.Event)
    .where('type', 'invoice_paid')
    .where((q) => {
      if (payment.invoiceId) q.orWhereRaw(`"metadata"->>'stripeInvoiceId' = ?`, [payment.invoiceId]);
      if (payment.paymentIntentId) {
        q.orWhereRaw(`"metadata"->>'stripePaymentIntentId' = ?`, [payment.paymentIntentId]);
      }
    });
  if (sourceEvents.length === 0) return none;

  const eventIds = sourceEvents.map((e) => e.id);
  const attributions = await trx<AttributionRow>(TABLES.Attribution).whereIn('eventId', eventIds);
  if (attributions.length === 0) return none;
  const attributionIds = attributions.map((a) => a.id);

  // Funding interlock (spec §8): commissions in a live allocation can't be
  // silently flipped — reserved allocations are canceled first (no charge
  // fires for them), mid-transfer ones are held and surfaced like
  // already-paid rows (the money is moving; claw back via adjustment).
  const candidates = (await trx<CommissionRow>(TABLES.Commission)
    .whereIn('attributionId', attributionIds)
    .whereIn('status', ['accrued', 'approved'])
    .select('id')) as Array<{ id: string }>;
  const interlock = await interlockCommissionReversal(trx, candidates.map((c) => c.id));
  if (interlock.held.length > 0) {
    console.error(
      `[funding] ${label} refund: ${interlock.held.length} commission(s) mid-transfer — held for post-settlement adjustment`,
    );
  }

  // Same check/use gap as the admin route: the interlock read and this
  // flip are separate statements, so re-assert the direct-rail guard
  // inside the UPDATE (a payout intent can claim a commission in between).
  const reversedRows = interlock.flippable.length === 0
    ? []
    : ((await whereNotClaimedByOpenIntent(
        trx,
        trx<CommissionRow>(TABLES.Commission)
          .whereIn(`${TABLES.Commission}.id`, interlock.flippable)
          .whereIn('status', ['accrued', 'approved']),
      )
        .update({ status: 'reversed' })
        .returning('*')) as CommissionRow[]);
  const reversed = reversedRows.length;

  const alreadyPaidRow = (await trx<CommissionRow>(TABLES.Commission)
    .whereIn('attributionId', attributionIds)
    .where('status', 'paid')
    .count('id as c')
    .first()) as { c: string | number } | undefined;
  const alreadyPaid = Number(alreadyPaidRow?.c ?? 0);

  // Commissions the guarded UPDATE refused because a payout intent
  // claimed them AFTER the interlock read. They are neither reversed nor
  // counted as held by the interlock, so without this they vanished from
  // the report entirely: the refund looked fully handled while a
  // commission for refunded revenue stayed payable.
  // Anything in `flippable` the UPDATE didn't take. Do NOT assume why:
  // a concurrent actor may have paid it, another refund may have already
  // reversed it, or a payout intent may have claimed it. Counting them
  // all as "held" produced false alerts and double-counted rows that were
  // also reported as alreadyPaid.
  const reversedIds = new Set(reversedRows.map((r) => r.id));
  const missedIds = interlock.flippable.filter((id) => !reversedIds.has(id));
  let lateHeld = 0;
  let lateNewlyPaid = 0;
  if (missedIds.length > 0) {
    const missed = (await trx<CommissionRow>(TABLES.Commission)
      .whereIn('id', missedIds)
      .select('id', 'status', 'payoutId')) as Array<Pick<CommissionRow, 'id' | 'status' | 'payoutId'>>;
    const stillPayable = missed.filter((c) => ['accrued', 'approved'].includes(c.status));
    lateHeld = stillPayable.length;
    if (lateHeld > 0) {
      console.error(
        `[funding] ALERT: ${label} refund: ${lateHeld} commission(s) were claimed by a payout intent or a funding allocation while the reversal was in flight (${stillPayable
          .map((c) => c.id)
          .join(', ')}) — refunded revenue may still be paid out; operator action required`,
      );
    }
    // A row that became `paid` between the alreadyPaid count and this
    // read is in NEITHER total — it would vanish from the report while
    // refunded revenue had just been paid out. Count it explicitly.
    const paidLate = missed.filter((c) => c.status === 'paid').length;
    if (paidLate > 0) {
      lateNewlyPaid = paidLate;
      console.error(
        `[funding] ALERT: ${label} refund: ${paidLate} commission(s) were PAID while the reversal was in flight — refunded revenue has left the platform; operator action required`,
      );
    }
    const otherwiseMoved = missed.length - lateHeld - paidLate;
    if (otherwiseMoved > 0) {
      console.warn(
        `[funding] ${label} refund: ${otherwiseMoved} commission(s) were already reversed concurrently — not counted as held`,
      );
    }
  }

  return {
    reversed,
    reversedRows,
    // Includes rows that became paid between the two reads; leaving them
    // out reported a cleanly-handled refund when money had just moved.
    alreadyPaid: alreadyPaid + lateNewlyPaid,
    heldInTransfer: interlock.held.length + lateHeld,
  };
}

async function resolveUserIdFromCustomer(
  trx: Knex.Transaction,
  stripe: Stripe,
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): Promise<string | null> {
  if (!customer) return null;
  let customerId: string | null = null;
  let metadataUserId: string | null = null;

  if (typeof customer === 'string') {
    customerId = customer;
    const fetched = await stripeReadOrNull('customers.retrieve', customer, () => stripe.customers.retrieve(customer));
    if (fetched && !fetched.deleted) metadataUserId = fetched.metadata?.openpartner_user_id ?? null;
  } else {
    if ('deleted' in customer && customer.deleted) return null;
    customerId = (customer as Stripe.Customer).id;
    metadataUserId = (customer as Stripe.Customer).metadata?.openpartner_user_id ?? null;
  }

  if (metadataUserId) return metadataUserId;
  if (!customerId) return null;

  // Fallback: Stripe Billing flow stitches Identity rows with userId =
  // customer.id. This covers the race where invoice.paid arrives before our
  // metadata-backfill on checkout.session.completed lands on Stripe's side.
  const identity = await trx<IdentityRow>(TABLES.Identity).where({ userId: customerId }).first();
  return identity ? customerId : null;
}

/** Coupons maybeRedeemStripeCoupons matched, and the userId their
 *  Identity rows are keyed on. */
interface RedeemedCoupons {
  userId: string;
  /** userId is the Customer's own openpartner_user_id (not its cus_ id, or
   *  a guest's email), so it gets one signup (signupRecorded). */
  merchantSet: boolean;
  codes: string[];
}

/**
 * The signup for a Checkout Session no partner link is behind, when a
 * partner code was redeemed on it (maybeRedeemStripeCoupons), keyed like
 * the coupon's Identity. A merchant-set userId gets one signup, as at a
 * cref checkout.
 */
async function couponSignup(
  trx: Knex.Transaction,
  tenantId: string,
  redeemed: RedeemedCoupons | null,
): Promise<MappedEvent | null> {
  if (!redeemed) return null;
  if (redeemed.merchantSet) {
    // maybeRedeemStripeCoupons took this lock before stitching; it's
    // re-entrant within the transaction.
    await lockMerchantUser(trx, tenantId, redeemed.userId);
    if (await signupRecorded(trx, tenantId, redeemed.userId)) return null;
  }
  return {
    userId: redeemed.userId,
    type: 'signup',
    metadata: { source: 'coupon', code: redeemed.codes.join(',') },
  };
}

/**
 * The revenue a paid one-time (mode=payment) Checkout Session collected, as
 * the user's conversion, or null when the session carries none of its own:
 *   - subscription sessions: their revenue arrives as invoice.paid, so the
 *     session's amount_total would count the first invoice twice
 *   - payment_status not 'paid' yet: a delayed method (SEPA, ACH, Bacs)
 *     reports at checkout.session.async_payment_succeeded, or never
 *   - invoice_creation enabled (session.invoice set): its post-payment
 *     invoice sends invoice.paid for the same money
 *   - nothing charged (a 100% discount)
 *
 * Recorded as `invoice_paid`, deliberately, rather than a new type. Every
 * consumer of "money was collected" keys on it: the funnel's paid stage,
 * billable GMV (DEFAULT_REVENUE_EVENT_TYPES), refund reversal, and the
 * commission rules brands already have ("20% of every invoice_paid"). A new
 * type would leave those rules paying nothing on one-time sales until each
 * brand found and edited them. The raw Event still says what it was:
 * stripeType checkout.session.*, checkoutMode 'payment', no
 * stripeInvoiceId. Keyed on the session id, so completed and a later
 * async_payment_succeeded can't both record it.
 */
function checkoutPaymentRevenue(session: Stripe.Checkout.Session, userId: string): MappedEvent | null {
  if (session.mode !== 'payment' || session.payment_status !== 'paid' || session.invoice) return null;
  const amount = session.amount_total ?? 0;
  if (amount <= 0) return null;
  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  return {
    userId,
    type: 'invoice_paid',
    value: amount / 100,
    currency: session.currency?.toUpperCase() ?? 'USD',
    externalEventId: session.id,
    metadata: {
      stripeCheckoutSessionId: session.id,
      checkoutMode: 'payment',
      // charge.refunded finds the purchase by it (reverseCommissionsForPayment).
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    },
  };
}

/** A checkout's conversions in recording order (signup, then revenue), or
 *  null when it has none. */
function checkoutEvents(...events: Array<MappedEvent | null>): MappedEvent[] | null {
  const recorded = events.filter((e): e is MappedEvent => e !== null);
  return recorded.length > 0 ? recorded : null;
}

/** The user a one-time Checkout purchase was recorded under, found by its
 *  PaymentIntent: how a refund of a guest purchase (no Customer) finds the
 *  referred user. */
async function userIdForPaymentIntent(trx: Knex.Transaction, paymentIntentId: string | null): Promise<string | null> {
  if (!paymentIntentId) return null;
  const row = await trx<EventRow>(TABLES.Event)
    .where('type', 'invoice_paid')
    .whereRaw(`"metadata"->>'stripePaymentIntentId' = ?`, [paymentIntentId])
    .first('userId');
  return row?.userId ?? null;
}

/**
 * Stitch the Click named by a Checkout Session's client_reference_id (the
 * cref) to a user: the session's cus_ id, or the merchant's own userId when
 * the Customer carries one. Unknown crefs are silently dropped so a bad
 * client_reference_id can't inflate a partner's numbers; RLS scopes the
 * Click lookup to the resolved tenant. Returns the Click and whether this
 * (click, user) pair is new, or null.
 */
async function stitchCheckoutCustomer(
  trx: Knex.Transaction,
  cref: string,
  userId: string,
): Promise<{ click: ClickRow; firstStitch: boolean } | null> {
  const click = await trx<ClickRow>(TABLES.Click).where({ id: cref }).first();
  if (!click) return null;
  const inserted = await trx<IdentityRow>(TABLES.Identity)
    .insert({ id: ulid(), tenantId: click.tenantId, clickId: cref, userId })
    .onConflict(['clickId', 'userId'])
    .ignore()
    .returning('id');
  return { click, firstStitch: inserted.length > 0 };
}

/**
 * Serialize webhook work on one merchant-set userId (a Customer's own
 * openpartner_user_id) until the request transaction ends. Stripe sends
 * customer.created, checkout.session.completed and the first invoice.paid
 * for a customer within moments of each other, and each one reads what
 * another writes: the signup dedupe reads the signup, attribution reads
 * the Identity the checkout stitches, the checkout's backlog pass reads
 * the early events. Unserialized, each read misses the other's
 * uncommitted write.
 */
async function lockMerchantUser(trx: Knex.Transaction, tenantId: string, userId: string): Promise<void> {
  await trx.raw(`select pg_advisory_xact_lock(hashtext(?::text || ':' || ?::text))`, [tenantId, userId]);
}

/**
 * Has this tenant recorded a signup for the user already? Checked under
 * lockMerchantUser, for merchant-set userIds only: a cus_-keyed customer's
 * second checkout records a second signup, as it always has.
 */
async function signupRecorded(trx: Knex.Transaction, tenantId: string, userId: string): Promise<boolean> {
  const row = await trx<EventRow>(TABLES.Event).where({ tenantId, userId, type: 'signup' }).first('id');
  return row != null;
}

/**
 * Attribute the user's events that have no Attribution yet, now that a
 * stitch gave the user a click. The same backlog pass identify() runs on a
 * first stitch, minus events that are already attributed (re-running one
 * against the new click could credit a second partner) and corrective
 * events, which never attribute.
 */
async function attributeUnattributedEvents(trx: Knex.Transaction, tenantId: string, userId: string): Promise<void> {
  const events = await trx<EventRow>(TABLES.Event)
    .where({ tenantId, userId })
    .whereNotIn('type', [...CORRECTIVE_EVENT_TYPES])
    .whereNotExists(function () {
      this.select(trx.raw('1'))
        .from(TABLES.Attribution)
        .whereRaw(`"${TABLES.Attribution}"."eventId" = "${TABLES.Event}"."id"`);
    })
    .orderBy('ts', 'asc');
  for (const event of events) await attributeEvent(trx, event as EventRow);
}

/**
 * Run a Stripe read whose permanent failure means "nothing to find": the
 * object doesn't exist in this account (resource_missing), or a restricted
 * key lacks that one permission. Those fail the same way on every
 * redelivery, so a 500 would only have Stripe retry the event for three
 * days. Log and return null; the caller carries on as if nothing matched
 * and the event is acknowledged.
 * Anything else (connection, Stripe 5xx, rate limit, unknown) propagates
 * as a 500, so Stripe redelivers the event. That includes an invalid or
 * revoked key: every Stripe call is failing then, and redelivery keeps the
 * events until the operator fixes the key.
 */
async function stripeReadOrNull<T>(call: string, id: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (!isPermanentStripeError(err)) throw err;
    const { type, code, message } = err as { type?: string; code?: string; message?: string };
    console.warn('[stripe-webhook] Stripe read failed permanently; treating as not found', { call, id, type, code, message });
    return null;
  }
}

function isPermanentStripeError(err: unknown): boolean {
  const { type, code } = (err ?? {}) as { type?: string; code?: string };
  if (type === 'StripePermissionError') return true;
  return type === 'StripeInvalidRequestError' && code === 'resource_missing';
}

/**
 * Out-of-order recovery for the client_reference_id flow. Stripe doesn't
 * order events, so invoice.paid or customer.subscription.created can land
 * before checkout.session.completed has stitched the customer. Read the
 * customer's completed Checkout Sessions and stitch now, as that event
 * will; its own stitch is then a no-op. Not for renewal invoices (see
 * RENEWAL_BILLING_REASONS).
 *
 * Answering non-2xx to wait for a redelivery instead would fail most
 * deliveries: on a self-host, every customer no partner referred lands
 * here too, and never resolves. A transient Stripe error propagates as a
 * 500, so Stripe redelivers the event; a permanent one reads as no
 * sessions (stripeReadOrNull).
 */
async function stitchFromCompletedCheckouts(
  trx: Knex.Transaction,
  stripe: Stripe,
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): Promise<string | null> {
  if (!customer || !receivesBrandStripeEvents()) return null;
  if (typeof customer !== 'string' && 'deleted' in customer && customer.deleted) return null;
  const customerId = typeof customer === 'string' ? customer : customer.id;

  const sessions = await stripeReadOrNull('checkout.sessions.list', customerId, () =>
    stripe.checkout.sessions.list({ customer: customerId, status: 'complete', limit: 10 }),
  );
  if (!sessions) return null;
  let stitched = false;
  for (const session of sessions.data) {
    if (!session.client_reference_id) continue;
    if (await stitchCheckoutCustomer(trx, session.client_reference_id, customerId)) stitched = true;
  }
  return stitched ? customerId : null;
}

/**
 * Auto-redeem any OpenPartner Coupons referenced by discount codes on
 * the event. Runs BEFORE the standard event mapping — synthesizes the
 * Click + Identity for the customer so the next attribution pass
 * credits the partner. Returns what matched, or null.
 *
 * Stripe events that carry discount codes:
 *   - checkout.session.completed / async_payment_succeeded (session.discounts;
 *     total_details.breakdown when we read the session back)
 *   - invoice.paid (invoice.discounts + total_discount_amounts, which
 *     arrive as bare ids, so we read the invoice back)
 *
 * Single-tenant self-host only (receivesBrandStripeEvents): that's the one
 * deployment where these are the brand's own checkouts and invoices.
 * Anywhere else they're OpenPartner's billing account, where a brand
 * paying for its own plan with a code that happens to equal one of its
 * partner coupons would otherwise credit the brand's subscription to the
 * partner, permanently. Nothing is read from Stripe there either.
 *
 * A discount matches a partner coupon by its PromotionCode id
 * (Coupon.stripePromotionCodeId, no Stripe read), else by the
 * customer-facing promotion_code.code, else by the Stripe Coupon id —
 * brands setting their Stripe Coupon IDs to match OpenPartner codes works
 * without an extra Stripe API call.
 */
async function maybeRedeemStripeCoupons(
  trx: Knex.Transaction,
  stripe: Stripe,
  event: Stripe.Event,
  tenantId: string,
): Promise<RedeemedCoupons | null> {
  if (!receivesBrandStripeEvents()) return null;
  const obj = event.data.object as unknown as Record<string, unknown>;
  const ts = new Date(event.created * 1000);

  // Customer ID — same shape across the event types we handle. A guest
  // Checkout (payment mode, no Customer) falls back to the prefilled email.
  const customerId = extractCustomerId(obj as { customer?: unknown; id?: string; object?: string });
  const guestEmail = typeof obj.customer_email === 'string' ? obj.customer_email : null;
  if (!customerId && !guestEmail) return null;

  let userId: string | null = null;
  let merchantSet = false;
  let firstStitch = false;
  const codes: string[] = [];
  for (const d of await collectDiscounts(stripe, event)) {
    let coupon = await findCouponByPromotionCodeId(trx, d);
    if (!coupon) {
      const code = await resolveDiscountCode(stripe, d);
      if (!code) continue;
      coupon = await findCouponByCode(trx, code);
    }
    if (!coupon || codes.includes(coupon.code)) continue;
    if (!userId) {
      userId = customerId ? await couponUserId(stripe, customerId) : guestEmail!;
      merchantSet = customerId != null && userId !== customerId;
      // As at a cref checkout: lock a merchant-set userId before the
      // stitch, so a concurrent delivery for this user sees our Identity
      // or has committed the Event the backlog pass below picks up.
      if (merchantSet) await lockMerchantUser(trx, tenantId, userId);
    }
    const { reused } = await ensureCouponClickAndIdentity(trx, tenantId, coupon, userId, ts);
    if (!reused) firstStitch = true;
    codes.push(coupon.code);
  }
  if (!userId) return null;
  // Events that beat this stitch (customer.created's signup) were recorded
  // under the merchant's id with no click to credit.
  if (merchantSet && firstStitch) await attributeUnattributedEvents(trx, tenantId, userId);
  return { userId, merchantSet, codes };
}

/**
 * The userId to key a coupon's Identity on: the one this customer's
 * revenue events resolve to (resolveUserIdFromCustomer), so they credit
 * the coupon's partner. That's the customer's openpartner_user_id metadata
 * when set, else the cus_ id. A cref checkout stitches its click to the
 * same id (mapStripeEvent).
 */
async function couponUserId(stripe: Stripe, customerId: string): Promise<string> {
  const customer = await stripeReadOrNull('customers.retrieve', customerId, () =>
    stripe.customers.retrieve(customerId),
  );
  return (customer && !customer.deleted && customer.metadata?.openpartner_user_id) || customerId;
}

interface DiscountRef {
  id?: string;
  coupon?: string | { id: string } | null;
  promotion_code?: string | { id: string; code?: string } | null;
  // Discount objects name their coupon here (API 2025-03-31 onward).
  source?: { coupon?: string | { id: string } | null } | null;
}

/**
 * The event's discounts, read back from Stripe when the payload doesn't
 * carry them. Webhook payloads expand nothing: an Invoice's discounts are
 * bare di_ ids (and a Discount can't be fetched by id), and a Checkout
 * Session's total_details.breakdown is only returned on request. Only an
 * object that actually discounted something is read back.
 *
 * The invoice read expands each discount's PromotionCode too, so its code
 * needs no further read. The session's breakdown can't: that path
 * (total_details.breakdown.discounts.discount.promotion_code) is past
 * Stripe's four-level expand limit, so those match on the PromotionCode id
 * (findCouponByPromotionCodeId) or read it (resolveDiscountCode).
 *
 * A transient Stripe error propagates as a 500, so Stripe redelivers the
 * event; a permanent one reads as no discounts (stripeReadOrNull) and the
 * event is processed without a redemption.
 */
async function collectDiscounts(stripe: Stripe, event: Stripe.Event): Promise<DiscountRef[]> {
  const inPayload = extractDiscounts(event.data.object);
  if (inPayload.length > 0) return inPayload;

  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as Stripe.Invoice;
    if (!invoice.id || !invoiceCarriesDiscount(invoice)) return [];
    const invoiceId = invoice.id;
    const full = await stripeReadOrNull('invoices.retrieve', invoiceId, () =>
      stripe.invoices.retrieve(invoiceId, {
        expand: ['discounts.promotion_code', 'total_discount_amounts.discount.promotion_code'],
      }),
    );
    return full ? extractDiscounts(full) : [];
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object as Stripe.Checkout.Session;
    if (!((session.total_details?.amount_discount ?? 0) > 0)) return [];
    const full = await stripeReadOrNull('checkout.sessions.retrieve', session.id, () =>
      stripe.checkout.sessions.retrieve(session.id, { expand: ['total_details.breakdown'] }),
    );
    return full ? extractDiscounts(full) : [];
  }
  return [];
}

/** Does the invoice list any discount, even as a bare id? Invoice-level
 *  discounts are in `discounts`; total_discount_amounts also covers
 *  line-item ones. */
function invoiceCarriesDiscount(invoice: Stripe.Invoice): boolean {
  return (invoice.discounts?.length ?? 0) > 0 || (invoice.total_discount_amounts?.length ?? 0) > 0;
}

/** Discount objects on a Checkout Session or Invoice. Bare ids are skipped
 *  (collectDiscounts reads those back), and a discount listed twice is
 *  returned once. */
function extractDiscounts(object: unknown): DiscountRef[] {
  const obj = object as Record<string, unknown>;
  const out: DiscountRef[] = [];
  const add = (d: unknown) => {
    if (typeof d !== 'object' || d === null) return;
    const ref = d as DiscountRef;
    if (ref.id && out.some((o) => o.id === ref.id)) return;
    out.push(ref);
  };

  // Checkout Session and Invoice: discounts. Invoice: total_discount_amounts.
  if (Array.isArray(obj.discounts)) obj.discounts.forEach(add);
  if (Array.isArray(obj.total_discount_amounts)) {
    for (const item of obj.total_discount_amounts as Array<{ discount?: unknown }>) add(item.discount);
  }
  // Checkout Session: total_details.breakdown.discounts.
  const totalDetails = obj.total_details as
    | { breakdown?: { discounts?: Array<{ discount?: unknown }> } | null }
    | null
    | undefined;
  for (const item of totalDetails?.breakdown?.discounts ?? []) add(item.discount);
  return out;
}

/**
 * The partner coupon whose Stripe PromotionCode this discount applied,
 * matched by id with no Stripe read. Coupons minted with a customer reward
 * record it (provisionCustomerReward); their Stripe Coupon ids are
 * auto-generated, so the coupon-id fallback in resolveDiscountCode never
 * matches them.
 */
async function findCouponByPromotionCodeId(trx: Knex.Transaction, d: DiscountRef): Promise<CouponRow | null> {
  const id = typeof d.promotion_code === 'string' ? d.promotion_code : d.promotion_code?.id;
  if (!id) return null;
  const row = await trx<CouponRow>(TABLES.Coupon).where({ stripePromotionCodeId: id }).whereNull('deactivatedAt').first();
  return row ?? null;
}

async function resolveDiscountCode(stripe: Stripe, d: DiscountRef): Promise<string | null> {
  // Prefer the customer-facing PromotionCode string.
  if (d.promotion_code) {
    if (typeof d.promotion_code === 'object' && d.promotion_code.code) {
      return d.promotion_code.code;
    }
    const id = typeof d.promotion_code === 'string' ? d.promotion_code : d.promotion_code.id;
    // A transient failure is a 500, so Stripe redelivers the event rather
    // than dropping the redemption for good.
    const promo = await stripeReadOrNull('promotionCodes.retrieve', id, () => stripe.promotionCodes.retrieve(id));
    if (promo?.code) return promo.code;
  }
  // Fallback: use the Coupon's Stripe ID directly. Brands who set their
  // Stripe Coupon IDs to match OpenPartner codes don't need the API call.
  const coupon = d.coupon ?? d.source?.coupon;
  if (coupon) {
    return typeof coupon === 'string' ? coupon : coupon.id;
  }
  return null;
}
