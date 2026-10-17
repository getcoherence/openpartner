import type { Knex } from 'knex';

/**
 * Scope Event.externalEventId uniqueness to the tenant.
 *
 * The multi-tenant migration re-scoped every natural-key unique to
 * (tenantId, ...) but this one stayed global. That was harmless while the
 * only writer was the Stripe webhook (Stripe event ids are globally
 * unique), but POST /attribution/events and /coupons/redeem take a
 * merchant-supplied key, and order numbers like "1001" collide across
 * brands constantly. Under a global constraint the second brand's insert
 * would hit ON CONFLICT DO NOTHING against a row RLS hides from it: a
 * silently dropped conversion, and an existence oracle across tenants.
 *
 * Existing rows satisfy the global constraint, so they satisfy the
 * composite one. Still a plain UNIQUE constraint (multiple NULLs allowed)
 * so ON CONFLICT ("tenantId", "externalEventId") can infer it as the
 * arbiter — see 20260430020000 for why a partial index can't be.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Event', (t) => {
    t.unique(['tenantId', 'externalEventId']);
  });
  await knex.schema.alterTable('Event', (t) => {
    t.dropUnique(['externalEventId']);
  });
}

export async function down(knex: Knex): Promise<void> {
  // Fails if two tenants have since reused an externalEventId — those rows
  // need resolving by hand before the global constraint can come back.
  await knex.schema.alterTable('Event', (t) => {
    t.unique(['externalEventId']);
  });
  await knex.schema.alterTable('Event', (t) => {
    t.dropUnique(['tenantId', 'externalEventId']);
  });
}
