/**
 * Row types matching the initial schema migration 1:1.
 *
 * These are the canonical on-the-wire shapes for export/import too — keeping
 * them close to the migration columns is what makes round-trip portability
 * between hosted and self-hosted tractable. If you add a column, update both.
 */

/**
 * Tenant: the top-level isolation boundary in multi-tenant deployments.
 * In single-tenant (self-host) mode, every row's tenantId is the seeded
 * 'default' tenant, so the same code paths work without changes.
 */
export interface TenantRow {
  id: string;
  slug: string;
  displayName: string;
  status: 'active' | 'suspended' | 'cancelled';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  customDomain: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  suspendedAt: Date | null;
  pendingDeletionAt: Date | null;
  deletionReason: string | null;
  /** Set on the FIRST successful coupon redemption (any path). Used to
   *  gate large coupon mints behind a "you've actually wired up the
   *  /coupons/redeem integration" check. Null = never verified. */
  couponIntegrationVerifiedAt: Date | null;
  /** Public URL for the tenant's brand logo, set via the upload endpoint.
   *  Null when the brand hasn't uploaded one — UI falls back to text. */
  logoUrl: string | null;
  /** Per-tenant billing tier. Null = legacy tenant predating per-tenant
   *  pricing (resolver falls back to OPENPARTNER_MODE). 'enterprise' has
   *  no Stripe subscription; billed out of band. */
  billingPlan: BillingPlan | null;
  /** Trial expiry. Null when no trial (legacy / enterprise) or when the
   *  trial has already converted to a paid subscription. */
  trialEndsAt: Date | null;
  /** When the tenant first activated a trial. Set on the first
   *  checkout.session.completed that includes a trial period; never
   *  cleared. Used to refuse second-and-later trials so a user can't
   *  trial-loop by cancelling and re-subscribing. */
  firstTrialActivatedAt: Date | null;
}

export type BillingPlan = 'flex' | 'revshare' | 'enterprise';
export const BILLING_PLANS: readonly BillingPlan[] = ['flex', 'revshare', 'enterprise'];

/** ID of the seeded default tenant — used in single-host mode and during migration backfills. */
export const DEFAULT_TENANT_ID = '01J0000000DEFAULTTENANT0000';

/**
 * Commission rules.
 *
 * A Campaign's commissionRule is an ARRAY of triggered sub-rules. One event can
 * fire multiple sub-rules (e.g., a `subscription_created` matches both a
 * first-sale bonus AND an every-event recurring rule), each producing its own
 * Commission row against the same Attribution.
 *
 * Triggers:
 *   every      — fires on every event whose type matches `eventType` (or every
 *                event if `eventType` is omitted; preserves single-rule behavior)
 *   first      — fires only on the FIRST event of `eventType` for this
 *                (partner, user) pair. "$200 first-sale bonus"-style payouts.
 *   subsequent — fires on every event of `eventType` for this (partner, user)
 *                EXCEPT the first. Pairs with a `first` rule to express
 *                "50% on first invoice, 20% on every subsequent invoice"
 *                without the rules double-firing on event #1.
 *
 * recurringMonths caps how long a `recurring` rule keeps firing, measured from
 * the first attributed event of the rule's `eventType` for this (partner, user).
 * Null = indefinite.
 *
 * Wire format is a JSON array on Campaign.commissionRule. The
 * 20260520000000_compound_commission_rules migration backfilled pre-array rows
 * into 1-element arrays — `parseCommissionRule` in attribution.ts also tolerates
 * the legacy single-object shape so a half-applied migration can't break attribution.
 */
export type CommissionRuleTrigger = 'every' | 'first' | 'subsequent';

export interface CommissionSubRule {
  trigger: CommissionRuleTrigger;
  /** Event-type filter. Required for `first`, optional for `every` (omit = all events). */
  eventType?: string;
  type: 'percent' | 'fixed';
  /** Percent: 20 means 20%. Fixed: dollar amount. */
  value: number;
  /** Only meaningful for fixed rules. */
  currency?: string;
  /** When true, the rule keeps firing on subsequent matching events
   *  (renewals). Combined with recurringMonths to cap duration. */
  recurring?: boolean;
  /** Cap (in months) after the first attributed event of this type for
   *  the (partner, user) pair. Null/omitted = no cap. */
  recurringMonths?: number;
}

export type CommissionRule = CommissionSubRule[];

