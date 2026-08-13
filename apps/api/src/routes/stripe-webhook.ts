import { Router, raw } from 'express';
import type { Knex } from 'knex';
import Stripe from 'stripe';
import { ulid } from 'ulid';
import {
  TABLES,
  type AttributionRow,
  type ClickRow,
  type CommissionRow,
  type EventRow,
  type IdentityRow,
  type PartnerRow,
  type PayoutRow,
} from '@openpartner/db';
import { appDb, db } from '../db.js';
import { attributeEvent } from '../attribution.js';
import { inferPlanFromPriceIds, persistMerchantSubscription, updateTenantPlanFromStripeSub } from './billing.js';
import { applyWhiteLabelFromSubscription, subscriptionHasWhiteLabel, whiteLabelPriceId } from '../white-label-billing.js';
import { ensureCouponClickAndIdentity, findCouponByCode } from './coupons.js';
import { handleFundingEvent } from '../funding/webhook.js';
import { mirrorHostedBillingState, type MirroredSubscriptionStatus } from '../billing-plan.js';
import { interlockCommissionReversal, whereNotClaimedByOpenIntent } from '../funding/interlocks.js';

const stripeKey = process.env.STRIPE_SECRET_KEY;
// STRIPE_WEBHOOK_SECRET accepts either a single secret or a comma-separated
// list. Stripe's new "Event destinations" UI splits platform-account events
// (checkout.*, invoice.*, customer.*) and connected-account events
// (account.updated, transfer.*) into separate destinations, each with its own
// signing secret. Both destinations point at the same /webhooks/stripe URL —
// we just need to verify against any configured secret.
const webhookSecrets = (process.env.STRIPE_WEBHOOK_SECRET ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const stripe = stripeKey ? new Stripe(stripeKey) : null;

export const stripeWebhookRouter = Router();

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
 *   - customer.created            → 'signup'
 *   - customer.subscription.created → 'subscription_created'
 *   - invoice.paid                → 'invoice_paid' (carries revenue)
 *
 * We require `openpartner_user_id` to be present in customer metadata as
 * the bridge from Stripe's Customer to the merchant's userId, which is
 * what Identity stitches against.
 */
stripeWebhookRouter.post(
  '/webhooks/stripe',
  raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || webhookSecrets.length === 0) {
      return res.status(503).json({ error: 'stripe_not_configured' });
    }

    const sig = req.header('stripe-signature');
    if (!sig) return res.status(400).json({ error: 'missing_signature' });

    let event: Stripe.Event | null = null;
    for (const secret of webhookSecrets) {
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
        break;
      } catch {
        // Try the next secret. If none match we'll fall through to 400.
      }
    }
    if (!event) return res.status(400).json({ error: 'invalid_signature' });

    // Funding-pipeline events (PaymentIntents/charges/transfers stamped
    // with our funding metadata) are platform-money events, not merchant
    // conversion events — they route to the funding state machine on the
    // privileged pool and never reach attribution. Runs regardless of
    // HOSTED_FUNDING_ENABLED: a late webhook after a flag flip must still
    // land in the inbox and CAS safely.
    const funding = await handleFundingEvent(db, stripe, event);
    if (funding) return res.json({ ok: true, funding });

    const tenantId = await resolveTenantForEvent(event);
    if (!tenantId) {
      // Genuinely unresolvable — most likely a connected-account event for
      // an account we don't recognize. 2xx so Stripe stops retrying.
      return res.json({ ok: true, skipped: event.type, reason: 'unresolved_tenant' });
    }

    const result = await runInTenant(tenantId, async (trx) => {
      const connectResult = await handleConnectEvent(trx, event!, tenantId);
      if (connectResult) return { connect: connectResult };

      // Coupon auto-redemption: if the event carries a discount code that
      // matches an OpenPartner Coupon in this tenant, ensure the synthetic
      // Click + Identity exist BEFORE the standard attribution path runs.
      // The next attributeEvent() call then finds the click and credits
      // the partner — same code path as a clicked share-link conversion.
      const redeemed = await maybeRedeemStripeCoupons(trx, stripe!, event!, tenantId);
      if (redeemed.length > 0) {
        console.log('[stripe-webhook] auto-redeemed coupons', { eventId: event!.id, redeemed });
      }

      const mapped = await mapStripeEvent(trx, stripe!, event!);
      if (!mapped) return { skipped: event!.type };

      // Idempotency: a Stripe retry (5xx, timeout) re-delivers the same
      // event.id. Insert with ON CONFLICT DO NOTHING on the unique
      // partial index over externalEventId, then handle the dedupe path.
      const eventId = ulid();
      const inserted = await trx<EventRow>(TABLES.Event)
        .insert({
          id: eventId,
          tenantId,
          userId: mapped.userId,
          type: mapped.type,
          value: mapped.value != null ? mapped.value.toFixed(2) : null,
          currency: mapped.currency ?? 'USD',
          externalEventId: event!.id,
          metadata: { stripeEventId: event!.id, stripeType: event!.type, ...(mapped.metadata ?? {}) },
          ts: new Date(event!.created * 1000),
        })
        .onConflict('externalEventId')
        .ignore()
        .returning('*');

      if (inserted.length === 0) {
        // Retry of a previously-processed event — the first delivery
        // already attributed it. Return 2xx so Stripe stops retrying.
        const existing = await trx<EventRow>(TABLES.Event).where({ externalEventId: event!.id }).first();
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
    });

    res.json({ ok: true, ...result });
  },
);

