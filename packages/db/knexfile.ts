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
    // We occasionally remove migrations that have already run against
    // existing databases (e.g. the Network carve-out). Knex's default
    // "corrupt directory" check refuses to boot in that case; instead
    // we ship a targeted tear-down migration and let old applied rows
    // live on in knex_migrations as history.
    disableMigrationsListValidation: true,
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
