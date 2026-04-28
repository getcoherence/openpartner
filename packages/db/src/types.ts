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
}

/** ID of the seeded default tenant — used in single-host mode and during migration backfills. */
export const DEFAULT_TENANT_ID = '01J0000000DEFAULTTENANT0000';

export type CommissionRule =
  | { type: 'percent'; value: number; recurring?: boolean }
  | { type: 'fixed'; value: number; currency?: string; recurring?: boolean };

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
  createdAt: Date;
}

export interface LinkRow {
  id: string;
  tenantId: string;
  linkKey: string;
  partnerId: string;
  campaignId: string;
  destinationUrl: string;
  createdAt: Date;
}

export type ClickFraudFlag = 'velocity' | 'manual' | 'revoked' | null;

export interface ClickRow {
  id: string;
  tenantId: string;
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
  | 'commission.approved'
  | 'commission.paid'
  | 'commission.reversed'
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
