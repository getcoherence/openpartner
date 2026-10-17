import type { Knex } from 'knex';

/**
 * Partner.revokedAt — admin-flipped suspension. When non-null:
 *   - Partner.sessions are all revoked (kicked out of the portal)
 *   - Attribution engine skips new events attributing to them
 *   - Router still serves /r/<linkKey> (no broken UX) but stamps
 *     fraudFlag='revoked' on the click so no commission accrues
 *   - Historical commissions are left untouched — admin reverses
 *     specific ones manually if the revocation is for fraud
 *
 * Reinstate = set revokedAt back to null. No history lost either way.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Partner', (t) => {
    t.timestamp('revokedAt', { useTz: true });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Partner', (t) => {
    t.dropColumn('revokedAt');
  });
}
