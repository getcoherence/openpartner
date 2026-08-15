import type { Knex } from 'knex';

/**
 * Partner invite + signin flow.
 *
 *   Partner.activatedAt   null while the partner has been invited but
 *                          hasn't accepted yet. Stamped when they verify
 *                          their magic link.
 *
 *   MagicLinkToken        single-use, short-lived. purpose='partner_invite'
 *                          for the initial acceptance, 'partner_signin'
 *                          for returning logins. partnerId is the partner
 *                          the token resolves to.
 *
*   Session               cookie-backed auth state. The portal stores an
 *                          op_session cookie; the API verifies on each
 *                          request via the same prefix+hash scheme as
 *                          ApiKey. Revocable server-side.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Partner', (t) => {
    t.timestamp('activatedAt', { useTz: true });
  });
  // Existing rows — before the invite flow existed — were all implicitly
  // active. Stamp activatedAt so they still authenticate normally.
  await knex.raw(`update "Partner" set "activatedAt" = "createdAt" where "activatedAt" is null`);

  await knex.schema.createTable('MagicLinkToken', (t) => {
    t.string('id').primary();
    t.string('prefix').notNullable();
    t.string('tokenHash').notNullable();
    t.string('email').notNullable();
    t.string('purpose').notNullable(); // 'partner_invite' | 'partner_signin'
    t.string('partnerId').notNullable().references('id').inTable('Partner').onDelete('CASCADE');
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
    t.string('partnerId').notNullable().references('id').inTable('Partner').onDelete('CASCADE');
    t.timestamp('expiresAt', { useTz: true }).notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('lastSeenAt', { useTz: true });
    t.timestamp('revokedAt', { useTz: true });
    t.index(['prefix']);
    t.index(['partnerId']);
  });

}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('Session');
  await knex.schema.dropTableIfExists('MagicLinkToken');
  await knex.schema.alterTable('Partner', (t) => {
    t.dropColumn('activatedAt');
  });
}
