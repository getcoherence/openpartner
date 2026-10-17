/**
 * Outbound webhook catalogue — one schema per event type, matching the
 * payloads the `dispatchEvent` call sites build (attribution.ts,
 * commission-events.ts, payouts.ts, payout-transfers.ts,
 * funding/executor.ts, routes/partners.ts, routes/partner-signup.ts,
 * routes/partner-auth.ts).
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

/** How a partner was added, on the partner.* events. A third way in (a CSV
 *  import) fires neither event, so it has no value. */
export const PARTNER_SOURCES = ['api', 'join_page'] as const;

const partnerSource = z.enum(PARTNER_SOURCES).openapi({
  description:
    'How the partner was added. `api`: `POST /partners` (the admin portal, an integration, or a Network approval, which also fires `partnership.approved`). `join_page`: they applied on the public join page. New values may be added.',
});

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
    replacesCommissionId: id.optional().openapi({
      description:
        'Set when a partial refund reduced a commission: this one carries the amount the partner keeps, and replaces the commission named here (reversed in the `commission.reversed` sent just before).',
    }),
  }),
  'commission.approved': lifecycleBase,
  'commission.paid': lifecycleBase.extend({ payoutId: id }),
  'commission.reversed': lifecycleBase.extend({
    reason: z.enum(['manual', 'refund', 'chargeback']).openapi({
      description:
        '`manual` = an admin reversed it; `refund` = a refund (`POST /attribution/refunds`, or a Stripe refund on self-host); `chargeback` = a chargeback reported to `POST /attribution/refunds`.',
    }),
    refundEventId: id.optional().openapi({ description: 'The refund or chargeback event behind a `refund` / `chargeback` reversal.' }),
    replacementCommissionId: id.optional().openapi({
      description: 'Partial refunds only: the commission accrued for the amount the partner keeps (sent next as `commission.accrued`).',
    }),
  }),
  'partner.created': z.object({
    partnerId: id,
    email: z.string().email(),
    name: z.string(),
    activatedAt: z.string().datetime().nullable().openapi({
      description: 'Null until the partner is active: an invited partner who has not accepted yet, or a join-page applicant held for review.',
    }),
    invited: z.boolean().openapi({
      description:
        'An invite email with a sign-in link was sent: `POST /partners` without `sendInvite: false`, or a join-page applicant approved automatically. An applicant held for review gets theirs when an admin approves them.',
    }),
    portalAccess: z.boolean().openapi({ description: 'The partner may sign in to the partner portal. See `portalAccess` on `POST /partners`.' }),
    programIds: z.array(id).openapi({ description: 'The programs the partner was granted. Join-page applicants start with none.' }),
    source: partnerSource,
  }),
  'partner.activated': z.object({
    partnerId: id,
    email: z.string().email(),
    name: z.string(),
    activatedAt: z.string().datetime(),
    invited: z.boolean().openapi({
      description:
        '`true`: the partner accepted an invite and signed in for the first time. `false`: they were active from the moment they were added and have not signed in: `POST /partners` with `sendInvite: false` (`source: "api"`; they may have no portal access), or a join-page applicant approved automatically (`source: "join_page"`; they were emailed a sign-in link).',
    }),
    source: partnerSource,
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
    grossAmount: Decimal.optional().openapi({
      description: 'Present when refund clawbacks were netted off this payout: the sum of `commissionIds`, before them. `amount` = `grossAmount` − `clawbackAmount`, rounded to whole units in a currency Stripe pays without fractions (JPY, for example).',
    }),
    clawbackAmount: Decimal.optional().openapi({
      description: 'Refund clawbacks deducted from this payout: commission the partner was already paid on revenue that was later refunded.',
    }),
    clawbackAdjustmentIds: z.array(id).optional().openapi({
      description: 'The `refund_clawback` commission adjustments this payout deducted.',
    }),
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
  'partner.created':
    'A partner was created: through `POST /partners` (admin, integration or Network approval; `source: "api"`), or by applying on the public join page (`source: "join_page"`). A join-page applicant held for review arrives with `activatedAt: null`; `POST /partners/{id}/invite` approves them. Not sent for partners imported with `POST /import/partners-csv`.',
  'partner.activated':
    'A partner became active. Fires once per partner: when they accept their invite and sign in for the first time (`invited: true`), or right after `partner.created` for a partner who is active from the moment they are added (`invited: false`): `POST /partners` with `sendInvite: false`, or a join-page applicant the program approves automatically. A join-page applicant held for review fires it on their first sign-in after approval. `source` says which way they came in. Not sent for partners imported with `POST /import/partners-csv`.',
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
