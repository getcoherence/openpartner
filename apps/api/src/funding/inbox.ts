/**
 * Stripe webhook inbox — spec §4 (finding 7).
 *
 * Every funding-relevant Stripe event is recorded here BEFORE processing;
 * a duplicate delivery (Stripe retry, dual event destinations) becomes a
 * no-op at the door instead of a re-processed transition. Platform-scoped
 * (no tenantId, no RLS): Stripe event ids are global and the funding
 * pipeline runs on the privileged pool.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';

/**
 * Record an event id. Returns true when this is the first delivery (caller
 * proceeds), false on a replay (caller no-ops). Outcome is stamped later.
 */
export async function claimInboxEvent(db: Knex, stripeEventId: string, type: string): Promise<boolean> {
  const inserted = await db(TABLES.StripeWebhookInbox)
    .insert({ stripeEventId, type, processedAt: new Date() })
    .onConflict('stripeEventId')
    .ignore()
    .returning('stripeEventId');
  return inserted.length > 0;
}

export async function stampInboxOutcome(db: Knex, stripeEventId: string, outcome: string): Promise<void> {
  await db(TABLES.StripeWebhookInbox)
    .where({ stripeEventId })
    .update({ outcome: outcome.slice(0, 255), processedAt: new Date() });
}
