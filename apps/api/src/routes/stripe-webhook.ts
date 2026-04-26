import { Router, raw } from 'express';
import Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, type AttributionRow, type ClickRow, type CommissionRow, type EventRow, type IdentityRow, type PartnerRow, type PayoutRow } from '@openpartner/db';
import { db } from '../db.js';
import { attributeEvent } from '../attribution.js';
import { persistMerchantSubscription } from './billing.js';

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
        metadata: { stripeEventId: event.id, stripeType: event.type, ...(mapped.metadata ?? {}) },
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

    // Corrective events (refund, dispute, payment_failed) are recorded for
    // the audit trail but don't drive new attribution rows — handling those
    // is done in mapStripeEvent before insertion (e.g. flipping the source
    // commissions to 'reversed').
    if (CORRECTIVE_EVENT_TYPES.has(mapped.type)) {
      return res.json({ ok: true, eventId, corrective: mapped.type });
    }

    const result = await attributeEvent(db, inserted[0] as EventRow);
    res.json({ ok: true, eventId, attribution: result });
  },
);

const CORRECTIVE_EVENT_TYPES = new Set(['refund', 'dispute_created', 'invoice_payment_failed']);

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
  metadata?: Record<string, unknown>;
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
      const userId = await resolveUserIdFromCustomer(stripe, charge.customer);
      if (!userId) return null;
      const rawInvoice = (charge as unknown as { invoice?: string | { id: string } | null }).invoice;
      const invoiceId = typeof rawInvoice === 'string' ? rawInvoice : rawInvoice?.id ?? null;

      // Auto-reverse non-paid Commissions linked to the original invoice.
      // Commissions already in 'paid' status are flagged for admin review —
      // we don't claw back funds that have already left the platform.
      const reversal = invoiceId
        ? await reverseCommissionsForInvoice(invoiceId)
        : { reversed: 0, alreadyPaid: 0 };

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
          userId = await resolveUserIdFromCustomer(stripe, charge.customer);
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
      const userId = await resolveUserIdFromCustomer(stripe, invoice.customer);
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
  invoiceId: string,
): Promise<{ reversed: number; alreadyPaid: number }> {
  const sourceEvents = await db<EventRow>(TABLES.Event)
    .whereRaw(`"metadata"->>'stripeInvoiceId' = ?`, [invoiceId])
    .where('type', 'invoice_paid');
  if (sourceEvents.length === 0) return { reversed: 0, alreadyPaid: 0 };

  const eventIds = sourceEvents.map((e) => e.id);
  const attributions = await db<AttributionRow>(TABLES.Attribution).whereIn('eventId', eventIds);
  if (attributions.length === 0) return { reversed: 0, alreadyPaid: 0 };
  const attributionIds = attributions.map((a) => a.id);

  const reversed = await db<CommissionRow>(TABLES.Commission)
    .whereIn('attributionId', attributionIds)
    .whereIn('status', ['accrued', 'approved'])
    .update({ status: 'reversed' });

  const alreadyPaidRow = (await db<CommissionRow>(TABLES.Commission)
    .whereIn('attributionId', attributionIds)
    .where('status', 'paid')
    .count('id as c')
    .first()) as { c: string | number } | undefined;
  const alreadyPaid = Number(alreadyPaidRow?.c ?? 0);

  return { reversed, alreadyPaid };
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
