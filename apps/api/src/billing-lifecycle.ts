/**
 * Tenant billing lifecycle — the brand's OWN subscription to OpenPartner,
 * not their end-customers' subscriptions.
 *
 * Two responsibilities:
 *
 *  1. Ops notifications for lifecycle transitions (cancellation scheduled,
 *     subscription ended, dunning failure) so operators hear about churn
 *     when it happens, not when the customer emails support.
 *
 *  2. Nightly reconciliation against Stripe. Webhooks are the fast path but
 *     not a guaranteed one — an endpoint subscribed to the wrong event list
 *     or an outage window loses the event forever, and every local mirror
 *     (whiteLabel entitlement, custom-domain routing, HostedBillingState,
 *     Tenant.stripeSubscriptionId) then drifts until someone notices in the
 *     Stripe dashboard. The nightly poll makes a missed cancellation
 *     self-heal within a day.
 */

import type { Knex } from 'knex';
import Stripe from 'stripe';
import { TABLES, type ConfigRow, type TenantRow } from '@openpartner/db';
// Ops-mail sends resolve the PLATFORM (default-tenant) mail settings, which
// RLS hides from a tenant-pinned webhook transaction — so mail goes through
// the privileged pool, same as brand-review's ops notifications.
import { db as privilegedDb } from './db.js';
import { applyWhiteLabelFromSubscription } from './white-label-billing.js';
import { mirrorHostedBillingState, type MirroredSubscriptionStatus } from './billing-plan.js';
import { sendOpsEmail } from './platform-ops-mail.js';
import {
  opsTenantCancellationResumedEmail,
  opsTenantCancellationScheduledEmail,
  opsTenantInvoicePaymentFailedEmail,
  opsTenantSubscriptionEndedEmail,
} from './email-templates.js';

/** Stripe statuses that mean "this subscription will never bill again".
 *  A retrieve error (incl. resource_missing) is deliberately NOT terminal —
 *  see the reconcile loop. */
export const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'canceled',
  'incomplete_expired',
]);

/** Config marker recording that ops was already told about a scheduled
 *  cancellation for this subscription — dedupes webhook retries against
 *  each other and against the nightly reconcile. */
const CANCEL_NOTICE_CONFIG_KEY = 'billing_cancel_scheduled_notice';

/** Config marker for the last dunning attempt ops was told about: a Stripe
 *  redelivery of the same attempt stays silent, each NEW attempt notifies. */
const DUNNING_NOTICE_CONFIG_KEY = 'billing_dunning_notice';

async function tenantForOps(db: Knex, tenantId: string): Promise<{ name: string; slug: string }> {
  const t = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['displayName', 'slug']);
  return { name: t?.displayName ?? tenantId, slug: t?.slug ?? tenantId };
}

function stripeSubscriptionUrl(subscriptionId: string): string {
  return `https://dashboard.stripe.com/subscriptions/${subscriptionId}`;
}

/** Has a cancellation been scheduled on this sub, by either mechanism?
 *  cancel_at_period_end is the Customer Portal path; a bare cancel_at
 *  covers dashboard "cancel at a date" and Subscription Schedules. */
export function subscriptionCancelScheduled(
  sub: Pick<Stripe.Subscription, 'cancel_at_period_end' | 'cancel_at'>,
): boolean {
  return !!sub.cancel_at_period_end || sub.cancel_at != null;
}

/**
 * The ONE "tenant subscription is gone" transition — shared by the
 * customer.subscription.deleted webhook and the nightly reconcile so both
 * paths clear exactly the same state: subscription pointer, HostedBilling-
 * State mirror, white-label entitlement (which also revokes custom-domain
 * routing + the DO edge), and the cancel-notice marker. The Tenant row
 * stays active so the brand can re-subscribe without losing data;
 * trialEndsAt stays put — it's the original signup-set evaluation deadline.
 *
 * The pointer clear is ONE conditional UPDATE: it only fires when the
 * tenant's pointer still IS the subscription this event/poll refers to. A
 * stale deleted event for a since-replaced sub, a webhook retry after the
 * pointer already cleared, or a resubscribe racing the nightly poll all
 * match 0 rows — the transition (and its ops email) is skipped and null is
 * returned.
 */
