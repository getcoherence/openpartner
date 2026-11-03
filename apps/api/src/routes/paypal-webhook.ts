/**
 * POST /webhooks/paypal/:connectionId — events from a brand's own PayPal
 * app, delivered to the webhook OpenPartner registered on it when the brand
 * connected (paypal-connection.ts): Payouts events for Pay with PayPal, and
 * payment events for an app that tracks payments
 * (docs/paypal-payments.md). The URL names the connection; the tenant
 * comes only from that row.
 *
 *   1. The signature is checked by PayPal itself
 *      (verify-webhook-signature, with the brand's token and the webhook
 *      id OpenPartner registered and keeps sealed). A delivery signed for
 *      any other webhook, say one an attacker pointed at this URL from
 *      their own PayPal app, fails, because the webhook id is part of
 *      what PayPal signed. The cert URL is never fetched here.
 *   2. A Payouts event only names the batch, which is then read back from
 *      PayPal (syncBatch) and applied to that batch's own payouts in that
 *      tenant: nothing acts on its payload.
 *   3. A payment event is recorded from its payload (paypal-payments.ts),
 *      which the verification proves is PayPal's, in the connection's
 *      tenant, and only while that connection tracks payments.
 *
 * Mounted before express.json() (it needs the exact bytes) and before
 * tenantMiddleware (PayPal posts to one URL with no tenant in it). Answers:
 *   - 200 for anything verified, including events it ignores, and for a
 *     connection that is gone, so PayPal stops redelivering;
 *   - 400 for a delivery that fails verification or isn't JSON;
 *   - 503 when PayPal couldn't be asked to verify (PayPal redelivers);
 *   - 500 when a payment event couldn't be recorded (a database or PayPal
 *     read failed): PayPal redelivers, and recording is idempotent.
 */

import { Router, raw, type Response } from 'express';
import { TABLES, type PaypalConnectionRow, type PaypalPayoutBatchRow } from '@openpartner/db';
import { db as privilegedDb } from '../db.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { PAYPAL_PAYMENT_EVENTS, verifyWebhookSignature, type PaypalSignatureHeaders, type PaypalWebhookEvent } from '../paypal-api.js';
import { PaypalConnectError, openWebhookId, paypalAccessToken } from '../paypal-connection.js';
import { factFromWebhookEvent, processPaypalFact, type PaypalFactResult } from '../paypal-payments.js';
import { syncPaypalBatchNow } from '../paypal-payouts.js';
import { announceRefund } from '../refunds.js';
import { tenantAcceptsStripeEvents } from '../stripe-app.js';
import { withTenantTransaction } from '../tenancy.js';

const PAYMENT_EVENTS: ReadonlySet<string> = new Set(PAYPAL_PAYMENT_EVENTS);

export const paypalWebhookRouter = Router();

/** PayPal posts from many addresses; this only caps a flood at one route
 *  that would otherwise spend the brand's PayPal API quota verifying. */
const webhookLimit = ipRateLimit({ name: 'paypal-webhook', max: 300, windowMs: 60_000 });

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function signatureHeaders(get: (name: string) => string | undefined): PaypalSignatureHeaders | null {
  const h = {
    authAlgo: get('paypal-auth-algo'),
    certUrl: get('paypal-cert-url'),
    transmissionId: get('paypal-transmission-id'),
    transmissionSig: get('paypal-transmission-sig'),
    transmissionTime: get('paypal-transmission-time'),
  };
  if (!h.authAlgo || !h.certUrl || !h.transmissionId || !h.transmissionSig || !h.transmissionTime) return null;
  // PayPal's certificates live on paypal.com. Anything else can't verify,
  // so refuse it without spending a call on it.
  try {
    const u = new URL(h.certUrl);
    if (u.protocol !== 'https:' || !(u.hostname === 'paypal.com' || u.hostname.endsWith('.paypal.com'))) return null;
  } catch {
    return null;
  }
  return h as PaypalSignatureHeaders;
}

