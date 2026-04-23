import 'dotenv/config';
import type { Knex } from 'knex';

const config: { [env: string]: Knex.Config } = {
  development: {
    client: 'pg',
    connection: process.env.DATABASE_URL ?? 'postgres://openpartner:openpartner@localhost:5433/openpartner',
    migrations: {
      directory: './migrations',
      extension: 'ts',
    },
  },
  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    migrations: {
      directory: './migrations',
      extension: 'ts',
    },
    pool: { min: 2, max: 10 },
  },
};

export default config;
