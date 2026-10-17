/**
 * Optional start/end window on Campaign — for scheduled pushes,
 * seasonal launches, holiday promos, etc. Both nullable; null/null
 * means "runs forever," matching today's behavior.
 *
 * Lifecycle (computed at read time, not stored):
 *   - Before startsAt → Scheduled (hidden from creator discovery,
 *     new applications + Link creation refused)
 *   - Between startsAt and endsAt (or null bounds) → Active
 *   - After endsAt → Ended (hidden from discovery, new apps + Links
 *     refused; existing Links keep redirecting; new commissions
 *     don't accrue on conversions dated after endsAt)
 *
 * The "existing Links keep working but stop earning" rule is what
 * separates a respectable partner platform from one creators won't
 * trust again — see the router's destination resolver, which doesn't
 * consult these dates (URLs always 302), and the attribution layer,
 * which does (commissions stop).
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.timestamp('startsAt', { useTz: true });
    t.timestamp('endsAt', { useTz: true });
    t.index(['startsAt']);
    t.index(['endsAt']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.dropIndex(['startsAt']);
    t.dropIndex(['endsAt']);
    t.dropColumn('startsAt');
    t.dropColumn('endsAt');
  });
}
