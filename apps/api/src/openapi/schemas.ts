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
import { ATTRIBUTION_MODELS, COMMISSION_STATUSES, PAYOUT_METHODS, PAYOUT_STATUSES } from './enums.js';
import { commissionBandsSchema, commissionTiersSchema } from '../commission-rule-schema.js';

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
  })
  .openapi('Partner');

export const PartnerCreated = Partner.extend({ invited: z.boolean() }).openapi('PartnerCreated');

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
  recurring: z.boolean().optional(),
  recurringMonths: z.number().int().optional(),
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
    attributionWindowDays: z.number().int(),
    attributionModel: z.enum(ATTRIBUTION_MODELS),
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
    status: z.enum(['attributed', 'no_identity', 'no_click', 'outside_window', 'already_attributed', 'not_attributed']).openapi({
      description:
        '`not_attributed` appears only on a replay of an event that did not attribute the first time; which miss it was is not stored.',
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
    attribution: Attribution,
    replayed: z.literal(true).optional().openapi({
      description: "Present when an earlier call with the same `externalEventId` already recorded this conversion. `eventId` and `attribution` are that call's.",
    }),
  })
  .openapi('ConversionResult');

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
  attributionId: id,
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
      "How the amount was worked out, where it took more than the rule's flat value. A banded or tiered rule records `slab`: which sub-rule (`ruleIndex`), `kind` (`band` or `tier`), the `level` reached and its `threshold` and `value`, and for tiers the `metric` and its `metricValue` over the `window`. Empty for a flat rule.",
  }),
});

export const Commission = CommissionRowShape.openapi('Commission');

export const CommissionListItem = CommissionRowShape.extend({
  holdbackDays: z.number().int().nullable(),
  programId: z.string().nullable(),
  campaignName: z.string().nullable().openapi({ description: 'The program\'s name (kept under its pre-rename key).' }),
  matureAt: tsNullable.openapi({ description: 'When the holdback ends and the commission becomes approvable. Null = no holdback.' }),
}).openapi('CommissionListItem');

export const CommissionPage = z
  .object({ commissions: z.array(CommissionListItem), nextCursor: z.string().nullable() })
  .openapi('CommissionPage');

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
    metadata: z.record(z.unknown()),
    createdAt: ts,
    completedAt: tsNullable,
  })
  .openapi('Payout');

const moneyGroup = z.object({ partnerId: id, currency: z.string(), amount: z.number() });

export const PayoutRunResult = z
  .object({
    runId: id,
    mode: z.enum(['selfhost', 'flat', 'revshare']),
    skippedBelowThreshold: z.array(moneyGroup),
    skippedUnfunded: z.array(moneyGroup),
    payouts: z.array(
      z.object({
        payoutId: id,
        partnerId: id,
        amount: z.number(),
        currency: z.string(),
        method: z.enum(PAYOUT_METHODS),
        status: z.enum(['pending', 'paid', 'failed']),
        platformFee: z.number().optional(),
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

// ---------- Reporting ----------

export const PartnerDashboard = z
  .object({
    partnerId: id,
    since: ts,
    clicks: z.number().int(),
    attributedEvents: z.number().int(),
    attributedRevenue: z.number(),
    commissionByStatus: z.record(z.enum(COMMISSION_STATUSES), z.number()).openapi({
      description:
        'Sum of commission amounts accrued since `since`, keyed by status, across all currencies (no conversion). Statuses with nothing are absent. `paid` includes manual payouts not yet sent: read payouts for money that went out.',
    }),
    links: z
      .array(z.object({ linkKey: z.string(), clicks: z.number().int(), attributedEvents: z.number().int(), attributedRevenue: z.number() }))
      .optional()
      .openapi({ description: 'Only with `includeLinks=true`.' }),
  })
  .openapi('PartnerDashboard');

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
          .object({ id, linkKey: z.string().nullable(), referer: z.string().nullable(), landingUrl: z.string().nullable(), ts: tsNullable })
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
      clicks: z.number().int().openapi({ description: 'Clicks, excluding fraud-flagged ones.' }),
      identities: z.number().int().openapi({ description: 'Distinct users stitched to those clicks.' }),
      signups: z.number().int().openapi({ description: 'Distinct users with an attributed `signup` event.' }),
      paid: z.number().int().openapi({ description: 'Distinct users with an attributed `invoice_paid` event.' }),
    }),
    rates: z.object({ stitchRate: z.number(), signupRate: z.number(), paidRate: z.number(), overall: z.number() }),
    revenue: z.number().openapi({ description: 'Attributed `invoice_paid` revenue.' }),
  })
  .openapi('PartnerFunnel');

// ---------- Webhook endpoints ----------

export const WebhookEndpoint = z
  .object({
    id,
    tenantId: id,
    url: z.string().url(),
    secretPrefix: z.string().openapi({ description: 'First characters of the signing secret, to tell secrets apart. The secret itself is only returned at creation.' }),
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
    report: z.object({ inserted: z.record(z.number().int()), skipped: z.record(z.number().int()) }),
  })
  .openapi('ImportResult');

export const Ok = z.object({ ok: z.literal(true) }).openapi('Ok');