const CORRECTIVE_EVENT_TYPES = new Set(['refund', 'dispute_created', 'invoice_payment_failed']);

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
 *   3. If neither yields a tenant, return null and the caller skips the
 *      event with 2xx so Stripe stops retrying.
 */
async function resolveTenantForEvent(event: Stripe.Event): Promise<string | null> {
  const obj = event.data.object as { metadata?: Record<string, string> | null };
  const direct = obj?.metadata?.openpartner_tenant_id;
  if (direct) return direct;

  switch (event.type) {
    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      const partnerId = account.metadata?.openpartner_partner_id;
      if (partnerId) {
        const row = await db<PartnerRow>(TABLES.Partner).where({ id: partnerId }).first(['tenantId']);
        if (row) return row.tenantId;
      }
      // Last-resort: any partner with this stripeConnectAccountId.
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
    case 'checkout.session.completed': {
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
      return null;
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
      if (!customerId) return null;
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
      return identity?.tenantId ?? null;
    }
    default:
      return null;
  }
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
      const partnerId = account.metadata?.openpartner_partner_id;
      if (!partnerId) return 'account_updated_no_partner_id';
      await trx<PartnerRow>(TABLES.Partner)
        .where({ id: partnerId })
        .update({
          stripeConnectAccountId: account.id,
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
      const parts = [
        newPlan ? `subscription_updated_plan_${newPlan}` : 'subscription_updated',
        ...(wl !== 'unchanged' ? [`white_label_${wl}`] : []),
      ];
      return parts.join('+');
    }
    case 'customer.subscription.deleted': {
      // Cancellation (manual via Portal or dunning exhaustion). Clear
      // the local subscription pointer; Tenant stays active so the admin
      // can re-subscribe via /billing/checkout without losing data.
      // trialEndsAt stays put — it's the original signup-set evaluation
      // deadline, not Stripe's trial state.
      const sub = event.data.object as Stripe.Subscription;
      await persistMerchantSubscription(trx, tenantId, {
        stripeSubscriptionId: null,
      });
      // The whole subscription is gone — the add-on with it. Revokes
      // custom-domain routing + DO edge if this was a white-label tenant.
      const wl = await applyWhiteLabelFromSubscription(trx, tenantId, false);
      await mirrorHostedBillingState(trx, tenantId, 'canceled');
      return `subscription_deleted_${sub.status}${wl !== 'unchanged' ? `+white_label_${wl}` : ''}`;
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
}

async function mapStripeEvent(
  trx: Knex.Transaction,
  stripe: Stripe,
  event: Stripe.Event,
): Promise<MappedEvent | null> {
  switch (event.type) {
    case 'checkout.session.completed': {
      // Rewardful-style flow: merchant adds client_reference_id (the cref)
      // to Stripe Checkout. We stitch the resulting Stripe customer to that
      // click here, so subsequent invoice.paid / subscription events resolve
      // without an explicit op.identify() call from the merchant's app.
      const session = event.data.object as Stripe.Checkout.Session;
      const cref = session.client_reference_id;
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      if (!cref || !customerId) return null;

      // Validate the cref points at a real Click in this tenant — silently
      // drop unknowns so a bad client_reference_id can't inflate a partner's
      // numbers. RLS scopes the query to the resolved tenant.
      const click = await trx<ClickRow>(TABLES.Click).where({ id: cref }).first();
      if (!click) return null;

      await trx<IdentityRow>(TABLES.Identity)
        .insert({ id: ulid(), tenantId: click.tenantId, clickId: cref, userId: customerId })
        .onConflict(['clickId', 'userId'])
        .ignore();

      // Backfill metadata so the cheaper resolve path (metadata lookup)
      // works for downstream invoice.paid / subscription events. Best-
      // effort: if the API call fails (deleted customer, network blip),
      // resolveUserIdFromCustomer will fall back to the Identity table.
      try {
        await stripe.customers.update(customerId, {
          metadata: { openpartner_user_id: customerId, openpartner_tenant_id: click.tenantId },
        });
      } catch {
        // Non-fatal.
      }

      return { userId: customerId, type: 'signup' };
    }
    case 'customer.created': {
      const customer = event.data.object as Stripe.Customer;
      const userId = customer.metadata?.openpartner_user_id;
      if (!userId) return null;
      return { userId, type: 'signup' };
    }
    case 'customer.subscription.created': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = sub.metadata?.openpartner_user_id ?? (await resolveUserIdFromCustomer(trx, stripe, sub.customer));
      if (!userId) return null;
      return { userId, type: 'subscription_created' };
    }
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const userId = await resolveUserIdFromCustomer(trx, stripe, invoice.customer);
      if (!userId) return null;
      // `charge` was moved off the Invoice type in recent SDK versions, but the
      // webhook payload still carries it on older API versions and is useful
      // for refund lookups. Read it tolerantly.
      const rawCharge = (invoice as unknown as { charge?: string | { id: string } | null }).charge;
      const chargeId = typeof rawCharge === 'string' ? rawCharge : rawCharge?.id ?? null;
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
        },
      };
    }
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      const userId = await resolveUserIdFromCustomer(trx, stripe, charge.customer);
      if (!userId) return null;
      const rawInvoice = (charge as unknown as { invoice?: string | { id: string } | null }).invoice;
      const invoiceId = typeof rawInvoice === 'string' ? rawInvoice : rawInvoice?.id ?? null;

      // Auto-reverse non-paid Commissions linked to the original invoice.
      // Commissions already in 'paid' status are flagged for admin review —
      // we don't claw back funds that have already left the platform.
      const reversal = invoiceId
        ? await reverseCommissionsForInvoice(trx, invoiceId)
        : { reversed: 0, alreadyPaid: 0, heldInTransfer: 0 };

      return {
        userId,
        type: 'refund',
        value: -(charge.amount_refunded / 100),
        currency: charge.currency?.toUpperCase() ?? 'USD',
        metadata: {
          stripeChargeId: charge.id,
          ...(invoiceId ? { stripeInvoiceId: invoiceId } : {}),
          amountRefunded: charge.amount_refunded,
          reversedCommissions: reversal.reversed,
          alreadyPaidCommissions: reversal.alreadyPaid,
          ...(reversal.heldInTransfer > 0 ? { heldInTransferCommissions: reversal.heldInTransfer } : {}),
        },
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
 * Mark Commissions linked to a refunded invoice as 'reversed'. Walks
 * Event(metadata.stripeInvoiceId) → Attribution → Commission. Only flips
 * Commissions in 'accrued' or 'approved' status; 'paid' Commissions stay
 * paid (the partner has the money) and the count is returned so the
 * refund Event can record that admin attention is needed.
 */
async function reverseCommissionsForInvoice(
  trx: Knex.Transaction,
  invoiceId: string,
): Promise<{ reversed: number; alreadyPaid: number; heldInTransfer: number }> {
  const sourceEvents = await trx<EventRow>(TABLES.Event)
    .whereRaw(`"metadata"->>'stripeInvoiceId' = ?`, [invoiceId])
    .where('type', 'invoice_paid');
  if (sourceEvents.length === 0) return { reversed: 0, alreadyPaid: 0, heldInTransfer: 0 };

  const eventIds = sourceEvents.map((e) => e.id);
  const attributions = await trx<AttributionRow>(TABLES.Attribution).whereIn('eventId', eventIds);
  if (attributions.length === 0) return { reversed: 0, alreadyPaid: 0, heldInTransfer: 0 };
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
      `[funding] invoice ${invoiceId} refund: ${interlock.held.length} commission(s) mid-transfer — held for post-settlement adjustment`,
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
        .returning('id')) as Array<{ id: string }>);
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
        `[funding] ALERT: invoice ${invoiceId} refund: ${lateHeld} commission(s) were claimed by a payout intent or a funding allocation while the reversal was in flight (${stillPayable
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
        `[funding] ALERT: invoice ${invoiceId} refund: ${paidLate} commission(s) were PAID while the reversal was in flight — refunded revenue has left the platform; operator action required`,
      );
    }
    const otherwiseMoved = missed.length - lateHeld - paidLate;
    if (otherwiseMoved > 0) {
      console.warn(
        `[funding] invoice ${invoiceId} refund: ${otherwiseMoved} commission(s) were already reversed concurrently — not counted as held`,
      );
    }
  }

  return {
    reversed,
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
    const fetched = await stripe.customers.retrieve(customer);
    if (!fetched.deleted) metadataUserId = fetched.metadata?.openpartner_user_id ?? null;
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

/**
 * Auto-redeem any OpenPartner Coupons referenced by discount codes on
 * the event. Runs BEFORE the standard event mapping — synthesizes the
 * Click + Identity for the customer so the next attribution pass
 * credits the partner. Returns the matched codes (for logging only).
 *
 * Stripe events that can carry discount codes:
 *   - checkout.session.completed (session.discounts +
 *                                  session.total_details.breakdown.discounts)
 *   - invoice.paid (invoice.discounts)
 *   - customer.subscription.created (subscription.discounts) — invoice
 *     also fires for subs so this is partly redundant; covered for
 *     consistency.
 *
 * The customer-facing code lives at promotion_code.code (when set).
 * If the discount has only a Coupon (no PromotionCode), we fall back
 * to coupon.id — brands setting their Stripe Coupon IDs to match
 * OpenPartner codes works without an extra Stripe API call.
 */
async function maybeRedeemStripeCoupons(
  trx: Knex.Transaction,
  stripe: Stripe,
  event: Stripe.Event,
  tenantId: string,
): Promise<string[]> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const ts = new Date(event.created * 1000);

  // Customer ID — same shape across the event types we handle.
  const customerRaw =
    (obj.customer as string | { id: string } | null | undefined) ??
    (obj.customer_email as string | undefined);
  const userId = typeof customerRaw === 'string' ? customerRaw : customerRaw?.id;
  if (!userId) return [];

  // Collect candidate codes from wherever Stripe might surface them.
  const candidateCodes: string[] = [];
  for (const d of extractDiscounts(event)) {
    const code = await resolveDiscountCode(stripe, d);
    if (code) candidateCodes.push(code);
  }
  if (candidateCodes.length === 0) return [];

  const matched: string[] = [];
  for (const code of candidateCodes) {
    const coupon = await findCouponByCode(trx, code);
    if (!coupon) continue;
    await ensureCouponClickAndIdentity(trx, tenantId, coupon, userId, ts);
    matched.push(coupon.code);
  }
  return matched;
}

interface DiscountRef {
  coupon?: string | { id: string } | null;
  promotion_code?: string | { id: string; code?: string } | null;
}

function extractDiscounts(event: Stripe.Event): DiscountRef[] {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const out: DiscountRef[] = [];

  // checkout.session.completed: session.discounts + total_details.breakdown.discounts
  if (Array.isArray(obj.discounts)) {
    for (const d of obj.discounts as Array<DiscountRef | string>) {
      if (typeof d === 'object' && d !== null) out.push(d);
    }
  }
  const totalDetails = obj.total_details as
    | { breakdown?: { discounts?: Array<{ discount?: DiscountRef }> } }
    | undefined;
  if (totalDetails?.breakdown?.discounts) {
    for (const item of totalDetails.breakdown.discounts) {
      if (item.discount) out.push(item.discount);
    }
  }
  return out;
}

async function resolveDiscountCode(stripe: Stripe, d: DiscountRef): Promise<string | null> {
  // Prefer the customer-facing PromotionCode string.
  if (d.promotion_code) {
    if (typeof d.promotion_code === 'object' && d.promotion_code.code) {
      return d.promotion_code.code;
    }
    const id = typeof d.promotion_code === 'string' ? d.promotion_code : d.promotion_code.id;
    try {
      const promo = await stripe.promotionCodes.retrieve(id);
      if (promo.code) return promo.code;
    } catch (err) {
      console.error('[stripe-webhook] promotion_code retrieve failed', { id, err });
    }
  }
  // Fallback: use the Coupon's Stripe ID directly. Brands who set their
  // Stripe Coupon IDs to match OpenPartner codes don't need the API call.
  if (d.coupon) {
    return typeof d.coupon === 'string' ? d.coupon : d.coupon.id;
  }
  return null;
}
