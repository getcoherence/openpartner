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
}

export function createDb(config: DbConfig): Knex {
  const { ssl, url } = sslFromConnectionString(config.connectionString);
  return knex({
    client: 'pg',
    connection: ssl ? { connectionString: url, ssl } : url,
    pool: {
      min: config.poolMin ?? 2,
      max: config.poolMax ?? 10,
    },
  });
}

// Table name constants — import these instead of hardcoding strings.
export const TABLES = {
  Tenant: 'Tenant',
  PlatformAdmin: 'PlatformAdmin',
  Partner: 'Partner',
  Campaign: 'Campaign',
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
  WebhookEndpoint: 'WebhookEndpoint',
  WebhookDelivery: 'WebhookDelivery',
} as const;
