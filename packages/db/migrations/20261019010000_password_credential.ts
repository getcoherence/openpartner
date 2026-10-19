import type { Knex } from 'knex';

/**
 * Password sign-in (apps/api/src/passwords.ts). A password is one more way
 * to prove who you are before the server issues the same single-use
 * sign-in token an emailed link carries — sessions are still only minted
 * by the magic-link verify endpoints.
 *
 * One row per credential, keyed the way MagicLinkToken and Session key
 * their principals:
 *   - principalKind 'platform', principalId = lower-cased email, tenantId =
 *     DEFAULT_TENANT_ID (placeholder). A brand admin's or ops operator's
 *     password: it belongs to the email, so one password covers every brand
 *     the person admins and the ops console.
 *   - principalKind 'partner', principalId = Partner.id, tenantId = the
 *     brand. Partner passwords are per brand: a brand portal is its own
 *     white-labelled site, and a brand's own mail provider (which carries
 *     its reset links) must never be able to set a credential another
 *     brand would accept.
 *   - principalKind 'signup', principalId = MagicLinkToken.id. The password
 *     typed on the public signup form, held until that activation link is
 *     redeemed, then promoted to the 'platform' row. Bound to the one link
 *     so no other link to the same inbox can bless it.
 *
 * PLATFORM-scoped like LocationDeclaration: only the privileged `db` pool
 * touches it, it is NOT granted to the openpartner_app role, carries no RLS
 * policy, and is not in the export allowlist — password hashes are not
 * portable data, and nothing running as the tenant role can read them.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('PasswordCredential', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable();
    t.string('principalKind').notNullable(); // 'platform' | 'partner' | 'signup'
    t.string('principalId').notNullable();
    t.text('passwordHash').notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['tenantId', 'principalKind', 'principalId']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('PasswordCredential');
}
