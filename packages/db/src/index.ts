/**
 * Shared database types + connection factory.
 */

import knex, { type Knex } from 'knex';
import { sslFromConnectionString } from './ssl.js';

export * from './types.js';
export { sslFromConnectionString } from './ssl.js';

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

export function createDb(config: DbConfig): Knex {
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
  Campaign: 'Campaign',
  PartnerCampaign: 'PartnerCampaign',
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
  WebhookEndpoint: 'WebhookEndpoint',
  WebhookDelivery: 'WebhookDelivery',
  NetworkOutbox: 'NetworkOutbox',
  Coupon: 'Coupon',
  PartnerCommission: 'PartnerCommission',
  PartnerPostback: 'PartnerPostback',
} as const;
