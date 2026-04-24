/**
 * Row types matching the initial schema migration 1:1.
 *
 * These are the canonical on-the-wire shapes for export/import too — keeping
 * them close to the migration columns is what makes round-trip portability
 * between hosted and self-hosted tractable. If you add a column, update both.
 */

export type CommissionRule =
  | { type: 'percent'; value: number; recurring?: boolean }
  | { type: 'fixed'; value: number; currency?: string; recurring?: boolean };

export type AttributionModel = 'last_click' | 'first_click' | 'linear' | 'position';

export type CommissionStatus = 'accrued' | 'approved' | 'paid' | 'reversed';

export type PayoutStatus = 'pending' | 'paid' | 'failed';

export type PayoutMethod = 'stripe_connect' | 'manual' | 'external';

export interface PartnerRow {
  id: string;
  email: string;
  name: string;
  stripeConnectAccountId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignRow {
  id: string;
  name: string;
  commissionRule: CommissionRule;
  attributionWindowDays: number;
  attributionModel: AttributionModel;
  createdAt: Date;
}

export interface LinkRow {
  id: string;
  linkKey: string;
  partnerId: string;
  campaignId: string;
  destinationUrl: string;
  createdAt: Date;
}

export type ClickFraudFlag = 'velocity' | 'manual' | null;

export interface ClickRow {
  id: string;
  linkId: string;
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
  prefix: string;
  keyHash: string;
  partnerId: string | null;
  networkVendorId: string | null;
  networkCreatorId: string | null;
  scopes: ApiScope[] | null;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

// ---- OpenPartner Network ----

export type NetworkVendorStatus = 'pending' | 'active' | 'suspended';
export type NetworkCreatorStatus = 'pending' | 'active' | 'suspended';
export type PartnershipRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type PartnershipRequestDirection = 'creator_to_vendor' | 'vendor_to_creator';
export type PartnershipStatus = 'active' | 'ended';

export interface CreatorPlatform {
  platform: 'youtube' | 'twitter' | 'instagram' | 'tiktok' | 'blog' | 'podcast' | 'other';
  url: string;
  followers?: number;
}

export type OfferingPayout =
  | { type: 'recurring_percent'; percent: number; durationMonths: number | null } // null = lifetime
  | { type: 'one_time_fee'; amount: number; currency?: string }
  | { type: 'tiered_percent'; tiers: Array<{ minRevenueUsd: number; percent: number }> };

export interface OfferingBonus {
  description: string;
  triggerRevenueUsd: number;
  bonusUsd: number;
}

export interface OfferingTerms {
  payout: OfferingPayout;
  bonuses?: OfferingBonus[];
  cookieWindowDays: number;
  exclusions?: string[];
}

export interface NetworkVendorRow {
  id: string;
  name: string;
  slug: string;
  email: string;
  websiteUrl: string | null;
  logoUrl: string | null;
  description: string | null;
  instanceUrl: string;
  instanceKeyCiphertext: string;
  instanceKeyPrefix: string;
  routerUrl: string | null;
  status: NetworkVendorStatus;
  createdAt: Date;
  activatedAt: Date | null;
}

export interface NetworkCreatorRow {
  id: string;
  name: string;
  handle: string;
  email: string;
  bio: string | null;
  avatarUrl: string | null;
  platforms: CreatorPlatform[];
  defaultPromoCode: string | null;
  status: NetworkCreatorStatus;
  createdAt: Date;
  activatedAt: Date | null;
}

export interface OfferingRow {
  id: string;
  vendorId: string;
  title: string;
  productUrl: string;
  description: string | null;
  heroImageUrl: string | null;
  vendorCampaignId: string;
  terms: OfferingTerms;
  published: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PartnershipRequestRow {
  id: string;
  offeringId: string;
  vendorId: string;
  creatorId: string;
  direction: PartnershipRequestDirection;
  message: string | null;
  promoCode: string | null;
  status: PartnershipRequestStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
}

// ---- Human auth (magic-link + sessions) ----

export type MagicLinkPurpose =
  | 'creator_signup'
  | 'creator_signin'
  | 'vendor_signup'
  | 'vendor_signin';

export interface MagicLinkCreatorClaim {
  kind: 'creator';
  handle: string;
  name: string;
}

export interface MagicLinkVendorClaim {
  kind: 'vendor';
  name: string;
  slug: string;
  instanceUrl: string;
  // AES-256-GCM envelope of the vendor's instance API key. We only have
  // the plaintext transiently during /auth/vendor/signup; the token sits
  // in MagicLinkToken.claim (jsonb) for up to 15 minutes until consumed,
  // and it must not store federation credentials in the clear.
  instanceKeyCiphertext: string;
  instanceKeyPrefix: string;
  routerUrl?: string;
  description?: string;
  websiteUrl?: string;
  logoUrl?: string;
}

export type MagicLinkClaim = MagicLinkCreatorClaim | MagicLinkVendorClaim;

export interface MagicLinkTokenRow {
  id: string;
  prefix: string;
  tokenHash: string;
  email: string;
  purpose: MagicLinkPurpose;
  claim: MagicLinkClaim | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export type SessionPrincipalKind = 'network_creator' | 'network_vendor' | 'partner' | 'admin';

export interface SessionRow {
  id: string;
  prefix: string;
  tokenHash: string;
  principalKind: SessionPrincipalKind;
  principalId: string;
  expiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export interface DevMessageRow {
  id: string;
  to: string;
  subject: string;
  body: string;
  html: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

// ---- Outbound webhooks ----

export type WebhookEventType =
  | 'attribution.created'
  | 'commission.approved'
  | 'commission.paid'
  | 'commission.reversed'
  | 'payout.created'
  | 'partnership.approved'
  | (string & {});

export interface WebhookEndpointRow {
  id: string;
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

export interface PartnershipRow {
  id: string;
  requestId: string;
  offeringId: string;
  vendorId: string;
  creatorId: string;
  vendorPartnerId: string;
  vendorLinkKey: string;
  publicShareUrl: string;
  status: PartnershipStatus;
  createdAt: Date;
  endedAt: Date | null;
}

export interface PayoutRow {
  id: string;
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
