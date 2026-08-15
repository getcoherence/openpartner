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

export type InboxClaim =
  /** This worker owns the event. `token` identifies THIS claim. */
  | { status: 'claimed'; token: string }
  /** Finished earlier. A redelivery is a genuine duplicate — ack it. */
  | { status: 'done' }
  /** Someone else is mid-flight. NOT ours, and NOT finished: the caller
   *  must not acknowledge, or Stripe stops retrying an event that may
   *  never get processed if that worker dies. */
  | { status: 'held' };

/**
 * Claim an event for processing.
 *
 * The three outcomes are deliberately distinct. Collapsing `held` into
 * `done` is what made the first version of this fix incomplete: a worker
 * that crashed mid-handler left the row unfinished, Stripe's redelivery
 * arrived inside the lease, the second worker said "replay", the endpoint
 * answered 2xx — and Stripe never delivered again. The event was still
 * lost, just on a five-minute fuse instead of forever.
 */
export async function claimInboxEvent(
  db: Knex,
  stripeEventId: string,
  type: string,
  opts: InboxClaimOptions = {},
): Promise<InboxClaim> {
  const now = opts.now ?? new Date();
  const leaseExpiry = new Date(now.getTime() - (opts.leaseMs ?? INBOX_CLAIM_LEASE_MS));
  // One statement, so two workers can't both win: the conflicting update
  // only fires for a row that is unfinished AND past its lease. The
  // claim's `processedAt` doubles as its owner token — a takeover swaps
  // it, so a resurrected predecessor can no longer stamp or delete a
  // claim it no longer owns.
  const res = (await db.raw(
    `insert into "StripeWebhookInbox" ("stripeEventId", "type", "processedAt")
     values (?, ?, ?)
     on conflict ("stripeEventId") do update
       set "processedAt" = excluded."processedAt", "type" = excluded."type"
     where "StripeWebhookInbox"."outcome" is null
       and "StripeWebhookInbox"."processedAt" < ?
     returning "processedAt"`,
    [stripeEventId, type, now, leaseExpiry],
  )) as { rows: Array<{ processedAt: Date }> };
  const claimedAt = res.rows?.[0]?.processedAt;
  if (claimedAt) return { status: 'claimed', token: new Date(claimedAt).toISOString() };

  const existing = (await db(TABLES.StripeWebhookInbox)
    .where({ stripeEventId })
    .first(['outcome'])) as { outcome: string | null } | undefined;
  return existing?.outcome ? { status: 'done' } : { status: 'held' };
}

/** Mark an event finished — only this makes the claim terminal. Scoped to
 *  the token so a worker whose lease was taken over can't stamp an
 *  outcome onto the new owner's claim. */
export async function stampInboxOutcome(
  db: Knex,
  stripeEventId: string,
  outcome: string,
  token?: string,
): Promise<boolean> {
  const q = db(TABLES.StripeWebhookInbox).where({ stripeEventId });
  if (token) q.where('processedAt', new Date(token));
  const updated = await q.update({ outcome: outcome.slice(0, 255), processedAt: new Date() });
  return updated > 0;
}

/**
 * Drop a claim whose handler threw, so Stripe's redelivery is processed
 * immediately instead of waiting out the lease. Only ever called on a
 * path that is about to return non-2xx, and only for the claim this
 * worker still owns.
 */
export async function releaseInboxClaim(
  db: Knex,
  stripeEventId: string,
  token?: string,
): Promise<void> {
  const q = db(TABLES.StripeWebhookInbox).where({ stripeEventId, outcome: null });
  if (token) q.where('processedAt', new Date(token));
  await q.del();
}