/**
 * Customer-side reward (dual-sided incentives, Path A — coupon-based).
 *
 * Configured per-Campaign. When set, every auto-minted Coupon for that
 * Campaign also provisions a matching Stripe Coupon + PromotionCode so
 * the customer's discount applies automatically at checkout.
 *
 * Maps to Stripe's Coupon API:
 *   percent_off  → coupon.percent_off
 *   amount_off   → coupon.amount_off (cents) + currency
 *   free_months  → coupon.percent_off=100 + duration='repeating' + duration_in_months=value
 *
 * `duration` controls how many invoices the discount applies to. 'once' = first
 * invoice only, 'forever' = every invoice indefinitely, 'repeating' = first N
 * invoices (durationInMonths required).
 */
export type CustomerRewardType = 'percent_off' | 'amount_off' | 'free_months';
export type CustomerRewardDuration = 'once' | 'forever' | 'repeating';

export interface CustomerReward {
  type: CustomerRewardType;
  /** percent_off: 20 = 20%. amount_off: 20 = $20 (currency required).
   *  free_months: 1 = 1 free month (delivered as percent_off=100 over N months). */
  value: number;
  /** Required for amount_off. ISO 4217 lowercase, e.g. 'usd'. */
  currency?: string;
  /** Ignored for free_months (always treated as repeating). */
  duration: CustomerRewardDuration;
  /** Required when duration='repeating'. */
  durationInMonths?: number;
}

export type AttributionModel = 'last_click' | 'first_click' | 'linear' | 'position';

export type CommissionStatus = 'accrued' | 'approved' | 'paid' | 'reversed';

export type PayoutStatus = 'pending' | 'paid' | 'failed';

export type PayoutMethod = 'stripe_connect' | 'manual' | 'external';

export interface PartnerRow {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  stripeConnectAccountId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  // null until the partner accepts their invite magic link
  activatedAt: Date | null;
  // non-null = admin has suspended the partner; sessions + future
  // attribution stop, historical commissions untouched
  revokedAt: Date | null;
  // Admin-supplied free-text reason surfaced in the revoke notification
  // email and shown if the partner later tries to sign in.
  revokeReason: string | null;
}

export type CommissionType = 'percent' | 'fixed';
export type PartnerCommissionSource = 'approval' | 'backfill' | 'amendment';

/**
 * Per-Partner commission snapshot. Sidecar to Partner. Presence of a
 * row means commission accrual reads from here instead of the live
 * Campaign rule — preserves the rate the partner was approved under
 * even after the brand edits the Campaign. Absence falls back to the
 * Campaign rule (legacy partners + non-Network partners).
 */
export interface PartnerCommissionRow {
  partnerId: string;
  tenantId: string;
  /** Legacy single-rule columns. Still populated for backwards compat — the
   *  resolver prefers `commissionRules` (the array form) when present and
   *  only falls back to these for snapshots predating compound rules. */
  commissionType: CommissionType;
  /** Decimal — comes back as string from pg. Percent stored as 20 for 20%. */
  commissionValue: string;
  recurring: boolean;
  /** Compound rule snapshot. Null = use legacy columns above. New snapshots
   *  always populate this; resolveCommissionRule prefers it when present. */
  commissionRules: CommissionRule | null;
  holdbackDays: number | null;
  source: PartnerCommissionSource;
  snapshottedAt: Date;
}

export type MagicLinkPurpose =
  | 'partner_invite'
  | 'partner_signin'
  | 'admin_invite'
  | 'admin_signin'
  | 'platform_signin';

export type PrincipalKind = 'partner' | 'admin' | 'platform';

