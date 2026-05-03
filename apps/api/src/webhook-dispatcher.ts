/**
 * Outbound webhook dispatcher.
 *
 * dispatchEvent(tenantId, type, data) fans out to every active endpoint
 * in `tenantId` subscribed to `type`, writes a WebhookDelivery row per
 * recipient, and fires the HTTP POST asynchronously so the inbound
 * request that triggered the event isn't blocked on webhook RTT.
 *
 * Signature: HMAC-SHA256 of `${timestamp}.${rawBody}` keyed on the
 * endpoint's signing secret — the same pattern Stripe uses. Receivers
 * verify by reading X-OpenPartner-Timestamp + X-OpenPartner-Signature,
 * recomputing, and rejecting timestamps drifting more than 5 minutes
 * to mitigate replay attacks.
 *
 * MVP does not auto-retry. WebhookDelivery rows capture every failure
 * with attempts + error, and admins can hit POST /webhooks/:id/
 * deliveries/:deliveryId/retry from the UI. A background retry cron
 * with exponential backoff is an obvious future extension.
 *
 * Multi-tenant: dispatch runs asynchronously after the request that
 * triggered it has responded — so the per-request transaction is gone
 * by the time we run. We use the privileged `db` directly and filter
 * every query by `tenantId` explicitly.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import {
  TABLES,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
  type WebhookEventType,
} from '@openpartner/db';
import { db } from './db.js';

const SIGNATURE_HEADER = 'x-openpartner-signature';
const TIMESTAMP_HEADER = 'x-openpartner-timestamp';
const EVENT_HEADER = 'x-openpartner-event';
const DELIVERY_HEADER = 'x-openpartner-delivery';

export interface WebhookEnvelope<T = unknown> {
  id: string;
  event: WebhookEventType;
  created: string;
  data: T;
}

export function makeSecret(): { plaintext: string; prefix: string } {
  const plaintext = `whsec_${randomBytes(24).toString('base64url')}`;
  return { plaintext, prefix: plaintext.slice(0, 12) };
}

export function signPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Fire-and-forget. Errors are trapped and logged; a webhook dispatch
 * failure cannot affect the caller's transaction. Callers invoke this
 * AFTER their DB writes have committed, so a subscriber receiving an
 * event can safely fetch the related rows via the API.
 */
