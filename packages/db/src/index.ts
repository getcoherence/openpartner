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
  Partner: 'Partner',
  Program: 'Program',
  PartnerProgram: 'PartnerProgram',
  Link: 'Link',
  Click: 'Click',
  Identity: 'Identity',
  Event: 'Event',
  Attribution: 'Attribution',
  Commission: 'Commission',
  Payout: 'Payout',
  ApiKey: 'ApiKey',
  Config: 'Config',
  Admin: 'Admin',
  MagicLinkToken: 'MagicLinkToken',
  Session: 'Session',
  PlatformSession: 'PlatformSession',
  PlatformSessionBundle: 'PlatformSessionBundle',
  WebhookEndpoint: 'WebhookEndpoint',
  WebhookDelivery: 'WebhookDelivery',
  NetworkOutbox: 'NetworkOutbox',
  Coupon: 'Coupon',
  PartnerCommission: 'PartnerCommission',
  PartnerPostback: 'PartnerPostback',
  BrandAsset: 'BrandAsset',
  PortalCustomDomain: 'PortalCustomDomain',
} as const;
