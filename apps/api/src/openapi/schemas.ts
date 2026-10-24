/**
 * Response shapes for the documented tenant API.
 *
 * Requests reuse the route handlers' own zod schemas; responses are
 * modelled here. __tests__/openapi-contract.test.ts parses real responses
 * against these, with unknown keys rejected, so a field added to or
 * dropped from a response fails CI until this file catches up.
 *
 * Conventions shared by every resource:
 *   - ids are opaque strings (mostly ULIDs; some carry a prefix, `cpn_`, `pc_`)
 *   - timestamps are ISO-8601 UTC strings
 *   - money in a database row (Commission.amount, Payout.amount, Event.value)
 *     is a decimal STRING ("12.50"), never a float; computed report totals
 *     (dashboard revenue, earnings) are JSON numbers
 */

import { z } from 'zod';
import { ATTRIBUTION_MODELS, BONUS_SOURCES, COMMISSION_STATUSES, PAYOUT_METHODS, PAYOUT_RAILS, PAYOUT_STATUSES } from './enums.js';
import { commissionBandsSchema, commissionTiersSchema } from '../commission-rule-schema.js';
import { PAYOUT_PROFILE_METHODS } from '@openpartner/db';
import { payoutDetailsSchema } from '../payout-profile.js';
import { DO_NOT_PAY_REASONS, MANUAL_EXCLUSION_REASONS, MANUAL_PAYOUT_PROVIDERS } from '../manual-payout-files.js';

import './registry.js'; // extendZodWithOpenApi before any .openapi() call

/** Nullable reference. `.nullable()` on a registered (`$ref`) schema comes
 *  out of the 3.1 generator as an `allOf` with conflicting types; a union
 *  with null renders as the correct `anyOf: [$ref, {type: null}]`. */
export function orNull<T extends z.ZodTypeAny>(schema: T) {
  return z.union([schema, z.null()]);
}

const id = z.string();
const ts = z.string().datetime();
const tsNullable = ts.nullable();
export const Decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .openapi('Decimal', { description: 'A decimal amount as a string, e.g. `"12.50"`. Major currency units.', example: '12.50' });

// ---------- Partners ----------

export const Partner = z
  .object({
    id,
    tenantId: id,
    email: z.string().email(),
    name: z.string(),
    stripeConnectAccountId: z.string().nullable(),
    metadata: z.record(z.unknown()).openapi({ description: 'Free-form JSON you supplied at creation. OpenPartner may add a `network` key when the partner is synced to the Network.' }),
    createdAt: ts,
    updatedAt: ts,
    activatedAt: tsNullable.openapi({ description: 'Null until the partner accepts their invite. `sendInvite: false` sets it at creation.' }),
    revokedAt: tsNullable,
    revokeReason: z.string().nullable(),
    portalAccess: z.boolean().openapi({
      description:
        'May the partner sign in to the partner portal? `false`: `POST /auth/signin` sends them nothing (answering as it does for an unknown email), password and Google sign-in turn them away the same way, their sessions end, and no invite or portal email goes to them. For headless programs. Set it on `POST /partners` or `PATCH /partners/{id}`.',
    }),
  })
  .openapi('Partner');

export const PartnerAccessSettings = z
  .object({
    uninvitedPortalAccess: z.boolean().openapi({
      description:
        'Portal access for partners added without an invite: `POST /partners` with `sendInvite: false` and no `portalAccess` (except partners the OpenPartner Network provisions), and every `POST /import/partners-csv` row. Default `true`. Turn it off before creating a headless program\'s partners.',
    }),
  })
  .openapi('PartnerAccessSettings');

export const PartnerCreated = Partner.extend({ invited: z.boolean() }).openapi('PartnerCreated');

export const PartnerSigninLink = z
  .object({
    url: z.string().url().openapi({
      description:
        "Redirect the partner's browser here. It signs them in to the partner portal, once, and lands on `returnTo` (or their dashboard). On your white-label domain when one is verified.",
    }),
    expiresAt: z.string().datetime().openapi({ description: 'Five minutes after minting. Unused by then, the link fails.' }),
    partnerId: z.string(),
  })
  .openapi('PartnerSigninLink');

export const PartnerPage = z
  .object({
    partners: z.array(Partner),
    nextCursor: z.string().nullable().openapi({ description: 'Pass as `cursor` for the next page. Null on the last page.' }),
  })
  .openapi('PartnerPage');

const commissionSubRule = z.object({
  trigger: z.enum(['every', 'first', 'subsequent']),
  eventType: z.string().optional(),
  type: z.enum(['percent', 'fixed']),
  value: z.number(),
  currency: z.string().optional(),
  recurring: z.boolean().optional().openapi({
    description:
      "Keeps paying on renewals, including renewals past the attribution window that the program's `renewalsStayWithPartner` carries. A rule without it pays only while the click that earned the customer is inside the window.",
  }),
  recurringMonths: z.number().int().optional().openapi({
    description: "Stop paying this many months after the customer's first attributed event of the rule's type for this partner. Omitted: no cap.",
  }),
  bands: commissionBandsSchema.optional().openapi('CommissionBands', {
    description:
      "Value bands: the rate steps up with the event's value. The sub-rule's own `value` is the base band; `levels` lists the steps above it. `whole` pays the reached band's rate on the whole value, `marginal` pays each slice at its own band's rate.",
  }),
  tiers: commissionTiersSchema.optional().openapi('CommissionTiers', {
    description: "Performance tiers: the rate steps up with the partner's own revenue or conversions over a window. Not combined with `bands`.",
  }),
});

export const CommissionSnapshot = z
  .object({
    id,
    partnerId: id,
    programId: id.nullable().openapi({ description: 'Null for partner-wide terms; set for terms on that one program.' }),
    commissionType: z.enum(['percent', 'fixed']),
    commissionValue: Decimal,
    recurring: z.boolean(),
    commissionRules: z.array(commissionSubRule).nullable(),
    holdbackDays: z.number().int().nullable(),
    source: z.enum(['approval', 'backfill', 'amendment']),
    snapshottedAt: ts,
  })
  .openapi('CommissionSnapshot', {
    description:
      "A per-partner commission override. When present it replaces the program's rule for this partner's future commissions: on every program (partner-wide, `programId` null) or on one program. On that program, program-scoped terms beat partner-wide ones.",
  });

// ---------- Programs ----------

export const CommissionRule = z
  .union([
    z.array(commissionSubRule),
    z.object({ type: z.enum(['percent', 'fixed']), value: z.number(), currency: z.string().optional(), recurring: z.boolean().optional() }),
  ])
  .openapi('CommissionRule', {
    description:
      'An array of triggered sub-rules. Programs written through this API always store the array; rows created before compound rules may still hold the legacy single-rule object.',
  });

export const CustomerReward = z
  .object({
    type: z.enum(['percent_off', 'amount_off', 'free_months']),
    value: z.number(),
    currency: z.string().optional(),
    duration: z.enum(['once', 'forever', 'repeating']),
    durationInMonths: z.number().int().optional(),
  })
  .openapi('CustomerReward');

