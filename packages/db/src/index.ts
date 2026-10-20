/**
 * Shared database types + connection factory.
 *
 * Knex is loaded lazily inside createDb() so that browser consumers
 * (apps/portal) can import the type-only and pure-function exports
 * without dragging knex + pg + their `process.env` references into
 * the client bundle. The dynamic import has a one-time async cost on
 * the first server-side createDb() call, which is negligible compared
 * to the connection handshake itself.
 */

import type { Knex } from 'knex';
import { sslFromConnectionString } from './ssl.js';

export * from './types.js';
export { sslFromConnectionString } from './ssl.js';
export { renderCommissionSummary } from './commission-summary.js';
export {
  bountyMetricIsMoney,
  formatBountyAmount,
  formatBountyValue,
  renderBountyGoal,
  renderBountySummary,
} from './bounty-summary.js';
export type { BountyLike, BountyMetricLike } from './bounty-summary.js';
export type {
  CommissionSubRuleLike,
  CustomerRewardLike,
} from './commission-summary.js';
export {
  PROGRAM_CATEGORIES,
  PROGRAM_CATEGORY_SLUGS,
  categoryLabel,
} from './categories.js';
export type { ProgramCategory } from './categories.js';
export { parseVideoUrl, isTrustedEmbedUrl } from './program-video.js';
export {
  CLICK_ID_MACRO,
  clickDestination,
  clickDestinationProblem,
  clickDestinationWarning,
  hasClickIdMacro,
} from './click-destination.js';
export type { ProgramVideo, VideoProvider } from './program-video.js';
export {
  AUDIENCE_SIZES,
  AUDIENCE_SIZE_LABELS,
  PARTNER_APPLICATION_LIMITS,
  audienceSizeLabel,
  isAudienceSize,
  isHttpUrl,
} from './partner-application.js';
export type { AudienceSize, PartnerApplication } from './partner-application.js';
export { COUNTRY_CODES, OCCUPIED_REGION_COUNTRY, isCountryCode } from './countries.js';
export type { CountryCode } from './countries.js';

export interface DbConfig {
  connectionString: string;
  poolMin?: number;
  poolMax?: number;
  /**
   * If true, every connection in the pool sets `row_security = off` on
   * acquire. Use for the privileged "admin" pool (cross-tenant work:
   * signup, stripe webhook tenant resolution, metrics, scheduler,
   * platform tooling, migrations). The role must be the table owner
   * or have BYPASSRLS for this to work.
   *
   * Leave false for the app pool (`appDb`); RLS engagement is the
   * whole point of that connection.
   */
  bypassRls?: boolean;
}

export async function createDb(config: DbConfig): Promise<Knex> {
  const { default: knex } = await import('knex');
  const { ssl, url } = sslFromConnectionString(config.connectionString);
  return knex({
    client: 'pg',
    connection: ssl ? { connectionString: url, ssl } : url,
    pool: {
      min: config.poolMin ?? 2,
      max: config.poolMax ?? 10,
      ...(config.bypassRls
        ? {
            // afterCreate runs once per pooled connection. We disable
            // row_security so cross-tenant queries on this pool aren't
            // silently filtered to zero rows by FORCE RLS policies.
            afterCreate: (
              conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
              done: (err: Error | null, conn: unknown) => void,
            ) => {
              conn.query('set session row_security = off', (err) => done(err, conn));
            },
          }
        : {}),
    },
  });
}

// Table name constants — import these instead of hardcoding strings.
export const TABLES = {
  Tenant: 'Tenant',
  PlatformAdmin: 'PlatformAdmin',
  PlatformAdminSession: 'PlatformAdminSession',
  SignupBlocklist: 'SignupBlocklist',
  PlatformAuditLog: 'PlatformAuditLog',
  PlatformSetting: 'PlatformSetting',
  BrandNotification: 'BrandNotification',
  EmailOptOut: 'EmailOptOut',
  LocationDeclaration: 'LocationDeclaration',
  SanctionsScreening: 'SanctionsScreening',
  Partner: 'Partner',
  Program: 'Program',
  PartnerProgram: 'PartnerProgram',
  Link: 'Link',
  Click: 'Click',
  Identity: 'Identity',
  Event: 'Event',
  Attribution: 'Attribution',
  Commission: 'Commission',
  Bonus: 'Bonus',
  Bounty: 'Bounty',
  Payout: 'Payout',
  ApiKey: 'ApiKey',
  ConversionPostbackToken: 'ConversionPostbackToken',
  Config: 'Config',
  Admin: 'Admin',
  MagicLinkToken: 'MagicLinkToken',
  PasswordCredential: 'PasswordCredential',
  Session: 'Session',
  PlatformSession: 'PlatformSession',
  PlatformSessionBundle: 'PlatformSessionBundle',
  WebhookEndpoint: 'WebhookEndpoint',
  WebhookDelivery: 'WebhookDelivery',
  NetworkOutbox: 'NetworkOutbox',
  Coupon: 'Coupon',
  PartnerCommission: 'PartnerCommission',
  PartnerNetworkConsent: 'PartnerNetworkConsent',
  PartnerPostback: 'PartnerPostback',
  BrandAsset: 'BrandAsset',
  PortalCustomDomain: 'PortalCustomDomain',
  HostedFundingBatch: 'HostedFundingBatch',
  HostedFundingAllocation: 'HostedFundingAllocation',
  HostedFundingTransfer: 'HostedFundingTransfer',
  HostedFundingAuthorization: 'HostedFundingAuthorization',
  HostedBillingState: 'HostedBillingState',
  TenantStripeConnection: 'TenantStripeConnection',
  StripeWebhookInbox: 'StripeWebhookInbox',
  PayoutReversal: 'PayoutReversal',
  CommissionAdjustment: 'CommissionAdjustment',
  OperatorRecoveryRequest: 'OperatorRecoveryRequest',
  UsageLedger: 'UsageLedger',
  HostedFeeTerms: 'HostedFeeTerms',
  HostedBillingProfile: 'HostedBillingProfile',
  UsageFeeShadow: 'UsageFeeShadow',
} as const;
