/**
 * Programmatic migration runner — avoids the pnpm-workspace / knex-CLI /
 * ESM tsx resolution mess that plagues `knex migrate:latest` when invoked
 * through the hoisted store. Same operations, same behavior.
 */

import 'dotenv/config';
import knex from 'knex';
import config from '../knexfile.js';

async function main(): Promise<void> {
  const sub = process.argv[2] ?? 'latest';
  const db = knex(config[process.env.NODE_ENV === 'production' ? 'production' : 'development']!);

  // Migrations modify schema and seed data across tenants — they must
  // bypass RLS. `SET row_security = off` disables policies for this
  // session. afterCreate runs once per pooled connection, which works
  // because migrations use a single connection from the pool.
  await db.raw('set row_security = off');

  try {
    if (sub === 'latest') {
      const [batch, files] = await db.migrate.latest();
      console.log(`migrated batch ${batch}:`, files);
    } else if (sub === 'rollback') {
      const [batch, files] = await db.migrate.rollback();
      console.log(`rolled back batch ${batch}:`, files);
    } else if (sub === 'status') {
      const current = await db.migrate.currentVersion();
      const list = await db.migrate.list();
      console.log('current:', current);
      console.log('completed:', list[0]);
      console.log('pending:', list[1]);
    } else if (sub === 'make') {
      const name = process.argv[3];
      if (!name) throw new Error('usage: make <name>');
      const file = await db.migrate.make(name, { extension: 'ts' });
      console.log('created', file);
    } else {
      throw new Error(`unknown subcommand: ${sub}`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