export const Program = z
  .object({
    id,
    tenantId: id,
    name: z.string(),
    commissionRule: CommissionRule,
    attributionWindowDays: z.number().int().openapi({
      description:
        "How old a click may be and still win a customer's first conversion of an event type. With `renewalsStayWithPartner`, it doesn't limit renewals.",
    }),
    attributionModel: z.enum(ATTRIBUTION_MODELS),
    renewalsStayWithPartner: z.boolean().openapi({
      description:
        "True (default): a repeat event, meaning a type the customer already has an attributed conversion of (the 2nd, 13th, 40th `invoice_paid`), keeps that first conversion's partners, weights and model whatever the click's age, and a later click from another partner doesn't take it. Past the window only `recurring` sub-rules pay on it, up to `recurringMonths`. False: every event is attributed on its own against the clicks inside the window.",
    }),
    destinationUrl: z.string().url(),
    deepLinkAllowedDomains: z.string().nullable(),
    holdbackDays: z.number().int().nullable().openapi({
      description: 'Above 0: commissions auto-approve this many days after accruing. 0 or null: they wait for a manual approve.',
    }),
    startsAt: tsNullable,
    endsAt: tsNullable,
    endNotificationSentAt: tsNullable,
    customerReward: orNull(CustomerReward),
    categories: z.array(z.string()),
    partnersMayCustomizeCode: z.boolean(),
    revenueEventTypes: z.array(z.string()).openapi({
      description:
        'Event types that are sales in this program beyond invoice_paid and subscription_created, which always are. Their value counts as partner-attributed revenue for the hosted platform fee.',
    }),
    shareOnNetwork: z.boolean(),
    marketplaceDescription: z.string().nullable(),
    marketplaceCoverUrl: z.string().nullable(),
    marketplaceVideoUrl: z.string().nullable(),
    networkOfferingId: z.string().nullable(),
    blockedAt: tsNullable,
    blockedReason: z.string().nullable(),
    blockedByEmail: z.string().nullable(),
    createdAt: ts,
  })
  .openapi('Program');

/** Saved anyway, but probably not what the caller meant. */
export const SaveWarnings = z
  .array(
    z.object({
      field: z.literal('destinationUrl'),
      message: z.string(),
    }),
  )
  .openapi('SaveWarnings', {
    description:
      'Present only when there is something to fix. Today: a Stripe Payment Link (`buy.stripe.com`, `checkout.stripe.com`) without `client_reference_id={click_id}`. Stripe reads the referral only from that parameter, so without it no purchase through the link can be credited to the partner.',
  });

export const ProgramSaved = Program.extend({ warnings: SaveWarnings.optional() }).openapi('ProgramSaved');

export const ProgramList = z
  .object({
    programs: z.array(Program),
    customerRewardDelivery: z.enum(['stripe', 'unconfigured', 'brand']).openapi({
      description: 'How customer-side rewards reach the customer on this deployment: minted in Stripe, not configured, or applied by the brand itself.',
    }),
  })
  .openapi('ProgramList');

export const PartnerVisibleProgram = z
  .object({
    id,
    name: z.string(),
    destinationUrl: z.string().url(),
    deepLinkAllowedDomains: z.string().nullable(),
    startsAt: tsNullable,
    endsAt: tsNullable,
    partnersMayCustomizeCode: z.boolean(),
    customerReward: orNull(CustomerReward),
    source: z.enum(['admin', 'offering']).optional().openapi({ description: 'Partner callers only: how the grant was made.' }),
  })
  .openapi('PartnerVisibleProgram');

export const ProgramGrant = z
  .object({
    id,
    name: z.string(),
    destinationUrl: z.string().url(),
    deepLinkAllowedDomains: z.string().nullable(),
    commissionRule: CommissionRule,
    holdbackDays: z.number().int().nullable(),
    granted: z.boolean(),
    grantSource: z.enum(['admin', 'offering']).nullable(),
    grantedAt: tsNullable,
    commission: orNull(CommissionSnapshot).openapi({
      description: "This partner's terms on this program (setPartnerProgramCommission). Null: the partner-wide override, or the program's own rule, applies.",
    }),
  })
  .openapi('ProgramGrant');

// ---------- Links ----------

export const Link = z
  .object({
    id,
    tenantId: id,
    linkKey: z.string(),
    partnerId: id,
    programId: id,
    destinationUrl: z.string().nullable().openapi({ description: "Deep-link override. Null = the program's destinationUrl." }),
    createdAt: ts,
  })
  .openapi('Link', {
    description:
      'A partner share link. The public URL is built from the router base, not stored: `https://app.openpartner.dev/r/<tenantSlug>/<linkKey>` on OpenPartner Cloud, `https://<custom-domain>/r/<linkKey>` on a white-label domain, `<router-origin>/r/<linkKey>` self-hosted.',
  });

export const LinkSaved = Link.extend({ warnings: SaveWarnings.optional() }).openapi('LinkSaved');

// ---------- Attribution ----------

export const IdentifyResult = z
  .object({
    ok: z.literal(true),
    identityId: z.string().nullable(),
    firstStitch: z.boolean().openapi({ description: 'False when this (cref, userId) pair was already stitched; nothing was written.' }),
    backfilledAttributions: z.number().int().openapi({
      description: 'Events already recorded for this userId that attributed now that the click is known.',
    }),
  })
  .openapi('IdentifyResult');

export const Attribution = z
  .object({
    status: z
      .enum(['attributed', 'no_identity', 'no_click', 'outside_window', 'already_attributed', 'not_attributed', 'corrective'])
      .openapi({
        description:
          "`outside_window`: no click is inside the window and the customer has no earlier attributed conversion to carry it (or the program has `renewalsStayWithPartner` off). A renewal of an attributed conversion attributes whatever the click's age. `not_attributed` appears only on a replay of an event that did not attribute the first time; which miss it was is not stored. `corrective`: a `refund`, `chargeback`, `dispute_created` or `invoice_payment_failed` event, recorded but never attributed. It reverses nothing; report refunds to `POST /attribution/refunds`.",
      }),
    model: z.enum(ATTRIBUTION_MODELS).optional(),
    touches: z
      .array(
        z.object({
          clickId: id,
          partnerId: id,
          weight: z.number(),
          attributionId: id,
          commissionId: id.optional(),
        }),
      )
      .optional(),
    commission: z
      .enum(['accrued', 'no_matching_rule', 'none'])
      .optional()
      .openapi({
        description:
          "Present when `status` is `attributed`. `accrued`: at least one commission was written. `no_matching_rule`: no commission rule on the partner's terms takes this event type, so nothing is paid. Usually a typo'd stage name (`funded` for `loan_funded`); such types are listed under `GET /attribution/unmatched-event-types`. `none`: a rule takes the type but nothing accrued (the program has ended, a `first` rule already paid, a cap was reached, or the amount came to zero). On a replay with no commission, checked against the rules as they are now.",
      }),
  })
  .openapi('AttributionResult');

export const EventResult = z
  .object({
    ok: z.literal(true),
    eventId: id,
    attribution: Attribution,
    replayed: z.literal(true).optional().openapi({
      description: 'Present when an earlier call with the same `externalEventId` already recorded this event. `eventId` and `attribution` are that call\'s.',
    }),
  })
  .openapi('EventResult');

export const ConversionResult = z
  .object({
    ok: z.literal(true),
    eventId: id,
    userId: z.string().openapi({ description: "The user the click was stitched to: your `userId`, or the click's own synthetic user when you sent none." }),
    outcome: z.enum(['attributed', 'no_matching_rule', 'not_attributed']).openapi({
      description:
        "What the conversion came to. `attributed`: a partner was credited (check `reason` and `attribution.commission`). `no_matching_rule`: a partner was credited, but no commission rule takes this `type`, so nothing is paid: check the stage name. `not_attributed`: no partner was credited (see `reason`). The conversion is recorded either way, so don't retry it. `GET /postback` answers the same words as text.",
    }),
    reason: z.enum(['no_commission', 'outside_window', 'no_click', 'no_identity', 'corrective']).optional().openapi({
      description:
        "With `attributed`: `no_commission` when a rule takes the type but nothing accrued. With `not_attributed`: `outside_window` (the click is older than the program's attribution window, or newer than the conversion's `ts`), `no_click` (the partner was revoked), `corrective` (a `refund`, `chargeback`, `dispute_created` or `invoice_payment_failed` type, which is recorded but never attributed; report refunds to `POST /attribution/refunds`). A replay of a miss carries no reason, because which miss it was isn't stored.",
    }),
    attribution: Attribution,
    replayed: z.literal(true).optional().openapi({
      description: "Present when an earlier call with the same `externalEventId` already recorded this conversion. `eventId` and `attribution` are that call's.",
    }),
  })
  .openapi('ConversionResult');

