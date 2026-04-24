/**
 * Shared database types + connection factory.
 */

import knex, { type Knex } from 'knex';

export * from './types.js';

export interface DbConfig {
  connectionString: string;
  poolMin?: number;
  poolMax?: number;
}

export function createDb(config: DbConfig): Knex {
  return knex({
    client: 'pg',
    connection: config.connectionString,
    pool: {
      min: config.poolMin ?? 2,
      max: config.poolMax ?? 10,
    },
  });
}

// Table name constants — import these instead of hardcoding strings.
export const TABLES = {
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
  MagicLinkToken: 'MagicLinkToken',
  Session: 'Session',
  WebhookEndpoint: 'WebhookEndpoint',
  WebhookDelivery: 'WebhookDelivery',
} as const;
