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
import { persistMerchantSubscription } from './routes/billing.js';
import { applyWhiteLabelFromSubscription } from './white-label-billing.js';
import { mirrorHostedBillingState, type MirroredSubscriptionStatus } from './billing-plan.js';
import { sendOpsEmail } from './platform-ops-mail.js';
import {
  opsTenantCancellationResumedEmail,
  opsTenantCancellationScheduledEmail,
  opsTenantInvoicePaymentFailedEmail,
  opsTenantSubscriptionEndedEmail,
} from './email-templates.js';

/** Stripe statuses that mean "this subscription will never bill again". */
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(['canceled', 'incomplete_expired']);

/** Config marker recording that ops was already told about a scheduled
 *  cancellation for this subscription — keeps the nightly reconcile from
 *  re-mailing every day until the period actually ends. */
const CANCEL_NOTICE_CONFIG_KEY = 'billing_cancel_scheduled_notice';

async function tenantForOps(db: Knex, tenantId: string): Promise<{ name: string; slug: string }> {
  const t = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['displayName', 'slug']);
  return { name: t?.displayName ?? tenantId, slug: t?.slug ?? tenantId };
}

function stripeSubscriptionUrl(subscriptionId: string): string {
  return `https://dashboard.stripe.com/subscriptions/${subscriptionId}`;
}

/**
 * The ONE "tenant subscription is gone" transition — shared by the
 * customer.subscription.deleted webhook and the nightly reconcile so both
 * paths clear exactly the same state: subscription pointer, white-label
 * entitlement (which also revokes custom-domain routing + the DO edge),
 * the HostedBillingState mirror, and the cancel-notice marker. The Tenant
 * row stays active so the brand can re-subscribe without losing data.
 * trialEndsAt stays put — it's the original signup-set evaluation deadline.
 */
export async function handleTenantSubscriptionEnded(
  db: Knex,
  tenantId: string,
  via: 'webhook' | 'reconciliation',
): Promise<'enabled' | 'disabled' | 'unchanged'> {
  await persistMerchantSubscription(db, tenantId, { stripeSubscriptionId: null });
  const wl = await applyWhiteLabelFromSubscription(db, tenantId, false);
  await mirrorHostedBillingState(db, tenantId, 'canceled');
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
 * cancel_at_period_end flipped on this subscription. Notifies ops and
 * maintains the cancel-notice marker (so webhook and reconcile don't
 * double-notify each other). Returns a short token for webhook logging.
 */
export async function handleCancellationScheduleChanged(
  db: Knex,
  tenantId: string,
  sub: Stripe.Subscription,
): Promise<'cancel_scheduled' | 'cancel_resumed'> {
  const { name, slug } = await tenantForOps(db, tenantId);
  if (sub.cancel_at_period_end) {
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
    await sendOpsEmail(
      privilegedDb,
      opsTenantCancellationScheduledEmail(name, slug, effectiveAt, feedback, stripeSubscriptionUrl(sub.id)),
      'ops_tenant_cancellation_scheduled',
    );
    await markCancelNoticeSent(db, tenantId, sub.id);
    return 'cancel_scheduled';
  }
  await sendOpsEmail(privilegedDb, opsTenantCancellationResumedEmail(name, slug), 'ops_tenant_cancellation_resumed');
  await clearCancelNotice(db, tenantId);
  return 'cancel_resumed';
}

/** Dunning on the tenant's own OpenPartner invoice → ops alert. */
export async function notifyTenantInvoicePaymentFailed(
  db: Knex,
  tenantId: string,
  invoice: Stripe.Invoice,
): Promise<void> {
  const { name, slug } = await tenantForOps(db, tenantId);
  const amount = `${(invoice.amount_due / 100).toFixed(2)} ${(invoice.currency ?? 'usd').toUpperCase()}`;
  await sendOpsEmail(
    privilegedDb,
    opsTenantInvoicePaymentFailedEmail(
      name,
      slug,
      amount,
      invoice.attempt_count ?? 0,
      invoice.hosted_invoice_url ?? null,
    ),
    'ops_tenant_invoice_payment_failed',
  );
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
      let sub: Stripe.Subscription | null = null;
      try {
        sub = await stripe.subscriptions.retrieve(tenant.stripeSubscriptionId!);
      } catch (err) {
        // Deleted long ago + pruned, or a bad id: same healing as canceled.
        if ((err as { code?: string })?.code !== 'resource_missing') throw err;
      }
      if (!sub || TERMINAL_SUBSCRIPTION_STATUSES.has(sub.status)) {
        await handleTenantSubscriptionEnded(db, tenant.id, 'reconciliation');
        result.ended.push(tenant.slug);
        continue;
      }
      // Live subscription — refresh the status mirror (webhooks normally
      // keep this current; the poll catches drift from missed deliveries).
      await mirrorHostedBillingState(db, tenant.id, sub.status as MirroredSubscriptionStatus);
      if (sub.cancel_at_period_end) {
        const notified = await cancelNoticeSentFor(db, tenant.id);
        if (notified !== sub.id) {
          await handleCancellationScheduleChanged(db, tenant.id, sub);
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
