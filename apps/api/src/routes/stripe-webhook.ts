import { Router, raw } from 'express';
import Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, type EventRow, type PartnerRow, type PayoutRow } from '@openpartner/db';
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

    const eventId = ulid();
    const [inserted] = await db<EventRow>(TABLES.Event)
      .insert({
        id: eventId,
        userId: mapped.userId,
        type: mapped.type,
        value: mapped.value != null ? mapped.value.toFixed(2) : null,
        currency: mapped.currency ?? 'USD',
        metadata: { stripeEventId: event.id, stripeType: event.type },
        ts: new Date(event.created * 1000),
      })
      .returning('*');

    const result = await attributeEvent(db, inserted as EventRow);
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
  if (typeof customer === 'string') {
    const fetched = await stripe.customers.retrieve(customer);
    if (fetched.deleted) return null;
    return fetched.metadata?.openpartner_user_id ?? null;
  }
  if ('deleted' in customer && customer.deleted) return null;
  return (customer as Stripe.Customer).metadata?.openpartner_user_id ?? null;
}
