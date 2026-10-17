/**
 * Outbound webhook catalogue — one schema per event type, matching the
 * payloads the `dispatchEvent` call sites build (attribution.ts,
 * commission-events.ts, payouts.ts, payout-transfers.ts,
 * funding/executor.ts, routes/partners.ts, routes/partner-auth.ts).
 *
 * The test-fire samples in webhook-dispatcher.ts are parsed against these
 * by __tests__/openapi.test.ts, and real deliveries by
 * __tests__/openapi-contract.test.ts, so a Zap or CRM mapping built from
 * this catalogue matches what actually arrives.
 */

import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { KNOWN_EVENTS } from '../routes/webhooks.js';
import { ATTRIBUTION_MODELS, PAYOUT_METHODS } from './enums.js';
import { Decimal, orNull } from './schemas.js';

const id = z.string();

/** Event.value as stored: a decimal string, or null for valueless events. */
const eventValue = orNull(Decimal).openapi({ description: "The triggering event's `value` (decimal string), or null." });

const commissionOrigin = {
  clickId: id.optional().openapi({ description: 'The click the commission traces back to. Omitted only if the origin lookup failed.' }),
  eventId: id.optional(),
  eventType: z.string().optional(),
  programId: id.optional(),
};

const lifecycleBase = z.object({
  commissionId: id,
  partnerId: id,
  attributionId: id,
  amount: Decimal,
  currency: z.string(),
  ...commissionOrigin,
});

export const WEBHOOK_PAYLOADS = {
  'attribution.created': z.object({
    attributionId: id,
    eventId: id,
    partnerId: id,
    programId: id,
    clickId: id,
    model: z.enum(ATTRIBUTION_MODELS),
    weight: z.number().openapi({ description: "This partner's share of the event, 0–1." }),
    eventType: z.string(),
    eventValue,
    commissionId: id.optional().openapi({
      description: 'The first commission this attribution produced; omitted when it produced none. Listen to `commission.accrued` for every commission.',
    }),
    commissionCurrency: z.string(),
  }),
  'commission.accrued': z.object({
    commissionId: id,
    partnerId: id,
    attributionId: id,
    clickId: id,
    eventId: id,
    programId: id,
    amount: Decimal,
    currency: z.string(),
    eventType: z.string(),
    eventValue,
  }),
  'commission.approved': lifecycleBase,
  'commission.paid': lifecycleBase.extend({ payoutId: id }),
  'commission.reversed': lifecycleBase.extend({
    reason: z.enum(['manual', 'refund']).openapi({ description: '`manual` = an admin reversed it; `refund` = a Stripe refund or dispute.' }),
  }),
  'partner.created': z.object({
    partnerId: id,
    email: z.string().email(),
    name: z.string(),
    activatedAt: z.string().datetime().nullable(),
    invited: z.boolean().openapi({ description: 'An invite email was sent (`sendInvite` was not false).' }),
    portalAccess: z.boolean().openapi({ description: 'The partner may sign in to the partner portal. See `portalAccess` on `POST /partners`.' }),
    programIds: z.array(id),
  }),
  'partner.activated': z.object({
    partnerId: id,
    email: z.string().email(),
    name: z.string(),
    activatedAt: z.string().datetime(),
    invited: z.boolean().openapi({
      description: '`true`: the partner accepted an invite and signed in. `false`: `POST /partners` created them active (`sendInvite: false`); they have not signed in, and may have no portal access.',
    }),
  }),
  'partnership.approved': z.object({
    partnerId: id,
    email: z.string().email(),
    name: z.string(),
    networkCreatorId: z.unknown().openapi({ description: "The creator's OpenPartner Network id, as the Network sent it." }),
    programIds: z.array(id),
  }),
  'payout.created': z.object({
    payoutId: id,
    partnerId: id,
    amount: Decimal,
    currency: z.string(),
    method: z.enum(PAYOUT_METHODS),
    commissionIds: z.array(id),
    platformFee: z.number().optional().openapi({ description: 'Revenue-share tier only: the platform fee noted on the payout (a ledger note, not a deduction).' }),
  }),
} satisfies Record<Exclude<(typeof KNOWN_EVENTS)[number], '*'>, z.AnyZodObject>;