export async function handleTenantSubscriptionEnded(
  db: Knex,
  tenantId: string,
  via: 'webhook' | 'reconciliation',
  endedSubscriptionId: string,
): Promise<'enabled' | 'disabled' | 'unchanged' | null> {
  const cleared = await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId, stripeSubscriptionId: endedSubscriptionId })
    .update({ stripeSubscriptionId: null, updatedAt: new Date() });
  if (cleared === 0) return null;
  await mirrorHostedBillingState(db, tenantId, 'canceled');
  const wl = await applyWhiteLabelFromSubscription(db, tenantId, false);
  await clearCancelNotice(db, tenantId);
  const { name, slug } = await tenantForOps(db, tenantId);
  await sendOpsEmail(
    privilegedDb,
    opsTenantSubscriptionEndedEmail(name, slug, via, wl === 'disabled'),
    'ops_tenant_subscription_ended',
  );
  return wl;
}

/**
 * The sub's cancellation schedule changed (or the reconcile discovered one).
 * Notifies ops and maintains the cancel-notice marker. The marker is the
 * dedupe for webhook retries AND the nightly reconcile, and is written only
 * after a SUCCESSFUL send — a mail-transport failure leaves it unset so the
 * next pass retries instead of losing the notice forever.
 */
export async function handleCancellationScheduleChanged(
  db: Knex,
  tenantId: string,
  sub: Stripe.Subscription,
  scheduled: boolean,
): Promise<'cancel_scheduled' | 'cancel_resumed'> {
  if (scheduled) {
    if ((await cancelNoticeSentFor(db, tenantId)) === sub.id) return 'cancel_scheduled';
    const { name, slug } = await tenantForOps(db, tenantId);
    // Stripe stamps cancel_at when a cancellation is scheduled; fall back
    // to the latest item period end (current_period_end lives on items
    // since the 2025 API versions).
    const endTs =
      typeof sub.cancel_at === 'number'
        ? sub.cancel_at
        : (sub.items?.data ?? []).reduce<number | null>(
            (max, it) =>
              typeof it.current_period_end === 'number' && (max === null || it.current_period_end > max)
                ? it.current_period_end
                : max,
            null,
          );
    const effectiveAt = endTs != null ? new Date(endTs * 1000) : null;
    const details = sub.cancellation_details;
    const feedback = [details?.feedback, details?.comment].filter(Boolean).join(' — ') || null;
    const sent = await sendOpsEmail(
      privilegedDb,
      opsTenantCancellationScheduledEmail(name, slug, effectiveAt, feedback, stripeSubscriptionUrl(sub.id)),
      'ops_tenant_cancellation_scheduled',
    );
    if (sent) await markCancelNoticeSent(db, tenantId, sub.id);
    return 'cancel_scheduled';
  }
  // Resume: only meaningful (and only mailed) when a scheduled notice was
  // actually recorded — a retry after the marker cleared stays silent.
  if ((await cancelNoticeSentFor(db, tenantId)) === null) return 'cancel_resumed';
  const { name, slug } = await tenantForOps(db, tenantId);
  await sendOpsEmail(
    privilegedDb,
    opsTenantCancellationResumedEmail(name, slug),
    'ops_tenant_cancellation_resumed',
  );
  await clearCancelNotice(db, tenantId);
  return 'cancel_resumed';
}

/** Dunning on the tenant's own OpenPartner invoice → ops alert, deduped
 *  per (invoice, attempt) so Stripe redeliveries stay silent while each
 *  new collection attempt still notifies. */
export async function notifyTenantInvoicePaymentFailed(
  db: Knex,
  tenantId: string,
  invoice: Stripe.Invoice,
): Promise<'notified' | 'duplicate'> {
  const attempt = invoice.attempt_count ?? 0;
  const marker = await db<ConfigRow>(TABLES.Config)
    .where({ tenantId, key: DUNNING_NOTICE_CONFIG_KEY })
    .first();
  const prev = marker?.value as { invoiceId?: string; attemptCount?: number } | undefined;
  if (prev?.invoiceId === invoice.id && (prev.attemptCount ?? 0) >= attempt) return 'duplicate';
  const { name, slug } = await tenantForOps(db, tenantId);
  const amount = `${(invoice.amount_due / 100).toFixed(2)} ${(invoice.currency ?? 'usd').toUpperCase()}`;
  const sent = await sendOpsEmail(
    privilegedDb,
    opsTenantInvoicePaymentFailedEmail(
      name,
      slug,
      amount,
      attempt,
      invoice.hosted_invoice_url ?? null,
    ),
    'ops_tenant_invoice_payment_failed',
  );
  if (sent) {
    await db<ConfigRow>(TABLES.Config)
      .insert({
        tenantId,
        key: DUNNING_NOTICE_CONFIG_KEY,
        value: { invoiceId: invoice.id, attemptCount: attempt } as unknown as never,
        updatedAt: new Date(),
      })
      .onConflict(['tenantId', 'key'])
      .merge({
        value: { invoiceId: invoice.id, attemptCount: attempt } as unknown as never,
        updatedAt: new Date(),
      });
  }
  return 'notified';
}