paypalWebhookRouter.post(
  '/webhooks/paypal/:connectionId',
  webhookLimit,
  raw({ type: () => true, limit: '512kb' }),
  async (req, res) => {
    const connectionId = req.params.connectionId!;
    if (!ULID.test(connectionId)) return res.status(404).json({ error: 'not_found' });
    const conn = (await privilegedDb<PaypalConnectionRow>(TABLES.PaypalConnection).where({ id: connectionId }).first()) as
      | PaypalConnectionRow
      | undefined;
    // Gone, or never registered a webhook: acknowledge so PayPal stops.
    const webhookId = conn && !conn.disconnectedAt ? openWebhookId(conn) : null;
    if (!conn || !webhookId) return res.status(200).json({ received: true, skipped: 'not_connected' });

    const headers = signatureHeaders((n) => req.header(n) ?? undefined);
    if (!headers) return res.status(400).json({ error: 'missing_signature' });
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    let event: { event_type?: unknown; resource?: Record<string, unknown> };
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.event_type !== 'string') {
      return res.status(400).json({ error: 'invalid_body' });
    }

    let genuine: boolean;
    try {
      const token = await paypalAccessToken(privilegedDb, conn);
      genuine = await verifyWebhookSignature(conn.environment, token, webhookId, headers, rawBody);
    } catch (err) {
      if (err instanceof PaypalConnectError) return res.status(200).json({ received: true, skipped: 'credentials_refused' });
      return res.status(503).json({ error: 'verification_unavailable' });
    }
    if (!genuine) return res.status(400).json({ error: 'invalid_signature' });

    if (PAYMENT_EVENTS.has(event.event_type)) return paymentEvent(res, conn, event, event.event_type);
    if (conn.purpose !== 'payouts') return res.status(200).json({ received: true, skipped: 'event_type' });
    if (!event.event_type.startsWith('PAYMENT.PAYOUTSBATCH.') && !event.event_type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
      return res.status(200).json({ received: true, skipped: 'event_type' });
    }
    const resource = event.resource ?? {};
    const header = resource.batch_header as { payout_batch_id?: unknown; sender_batch_header?: { sender_batch_id?: unknown } } | undefined;
    const payoutBatchId = typeof header?.payout_batch_id === 'string' ? header.payout_batch_id : typeof resource.payout_batch_id === 'string' ? resource.payout_batch_id : null;
    // A batch event also names our own id: it finds a batch whose POST
    // answer never arrived, which the sync then re-sends (PayPal answers
    // with the batch it already has).
    const rawSender = header?.sender_batch_header?.sender_batch_id;
    const senderBatchId = typeof rawSender === 'string' && ULID.test(rawSender) ? rawSender : null;
    if (!payoutBatchId && !senderBatchId) return res.status(200).json({ received: true, skipped: 'no_batch' });

    const scope = { tenantId: conn.tenantId, environment: conn.environment };
    const batch = ((payoutBatchId
      ? await privilegedDb<PaypalPayoutBatchRow>(TABLES.PaypalPayoutBatch).where({ ...scope, payoutBatchId }).first()
      : undefined) ??
      (senderBatchId
        ? await privilegedDb<PaypalPayoutBatchRow>(TABLES.PaypalPayoutBatch).where({ ...scope, id: senderBatchId }).whereNull('payoutBatchId').first()
        : undefined)) as PaypalPayoutBatchRow | undefined;
    // A batch the brand sent some other way: not ours to follow.
    if (!batch) return res.status(200).json({ received: true, skipped: 'unknown_batch' });

    try {
      await syncPaypalBatchNow(privilegedDb, conn.tenantId, batch.id);
    } catch (err) {
      // The poll catches up; a redelivery wouldn't do better.
      console.error(`[paypal] webhook sync of batch ${batch.id} failed`, err instanceof Error ? err.message : err);
    }
    res.status(200).json({ received: true });
  },
);

/** A verified payment event: recorded in the connection's tenant. */
async function paymentEvent(res: Response, conn: PaypalConnectionRow, event: PaypalWebhookEvent, type: string) {
  if (!conn.paymentsSince) return res.status(200).json({ received: true, skipped: 'payments_not_tracked' });
  if (!(await tenantAcceptsStripeEvents(conn.tenantId))) return res.status(200).json({ received: true, skipped: 'tenant_inactive' });
  const fact = factFromWebhookEvent(event);
  // A pending capture, a refund not finished yet: its completion is
  // another event.
  if (!fact) return res.status(200).json({ received: true, skipped: 'not_final' });

  // Best effort, for the Integrations card: never fails the delivery.
  await privilegedDb(TABLES.PaypalConnection)
    .where({ id: conn.id })
    .update({ lastPaymentEventAt: new Date() })
    .catch(() => undefined);

  let result: PaypalFactResult;
  try {
    result = await withTenantTransaction(conn.tenantId, (trx) =>
      processPaypalFact(trx, { conn, via: 'webhook', type, token: () => paypalAccessToken(privilegedDb, conn) }, fact),
    );
  } catch (err) {
    // A constant format: the event id comes from the delivery.
    console.error('[paypal] payment event %s for connection %s failed', String(event.id ?? ''), conn.id, err instanceof Error ? err.message : err);
    return res.status(500).json({ error: 'not_recorded' });
  }
  for (const r of result.refunds) void announceRefund(conn.tenantId, r.announce, { kind: 'refund', refundEventId: r.refundEventId });
  return res.status(200).json({ received: true, outcome: result.outcome });
}
