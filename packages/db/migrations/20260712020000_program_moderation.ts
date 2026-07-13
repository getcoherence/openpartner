import type { Knex } from 'knex';

/**
 * Program-level moderation (anti-spam, complements brand approval).
 *
 * A brand can clear review yet run — or later add — an abusive Program
 * (the tell is usually Program.destinationUrl pointing at a phishing /
 * cloaked page). This adds a reversible per-Program takedown that leaves
 * the brand itself on the platform:
 *
 *   blockedAt set  → the router refuses to serve any of the program's
 *                    partner links (they stop redirecting), independent of
 *                    the brand's approvalStatus.
 *
 * Distinct from the existing Program.endsAt (a scheduled wind-down where
 * links keep redirecting and only accrual stops) — a block kills the
 * redirect outright. Null blockedAt = normal.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Program', (t) => {
    t.timestamp('blockedAt', { useTz: true });
    t.text('blockedReason');
    t.string('blockedByEmail'); // platform operator who blocked it
    t.index(['blockedAt']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Program', (t) => {
    t.dropIndex(['blockedAt']);
    t.dropColumn('blockedAt');
    t.dropColumn('blockedReason');
    t.dropColumn('blockedByEmail');
  });
}
