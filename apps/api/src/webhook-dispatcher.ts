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
 * to mitigate replay attacks. The secret is sealed at rest
 * (webhook-secret.ts) and opened here, only to sign; a delivery whose
 * secret can't be opened is recorded as failed and never sent.
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

import { createHmac } from 'node:crypto';
import { ulid } from 'ulid';
import {
  TABLES,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
  type WebhookEventType,
} from '@openpartner/db';
import { db } from './db.js';
import { dispatchPartnerPostbacks, isPostbackEvent, postbackStatus } from './partner-postback.js';
import { safeFetch } from './outbound-guard.js';
import { isPlaintextSecret, openSecret, sealStoredSecret } from './webhook-secret.js';

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

/** WebhookDelivery.error for a delivery whose signing secret can't be
 *  opened. Says what to do, never anything about the secret. */
export const SECRET_UNREADABLE_ERROR =
  "Signing secret can't be opened on this deployment (sealed under another SECRETS_ENCRYPTION_KEY). Rotate the endpoint's secret.";

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
  // Tenant-side outbound webhooks (brand integrations: Zapier / CRM / etc.).
  const endpoints = await db<WebhookEndpointRow>(TABLES.WebhookEndpoint).where({ tenantId, active: true });
  const matching = endpoints.filter((e) => {
    const events = Array.isArray(e.events) ? e.events : [];
    return events.includes(event) || events.includes('*');
  });
  if (matching.length > 0) {
    const envelope: WebhookEnvelope = {
      id: `evt_${ulid()}`,
      event,
      created: new Date().toISOString(),
      data,
    };
    await Promise.all(matching.map((endpoint) => deliverOne(tenantId, endpoint, envelope)));
  }

  // Partner-side postbacks. Only the partner's own earnings (commission.*
  // and bonus.awarded / .paid) carry a partnerId and a ledger semantic —
  // partner-state events (partner.created etc.) stay tenant-scoped.
  if (isPostbackEvent(event)) {
    const d = (data ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    // A null field is known to be empty (a click without a sub-ID, a
    // valueless event) → ''. An absent one (a bonus has no click, or the
    // origin lookup failed) → undefined, so its macro stays literal.
    const strOrEmpty = (v: unknown) => (v === null ? '' : str(v));
    const partnerId = str(d.partnerId) ?? null;
    if (partnerId) {
      dispatchPartnerPostbacks(tenantId, partnerId, event, {
        click_id: str(d.clickId),
        partner_id: partnerId,
        commission_id: str(d.commissionId),
        commission_amount: str(d.amount),
        currency: str(d.currency),
        event_id: str(d.eventId),
        transaction_id: str(d.eventId),
        event_type: str(d.eventType),
        program_id: str(d.programId),
        payout_id: str(d.payoutId),
        bonus_id: str(d.bonusId),
        bounty_id: str(d.bountyId),
        bonus_amount: event.startsWith('bonus.') ? str(d.amount) : undefined,
        sub_id: strOrEmpty(d.subId),
        status: postbackStatus(event, d.status),
        sale_amount: strOrEmpty(d.eventValue),
      });
    }
  }
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
 *  identically against real events. __tests__/openapi.test.ts parses
 *  each one against the documented catalogue (openapi/webhook-events.ts),
 *  which the contract test checks against real deliveries — event values
 *  are decimal strings there, as Event.value comes back from Postgres.
 *  Keys with no entry fall through
 *  to the generic webhook.test body (useful when an admin wants to
 *  test a custom event type they're firing themselves). */
const SYNTHETIC_PAYLOADS: Record<string, () => Record<string, unknown>> = {
  'attribution.created': () => ({
    attributionId: `01J${'2'.repeat(23)}`,
    eventId: `01J${'3'.repeat(23)}`,
    partnerId: `01J${'1'.repeat(23)}`,
    programId: 'cmp_default',
    clickId: `01J${'4'.repeat(23)}`,
    model: 'last_click',
    weight: 1,
    eventType: 'invoice_paid',
    eventValue: '60.00',
    commissionId: `01J${'0'.repeat(23)}`,
    commissionCurrency: 'USD',
  }),
  'commission.accrued': () => ({
    commissionId: `01J${'0'.repeat(23)}`,
    partnerId: `01J${'1'.repeat(23)}`,
    attributionId: `01J${'2'.repeat(23)}`,
    clickId: `01J${'4'.repeat(23)}`,
    eventId: `01J${'3'.repeat(23)}`,
    programId: 'cmp_default',
    amount: '12.00',
    currency: 'USD',
    eventType: 'invoice_paid',
    eventValue: '60.00',
    subId: 'sample-sub-id',
  }),
  // Lifecycle events share commission-events.ts's payload shape.
  'commission.approved': () => sampleLifecyclePayload(),
  'commission.paid': () => sampleLifecyclePayload({ payoutId: `01J${'5'.repeat(23)}` }),
  'commission.reversed': () => sampleLifecyclePayload({ reason: 'refund' }),
  // Bonus events share bonuses.ts's bonusPayload shape.
  'bonus.awarded': () => sampleBonusPayload({ status: 'approved' }),
  'bonus.approved': () => sampleBonusPayload(),
  'bonus.paid': () => sampleBonusPayload({ payoutId: `01J${'5'.repeat(23)}` }),
  'bonus.reversed': () => sampleBonusPayload({ reason: 'manual' }),
  'partner.created': () => ({
    partnerId: `01J${'1'.repeat(23)}`,
    email: 'sample@example.com',
    name: 'Sample Partner',
    activatedAt: null,
    invited: true,
    portalAccess: true,
    programIds: ['cmp_default'],
    source: 'api',
  }),
  'partner.activated': () => ({
    partnerId: `01J${'1'.repeat(23)}`,
    email: 'sample@example.com',
    name: 'Sample Partner',
    activatedAt: new Date().toISOString(),
    invited: true,
    source: 'api',
  }),
  'partnership.approved': () => ({
    partnerId: `01J${'1'.repeat(23)}`,
    email: 'sample@example.com',
    name: 'Sample Partner',
    networkCreatorId: `crt_${'a'.repeat(20)}`,
    programIds: ['cmp_default'],
  }),
  'payout.created': () => ({
    payoutId: `01J${'5'.repeat(23)}`,
    partnerId: `01J${'1'.repeat(23)}`,
    amount: '120.00',
    currency: 'USD',
    method: 'manual',
    commissionIds: [`01J${'0'.repeat(23)}`],
  }),
};

function sampleLifecyclePayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commissionId: `01J${'0'.repeat(23)}`,
    partnerId: `01J${'1'.repeat(23)}`,
    attributionId: `01J${'2'.repeat(23)}`,
    amount: '12.00',
    currency: 'USD',
    clickId: `01J${'4'.repeat(23)}`,
    eventId: `01J${'3'.repeat(23)}`,
    eventType: 'invoice_paid',
    programId: 'cmp_default',
    eventValue: '60.00',
    subId: 'sample-sub-id',
    ...extra,
  };
}

function sampleBonusPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bonusId: `01J${'6'.repeat(23)}`,
    commissionId: `01J${'0'.repeat(23)}`,
    partnerId: `01J${'1'.repeat(23)}`,
    programId: 'cmp_default',
    bountyId: null,
    source: 'manual',
    amount: '50.00',
    currency: 'USD',
    note: 'Thanks for a great launch week',
    ...extra,
  };
}

export function payloadFor(eventType: string, endpointId: string): Record<string, unknown> {
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

/**
 * The endpoint's signing key, or null when its secret can't be opened. A
 * plaintext secret (from before sealing, or a SQL-dump restore) is sealed
 * on the way; failing to seal it doesn't stop the delivery, and the sweep
 * (webhook-secret.ts) tries again. Logs the endpoint id only.
 */
async function signingKey(endpoint: WebhookEndpointRow): Promise<string | null> {
  const key = openSecret(endpoint.secret);
  if (key && isPlaintextSecret(endpoint.secret)) {
    await sealStoredSecret(db, endpoint.id, endpoint.secret).catch(() => {
      console.error(`[webhook] couldn't seal the signing secret of endpoint ${endpoint.id}; the seal sweep will retry`);
    });
  }
  return key;
}

async function attemptDelivery(deliveryId: string, endpoint: WebhookEndpointRow, body: string): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const envelope = JSON.parse(body) as WebhookEnvelope;

  const attemptAt = new Date();
  const key = await signingKey(endpoint);
  if (!key) {
    await db<WebhookDeliveryRow>(TABLES.WebhookDelivery)
      .where({ id: deliveryId })
      .update({
        status: 'failed',
        error: SECRET_UNREADABLE_ERROR,
        attempts: db.raw('attempts + 1'),
        lastAttemptAt: attemptAt,
      });
    return;
  }
  const signature = signPayload(key, timestamp, body);
  try {
    // safeFetch enforces the SSRF policy (public-unicast destination, DNS
    // pinning, no redirects) and throws OutboundBlockedError — caught below
    // and recorded as a failed delivery — for anything it refuses.
    const res = await safeFetch(endpoint.url, {
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
      timeoutMs: 10_000,
      // Admin-configured endpoint: full deployment policy (may use the
      // operator's private-CIDR escape hatch on self-host).
      trust: 'admin',
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
