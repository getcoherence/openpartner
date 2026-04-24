import 'dotenv/config';
import type { Knex } from 'knex';

// In dev we run .ts migrations via tsx; in prod the package ships
// compiled .js alongside this (also-compiled) knexfile, so the same
// `./migrations` directory is correct either way — only the file
// extension changes. The migrate runner cd's into the right directory
// before invoking so the relative path resolves.
const isProd = process.env.NODE_ENV === 'production';

const common: Knex.Config = {
  client: 'pg',
  migrations: {
    directory: './migrations',
    extension: isProd ? 'js' : 'ts',
    loadExtensions: isProd ? ['.js'] : ['.ts'],
  },
};

const config: { [env: string]: Knex.Config } = {
  development: {
    ...common,
    connection: process.env.DATABASE_URL ?? 'postgres://openpartner:openpartner@localhost:5433/openpartner',
  },
  production: {
    ...common,
    connection: process.env.DATABASE_URL,
    pool: { min: 2, max: 10 },
  },
};

export default config;
