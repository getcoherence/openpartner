/**
 * Brand-side account deletion. Two-phase, GDPR-aligned:
 *
 *   Phase 1 — soft delete: admin clicks Delete, we stamp
 *     Tenant.pendingDeletionAt + reason, revoke all admin Sessions,
 *     and respond. The brand is immediately locked out (the tenancy
 *     middleware refuses requests for a tenant that's pending deletion).
 *
 *   Phase 2 — hard delete: a scheduler sweep finds tenants past the
 *     30-day grace window and cascades the wipe. Until then, an admin
 *     can call /account/restore to clear pendingDeletionAt and recover.
 *
 * NOT yet handled (TODOs that should land before public launch):
 *   - Stripe subscription cancellation. Today the brand keeps getting
 *     billed inside the grace window. Should at least set the sub to
 *     cancel-at-period-end at delete-time.
 *   - Network-side vendor row revoke (the Network keeps thinking we're
 *     federated). Needs a /vendors/me/delete on the Network.
 *   - Any pending payouts / unpaid commissions guard — right now we
 *     allow deletion regardless. A real production gate would refuse
 *     until the ledger is settled.
 */

import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type TenantRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { stripe } from '../stripe.js';
import { adminRestoreVendor, getNetworkMembership, networkProxy, saveNetworkMembership, NetworkProxyError } from '../network-client.js';

export const accountDeletionRouter = Router();

interface PendingObligations {
  /** Sum of unpaid commission amounts (decimal, in the Commission's
   *  currency — typically USD). Field renamed from the original
   *  *Cents to match the actual `amount` decimal column. */
  unpaidCommissionAmount: number;
  pendingPayoutCount: number;
}

async function checkPendingObligations(tenantId: string): Promise<PendingObligations> {
  // Commissions are unpaid when status is 'accrued' (newly recorded,
  // pending admin approval) or 'approved' (cleared but not paid out).
  // 'paid' and 'reversed' are settled.
  const [c] = await db(TABLES.Commission)
    .where({ tenantId })
    .whereIn('status', ['accrued', 'approved'])
    .sum<Array<{ sum: string | null }>>({ sum: 'amount' });
  // Payouts are mid-flight when 'pending'. 'paid' and 'failed' are
  // resolved states. (No 'processing' status exists.)
  const [p] = await db(TABLES.Payout)
    .where({ tenantId })
    .where('status', 'pending')
    .count<Array<{ count: string }>>({ count: '*' });
  return {
    unpaidCommissionAmount: Number(c?.sum ?? 0),
    pendingPayoutCount: Number(p?.count ?? 0),
  };
}

const deleteSchema = z.object({
  confirmSlug: z.string().min(1),
  reason: z.string().max(2000).optional(),
  /** When set, ignore the pending-payouts/unpaid-commissions guard. */
  forceDespiteObligations: z.boolean().optional(),
});

