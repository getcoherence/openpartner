import type { Knex } from 'knex';

/**
 * Two-step sign-in for brand admins (apps/api/src/two-factor.ts,
 * docs/two-step-sign-in.md).
 *
 * TwoFactorCredential — one authenticator per person, keyed like
 * PasswordCredential: principalKind 'platform', principalId = lower-cased
 * email, tenantId = DEFAULT_TENANT_ID (placeholder). It belongs to the
 * email, so one authenticator covers every brand the person admins and
 * their OpenPartner account.
 *
 *   secret         the TOTP secret, sealed (crypto.ts encryptSecret).
 *   enabledAt      null while setup waits for the first code.
 *   lastUsedStep   the 30-second step of the last code accepted; a code is
 *                  only taken for a later step, so none works twice.
 *   recoveryCodes  [{ hash, usedAt }]: salted sha256 of each one-time code.
 *   recoverySalt   that salt.
 *
 * PLATFORM-scoped like PasswordCredential: only the privileged `db` pool
 * touches it, it is NOT granted to the openpartner_app role, carries no RLS
 * policy, and is not exported. scheduler.ts deletes a credential 30 days
 * after its email's last admin seat ends, as it does the password.
 *
 * Session and PlatformSession gain the second-factor state. A session
 * created for someone with two-step on starts `secondFactorPending`: it
 * resolves to nobody (resolveSession / resolvePlatformSession) until a code
 * is entered against it, which sets `secondFactorAt`. `secondFactorAt` set
 * on a session that was never pending means the person proved a code when
 * it was made (entering a brand from a verified OpenPartner account).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('TwoFactorCredential', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable();
    t.string('principalKind').notNullable();
    t.string('principalId').notNullable();
    t.text('secret').notNullable();
    t.timestamp('enabledAt', { useTz: true });
    t.bigInteger('lastUsedStep');
    t.jsonb('recoveryCodes').notNullable().defaultTo('[]');
    t.string('recoverySalt', 64);
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['tenantId', 'principalKind', 'principalId']);
  });

  for (const table of ['Session', 'PlatformSession']) {
    await knex.schema.alterTable(table, (t) => {
      t.boolean('secondFactorPending').notNullable().defaultTo(false);
      t.timestamp('secondFactorAt', { useTz: true });
      t.smallint('secondFactorAttempts').notNullable().defaultTo(0);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['Session', 'PlatformSession']) {
    await knex.schema.alterTable(table, (t) => {
      t.dropColumn('secondFactorAttempts');
      t.dropColumn('secondFactorAt');
      t.dropColumn('secondFactorPending');
    });
  }
  await knex.schema.dropTableIfExists('TwoFactorCredential');
}