export const RefundCommission = z
  .object({
    commissionId: id.openapi({ description: 'The commission the conversion originally accrued.' }),
    partnerId: id,
    currency: z.string(),
    originalAmount: Decimal,
    keptAmount: Decimal.openapi({
      description: "What the partner keeps for this conversion now: the live commission's amount, or a paid one's amount net of adjustments.",
    }),
    status: z.enum(['reversed', 'reduced', 'clawback_recorded', 'held_in_transfer', 'unchanged']).openapi({
      description: [
        '`reversed`: unpaid, and nothing is kept (a full refund), so it was reversed.',
        '`reduced`: unpaid; reversed and replaced by `currentCommissionId` for the kept amount (a partial refund).',
        "`clawback_recorded`: already paid. It stays paid, and a negative adjustment of `clawbackAmount` records the refunded revenue the partner holds. OpenPartner deducts it from the partner's next manual or self-hosted Stripe Connect payout; funded Stripe Connect payouts on hosted OpenPartner don't, so recover those with the partner.",
        '`held_in_transfer`: a payout for it is in flight, so nothing changed. Retry this request (same `externalEventId`) once the payout settles.',
        '`unchanged`: nothing to take back.',
      ].join(' '),
    }),
    currentCommissionId: id.nullable().openapi({ description: 'The live commission row: the original, its replacement, or null once reversed.' }),
    currentStatus: z.enum(['accrued', 'approved', 'paid']).nullable(),
    clawbackAmount: orNull(Decimal).openapi({ description: 'Paid commissions only: the refund clawbacks recorded against it, negative. Null when none.' }),
  })
  .openapi('RefundCommission');

export const RefundResult = z
  .object({
    ok: z.literal(true),
    refundEventId: id.openapi({ description: 'The corrective event recorded for this refund.' }),
    conversionEventId: id,
    kind: z.enum(['refund', 'chargeback']),
    amount: orNull(Decimal).openapi({ description: "This refund's amount, positive. Null for a refund of a conversion with no value." }),
    refundedAmount: orNull(Decimal).openapi({ description: 'Everything refunded on this conversion so far, this refund included. Null when the conversion has no value.' }),
    conversionValue: orNull(Decimal),
    currency: z.string(),
    fullRefund: z.boolean().openapi({ description: 'Nothing of the conversion is left.' }),
    actionRequired: z.boolean().openapi({
      description:
        'Some commission is `held_in_transfer` (retry later) or `clawback_recorded` (the partner was already paid; usually deducted from their next payout, see `clawback_recorded`).',
    }),
    commissions: z.array(RefundCommission).openapi({ description: 'One entry per commission the conversion accrued; empty when no partner was credited.' }),
    replayed: z.literal(true).optional().openapi({
      description:
        "Present when an earlier call with the same `externalEventId` recorded this refund. Nothing new is recorded; the refund is re-applied, which finishes any commission that was held in transfer, and `commissions` shows where they stand now.",
    }),
  })
  .openapi('RefundResult');
export const UnmatchedEventTypes = z
  .object({
    since: ts,
    eventTypes: z.array(
      z.object({
        type: z.string(),
        events: z.number().int().openapi({ description: 'Attributed events of this type since `since` that no rule took.' }),
        lastSeenAt: ts,
        programs: z.array(z.object({ id, name: z.string() })),
      }),
    ),
  })
  .openapi('UnmatchedEventTypes');

export const PostbackToken = z
  .object({
    prefix: z.string().openapi({ description: 'The start of the token, `opcp_…`, to tell tokens apart. The full token is shown only once.' }),
    ipAllowlist: z.array(z.string()).openapi({ description: 'IP addresses or CIDR ranges `GET /postback` accepts calls from. Empty: any address.' }),
    createdAt: ts,
    lastUsedAt: tsNullable,
  })
  .openapi('PostbackToken');

export const ClickIngestResult = z.object({ ok: z.literal(true), id, replayed: z.literal(true).optional() }).openapi('ClickIngestResult');

// ---------- Coupons ----------

const CouponRowShape = z.object({
  id,
  tenantId: id,
  partnerId: id,
  programId: id,
  code: z.string(),
  stripeCouponId: z.string().nullable(),
  stripePromotionCodeId: z.string().nullable(),
  brandChosen: z.boolean().openapi({
    description:
      "The brand's admin typed this code. Only then does a Stripe promotion code or coupon the brand already had under the same string credit the partner.",
  }),
  deactivatedAt: tsNullable,
  createdAt: ts,
  canEdit: z.boolean().openapi({ description: "The program lets partners rename their own codes." }),
});

export const Coupon = CouponRowShape.openapi('Coupon');

export const CouponWithStats = CouponRowShape.extend({
  redemptions90d: z.number().int(),
  revenue90d: z.number(),
})
  .openapi('CouponWithStats');

export const CouponRedeemResult = z
  .object({
    ok: z.literal(true),
    eventId: id,
    partnerId: id.optional().openapi({ description: 'Omitted on a replay.' }),
    replayed: z.literal(true).optional(),
  })
  .openapi('CouponRedeemResult');

// ---------- Commissions + payouts ----------

const CommissionRowShape = z.object({
  id,
  tenantId: id,
  attributionId: id.nullable().openapi({
    description: "The attributed sale this commission was earned on. Null on a bonus's commission (`bonusId` is set instead).",
  }),
  bonusId: id.nullable().openapi({ description: "The bonus this commission pays (`POST /bonuses`). Null on a sale's commission." }),
  partnerId: id,
  amount: Decimal,
  currency: z.string(),
  status: z.enum(COMMISSION_STATUSES).openapi({
    description:
      "`paid` means the commission is in a payout. On the manual rail that happens when the payout is planned, before the money is sent: check the payout's own `status`.",
  }),
  accruedAt: ts,
  paidAt: tsNullable,
  payoutId: z.string().nullable(),
  metadata: z.record(z.unknown()).openapi({
    description:
      "How the amount was worked out. `rateType` is the sub-rule's `percent` or `fixed` (absent on commissions accrued before October 2026). A banded or tiered rule also records `slab`: which sub-rule (`ruleIndex`), `kind` (`band` or `tier`), the `level` reached and its `threshold` and `value`, and for tiers the `metric` and its `metricValue` over the `window`. A replacement accrued for what a partial refund left records `refund`.",
  }),
});

export const Commission = CommissionRowShape.openapi('Commission');

export const CommissionListItem = CommissionRowShape.extend({
  partnerName: z.string().nullable().openapi({ description: "The partner's name. Null only if the partner record is gone." }),
  holdbackDays: z.number().int().nullable(),
  programId: z.string().nullable(),
  campaignName: z.string().nullable().openapi({ description: 'The program\'s name (kept under its pre-rename key).' }),
  matureAt: tsNullable.openapi({ description: 'When the holdback ends and the commission becomes approvable. Null = no holdback.' }),
  source: z.enum(['attribution', 'bonus']).openapi({
    description: '`attribution`: earned on an attributed sale. `bonus`: pays a bonus, with no event or click behind it.',
  }),
  eventType: z.string().nullable().openapi({
    description:
      "The type of the attributed event the commission was earned on: `signup`, `trial_started`, `subscription_created`, `invoice_paid`, or one of your custom types. Null on a bonus's commission.",
  }),
  bonus: z
    .object({
      id,
      source: z.enum(BONUS_SOURCES),
      note: z.string().nullable().openapi({ description: 'Shown to the partner.' }),
      bountyId: id.nullable(),
      bountyName: z.string().nullable().openapi({ description: "The performance bounty's name, when a bounty paid it." }),
    })
    .nullable()
    .openapi({ description: 'The bonus behind a `source: "bonus"` commission; null otherwise.' }),
}).openapi('CommissionListItem');

