import { Router, raw } from 'express';
import Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, type ClickRow, type EventRow, type IdentityRow, type PartnerRow, type PayoutRow } from '@openpartner/db';
import { db } from '../db.js';
import { attributeEvent } from '../attribution.js';
import { persistMerchantSubscription } from './billing.js';

const stripeKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const stripe = stripeKey ? new Stripe(stripeKey) : null;

export const stripeWebhookRouter = Router();

/**
 * Stripe webhook → raw event log.
 *
 * Each Stripe event we care about becomes an immutable Event row, then goes
 * through the attribution engine. We map:
 *   - customer.created            → 'signup'
 *   - customer.subscription.created → 'subscription_created'
 *   - invoice.paid                → 'invoice_paid' (carries revenue)
 *
 * We require stripe_userId to be present in customer metadata as
 * `openpartner_user_id` — that's the bridge from Stripe's Customer to the
 * merchant's userId, which is what Identity stitches against.
 */
stripeWebhookRouter.post(
  '/webhooks/stripe',
  raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || !webhookSecret) {
      return res.status(503).json({ error: 'stripe_not_configured' });
    }

    const sig = req.header('stripe-signature');
    if (!sig) return res.status(400).json({ error: 'missing_signature' });

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch {
      return res.status(400).json({ error: 'invalid_signature' });
    }

    const connectResult = await handleConnectEvent(event);
    if (connectResult) return res.json({ ok: true, connect: connectResult });

    const mapped = await mapStripeEvent(stripe, event);
    if (!mapped) return res.json({ ok: true, skipped: event.type });

    // Idempotency: a Stripe retry (5xx, timeout) re-delivers the same
    // event.id. Insert with ON CONFLICT DO NOTHING on the unique
    // partial index over externalEventId, then handle the dedupe path.
    const eventId = ulid();
    const inserted = await db<EventRow>(TABLES.Event)
      .insert({
        id: eventId,
        userId: mapped.userId,
        type: mapped.type,
        value: mapped.value != null ? mapped.value.toFixed(2) : null,
        currency: mapped.currency ?? 'USD',
        externalEventId: event.id,
        metadata: { stripeEventId: event.id, stripeType: event.type },
        ts: new Date(event.created * 1000),
      })
      .onConflict('externalEventId')
      .ignore()
      .returning('*');

    if (inserted.length === 0) {
      // Retry of a previously-processed event — the first delivery
      // already attributed it. Return 2xx so Stripe stops retrying.
      const existing = await db<EventRow>(TABLES.Event).where({ externalEventId: event.id }).first();
      return res.json({ ok: true, idempotent: true, eventId: existing?.id });
    }

    const result = await attributeEvent(db, inserted[0] as EventRow);
    res.json({ ok: true, eventId, attribution: result });
  },
);

// Connect-side events. These don't produce attribution Events — they update
// Partner (onboarding progress) and Payout (transfer resolution) rows.
async function handleConnectEvent(event: Stripe.Event): Promise<string | null> {
  switch (event.type) {
    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      const partnerId = account.metadata?.openpartner_partner_id;
      if (!partnerId) return 'account_updated_no_partner_id';
      await db<PartnerRow>(TABLES.Partner)
        .where({ id: partnerId })
        .update({
          stripeConnectAccountId: account.id,
          metadata: db.raw(
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
        await persistMerchantSubscription(session.customer, session.subscription);
        return 'merchant_subscription_persisted';
      }
      return null;
    }
    case 'transfer.updated':
    case 'transfer.reversed': {
      const transfer = event.data.object as Stripe.Transfer;
      const payoutId = transfer.metadata?.openpartner_payout_id;
      if (!payoutId) return null;
      const reversed = event.type === 'transfer.reversed' || (transfer.reversed ?? false);
      await db<PayoutRow>(TABLES.Payout).where({ id: payoutId }).update({
        status: reversed ? 'failed' : 'paid',
        completedAt: reversed ? null : new Date(),
      });
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
}

async function mapStripeEvent(stripe: Stripe, event: Stripe.Event): Promise<MappedEvent | null> {
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

      // Validate the cref points at a real Click — silently drop unknowns
      // so a bad client_reference_id can't inflate a partner's numbers.
      const click = await db<ClickRow>(TABLES.Click).where({ id: cref }).first();
      if (!click) return null;

      await db<IdentityRow>(TABLES.Identity)
        .insert({ id: ulid(), clickId: cref, userId: customerId })
        .onConflict(['clickId', 'userId'])
        .ignore();

      // Backfill metadata so the cheaper resolve path (metadata lookup)
      // works for downstream invoice.paid / subscription events. Best-
      // effort: if the API call fails (deleted customer, network blip),
      // resolveUserIdFromCustomer will fall back to the Identity table.
      try {
        await stripe.customers.update(customerId, {
          metadata: { openpartner_user_id: customerId },
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
      const userId = sub.metadata?.openpartner_user_id ?? (await resolveUserIdFromCustomer(stripe, sub.customer));
      if (!userId) return null;
      return { userId, type: 'subscription_created' };
    }
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const userId = await resolveUserIdFromCustomer(stripe, invoice.customer);
      if (!userId) return null;
      return {
        userId,
        type: 'invoice_paid',
        value: invoice.amount_paid / 100,
        currency: invoice.currency?.toUpperCase() ?? 'USD',
      };
    }
    default:
      return null;
  }
}

async function resolveUserIdFromCustomer(
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
  const identity = await db<IdentityRow>(TABLES.Identity).where({ userId: customerId }).first();
  return identity ? customerId : null;
}