async function markCancelNoticeSent(db: Knex, tenantId: string, subscriptionId: string): Promise<void> {
  await db<ConfigRow>(TABLES.Config)
    .insert({
      tenantId,
      key: CANCEL_NOTICE_CONFIG_KEY,
      value: { subscriptionId } as unknown as never,
      updatedAt: new Date(),
    })
    .onConflict(['tenantId', 'key'])
    .merge({ value: { subscriptionId } as unknown as never, updatedAt: new Date() });
}

async function clearCancelNotice(db: Knex, tenantId: string): Promise<void> {
  await db<ConfigRow>(TABLES.Config).where({ tenantId, key: CANCEL_NOTICE_CONFIG_KEY }).del();
}

async function cancelNoticeSentFor(db: Knex, tenantId: string): Promise<string | null> {
  const row = await db<ConfigRow>(TABLES.Config)
    .where({ tenantId, key: CANCEL_NOTICE_CONFIG_KEY })
    .first();
  const value = row?.value as { subscriptionId?: string } | undefined;
  return value?.subscriptionId ?? null;
}

export interface ReconcileResult {
  checked: number;
  /** Slugs whose subscription turned out to be gone — missed-webhook heal. */
  ended: string[];
  /** Slugs newly discovered as cancel-scheduled (webhook missed it). */
  cancelScheduled: string[];
  errors: string[];
}

/**
 * Nightly poll: for every tenant that locally claims an active plan
 * subscription, ask Stripe what's actually true and heal the drift a
 * missed webhook left behind. Verifies + clears state and alerts ops;
 * never touches Stripe-side state.
 */
export async function reconcileTenantSubscriptions(
  db: Knex,
  stripeClient?: Pick<Stripe, 'subscriptions'>,
): Promise<ReconcileResult | { skipped: string }> {
  const key = process.env.STRIPE_SECRET_KEY;
  const stripe = stripeClient ?? (key ? new Stripe(key) : null);
  if (!stripe) return { skipped: 'stripe_not_configured' };

  const tenants = await db<TenantRow>(TABLES.Tenant)
    .whereNotNull('stripeSubscriptionId')
    .select(['id', 'slug', 'stripeSubscriptionId']);

  const result: ReconcileResult = { checked: tenants.length, ended: [], cancelScheduled: [], errors: [] };
  for (const tenant of tenants) {
    try {
      let sub: Stripe.Subscription;
      try {
        sub = await stripe.subscriptions.retrieve(tenant.stripeSubscriptionId!);
      } catch (err) {
        // A retrieve error — INCLUDING resource_missing — is never proof of
        // cancellation. Canceled subscriptions stay retrievable forever, so
        // "missing" means the configured key can't see this id at all
        // (wrong account, test-mode key, corrupt pointer). Healing on it
        // would let one config mistake mass-revoke every live tenant's
        // white-label + custom domain. Report and move on.
        result.errors.push(`${tenant.slug}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (TERMINAL_SUBSCRIPTION_STATUSES.has(sub.status)) {
        const wl = await handleTenantSubscriptionEnded(db, tenant.id, 'reconciliation', tenant.stripeSubscriptionId!);
        // null = the pointer changed mid-run (resubscribe race) — skipped.
        if (wl !== null) result.ended.push(tenant.slug);
        continue;
      }
      // Live subscription — refresh the status mirror (webhooks normally
      // keep this current; the poll catches drift from missed deliveries).
      await mirrorHostedBillingState(db, tenant.id, sub.status as MirroredSubscriptionStatus);
      if (subscriptionCancelScheduled(sub)) {
        const notified = await cancelNoticeSentFor(db, tenant.id);
        if (notified !== sub.id) {
          await handleCancellationScheduleChanged(db, tenant.id, sub, true);
          result.cancelScheduled.push(tenant.slug);
        }
      } else {
        // Covers the resume-without-webhook case too: a stale marker would
        // otherwise suppress the notice if they cancel again later.
        await clearCancelNotice(db, tenant.id);
      }
    } catch (err) {
      result.errors.push(`${tenant.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (result.errors.length > 0) {
    console.error('[billing-reconcile] errors', result.errors);
  }
  return result;
}