export const CommissionPage = z
  .object({ commissions: z.array(CommissionListItem), nextCursor: z.string().nullable() })
  .openapi('CommissionPage');

export const Bonus = z
  .object({
    id,
    tenantId: id,
    partnerId: id,
    programId: id.nullable(),
    amount: Decimal,
    currency: z.string(),
    source: z.enum(BONUS_SOURCES).openapi({
      description:
        "`manual`: paid with `POST /bonuses` (an admin or your integration). `network`: an OpenPartner Network bounty, paid with the Network's federation key. `performance_bounty`: the partner reached a bounty's goal. New values may be added.",
    }),
    bountyId: id.nullable(),
    externalRef: z.string().nullable(),
    note: z.string().nullable(),
    createdBy: z.string().nullable().openapi({ description: 'The admin or API key that paid it; null for a performance bounty.' }),
    createdAt: ts,
  })
  .openapi('Bonus');

export const BonusAwarded = z
  .object({
    replayed: z.literal(true).optional().openapi({ description: 'Set on a replay of an `externalRef` already used: the original bonus.' }),
    bonus: Bonus,
    commission: Commission,
  })
  .openapi('BonusAwarded');

export const BonusListItem = Bonus.extend({
  commission: z.object({
    id,
    status: z.enum(COMMISSION_STATUSES),
    payoutId: z.string().nullable(),
    paidAt: tsNullable,
  }),
}).openapi('BonusListItem');

export const BonusPage = z
  .object({ bonuses: z.array(BonusListItem), nextCursor: z.string().nullable() })
  .openapi('BonusPage');

export const Payout = z
  .object({
    id,
    tenantId: id,
    partnerId: id,
    amount: Decimal,
    currency: z.string(),
    method: z.enum(PAYOUT_METHODS),
    stripeTransferId: z.string().nullable(),
    status: z.enum(PAYOUT_STATUSES).openapi({
      description: 'A `manual` payout stays `pending` until you send the money and confirm it; only `paid` means it went out.',
    }),
    metadata: z.record(z.unknown()).openapi({
      description:
        'What the run and the payout rails recorded. `externalReference` is the payment reference you gave when you confirmed a manual payout (`POST /payouts/{id}/confirm`).',
    }),
    createdAt: ts,
    completedAt: tsNullable,
  })
  .openapi('Payout');

const partnerName = z.string().nullable().openapi({ description: "The partner's name. Null only if the partner record is gone." });

const rateString = z.string().regex(/^\d+(\.\d+)?$/).openapi({
  description: 'Units of the sent currency per unit of the payout’s currency, as a decimal string (ECB reference rates, crossed through EUR).',
  example: '0.011958904110',
});

export const PayoutSent = z
  .object({
    amount: Decimal.openapi({ description: 'What PayPal was asked to send.' }),
    currency: z.string(),
    rate: rateString,
    rateSource: z.literal('ecb'),
    rateDate: z.string().openapi({ description: 'The ECB reference date of the rate (YYYY-MM-DD).' }),
  })
  .openapi('PayoutSent', {
    description:
      'A payout PayPal can’t send in its own currency (INR), sent through Pay with PayPal in another (USD) at the ECB reference rate frozen when the batch was made. `amount` and `currency` on the payout stay its own. PayPal’s own conversion of it into the partner’s currency is between the partner and PayPal.',
  });

const sent = orNull(PayoutSent).openapi({ description: 'Set while (or once) a PayPal batch sends this payout in another currency; gone if PayPal returns it.' });

/** A payout in the payout lists: with what PayPal sent, if converted. */
export const PayoutWithSent = Payout.extend({ sent }).openapi('PayoutWithSent');

export const PayoutListItem = Payout.extend({ partnerName, sent }).openapi('PayoutListItem');

export const PayoutPage = z
  .object({ payouts: z.array(PayoutListItem), nextCursor: z.string().nullable() })
  .openapi('PayoutPage');

// ---------- Payout statements ----------

export const PayoutStatementSettings = z
  .object({
    legalName: z.string().nullable().openapi({ description: 'The registered business name statements are issued in. Null: the program name.' }),
    address: z.string().nullable().openapi({ description: 'Your postal address; line breaks are kept.' }),
    footer: z.string().nullable().openapi({ description: 'Printed at the foot of every statement; line breaks are kept.' }),
    numberPrefix: z.string().nullable().openapi({ description: 'Put before the payout id to make the statement number, e.g. `PS-`.' }),
    taxLines: z
      .object({
        enabled: z.boolean(),
        labels: z.array(z.string()),
      })
      .openapi({
        description:
          'A placeholder for tax lines such as tax withheld, off by default. Turned on, each label prints as a row marked "Not recorded": OpenPartner records no tax amounts yet. Which lines you need (GST, TDS) is for your accountant to say.',
      }),
  })
  .openapi('PayoutStatementSettings');

const StatementLine = z
  .object({
    id: id.openapi({ description: 'The commission, bonus, commission adjustment or reversal id.' }),
    commissionId: id.nullable().openapi({ description: 'The commission behind the line; null on a reversal.' }),
    date: z.string().openapi({ description: 'YYYY-MM-DD (UTC): when it was earned, or when a deduction or reversal was recorded.', example: '2026-10-14' }),
    programName: z.string().nullable(),
    description: z.string().openapi({ example: 'Invoice paid' }),
    amount: Decimal.openapi({ description: 'Signed: deductions and reversals are negative.' }),
    currency: z.string(),
  })
  .openapi('PayoutStatementLine');

export const PayoutStatement = z
  .object({
    statementNumber: z.string().openapi({ description: 'Your `numberPrefix` and the payout id: unique, and the same every time.' }),
    generatedAt: ts,
    issuer: z.object({
      name: z.string(),
      tradingName: z.string().nullable().openapi({ description: 'The program name, when it differs from `name`.' }),
      address: z.string().nullable(),
      gstin: z.string().nullable().openapi({ description: 'OpenPartner Cloud: the GSTIN on your billing profile.' }),
      logoUrl: z.string().nullable(),
    }),
    partner: z.object({
      id,
      name: z.string().nullable(),
      email: z.string().nullable(),
      destination: z.string().nullable().openapi({
        description: "Where the payout goes, masked, never in full: the last four characters of the Stripe account the transfer was made to, or the partner's payout details on file (`PayPal j•••@example.com`, `Bank account •••• 1234 (INR)`). Null when a manual payout's partner has no details on file.",
      }),
      destinationChanged: z.boolean().openapi({
        description: "The partner changed their payout details after the payout was sent (or put in a batch file); `destination` shows the current ones.",
      }),
    }),
    payout: z.object({
      id,
      status: z.enum(PAYOUT_STATUSES),
      method: z.enum(PAYOUT_METHODS),
      methodLabel: z.string().openapi({ example: 'Manual · Wise batch payment' }),
      reference: z
        .object({ label: z.string(), value: z.string() })
        .nullable()
        .openapi({
          description:
            'What identifies the payout: the Stripe transfer (`Stripe transfer`), its PayPal Customer ID or Wise reference in a batch file (`PayPal Customer ID`, `Wise payment reference`), or, for a payout sent one at a time, the `reference` you gave `POST /payouts/{id}/confirm` (`Payment reference`). Null when there is none.',
        }),
      amount: Decimal.openapi({ description: 'What was paid, or is to be.' }),
      currency: z.string(),
      createdAt: ts,
      completedAt: tsNullable,
    }),
    commissions: z.array(StatementLine),
    bonuses: z.array(StatementLine),
    clawbacks: z.array(StatementLine).openapi({ description: 'Refund clawbacks deducted from this payout.' }),
    reversals: z.array(StatementLine).openapi({ description: 'Stripe transfer reversals after the payout was paid. Not in `totals`.' }),
    taxLines: z.array(z.object({ label: z.string(), amount: Decimal.nullable(), currency: z.string() })).openapi({
      description: 'Empty unless you turned tax lines on (`POST /config/payout-statements`). `amount` is always null for now.',
    }),
    totals: z
      .array(z.object({ currency: z.string(), commissions: Decimal, bonuses: Decimal, clawbacks: Decimal, net: Decimal }))
      .openapi({ description: 'One per currency the lines are in, never added across currencies. A payout has one; `net` matches `payout.amount` except where the currency is paid in whole units.' }),
    notes: z.array(z.string()).openapi({ description: 'Plain sentences: a pending, failed or reversed payout, or rounding.' }),
    footer: z.string().nullable(),
  })
  .openapi('PayoutStatement');