accountDeletionRouter.post('/account/delete', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);

  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first();
  if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });
  if (tenant.pendingDeletionAt) {
    return res.status(409).json({
      error: 'already_pending_deletion',
      pendingDeletionAt: tenant.pendingDeletionAt,
    });
  }

  const body = deleteSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  // Defensive: require the admin to type their own slug to confirm.
  if (body.data.confirmSlug !== tenant.slug) {
    return res.status(400).json({ error: 'confirm_slug_mismatch' });
  }

  // Financial obligations gate. The brand can override with
  // forceDespiteObligations after they've seen the warning surface in
  // the UI; without that flag, refuse so we don't strand creators.
  const obligations = await checkPendingObligations(tenantId);
  const hasObligations = obligations.unpaidCommissionAmount > 0 || obligations.pendingPayoutCount > 0;
  if (hasObligations && !body.data.forceDespiteObligations) {
    return res.status(409).json({
      error: 'pending_obligations',
      detail: obligations,
      hint: 'Settle these or pass forceDespiteObligations=true to delete anyway.',
    });
  }

  // Stripe: cancel-at-period-end (not immediate) so the brand isn't
  // charged again at renewal. They keep access for the rest of the
  // current billing period — which is fine, because soft-delete
  // immediately locks them out of the app anyway. The Stripe sub
  // closing on its own is the cleanest thing for refunds + accounting.
  if (tenant.stripeSubscriptionId && stripe) {
    try {
      await stripe.subscriptions.update(tenant.stripeSubscriptionId, {
        cancel_at_period_end: true,
        metadata: { openpartner_deletion_reason: body.data.reason ?? '' },
      });
    } catch (err) {
      console.error('[account-deletion] stripe cancel failed', { tenantId, err });
      // Don't block deletion on Stripe errors — operator can clean up
      // billing manually if needed. Log loudly.
    }
  }

  // Network: tell the federation hub this brand is going away. The
  // Network marks the vendor cancelled + revokes affiliations so the
  // creator UI hides the brand. Membership stays in our Config (with
  // enabled=false) so a restore can re-mint a vendorToken.
  const membership = await getNetworkMembership(db, tenantId);
  if (membership && membership.enabled && membership.networkUrl) {
    try {
      await networkProxy.deleteVendor(db, tenantId);
      await saveNetworkMembership(db, tenantId, { enabled: false });
    } catch (err) {
      const detail = err instanceof NetworkProxyError ? err.message : String(err);
      console.error('[account-deletion] network delete failed', { tenantId, detail });
      // Same reasoning as Stripe — don't block. The vendor row stays
      // alive on Network until either the operator cleans it up or
      // the scheduler hard-delete pass eventually purges it.
    }
  }

  await db.transaction(async (trx) => {
    await trx<TenantRow>(TABLES.Tenant).where({ id: tenantId }).update({
      pendingDeletionAt: new Date(),
      deletionReason: body.data.reason ?? null,
      updatedAt: new Date(),
    });
    await trx(TABLES.Session)
      .where({ tenantId })
      .whereNull('revokedAt')
      .update({ revokedAt: new Date() });
  });

  res.json({
    ok: true,
    pendingDeletionAt: new Date(),
    graceWindowDays: 30,
    obligationsAtDelete: obligations,
  });
});

accountDeletionRouter.post('/account/restore', requireAuth, requireAdmin, async (req, res) => {
  // Reachable inside the grace window because tenantMiddleware lets
  // recovery routes through (see TenantPendingDeletionError exemption).
  const { tenantId } = tenantOf(req);

  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first();
  if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });
  if (!tenant.pendingDeletionAt) {
    return res.status(409).json({ error: 'not_pending_deletion' });
  }

  // Restore Network vendor row + grab a fresh vendorToken (the original
  // was burned when delete fired). Needs NETWORK_ADMIN_API_KEY + the
  // vendorId we persisted at signup. If either is missing the local
  // restore still works; the operator can manually re-onboard the
  // brand to the Network.
  const membership = await getNetworkMembership(db, tenantId);
  if (membership && membership.networkUrl && membership.vendorId && process.env.NETWORK_ADMIN_API_KEY) {
    try {
      const restored = await adminRestoreVendor(membership.networkUrl, membership.vendorId);
      await saveNetworkMembership(db, tenantId, {
        enabled: true,
        vendorToken: restored.vendorToken,
      });
    } catch (err) {
      console.error('[account-deletion] network restore failed', { tenantId, err });
    }
  }

  await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).update({
    pendingDeletionAt: null,
    deletionReason: null,
    updatedAt: new Date(),
  });

  // Stripe: clear cancel_at_period_end so the brand keeps billing.
  if (tenant.stripeSubscriptionId && stripe) {
    try {
      await stripe.subscriptions.update(tenant.stripeSubscriptionId, {
        cancel_at_period_end: false,
      });
    } catch (err) {
      console.error('[account-deletion] stripe uncancel failed', { tenantId, err });
    }
  }

  res.json({ ok: true });
});

accountDeletionRouter.get('/account/deletion-status', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);
  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first();
  if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });

  res.json({
    pendingDeletionAt: tenant.pendingDeletionAt,
    deletionReason: tenant.deletionReason,
    graceWindowDays: 30,
    hardDeleteAt: tenant.pendingDeletionAt
      ? new Date(tenant.pendingDeletionAt.getTime() + 30 * 24 * 60 * 60 * 1000)
      : null,
  });
});
