/**
 * Shared database types + connection factory.
 *
 * Phase 1 will flesh out per-table TypeScript interfaces matching the migration schema.
 */

import knex, { type Knex } from 'knex';

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
} as const;