const moneyGroup = z.object({ partnerId: id, partnerName, currency: z.string(), amount: z.number() });

const PayoutHoldReason = z.enum(['country_not_supported', 'screening_confirmed', 'screening_review', 'screening_pending']).openapi({
  description:
    "Why the partner is on hold: `country_not_supported` (their declared country isn't served), `screening_review` (a possible sanctions-list match waits for OpenPartner's review), `screening_confirmed` (a confirmed match), or `screening_pending` (not screened yet; usually clears within the hour).",
});

export const PayoutRunResult = z
  .object({
    runId: id,
    mode: z.enum(['selfhost', 'flat', 'revshare']),
    skippedBelowThreshold: z.array(moneyGroup),
    skippedUnfunded: z.array(moneyGroup),
    heldForClawback: z.array(moneyGroup.extend({ clawbackAmount: z.number() })).openapi({
      description:
        'Partners not paid this run because their outstanding refund clawbacks are at least what they are owed (`amount`, before clawbacks). Their commissions stay approved and are paid, net, once enough accrues.',
    }),
    heldForCompliance: z.array(moneyGroup.extend({ reason: PayoutHoldReason })).openapi({
      description:
        'OpenPartner Cloud: Stripe payouts not made this run because the partner is on a compliance hold (`GET /payouts/holds`). Their commissions stay approved and are paid on the first run after the hold lifts. `amount` is what they are owed.',
    }),
    payouts: z.array(
      z.object({
        payoutId: id,
        partnerId: id,
        partnerName,
        amount: z.number(),
        currency: z.string(),
        method: z.enum(PAYOUT_METHODS),
        status: z.enum(['pending', 'paid', 'failed']),
        platformFee: z.number().optional(),
        clawbackAmount: z.number().optional().openapi({
          description: 'Refund clawbacks netted off this payout. `amount` is already net of them.',
        }),
        complianceWarning: PayoutHoldReason.optional().openapi({
          description:
            'A `manual` payout to a partner on a compliance hold. You send this money yourself, so the payout was still made: check before you send it.',
        }),
        error: z.string().optional(),
      }),
    ),
    transfers: z.object({
      processed: z.number().int(),
      confirmed: z.array(z.object({ payoutId: id, stripeTransferId: z.string() })),
      failed: z.array(z.object({ payoutId: id, error: z.string() })),
      ambiguous: z.array(z.string()),
      reconciled: z.array(z.string()),
      canceled: z.array(z.object({ payoutId: id, reason: z.string() })),
      skipped: z.number().int(),
    }),
  })
  .openapi('PayoutRunResult');

export const PayoutHolds = z
  .object({
    holds: z.array(
      z.object({
        partnerId: id,
        partnerName: z.string(),
        partnerEmail: z.string(),
        reason: PayoutHoldReason,
        effect: z.enum(['held', 'warning']).openapi({
          description: '`held`: Stripe payouts are not made. `warning`: you pay this partner yourself, so nothing is held.',
        }),
        owed: z.array(z.object({ currency: z.string(), amount: z.number() })).openapi({
          description: 'Approved commissions not yet on a payout, per currency.',
        }),
      }),
    ),
  })
  .openapi('PayoutHolds');

// ---------- Manual payouts: payout details and batch files ----------

export const PayoutDetails = payoutDetailsSchema.openapi('PayoutDetails', {
  description:
    'Where the partner wants manual payouts sent, by `method`: `paypal` (the PayPal account email), `bank` (an IBAN, or a local account number with what routes to it: `sortCode` for GBP, `routingNumber` + `accountType` + `address` for USD, `ifsc` for INR, `bic` + `address` for any other currency; an `address` for any USD, PHP, THB or TRY account, with its `state` in the US, Canada or Brazil), `upi` (an Indian UPI ID), or `other` (free-text instructions). Values are validated (IBAN checksum, ABA checksum, IFSC shape) and normalised (upper case, spaces removed).',
});

const PayoutProfileMethod = z.enum(PAYOUT_PROFILE_METHODS);
const PayoutProfileUpdatedBy = z.enum(['partner', 'admin', 'api']).openapi({
  description: 'Who saved them last: the partner (portal), an admin (portal) or an API key.',
});

export const PartnerPayoutProfile = z
  .object({
    profile: orNull(
      z
        .object({
          method: PayoutProfileMethod,
          country: z.string().nullable().openapi({ description: 'Where the account is held (ISO 3166-1 alpha-2); `IN` for UPI; null for a PayPal email or instructions without one.' }),
          details: orNull(PayoutDetails).openapi({
            description: "Null when the stored details can't be read on this deployment (restored from an encrypted copy elsewhere): the partner has to enter them again.",
          }),
          summary: z.string().nullable().openapi({ description: 'A masked one-line description, safe to show anywhere, e.g. `Bank IBAN GB •••• 5432 (GBP)`.' }),
          updatedAt: ts,
          updatedBy: PayoutProfileUpdatedBy,
        })
        .openapi('PayoutProfile'),
    ).openapi({ description: 'Null until the partner (or you) gives payout details.' }),
    paidVia: z.enum(['manual', 'stripe_connect']).openapi({
      description: "How this partner's payouts go out under your payout rail today. Payout details are only used for `manual`.",
    }),
    rail: z.enum(PAYOUT_RAILS).openapi({
      description:
        "The brand's payout rail setting. `manual`: the brand pays every partner itself (bank transfer, PayPal or Wise batch files) from these details, and Stripe Connect isn't used. `stripe_connect`: every partner is paid through Stripe Connect. `auto`: Stripe Connect when the partner has connected an account, otherwise manual.",
    }),
  })
  .openapi('PartnerPayoutProfileResponse');

const ManualPayoutProvider = z.enum(MANUAL_PAYOUT_PROVIDERS);
const nextCursor = z.string().nullable().openapi({ description: 'Pass as `cursor` for the next page; null on the last.' });
const DoNotPayReason = z.enum(DO_NOT_PAY_REASONS).openapi({
  description:
    "OpenPartner Cloud: the payout must not be paid. `country_not_supported`: the partner, or their payout account, is in a country OpenPartner doesn't serve. `screening_confirmed`: a confirmed sanctions-list match. Every confirm refuses it.",
});
const PaypalConversion = z
  .object({
    sourceAmount: Decimal.openapi({ description: 'The payout’s own amount.' }),
    sourceCurrency: z.string(),
    sentAmount: Decimal.openapi({ description: 'What PayPal was asked to send: sourceAmount × rate, rounded to the cent on its own.' }),
    sentCurrency: z.string(),
    rate: rateString,
    rateSource: z.literal('ecb'),
    rateDate: z.string().openapi({ description: 'The ECB reference date of the rate (YYYY-MM-DD).' }),
  })
  .openapi('PaypalConversion', {
    description: 'Stamped on a payout a PayPal batch sends in another currency (`metadata.manualExport.conversion`); exported with the payout.',
  });

const PaypalItemStatus = z
  .object({
    itemId: z.string().openapi({ description: 'PayPal’s payout_item_id.' }),
    status: z.string().openapi({ description: 'PayPal’s transaction_status: SUCCESS, PENDING, UNCLAIMED, ONHOLD, FAILED, RETURNED, BLOCKED, REFUNDED, REVERSED.' }),
    transactionId: z.string().nullable(),
    amount: Decimal.nullable().openapi({ description: 'What PayPal sent: whole units where PayPal takes no decimals (HUF, JPY, TWD).' }),
    currency: z.string().nullable(),
    error: z.string().nullable().openapi({ description: 'PayPal’s error name for an item that didn’t go through (RECEIVER_UNREGISTERED, …).' }),
  })
  .openapi('PaypalItemStatus');

