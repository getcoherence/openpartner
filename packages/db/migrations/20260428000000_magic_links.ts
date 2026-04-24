import type { Knex } from 'knex';

/**
 * Email magic-link auth for humans.
 *
 * Design:
 *   - MagicLinkToken  one-time, short-TTL token emailed to a user. Hashed
 *                     at rest (same sha256 pattern as ApiKey). Includes a
 *                     `purpose` (signup or signin) and, for signup, a
 *                     claim jsonb carrying the pending creator's handle +
 *                     name until they verify ownership of the email.
 *
 *   - Session         server-side session created when a MagicLinkToken is
 *                     consumed. The session's token is set as an HttpOnly
 *                     cookie so every subsequent request authenticates
 *                     without needing to read the URL. Principal kind lets
 *                     the same table back future vendor / admin sessions
 *                     once we add magic-link auth for those roles.
 *
 *   - DevMessage      stand-in mailbox for local dev and CI. The DevMailer
 *                     writes here instead of hitting SMTP. An admin-only
 *                     /dev/mailbox endpoint reads them back so you can
 *                     follow the magic link in your browser without any
 *                     external email provider configured.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('MagicLinkToken', (t) => {
    t.string('id').primary();
    t.string('prefix').notNullable();
    t.string('tokenHash').notNullable();
    t.string('email').notNullable();
    t.string('purpose').notNullable(); // 'signup' | 'signin'
    t.jsonb('claim'); // signup-time profile: { handle, name }
    t.timestamp('expiresAt', { useTz: true }).notNullable();
    t.timestamp('consumedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['prefix']);
    t.index(['email', 'purpose']);
  });

  await knex.schema.createTable('Session', (t) => {
    t.string('id').primary();
    t.string('prefix').notNullable();
    t.string('tokenHash').notNullable();
    // For MVP sessions only back network_creator. Future: network_vendor,
    // partner, admin — hence the open `principalKind` string.
    t.string('principalKind').notNullable();
    t.string('principalId').notNullable();
    t.timestamp('expiresAt', { useTz: true }).notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('lastSeenAt', { useTz: true });
    t.timestamp('revokedAt', { useTz: true });
    t.index(['prefix']);
    t.index(['principalKind', 'principalId']);
  });

  await knex.schema.createTable('DevMessage', (t) => {
    t.string('id').primary();
    t.string('to').notNullable();
    t.string('subject').notNullable();
    t.text('body').notNullable();
    t.text('html');
    t.jsonb('metadata').notNullable().defaultTo('{}');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['to']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('DevMessage');
  await knex.schema.dropTableIfExists('Session');
  await knex.schema.dropTableIfExists('MagicLinkToken');
}