export type WebhookEventName = keyof typeof WEBHOOK_PAYLOADS;

/** The payload a dispatch site must send for `E`. Dispatch sites annotate
 *  their literals with `satisfies WebhookPayload<'...'>`, so a field added,
 *  dropped or retyped at the source fails typecheck until this catalogue
 *  (and the published spec) agrees. Type-only: importing it loads nothing. */
export type WebhookPayload<E extends WebhookEventName> = z.input<(typeof WEBHOOK_PAYLOADS)[E]>;

const WEBHOOK_DESCRIPTIONS: Record<WebhookEventName, string> = {
  'attribution.created': 'A conversion event was credited to a partner. Fires once per credited partner (multi-touch models credit several).',
  'commission.accrued': 'A commission was written. One per commission rule that matched, so an event can accrue several.',
  'commission.approved': 'A commission was approved, by an admin or by the holdback auto-approve job.',
  'commission.paid':
    'A commission was included in a payout. For a `manual` payout this fires when the payout is planned, before you have sent the money; `POST /payouts/{id}/confirm` records that you did.',
  'commission.reversed': 'A commission was reversed: by an admin, or by a Stripe refund or dispute.',
  'partner.created': 'A partner was created through `POST /partners` (admin, integration or Network approval).',
  'partner.activated':
    'A partner became active: they accepted their invite and signed in for the first time (`invited: true`), or `POST /partners` created them active with `sendInvite: false` (`invited: false`, sent right after `partner.created`). Fires once per partner. Not sent for partners imported with `POST /import/partners-csv`, or for join-page applicants approved automatically (they are active from the moment they apply); an applicant held for review fires it on their first sign-in after approval.',
  'partnership.approved': 'A partner was created from an approved OpenPartner Network application.',
  'payout.created':
    'A payout was recorded: a Stripe Connect transfer that went out, or a `manual` payout you still have to send (it stays `pending` until confirmed).',
};

export function envelopeSchema(event: string, data: z.ZodTypeAny) {
  return z.object({
    id: z.string().openapi({ description: 'Unique per event (`evt_…`). A manual redelivery reuses it, so dedupe on this.', example: 'evt_01JABCDEF0123456789ABCDEFG' }),
    event: z.literal(event),
    created: z.string().datetime(),
    data,
  });
}

export const WEBHOOK_HEADERS = z.object({
  'x-openpartner-signature': z.string().openapi({ description: 'Hex HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with the endpoint secret.' }),
  'x-openpartner-timestamp': z.string().openapi({ description: 'Unix seconds when this attempt was signed. Reject anything more than 5 minutes off.' }),
  'x-openpartner-event': z.string().openapi({ description: 'The event type, e.g. `commission.accrued`.' }),
  'x-openpartner-delivery': z.string().openapi({ description: 'The envelope `id`.' }),
});

export function registerWebhooks(registry: OpenAPIRegistry): void {
  for (const [event, data] of Object.entries(WEBHOOK_PAYLOADS) as Array<[WebhookEventName, z.AnyZodObject]>) {
    registry.registerWebhook({
      method: 'post',
      path: event,
      operationId: `webhook_${event.replace('.', '_')}`,
      tags: ['Webhook events'],
      summary: event,
      description: `${WEBHOOK_DESCRIPTIONS[event]}\n\nSubscribe with \`events: ["${event}"]\` (or \`"*"\`). Delivered as a signed JSON POST; see **Webhooks** in the introduction for verification.`,
      request: {
        headers: WEBHOOK_HEADERS,
        body: { required: true, content: { 'application/json': { schema: envelopeSchema(event, data) } } },
      },
      responses: {
        200: { description: 'Any 2xx acknowledges. A non-2xx answer, a redirect, or no answer within 10 seconds marks the delivery failed. Failed deliveries are not retried automatically.' },
      },
    });
  }
}