export const ManualPayoutRuns = z
  .object({
    runs: z.array(
      z.object({
        runId: id,
        createdAt: ts,
        pendingCount: z.number().int().openapi({ description: 'Manual payouts in the run not yet confirmed as sent.' }),
        pendingTotals: z.array(z.object({ currency: z.string(), amount: Decimal })),
      }),
    ),
    nextCursor,
  })
  .openapi('ManualPayoutRuns');

export const ManualPayoutRun = z
  .object({
    runId: id,
    createdAt: ts,
    pendingCount: z.number().int(),
    ready: z
      .array(
        z.object({
          provider: ManualPayoutProvider,
          currency: z.string(),
          sendAs: z.string().nullable().openapi({
            description:
              'Balances PayPal can’t send in `currency` (INR) that Pay with PayPal sends in this currency instead (the `paypal_payouts` setting): quote with `POST /payouts/runs/{runId}/paypal-batches/quote`, then send. No file takes them. Null for every other group.',
          }),
          count: z.number().int(),
          total: Decimal.openapi({ description: 'In `currency`.' }),
        }),
      )
      .openapi({
        description:
          'Payouts no file holds yet that a new file would take, per provider and currency (PayPal: the payout currency; Wise: the source currency). Each new file takes up to 5,000 (PayPal) or 1,000 (Wise) of them.',
      }),
    exports: z
      .array(
        z.object({
          exportId: id,
          provider: ManualPayoutProvider,
          currency: z.string(),
          createdAt: ts,
          createdBy: z.enum(['admin', 'api']),
          pendingCount: z.number().int().openapi({ description: 'Payouts in the file not confirmed yet.' }),
          pendingTotal: Decimal,
          changedCount: z.number().int().openapi({
            description:
              'Of those, whose partner changed or removed their payout details after the file was made. A re-download carries the new details, or leaves the payout out when they no longer fit the file.',
          }),
          doNotPayCount: z.number().int().openapi({ description: 'Of those, now on a do-not-pay hold. Confirming the file refuses them.' }),
        }),
      )
      .openapi({ description: 'Files made from this run that still hold payouts to confirm.' }),
    inPaypalBatches: z.number().int().openapi({
      description: 'Pending payouts in a PayPal Payouts batch OpenPartner sent with your PayPal app. List the batches with `GET /payouts/runs/{runId}/paypal-batches`.',
    }),
    excluded: z
      .array(z.object({ reason: z.enum(MANUAL_EXCLUSION_REASONS), count: z.number().int() }))
      .openapi({ description: 'Pending payouts in no file, per reason (see ManualRunPayout.excluded).' }),
  })
  .openapi('ManualPayoutRun');

export const ManualRunPayout = z
  .object({
    payoutId: id,
    partnerId: id,
    partnerName: z.string(),
    partnerEmail: z.string(),
    amount: Decimal,
    currency: z.string(),
    createdAt: ts,
    destination: orNull(
      z.object({
        method: PayoutProfileMethod,
        country: z.string().nullable(),
        summary: z.string().nullable().openapi({ description: "Masked. Null when the details can't be read." }),
        updatedAt: ts.openapi({ description: 'A change shortly before a payout is worth a second look before you send it.' }),
        updatedBy: PayoutProfileUpdatedBy,
      }),
    ).openapi({ description: 'The partner’s payout details, masked; null when they have none.' }),
    export: orNull(
      z.object({
        exportId: id,
        provider: ManualPayoutProvider,
        via: z.enum(['file', 'api']).openapi({
          description: '`file`: a batch file you upload. `api`: a PayPal Payouts batch OpenPartner sent with your PayPal app; `exportId` is the batch id and `paypal` what PayPal last said.',
        }),
        createdAt: ts,
        reference: z.string().nullable().openapi({
          description:
            'What identifies this payout in the file: the PayPal Customer ID (the payout id), or the Wise payment reference (its last 10 characters; none for JPY or COP).',
        }),
        destinationChanged: z.boolean().openapi({ description: 'The partner changed or removed their payout details after the file was made.' }),
        paypal: orNull(PaypalItemStatus).openapi({ description: 'A PayPal Payouts batch: this payout’s item, once PayPal has listed it.' }),
        conversion: orNull(PaypalConversion).openapi({
          description: 'A PayPal Payouts batch sending this payout in another currency (an INR balance sent in USD): its amounts and the rate, frozen when the batch was made.',
        }),
      }),
    ).openapi({ description: 'The file (or PayPal Payouts batch) this payout is in. It stays there, and only there, until it is confirmed, the file is discarded, or PayPal reports it failed or returned.' }),
    ready: ManualPayoutProvider.nullable().openapi({ description: 'The file a new export would put this payout in.' }),
    sendAs: z.string().nullable().openapi({
      description: 'Ready for a Pay with PayPal batch only, sent in this currency at a quoted rate (a balance PayPal can’t send in its own). No file takes it.',
    }),
    excluded: z.enum(MANUAL_EXCLUSION_REASONS).nullable().openapi({
      description:
        "Why a payout is in no file: `no_payout_details`, `details_unreadable`, `pay_individually` (a UPI ID or instructions: pay it yourself), `currency_not_supported` (PayPal can't send INR; Wise can't send from this currency, or to INR yet), `details_incomplete` (Wise needs the holder's address for a payout sent in USD or AUD), `over_paypal_limit` (more than PayPal sends in one payment in this currency, e.g. USD 60,000), and on OpenPartner Cloud the do-not-pay reasons `country_not_supported` and `screening_confirmed`.",
    }),
    complianceWarning: PayoutHoldReason.nullable().openapi({
      description: 'OpenPartner Cloud: the partner is on a compliance hold. A sanctions review or pending screening stays payable; check before you send it.',
    }),
    doNotPay: DoNotPayReason.nullable(),
  })
  .openapi('ManualRunPayout');

export const ManualRunPayoutPage = z
  .object({ payouts: z.array(ManualRunPayout), nextCursor })
  .openapi('ManualRunPayoutPage');

export const ManualExportFile = z
  .object({
    export: z.object({
      exportId: id,
      runId: id,
      provider: ManualPayoutProvider,
      currency: z.string(),
      createdAt: ts,
      createdBy: z.enum(['admin', 'api']),
      payoutIds: z.array(id).openapi({ description: 'Exactly the payouts in the file, and what `POST /payouts/exports/{exportId}/confirm` confirms.' }),
      count: z.number().int(),
      total: Decimal,
    }),
    filename: z.string(),
    csv: z.string().openapi({ description: 'The file to upload to your PayPal or Wise account (UTF-8, CRLF line endings).' }),
  })
  .openapi('ManualExportFile');

export const BulkConfirmResult = z
  .object({
    confirmed: z.array(Payout),
    notConfirmable: z.array(
      z.object({
        payoutId: id,
        error: z.enum(['payout_not_found', 'not_confirmable']),
        reason: z
          .union([DoNotPayReason, z.literal('in_paypal_batch')])
          .optional()
          .openapi({ description: 'A do-not-pay hold, or `in_paypal_batch`: PayPal reports whether this payout was paid.' }),
        detail: z.string().optional(),
      }),
    ),
  })
  .openapi('BulkConfirmResult');

// ---------- Pay with PayPal ----------

export const PaypalEnvironment = z.enum(['live', 'sandbox']);

