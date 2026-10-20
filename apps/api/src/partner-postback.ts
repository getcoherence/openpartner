/**
 * Partner postback URL fan-out.
 *
 * Distinct from the tenant-scoped outbound webhooks in
 * webhook-dispatcher.ts: those are the brand's integrations, signed
 * with HMAC + JSON body. This is the *partner's* own tracker callback
 * — Voluum / Bemob / RedTrack / etc. — fired as a plain GET with
 * macro-substituted query parameters, the way affiliate trackers
 * universally consume conversions.
 *
 * Subscription is restricted to the partner's own earnings: commission.*
 * (the conversion ledger) and bonus.awarded / bonus.paid. partner-state
 * events stay tenant-scoped.
 *
 * No HMAC: classic postbacks aren't signed. Partners that want
 * verification put a shared secret in the URL template
 * (?secret=...&clickid={click_id}) and check it on their end.
 *
 * Audit lives in rolling counters on PartnerPostback (lastFiredAt /
 * lastStatus / successCount / failureCount). Per-delivery rows would
 * blow up at any reasonable partner volume.
 */

import type { Knex } from 'knex';
import {
  TABLES,
  type PartnerPostbackEvent,
  type PartnerPostbackRow,
} from '@openpartner/db';
import { db } from './db.js';
import { safeFetch } from './outbound-guard.js';

const POSTBACK_TIMEOUT_MS = 5_000;

/** Subset of WebhookEventType — events partners can postback on. */
const POSTBACK_EVENTS: readonly PartnerPostbackEvent[] = [
  'commission.accrued',
  'commission.approved',
  'commission.paid',
  'commission.reversed',
  'bonus.awarded',
  'bonus.paid',
];

export function isPostbackEvent(s: string): s is PartnerPostbackEvent {
  return (POSTBACK_EVENTS as readonly string[]).includes(s);
}

export function postbackEventsList(): readonly PartnerPostbackEvent[] {
  return POSTBACK_EVENTS;
}

/**
 * Fields available for {macro} substitution. Names match the body
 * fields fired by attribution.ts / payouts.ts so the macro list stays
 * self-explanatory ({commission_id} from data.commissionId, etc).
 *
 * Adding a macro is two steps: (1) add it to the type, (2) populate it
 * in the dispatch caller. Unknown {macros} in user URLs stay literal —
 * we don't want to silently delete them.
 */
export interface PostbackContext {
  click_id?: string;
  partner_id?: string;
  commission_id?: string;
  commission_amount?: string;
  currency?: string;
  event_id?: string;
  event_type?: string;
  program_id?: string;
  payout_id?: string;
  /** Alias for event_id — affiliate trackers commonly call it
   *  "transaction_id" / "tid". */
  transaction_id?: string;
  /** bonus.* only. A bonus has no click or event, so {click_id},
   *  {event_id}, {transaction_id}, {sub_id} and {sale_amount} stay
   *  literal on its postbacks. */
  bonus_id?: string;
  bounty_id?: string;
  bonus_amount?: string;
  /** The publisher's own sub-ID from the partner link (`?sub_id=`), so a
   *  tracking tool can match the conversion to its click. Empty when the
   *  link carried none. */
  sub_id?: string;
  /** Which status change fired this postback (see postbackStatus), so one
   *  URL subscribed to several events can tell them apart. */
  status?: PostbackStatus;
  /** The conversion's value in major units (Event.value), in the sale's
   *  currency. Empty when the event has no value. */
  sale_amount?: string;
}

export type PostbackStatus = 'pending' | 'approved' | 'reversed' | 'paid';

/**
 * {status} for an event. commission.accrued is `pending` (awaiting approval
 * or the holdback). bonus.awarded is `approved` when the bonus goes straight
 * to the next payout run and `pending` while it sits out the holdback (its
 * payload's `status`).
 */
export function postbackStatus(event: PartnerPostbackEvent, bonusStatus?: unknown): PostbackStatus {
  switch (event) {
    case 'commission.accrued':
      return 'pending';
    case 'commission.approved':
      return 'approved';
    case 'commission.reversed':
      return 'reversed';
    case 'commission.paid':
    case 'bonus.paid':
      return 'paid';
    case 'bonus.awarded':
      return bonusStatus === 'approved' ? 'approved' : 'pending';
  }
}

/** Replace {name} placeholders with URL-encoded values from ctx.
 *  Unknown macros stay literal. */
export function substituteMacros(template: string, ctx: PostbackContext): string {
  return template.replace(/\{([a-z_]+)\}/g, (match, name) => {
    const v = (ctx as Record<string, string | undefined>)[name];
    return v !== undefined ? encodeURIComponent(v) : match;
  });
}

/**
 * Fire-and-forget partner postback dispatch. Looks up enabled
 * PartnerPostback rows for (tenant, partner) subscribed to `event`,
 * substitutes macros into the URL, fires GET, updates rolling
 * counters. Errors are trapped — a postback failure cannot affect
 * the caller's transaction.
 *
 * Dispatched from webhook-dispatcher.ts after the tenant-side
 * webhook fan-out so the two paths can't starve each other.
 */
export function dispatchPartnerPostbacks(
  tenantId: string,
  partnerId: string,
  event: PartnerPostbackEvent,
  ctx: PostbackContext,
): void {
  void runPostbackDispatch(tenantId, partnerId, event, ctx).catch((err) => {
    console.error(
      `[postback] dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function runPostbackDispatch(
  tenantId: string,
  partnerId: string,
  event: PartnerPostbackEvent,
  ctx: PostbackContext,
): Promise<void> {
  const postbacks = await db<PartnerPostbackRow>(TABLES.PartnerPostback)
    .where({ tenantId, partnerId, enabled: true });
  const matching = postbacks.filter((p) => {
    const events = Array.isArray(p.events) ? p.events : [];
    return events.includes(event);
  });
  if (matching.length === 0) return;

  await Promise.all(matching.map((p) => fireOne(p, ctx)));
}

async function fireOne(row: PartnerPostbackRow, ctx: PostbackContext): Promise<void> {
  const url = substituteMacros(row.url, ctx);
  const now = new Date();
  let status = 0;
  let error: string | null = null;
  try {
    // Validate AFTER macro substitution (the fired URL is what matters).
    // safeFetch enforces the SSRF policy and throws OutboundBlockedError
    // (a stable code, safe to store in the partner-visible lastError) for
    // any non-public destination.
    const res = await safeFetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'OpenPartner-Postback/1' },
      timeoutMs: POSTBACK_TIMEOUT_MS,
      // Partner-controlled URL: hardened policy — never the escape hatch.
      trust: 'partner',
    });
    status = res.status;
    if (!res.ok) {
      error = `http_${res.status}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const success = !error;
  const update: Partial<PartnerPostbackRow> = {
    lastFiredAt: now,
    lastStatus: status || null,
    lastError: error?.slice(0, 500) ?? null,
  };
  // Increment the counter on the success/failure side. Knex doesn't
  // express increment-and-update-other-fields cleanly, so split.
  await db<PartnerPostbackRow>(TABLES.PartnerPostback).where({ id: row.id }).update(update);
  await db<PartnerPostbackRow>(TABLES.PartnerPostback)
    .where({ id: row.id })
    .increment(success ? 'successCount' : 'failureCount', 1);
}
