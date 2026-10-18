/**
 * POST /webhooks/stripe-app — events from hosted brands' own Stripe
 * accounts, delivered by the OpenPartner Stripe App's Connect webhook
 * endpoint ("Listen to events on Connected accounts") in the app's
 * developer account. docs/stripe-app.md has the endpoint setup.
 *
 * Kept apart from /webhooks/stripe on purpose:
 *   - its own signing secrets (STRIPE_APP_WEBHOOK_SECRET), so neither
 *     route accepts the other's deliveries;
 *   - the tenant comes ONLY from event.account through
 *     TenantStripeConnection — never from object metadata, which the
 *     brand controls — and an account no live connection names is
 *     skipped;
 *   - only brand-attribution event types run (STRIPE_APP_ATTRIBUTION_
 *     EVENT_TYPES), through processBrandStripeEvent: the same mapping
 *     single-tenant self-host uses. The funding pipeline and the
 *     billing / payout handlers (handleConnectEvent) never see these
 *     events — they're about OpenPartner's own account.
 *
 * Retries: a transient failure (database, a Stripe read, a token refresh
 * that couldn't reach Stripe) answers 500 so Stripe redelivers; every
 * recorded Event is idempotent on its key. A connection that's gone or
 * waiting for a reconnect answers 2xx with a skip reason, so one brand's
 * revoked grant doesn't keep the shared endpoint failing for days.
 */

import { Router, raw } from 'express';
import Stripe from 'stripe';
import { announceRefund } from '../refunds.js';
import {
  STRIPE_APP_ATTRIBUTION_EVENT_TYPES,
  StripeConnectionUnavailableError,
  activeConnectionForAccount,
  brandStripe,
  disconnectAccount,
  isHostedMode,
  recordPermissionsGranted,
  stripeAppWebhookSecrets,
  tenantAcceptsStripeEvents,
  touchConnection,
} from '../stripe-app.js';
import { withTenantTransaction } from '../tenancy.js';
import { processBrandStripeEvent, type BrandStripeSource } from './stripe-webhook.js';

export const stripeAppWebhookRouter = Router();

/** The app was uninstalled (or its install deleted). The install event
 *  names changed in API version 2026-09-30; accept both. */
const UNINSTALL_EVENT_TYPES = new Set(['account.application.deauthorized', 'apps.install.deleted', 'app.install.deleted']);
/** An install's granted permissions, created or changed. */
const INSTALL_EVENT_TYPES = new Set(['apps.install.created', 'apps.install.updated', 'app.install.created', 'app.install.updated']);

// Signature checks only need the SDK's webhook helper, which no API call
// backs; the key is a placeholder.
let verifier: Stripe | null = null;
function verifyEvent(body: Buffer, sig: string, secrets: string[]): Stripe.Event | null {
  verifier ??= new Stripe('sk_stripe_app_webhook_verify_only');
  for (const secret of secrets) {
    try {
      return verifier.webhooks.constructEvent(body, sig, secret);
    } catch {
      // Not this secret — try the next (one per endpoint, plus rotation).
    }
  }
  return null;
}

stripeAppWebhookRouter.post('/webhooks/stripe-app', raw({ type: 'application/json' }), async (req, res) => {
  const secrets = stripeAppWebhookSecrets();
  // Hosted only: on a self-host the brand's account already posts to
  // /webhooks/stripe.
  if (!isHostedMode() || secrets.length === 0) return res.status(503).json({ error: 'stripe_app_not_configured' });

  const sig = req.header('stripe-signature');
  if (!sig) return res.status(400).json({ error: 'missing_signature' });
  const event = verifyEvent(req.body, sig, secrets);
  if (!event) return res.status(400).json({ error: 'invalid_signature' });

  // An app event names the installing account. One without it is the
  // developer account's own (its own install notices), not a brand's.
  const account = typeof event.account === 'string' ? event.account : null;
  if (!account) return res.json({ ok: true, skipped: event.type, reason: 'no_account' });

  if (UNINSTALL_EVENT_TYPES.has(event.type)) {
    // Only the connection in the event's mode: uninstalling from the
    // test-mode sandbox leaves a live connection running.
    const tenants = await disconnectAccount(account, event.livemode);
    if (tenants.length > 0) {
      console.log('[stripe-app] app uninstalled in Stripe; connection closed', { account, livemode: event.livemode, tenants });
    }
    return res.json({ ok: true, deauthorized: tenants.length });
  }
  if (INSTALL_EVENT_TYPES.has(event.type)) {
    const granted = (event.data.object as { permissions_granted?: unknown }).permissions_granted;
    const permissions = Array.isArray(granted)
      ? granted
          .map((p) => (typeof p === 'string' ? p : (p as { permission?: unknown } | null)?.permission))
          .filter((p): p is string => typeof p === 'string')
      : null;
    const updated = permissions ? await recordPermissionsGranted(account, event.livemode, permissions) : 0;
    return res.json({ ok: true, install: event.type, updated });
  }
  if (!STRIPE_APP_ATTRIBUTION_EVENT_TYPES.has(event.type)) {
    // account.application.authorized lands here too: the connection is
    // made by the OAuth completion, which has the tenant; this event
    // doesn't.
    return res.json({ ok: true, skipped: event.type, reason: 'unhandled_type' });
  }

  const conn = await activeConnectionForAccount(account);
  if (!conn) return res.json({ ok: true, skipped: event.type, reason: 'unknown_account' });
  // A live Connect endpoint also receives test-mode events from an
  // account that installed the app in both modes.
  if (conn.livemode !== event.livemode) return res.json({ ok: true, skipped: event.type, reason: 'livemode_mismatch' });
  if (conn.refreshFailedAt) return res.json({ ok: true, skipped: event.type, reason: 'reconnect_needed' });
  if (!(await tenantAcceptsStripeEvents(conn.tenantId))) {
    return res.json({ ok: true, skipped: event.type, reason: 'tenant_inactive' });
  }

  let stripe: Stripe;
  try {
    stripe = await brandStripe(conn);
  } catch (err) {
    if (err instanceof StripeConnectionUnavailableError) {
      return res.json({ ok: true, skipped: event.type, reason: err.reason });
    }
    throw err;
  }
  await touchConnection(conn.id);

  const source: BrandStripeSource = {
    stripe,
    brandAccount: true,
    writeCustomerMetadata: false,
    keyRevenueByTransaction: true,
    // `via`, not `source`: the mapping uses metadata.source for how a
    // conversion was attributed ('coupon'), and would overwrite it.
    eventMetadata: { via: 'stripe_app', stripeAccountId: account },
  };
  // What a refund did to commissions inside the transaction. Announced
  // (commission.* webhooks, partner postbacks) only once it has committed,
  // as on /webhooks/stripe.
  let refunds: Awaited<ReturnType<typeof processBrandStripeEvent>>['refunds'] = [];
  const result = await withTenantTransaction(conn.tenantId, async (trx) => {
    const processed = await processBrandStripeEvent(trx, source, event, conn.tenantId);
    refunds = processed.refunds;
    return processed.result;
  });
  for (const r of refunds) void announceRefund(conn.tenantId, r.announce, { kind: 'refund', refundEventId: r.refundEventId });
  res.json({ ok: true, ...result });
});