export function dispatchEvent(tenantId: string, event: WebhookEventType, data: unknown): void {
  void runDispatch(tenantId, event, data).catch((err) => {
    console.error(`[webhook] dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function runDispatch(tenantId: string, event: WebhookEventType, data: unknown): Promise<void> {
  const endpoints = await db<WebhookEndpointRow>(TABLES.WebhookEndpoint).where({ tenantId, active: true });
  const matching = endpoints.filter((e) => {
    const events = Array.isArray(e.events) ? e.events : [];
    return events.includes(event) || events.includes('*');
  });
  if (matching.length === 0) return;

  const envelope: WebhookEnvelope = {
    id: `evt_${ulid()}`,
    event,
    created: new Date().toISOString(),
    data,
  };

  await Promise.all(matching.map((endpoint) => deliverOne(tenantId, endpoint, envelope)));
}

/**
 * Synchronous test ping. Used by Zapier / ActivePieces setup flows
 * via POST /webhooks/:id/test — admin clicks "Send test" and we want
 * to surface the result immediately rather than dropping it in the
 * delivery log to be hunted for. Returns the WebhookDelivery row
 * after the attempt completes (delivered or failed).
 *
 * Pass an `eventType` (any of SYNTHETIC_PAYLOADS keys, or omit) to
 * fire a realistic-looking sample payload for that event type
 * instead of the generic webhook.test envelope. Useful for
 * end-to-end testing of Zapier triggers + ActivePieces pieces
 * without needing to seed real conversion data on the brand's DB.
 *
 * The synthetic fire bypasses subscription filtering — the event
 * goes to the chosen endpoint regardless of whether that endpoint
 * subscribes to the chosen event type. That's intentional: this
 * is a testing tool, not a normal dispatch path.
 */
export async function sendTest(
  tenantId: string,
  endpointId: string,
  eventType: string = 'webhook.test',
): Promise<WebhookDeliveryRow | null> {
  const endpoint = await db<WebhookEndpointRow>(TABLES.WebhookEndpoint)
    .where({ id: endpointId, tenantId })
    .first();
  if (!endpoint) return null;
  const envelope: WebhookEnvelope = {
    id: `evt_${ulid()}`,
    event: eventType as WebhookEventType,
    created: new Date().toISOString(),
    data: payloadFor(eventType, endpoint.id),
  };
  await deliverOne(tenantId, endpoint, envelope);
  // Re-fetch the delivery row that deliverOne wrote so the caller
  // sees status / httpStatus / error.
  return (
    (await db<WebhookDeliveryRow>(TABLES.WebhookDelivery)
      .where({ eventId: envelope.id })
      .first()) ?? null
  );
}

/** Sample payload bodies for each known event type — shape-matches
 *  what real fires from attribution.ts / payouts.ts / commissions.ts
 *  produce, so a Zap built against a synthetic sample works
 *  identically against real events. Keys with no entry fall through
 *  to the generic webhook.test body (useful when an admin wants to
 *  test a custom event type they're firing themselves). */
const SYNTHETIC_PAYLOADS: Record<string, () => Record<string, unknown>> = {
  'attribution.created': () => ({
    attributionId: `01J${'2'.repeat(23)}`,
    eventId: `01J${'3'.repeat(23)}`,
    partnerId: `01J${'1'.repeat(23)}`,
    campaignId: 'cmp_default',
    clickId: `01J${'4'.repeat(23)}`,
    model: 'last_click',
    weight: 1,
    eventType: 'invoice_paid',
    eventValue: 60.0,
    commissionId: `01J${'0'.repeat(23)}`,
    commissionAmount: '12.00',
    commissionCurrency: 'USD',
  }),
  'commission.accrued': () => ({
    commissionId: `01J${'0'.repeat(23)}`,
    partnerId: `01J${'1'.repeat(23)}`,
    attributionId: `01J${'2'.repeat(23)}`,
    campaignId: 'cmp_default',
    amount: '12.00',
    currency: 'USD',
    eventType: 'invoice_paid',
    eventValue: 60.0,
  }),
  'commission.approved': () => ({
    commissionId: `01J${'0'.repeat(23)}`,
    partnerId: `01J${'1'.repeat(23)}`,
    amount: '12.00',
    currency: 'USD',
    approvedAt: new Date().toISOString(),
  }),
  'commission.paid': () => ({
    commissionId: `01J${'0'.repeat(23)}`,
    payoutId: `01J${'5'.repeat(23)}`,
    partnerId: `01J${'1'.repeat(23)}`,
    amount: '12.00',
    currency: 'USD',
  }),
  'commission.reversed': () => ({
    commissionId: `01J${'0'.repeat(23)}`,
    partnerId: `01J${'1'.repeat(23)}`,
    amount: '12.00',
    currency: 'USD',
    reason: 'refund',
  }),
  'partner.created': () => ({
    partnerId: `01J${'1'.repeat(23)}`,
    email: 'sample@example.com',
    name: 'Sample Partner',
    activatedAt: null,
    invited: true,
    campaignIds: ['cmp_default'],
  }),
  'partner.activated': () => ({
    partnerId: `01J${'1'.repeat(23)}`,
    email: 'sample@example.com',
    name: 'Sample Partner',
    activatedAt: new Date().toISOString(),
  }),
  'partnership.approved': () => ({
    partnerId: `01J${'1'.repeat(23)}`,
    email: 'sample@example.com',
    name: 'Sample Partner',
    networkCreatorId: `crt_${'a'.repeat(20)}`,
    campaignIds: ['cmp_default'],
  }),
  'payout.created': () => ({
    payoutId: `01J${'5'.repeat(23)}`,
    partnerId: `01J${'1'.repeat(23)}`,
    amount: '120.00',
    currency: 'USD',
    commissionCount: 10,
  }),
};

function payloadFor(eventType: string, endpointId: string): Record<string, unknown> {
  const factory = SYNTHETIC_PAYLOADS[eventType];
  if (factory) {
    return { ...factory(), _synthetic: true, _endpointId: endpointId };
  }
  return {
    message: 'This is a test webhook delivery from OpenPartner.',
    endpointId,
    sentAt: new Date().toISOString(),
    _synthetic: true,
  };
}

async function deliverOne(tenantId: string, endpoint: WebhookEndpointRow, envelope: WebhookEnvelope): Promise<void> {
  const deliveryId = ulid();
  const body = JSON.stringify(envelope);

  await db<WebhookDeliveryRow>(TABLES.WebhookDelivery).insert({
    id: deliveryId,
    tenantId,
    endpointId: endpoint.id,
    eventId: envelope.id,
    eventType: envelope.event,
    payload: body as unknown as never,
    status: 'pending',
    attempts: 0,
  });

  await attemptDelivery(deliveryId, endpoint, body);
}

async function attemptDelivery(deliveryId: string, endpoint: WebhookEndpointRow, body: string): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(endpoint.secret, timestamp, body);
  const envelope = JSON.parse(body) as WebhookEnvelope;

  const attemptAt = new Date();
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signature,
        [EVENT_HEADER]: envelope.event,
        [DELIVERY_HEADER]: envelope.id,
        'user-agent': 'OpenPartner-Webhooks/1',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const ok = res.ok;
    await db<WebhookDeliveryRow>(TABLES.WebhookDelivery)
      .where({ id: deliveryId })
      .update({
        status: ok ? 'delivered' : 'failed',
        httpStatus: res.status,
        attempts: db.raw('attempts + 1'),
        lastAttemptAt: attemptAt,
        deliveredAt: ok ? attemptAt : null,
        error: ok ? null : `HTTP ${res.status}`,
      });
    await db<WebhookEndpointRow>(TABLES.WebhookEndpoint)
      .where({ id: endpoint.id })
      .update({ lastUsedAt: attemptAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db<WebhookDeliveryRow>(TABLES.WebhookDelivery)
      .where({ id: deliveryId })
      .update({
        status: 'failed',
        error: message,
        attempts: db.raw('attempts + 1'),
        lastAttemptAt: attemptAt,
      });
  }
}

export async function redeliver(tenantId: string, deliveryId: string): Promise<WebhookDeliveryRow | null> {
  const delivery = await db<WebhookDeliveryRow>(TABLES.WebhookDelivery)
    .where({ id: deliveryId, tenantId })
    .first();
  if (!delivery) return null;
  const endpoint = await db<WebhookEndpointRow>(TABLES.WebhookEndpoint)
    .where({ id: delivery.endpointId, tenantId })
    .first();
  if (!endpoint) return null;

  const body = typeof delivery.payload === 'string' ? delivery.payload : JSON.stringify(delivery.payload);
  await attemptDelivery(deliveryId, endpoint, body);
  return (
    (await db<WebhookDeliveryRow>(TABLES.WebhookDelivery).where({ id: deliveryId, tenantId }).first()) ?? null
  );
}