export interface MagicLinkTokenRow {
  id: string;
  tenantId: string;
  prefix: string;
  tokenHash: string;
  email: string;
  purpose: MagicLinkPurpose;
  principalKind: PrincipalKind;
  principalId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface SessionRow {
  id: string;
  tenantId: string;
  prefix: string;
  tokenHash: string;
  principalKind: PrincipalKind;
  principalId: string;
  expiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export interface PlatformSessionRow {
  id: string;
  prefix: string;
  tokenHash: string;
  email: string;
  expiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export interface AdminRow {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  activatedAt: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  lastSignInAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Platform admins are Coherence support staff who can read across all
 * tenants for triage / debugging. Stored separately from tenant-scoped
 * Admins. Their requests set `app.platform_admin = 'on'`, which RLS
 * policies treat as a wildcard match.
 */
export interface PlatformAdminRow {
  id: string;
  email: string;
  name: string;
  /** Restrict scope: 'support' = read-only, 'admin' = read+write across tenants. */
  role: 'support' | 'admin';
  createdAt: Date;
  revokedAt: Date | null;
}

export interface CampaignRow {
  id: string;
  tenantId: string;
  name: string;
  commissionRule: CommissionRule;
  attributionWindowDays: number;
  attributionModel: AttributionModel;
  /** Where partner share-links for this Campaign land by default. Brand
   *  controls this; partners can only override if deepLinkAllowedDomains
   *  is set and their override matches. */
  destinationUrl: string;
  /** Comma-separated host allowlist enabling per-Link destination
   *  overrides (deep-linking to product pages). Null = partners can't
   *  override the Campaign default. */
  deepLinkAllowedDomains: string | null;
  /** Days a commission must age past accruedAt before it can be
   *  approved + paid out. Null/0 = no holdback (immediately approvable).
   *  Used by brands with a refund window or trial — e.g. set to 30
   *  for a 30-day money-back guarantee so partners don't get paid on
   *  conversions that might still refund. Surfaced on the offering
   *  listing so creators see the terms before applying. */
  holdbackDays: number | null;
  /** Optional scheduled start. Null = no start gate (active immediately). */
  startsAt: Date | null;
  /** Optional scheduled end. Null = runs forever. After this date the
   *  campaign is "ended" — links keep redirecting, but no new
   *  applications + no commission accrual on later events. */
  endsAt: Date | null;
  /** When the "ends in 7 days" reminder was sent to brand admin +
   *  participating partners. Null = not sent yet (or endsAt was
   *  pushed back past the window and the flag was cleared so a fresh
   *  reminder fires before the new end). */
  endNotificationSentAt: Date | null;
  /** Customer-side reward (dual-sided incentive). Null = partner-only.
   *  When set, auto-minted Coupons for this Campaign also provision a
   *  Stripe Coupon + PromotionCode. */
  customerReward: CustomerReward | null;
  /** Industry / product categories. Multi-value, drawn from the curated
   *  PROGRAM_CATEGORIES list. Drives marketplace filtering + the
   *  Category chip on the discover card. Empty array = uncategorized
   *  (legitimate; the brand can leave this blank). */
  categories: string[];
  /** When true AND the brand has a Network membership configured, every
   *  campaign save upserts the corresponding Network Offering so the
   *  marketplace listing stays in sync. False = private campaign,
   *  partner-only — no marketplace presence. Defaults to false at the
   *  DB level; the API route applies a smarter default (true when the
   *  brand is on the Network) for new campaigns. */
  shareOnNetwork: boolean;
  /** Public-facing description shown on the Network marketplace card.
   *  Null/empty = card renders without a description block (just brand
   *  mark + chips + CTA). Internal `name` stays admin-only. */
  marketplaceDescription: string | null;
  /** The Network's Offering row id we're synced against. Null until
   *  the first successful federation upsert; subsequent edits PATCH
   *  this id instead of creating a new offering. */
  networkOfferingId: string | null;
  createdAt: Date;
}

export interface PartnerCampaignRow {
  id: string;
  tenantId: string;
  partnerId: string;
  campaignId: string;
  /** Why this grant exists. 'admin' = brand admin assignment;
   *  'offering' = auto-granted when a Network application was approved
   *  for the Offering tied to this Campaign. */
  source: 'admin' | 'offering';
  createdAt: Date;
}

export interface LinkRow {
  id: string;
  tenantId: string;
  linkKey: string;
  partnerId: string;
  campaignId: string;
  /** Override of Campaign.destinationUrl. Null = inherit. Set only when
   *  the Campaign allows deep-linking and the partner picked a custom
   *  destination on an allowed host. */
  destinationUrl: string | null;
  createdAt: Date;
}

export type ClickFraudFlag = 'velocity' | 'manual' | 'revoked' | null;

export interface ClickRow {
  id: string;
  tenantId: string;
  /** Null for synthetic clicks generated by coupon-code redemptions
   *  (no Link involved — customer entered a code, not clicked a URL). */
  linkId: string | null;
  partnerId: string;
  campaignId: string;
  landingUrl: string;
  ipHash: string | null;
  userAgent: string | null;
  referer: string | null;
  fraudFlag: ClickFraudFlag;
  ts: Date;
}

export interface IdentityRow {
  id: string;
  tenantId: string;
  clickId: string;
  userId: string;
  stitchedAt: Date;
}

export type EventType =
  | 'signup'
  | 'trial_started'
  | 'subscription_created'
  | 'invoice_paid'
  | (string & {});

export interface EventRow {
  id: string;
  tenantId: string;
  userId: string;
  type: EventType;
  value: string | null; // decimal comes back as string from pg
  currency: string | null;
  externalEventId: string | null;
  metadata: Record<string, unknown>;
  ts: Date;
}

export interface AttributionRow {
  id: string;
  tenantId: string;
  eventId: string;
  partnerId: string;
  campaignId: string;
  clickId: string;
  model: AttributionModel;
  weight: string; // decimal as string
  computedAt: Date;
}

export interface CommissionRow {
  id: string;
  tenantId: string;
  attributionId: string;
  partnerId: string;
  amount: string; // decimal as string
  currency: string;
  status: CommissionStatus;
  accruedAt: Date;
  paidAt: Date | null;
  payoutId: string | null;
}

export interface ConfigRow {
  tenantId: string;
  key: string;
  value: unknown;
  updatedAt: Date;
}

export type ApiScope =
  | 'partners:read'
  | 'partners:write'
  | 'links:read'
  | 'links:write'
  | 'commissions:read'
  | (string & {}); // permit future additions without a migration

export interface ApiKeyRow {
  id: string;
  tenantId: string;
  prefix: string;
  keyHash: string;
  partnerId: string | null;
  scopes: ApiScope[] | null;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

// ---- Outbound webhooks ----

export type WebhookEventType =
  | 'attribution.created'
  | 'commission.accrued'
  | 'commission.approved'
  | 'commission.paid'
  | 'commission.reversed'
  | 'partner.created'
  | 'partner.activated'
  | 'partnership.approved'
  | 'payout.created'
  | (string & {});

export interface WebhookEndpointRow {
  id: string;
  tenantId: string;
  url: string;
  secretPrefix: string;
  secret: string;
  events: WebhookEventType[];
  active: boolean;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface WebhookDeliveryRow {
  id: string;
  tenantId: string;
  endpointId: string;
  eventId: string;
  eventType: WebhookEventType;
  payload: unknown;
  status: WebhookDeliveryStatus;
  httpStatus: number | null;
  error: string | null;
  attempts: number;
  createdAt: Date;
  deliveredAt: Date | null;
  lastAttemptAt: Date | null;
}

export interface PayoutRow {
  id: string;
  tenantId: string;
  partnerId: string;
  amount: string;
  currency: string;
  method: PayoutMethod;
  stripeTransferId: string | null;
  status: PayoutStatus;
  metadata: Record<string, unknown>;
  createdAt: Date;
  completedAt: Date | null;
}

// ---- Partner postbacks ----

/** Events a partner postback can subscribe to. Restricted to the
 *  conversion ledger; partner-state events stay tenant-scoped. */
export type PartnerPostbackEvent =
  | 'commission.accrued'
  | 'commission.approved'
  | 'commission.paid'
  | 'commission.reversed';

export interface PartnerPostbackRow {
  id: string;
  tenantId: string;
  partnerId: string;
  url: string;
  events: PartnerPostbackEvent[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastFiredAt: Date | null;
  lastStatus: number | null;
  lastError: string | null;
  successCount: number;
  failureCount: number;
}

export type NetworkOutboxOp = 'partner_upsert' | 'partner_revoke' | 'backfill_partner';
export type NetworkOutboxStatus = 'pending' | 'dead';

export interface NetworkOutboxRow {
  id: string;
  tenantId: string;
  op: NetworkOutboxOp;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  lastAttemptAt: Date | null;
  lastError: string | null;
  status: NetworkOutboxStatus;
}

export interface CouponRow {
  id: string;
  tenantId: string;
  partnerId: string;
  campaignId: string;
  /** User-facing string. Per-tenant unique. Lookups are case-insensitive
   *  but storage is whatever the creator/admin picked at mint time. */
  code: string;
  /** Stripe Coupon ID provisioned alongside the OpenPartner Coupon when
   *  the bound Campaign has a customerReward. Null = no customer-side
   *  reward, OR Stripe wasn't configured at mint time. */
  stripeCouponId: string | null;
  /** Stripe PromotionCode ID — what the customer types at checkout. */
  stripePromotionCodeId: string | null;
  createdAt: Date;
}
