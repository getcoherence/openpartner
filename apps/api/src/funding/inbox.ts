/**
 * Stripe webhook inbox — spec §4 (finding 7).
 *
 * Every funding-relevant Stripe event is recorded here BEFORE processing;
 * a duplicate delivery (Stripe retry, dual event destinations) becomes a
 * no-op at the door instead of a re-processed transition. Platform-scoped
 * (no tenantId, no RLS): Stripe event ids are global and the funding
 * pipeline runs on the privileged pool.
 *
 * The claim is a LEASE, not a tombstone (audit #12). Recording "seen"
 * before the handler runs means a crash mid-handler used to make the
 * event permanently unprocessable: the row said seen, so every Stripe
 * redelivery no-opped, and the transition it carried never happened.
 *
 * So the row means one of two things:
 *   outcome IS NOT NULL   → processed, terminal, replays no-op forever
 *   outcome IS NULL       → claimed by a worker that hasn't finished
 *
 * An unfinished claim older than the lease window is assumed dead and can
 * be taken over by a redelivery. Handlers are CAS-based and idempotent, so
 * a takeover that races a still-living worker degrades to a lost CAS
 * rather than a double transition. Stale claims that never get redelivered
 * are surfaced by the daily reconcile.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';

/** How long a claim is trusted before a redelivery may take it over.
 *  Comfortably longer than any handler (each makes at most a couple of
 *  Stripe calls) and shorter than Stripe's retry schedule stretches. */
export const INBOX_CLAIM_LEASE_MS = 5 * 60 * 1000;

export interface InboxClaimOptions {
  leaseMs?: number;
  now?: Date;
}

/**
 * Claim an event for processing. Returns true when this worker owns it
 * (first delivery, or takeover of an abandoned claim) and false when it is
 * already processed or actively held by someone else.
 */
export async function claimInboxEvent(
  db: Knex,
  stripeEventId: string,
  type: string,
  opts: InboxClaimOptions = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const leaseExpiry = new Date(now.getTime() - (opts.leaseMs ?? INBOX_CLAIM_LEASE_MS));
  // One statement, so two workers can't both win: the conflicting update
  // only fires for a row that is unfinished AND past its lease.
  const res = (await db.raw(
    `insert into "StripeWebhookInbox" ("stripeEventId", "type", "processedAt")
     values (?, ?, ?)
     on conflict ("stripeEventId") do update
       set "processedAt" = excluded."processedAt", "type" = excluded."type"
     where "StripeWebhookInbox"."outcome" is null
       and "StripeWebhookInbox"."processedAt" < ?
     returning "stripeEventId"`,
    [stripeEventId, type, now, leaseExpiry],
  )) as { rows: Array<{ stripeEventId: string }> };
  return (res.rows?.length ?? 0) > 0;
}

/** Mark an event finished. Only this makes the claim terminal. */
export async function stampInboxOutcome(db: Knex, stripeEventId: string, outcome: string): Promise<void> {
  await db(TABLES.StripeWebhookInbox)
    .where({ stripeEventId })
    .update({ outcome: outcome.slice(0, 255), processedAt: new Date() });
}

/**
 * Drop a claim whose handler threw, so Stripe's redelivery is processed
 * immediately instead of waiting out the lease. Only ever called on a
 * path that is about to return non-2xx.
 */
export async function releaseInboxClaim(db: Knex, stripeEventId: string): Promise<void> {
  await db(TABLES.StripeWebhookInbox).where({ stripeEventId, outcome: null }).del();
}