export const PaypalConnection = z
  .object({
    id,
    environment: PaypalEnvironment,
    clientIdPreview: z.string().openapi({ description: 'The client id’s first 6 and last 4 characters. The secret is never returned.' }),
    appId: z.string().nullable().openapi({ description: 'PayPal’s id for the app, from the token call.' }),
    payoutsEnabled: z.boolean().openapi({
      description: 'PayPal granted the app the Payouts scope. False: PayPal hasn’t enabled Payouts on the account yet, and sends would be refused.',
    }),
    webhook: z.object({
      registered: z.boolean().openapi({ description: 'OpenPartner registered a webhook on your app, so status arrives as PayPal sends it. Otherwise batches are polled every few minutes.' }),
      error: z.string().nullable(),
    }),
    active: z.boolean().openapi({ description: 'Pay with PayPal sends with this environment.' }),
    connectedAt: ts,
    verifiedAt: tsNullable,
    lastError: z.string().nullable(),
    lastErrorAt: tsNullable,
    openBatches: z.number().int().openapi({ description: 'Batches sent with this app that are still in flight. Disconnecting waits for them.' }),
  })
  .openapi('PaypalConnection');

export const PaypalBatch = z
  .object({
    batchId: id.openapi({ description: 'Also the `sender_batch_id` PayPal shows, and each payout’s `exportId`.' }),
    runId: id,
    environment: PaypalEnvironment,
    currency: z.string().openapi({ description: 'What PayPal sends: the payouts’ currency, or the one their balances were converted to (`conversion`).' }),
    itemCount: z.number().int(),
    total: Decimal.openapi({ description: 'In `currency`: what PayPal is asked to send.' }),
    conversion: orNull(
      z.object({
        sourceCurrency: z.string().openapi({ description: 'The payouts’ own currency (INR).' }),
        sourceTotal: Decimal,
        rate: rateString,
        rateSource: z.literal('ecb'),
        rateDate: z.string().openapi({ description: 'The ECB reference date of the rate (YYYY-MM-DD).' }),
        quotedAt: ts.openapi({ description: 'When the quote this batch was sent with was made.' }),
      }),
    ).openapi({ description: 'A batch sending balances PayPal can’t send in their own currency, at a quoted rate. Null otherwise.' }),
    state: z.enum(['intent', 'posted', 'submitted', 'completed', 'failed', 'denied', 'released', 'reconcile_required']).openapi({
      description:
        '`intent`: committed, not sent yet. `posted`: sent, PayPal’s answer not in yet (re-sent automatically; PayPal never makes a second batch for the same id). `submitted`: PayPal has it and is paying. `completed`: every payout paid or released. `failed`: PayPal refused it outright; nothing was sent and the payouts are back to pending. `denied`: PayPal denied the batch; payouts released. `released`: you released it after checking PayPal. `reconcile_required`: OpenPartner can’t tell whether it went out; check PayPal, then `POST /payouts/paypal-batches/{batchId}/resolve`.',
    }),
    payoutBatchId: z.string().nullable().openapi({ description: 'PayPal’s id for the batch.' }),
    batchStatus: z.string().nullable().openapi({ description: 'PayPal’s batch_status: PENDING, PROCESSING, SUCCESS, DENIED, CANCELED.' }),
    summary: z.object({
      paid: z.number().int(),
      released: z.number().int().openapi({ description: 'Back to pending: failed, returned, refunded, or the batch didn’t go out.' }),
      unclaimed: z.number().int().openapi({ description: 'PayPal emailed the partner to claim it (no PayPal account at that email). Returned after 30 days unless claimed.' }),
      processing: z.number().int(),
    }),
    rehearsal: orNull(
      z.object({ paid: z.number().int(), unclaimed: z.number().int(), failed: z.number().int() }),
    ).openapi({
      description:
        'A finished **sandbox** batch: what PayPal’s sandbox did with its test money. A sandbox batch never marks a payout paid; once PayPal settles every item its payouts go back to pending, ready for a live batch or a file.',
    }),
    lastError: z.string().nullable(),
    createdAt: ts,
    createdBy: z.enum(['admin', 'api']),
    completedAt: tsNullable,
    lastSyncedAt: tsNullable,
  })
  .openapi('PaypalBatch');

const quoteItem = z.object({
  payoutId: id,
  partnerId: id,
  partnerName: z.string(),
  destination: z.string().openapi({ description: 'The PayPal account it goes to, masked. A change before sending voids the quote.' }),
  amount: Decimal.openapi({ description: 'The payout’s own amount, in `currency`.' }),
  sentAmount: Decimal.openapi({ description: 'What PayPal would send for it, in `sendAs`: amount × rate, rounded half up to the cent on its own.' }),
});

export const PaypalConversionQuote = z
  .object({
    quoteId: z.string().openapi({ description: 'Send with it (`POST /payouts/runs/{runId}/paypal-batches` with `currency`, `sendAs` and `quoteId`) before `expiresAt`. Signed; it reserves nothing.' }),
    runId: id,
    environment: PaypalEnvironment.openapi({
      description: 'The PayPal app the batch would send from: your live app, or a sandbox test. If another app is made active before you send, the send is refused (`409 quote_changed`).',
    }),
    currency: z.string().openapi({ description: 'The payouts’ own currency (INR).' }),
    sendAs: z.enum(['USD']),
    rate: rateString,
    rateSource: z.literal('ecb'),
    rateDate: z.string().openapi({ description: 'The ECB reference date (YYYY-MM-DD). The ECB publishes once a business day, around 16:00 CET.' }),
    quotedAt: ts,
    expiresAt: ts.openapi({ description: '15 minutes after `quotedAt`.' }),
    count: z.number().int(),
    sourceTotal: Decimal.openapi({ description: 'What the quoted payouts add up to, in `currency`.' }),
    sentTotal: Decimal.openapi({ description: 'What PayPal would send, in `sendAs`: the sum of the per-item amounts, which can differ by a few cents from sourceTotal × rate.' }),
    items: z.array(quoteItem),
    leftOut: z
      .array(quoteItem.extend({ reason: z.enum(['over_paypal_limit', 'below_minimum']) }))
      .openapi({ description: 'Payouts this batch can’t take at this rate: over PayPal’s per-payment limit in `sendAs` (USD 60,000), or under a cent in it. Pay them another way.' }),
  })
  .openapi('PaypalConversionQuote');

export const PaypalPayoutSettings = z
  .object({
    sendUnsupportedAs: z.enum(['USD']).nullable().openapi({
      description:
        'Pay balances PayPal can’t send in their own currency (INR) through Pay with PayPal in this currency, at the ECB reference rate quoted before each batch. Null (the default): off, and those payouts stay `currency_not_supported`.',
    }),
  })
  .openapi('PaypalPayoutSettings');

// ---------- Reporting ----------

const amountsByCurrency = z.record(z.string(), z.number()).openapi({
  description: 'Amount per ISO 4217 currency code. Currencies with nothing are absent; nothing is converted.',
});

const commissionByStatusAndCurrency = z.record(z.string(), z.record(z.enum(COMMISSION_STATUSES), z.number())).openapi({
  description: 'Commission totals per currency, then per status. Currencies and statuses with nothing are absent.',
});

export const PartnerDashboard = z
  .object({
    partnerId: id,
    since: ts,
    currency: z.string().openapi({
      description: "The brand's default currency: the currency of `attributedRevenue` and `commissionByStatus`.",
      example: 'USD',
    }),
    clicks: z.number().int(),
    attributedEvents: z.number().int(),
    attributedRevenue: z.number().openapi({ description: 'Attributed revenue in `currency` only.' }),
    attributedRevenueByCurrency: amountsByCurrency,
    commissionByStatus: z.record(z.enum(COMMISSION_STATUSES), z.number()).openapi({
      description:
        'Sum of commission amounts in `currency` accrued since `since`, keyed by status. Statuses with nothing are absent. Commissions in other currencies are in `commissionByCurrency`. `paid` includes manual payouts not yet sent: read payouts for money that went out.',
    }),
    commissionByCurrency: commissionByStatusAndCurrency,
    links: z
      .array(
        z.object({
          linkKey: z.string(),
          clicks: z.number().int(),
          attributedEvents: z.number().int(),
          attributedRevenue: z.number().openapi({ description: 'In `currency` only.' }),
          attributedRevenueByCurrency: amountsByCurrency,
        }),
      )
      .optional()
      .openapi({ description: 'Only with `includeLinks=true`.' }),
  })
  .openapi('PartnerDashboard');

