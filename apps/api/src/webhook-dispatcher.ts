/**
 * Outbound webhook dispatcher.
 *
 * dispatchEvent(type, data) fans out to every active endpoint subscribed
 * to `type`, writes a WebhookDelivery row per recipient, and fires the
 * HTTP POST asynchronously so the inbound request that triggered the
 * event isn't blocked on webhook RTT.
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
export function dispatchEvent(event: WebhookEventType, data: unknown): void {
  void runDispatch(event, data).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[webhook] dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function runDispatch(event: WebhookEventType, data: unknown): Promise<void> {
  const endpoints = await db<WebhookEndpointRow>(TABLES.WebhookEndpoint).where({ active: true });
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

  await Promise.all(matching.map((endpoint) => deliverOne(endpoint, envelope)));
}

async function deliverOne(endpoint: WebhookEndpointRow, envelope: WebhookEnvelope): Promise<void> {
  const deliveryId = ulid();
  const body = JSON.stringify(envelope);

  await db<WebhookDeliveryRow>(TABLES.WebhookDelivery).insert({
    id: deliveryId,
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

export async function redeliver(deliveryId: string): Promise<WebhookDeliveryRow | null> {
  const delivery = await db<WebhookDeliveryRow>(TABLES.WebhookDelivery).where({ id: deliveryId }).first();
  if (!delivery) return null;
  const endpoint = await db<WebhookEndpointRow>(TABLES.WebhookEndpoint).where({ id: delivery.endpointId }).first();
  if (!endpoint) return null;

  const body = typeof delivery.payload === 'string' ? delivery.payload : JSON.stringify(delivery.payload);
  await attemptDelivery(deliveryId, endpoint, body);
  return (await db<WebhookDeliveryRow>(TABLES.WebhookDelivery).where({ id: deliveryId }).first()) ?? null;
}