export const ProgramStatsList = z
  .object({
    since: ts,
    until: ts,
    currency: z.string().openapi({
      description: "The brand's default currency, for showing a zero. Amounts are in their own currencies.",
      example: 'USD',
    }),
    programs: z
      .array(
        z.object({
          programId: id,
          name: z.string(),
          partners: z.number().int().openapi({
            description: 'Partners enrolled in the program now, plus any with clicks, conversions or commission in it during the window.',
          }),
          clicks: z.number().int(),
          attributedEvents: z.number().int().openapi({
            description:
              'Conversions attributed in the window, counted per attribution: an event credited through two clicks (a multi-touch model) counts twice.',
          }),
          attributedRevenueByCurrency: amountsByCurrency,
          commissionByCurrency: commissionByStatusAndCurrency,
        }),
      )
      .openapi({ description: 'Every program, newest first, including programs with no activity.' }),
  })
  .openapi('ProgramStatsList');

export const PartnerTimeseries = z
  .object({
    partnerId: id,
    since: ts,
    until: ts,
    bucket: z.enum(['day', 'week']),
    buckets: z.array(
      z.object({
        bucket: ts,
        clicks: z.number().int(),
        leads: z.number().int().openapi({ description: '`signup` and `trial_started` events.' }),
        sales: z.number().int().openapi({ description: 'Events with a value above 0.' }),
        revenue: z.number(),
        earnings: z.number().openapi({ description: 'Commission accrued in the bucket.' }),
      }),
    ),
  })
  .openapi('PartnerTimeseries');

export const PartnerEventList = z
  .object({
    partnerId: id,
    events: z.array(
      z.object({
        attributionId: id,
        weight: z.number(),
        model: z.enum(ATTRIBUTION_MODELS),
        eventId: id,
        type: z.string(),
        value: z.number().nullable(),
        currency: z.string().nullable(),
        ts,
        userId: z.string(),
        click: z
          .object({
            id,
            linkKey: z.string().nullable(),
            referer: z.string().nullable(),
            landingUrl: z.string().nullable(),
            ts: tsNullable,
            subId: z.string().nullable().openapi({ description: 'The `sub_id` on the partner link the click came through, or null.' }),
          })
          .nullable(),
      }),
    ),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi('PartnerEventList');

export const PartnerCustomerList = z
  .object({
    partnerId: id,
    customers: z.array(
      z.object({ userId: z.string(), firstEventAt: ts, lastEventAt: ts, eventCount: z.number().int(), revenue: z.number() }),
    ),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi('PartnerCustomerList');

export const PartnerBreakdown = z
  .object({
    dimension: z.string(),
    rows: z.array(z.object({ value: z.string(), count: z.number().int() })),
    sampleSize: z.number().int().optional().openapi({ description: 'User-agent dimensions only: clicks sampled (newest first).' }),
    sampleCapped: z.boolean().optional(),
  })
  .openapi('PartnerBreakdown');

export const PartnerFunnel = z
  .object({
    partnerId: id,
    since: ts,
    stages: z.object({
      clicks: z.number().int().openapi({ description: "The partner's clicks since `since`, excluding fraud-flagged ones. Every later stage follows these clicks." }),
      identities: z.number().int().openapi({ description: 'Distinct users stitched to those clicks.' }),
      signups: z.number().int().openapi({
        description:
          'Of those users, the ones with a `signup`, `trial_started`, `subscription_created` or `invoice_paid` event attributed to this partner through one of those clicks.',
      }),
      paid: z.number().int().openapi({ description: 'Of those, the ones with an attributed `invoice_paid` event.' }),
    }),
    rates: z.object({ stitchRate: z.number(), signupRate: z.number(), paidRate: z.number(), overall: z.number() }),
    currency: z.string().openapi({ description: "The brand's default currency: the currency of `revenue`.", example: 'USD' }),
    revenue: z.number().openapi({
      description: "What the paying users in `paid` have paid so far (attributed `invoice_paid`, the partner's weighted share), in `currency` only.",
    }),
    revenueByCurrency: amountsByCurrency,
  })
  .openapi('PartnerFunnel');

// ---------- Webhook endpoints ----------

export const WebhookEndpoint = z
  .object({
    id,
    tenantId: id,
    url: z.string().url(),
    secretPrefix: z.string().openapi({ description: 'First characters of the signing secret, to tell secrets apart. The secret itself is stored encrypted and only returned at creation and rotation.' }),
    events: z.array(z.string()),
    active: z.boolean(),
    label: z.string().nullable(),
    createdAt: ts,
    lastUsedAt: tsNullable,
  })
  .openapi('WebhookEndpoint');

export const WebhookDelivery = z
  .object({
    id,
    tenantId: id,
    endpointId: id,
    eventId: z.string().openapi({ description: 'The envelope `id` (`evt_…`), also sent as `X-OpenPartner-Delivery`.' }),
    eventType: z.string(),
    payload: z.unknown().openapi({ description: 'The exact envelope that was sent.' }),
    status: z.enum(['pending', 'delivered', 'failed']),
    httpStatus: z.number().int().nullable(),
    error: z.string().nullable(),
    attempts: z.number().int(),
    createdAt: ts,
    deliveredAt: tsNullable,
    lastAttemptAt: tsNullable,
  })
  .openapi('WebhookDelivery');

// ---------- API keys ----------

export const CreatedKey = z
  .object({
    id,
    plaintext: z.string().openapi({ description: 'The key. Shown once and never stored; keep it server-side.' }),
  })
  .openapi('CreatedKey');

export const ApiKeySummary = z
  .object({
    id,
    prefix: z.string(),
    label: z.string().nullable(),
    scopes: z.array(z.string()).optional(),
    createdAt: ts,
    lastUsedAt: tsNullable,
    revokedAt: tsNullable,
  })
  .openapi('ApiKeySummary');

// ---------- Settings ----------

export const NetworkMembership = z
  .object({
    enabled: z.boolean(),
    networkUrl: z.string(),
    hasVendorToken: z.boolean(),
    scopedKeyId: z.string().nullable(),
    autoEnroll: z.boolean().openapi({
      description:
        'Stored name for "offer the Network to my partners". When `enabled && autoEnroll`, partners are asked whether to join, and only those who opt in are shared (name and email; never `metadata`).',
    }),
    bonusesAuthorized: z.boolean().openapi({
      description:
        "The Network's federation key holds `bonuses:write`, so OpenPartner Network bounties can pay your partners through `POST /bonuses`. Keys from before Network bounties don't: `POST /config/network/authorize-bonuses` adds it.",
    }),
  })
  .openapi('NetworkMembership');

// ---------- Export ----------

export const ExportBundle = z
  .object({
    exportedAt: ts,
    schemaVersion: z.number().int(),
    tables: z.record(z.array(z.record(z.unknown()))),
  })
  .openapi('ExportBundle', { description: 'The whole tenant, re-importable by a self-hosted instance (`POST /import`).' });

export const ImportResult = z
  .object({
    ok: z.literal(true),
    report: z.object({
      inserted: z.record(z.number().int()),
      skipped: z.record(z.number().int()),
      credentials: z.record(z.array(z.record(z.unknown()))).openapi({
        description:
          'Fresh credentials for restored rows, per table, shown once. `WebhookEndpoint`: `{ id, url, secret }` for each endpoint restored (paused until you turn it back on).',
      }),
    }),
  })
  .openapi('ImportResult');

export const Ok = z.object({ ok: z.literal(true) }).openapi('Ok');
