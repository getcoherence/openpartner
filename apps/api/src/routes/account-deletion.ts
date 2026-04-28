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

export const accountDeletionRouter = Router();

const deleteSchema = z.object({
  confirmSlug: z.string().min(1),
  reason: z.string().max(2000).optional(),
});

accountDeletionRouter.post('/account/delete', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);

  // Privileged db: we're about to write to Tenant + revoke Sessions
  // across the tenant. RLS on Tenant only allows the row's own tenant
  // to read/write its row, so this works through req.db too — but we
  // use the privileged pool so the Session revoke (which spans many
  // sessions for this tenant) doesn't trip per-row policies.
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
  // Stops accidental DELETE clicks from wiping a brand.
  if (body.data.confirmSlug !== tenant.slug) {
    return res.status(400).json({ error: 'confirm_slug_mismatch' });
  }

  await db.transaction(async (trx) => {
    await trx<TenantRow>(TABLES.Tenant).where({ id: tenantId }).update({
      pendingDeletionAt: new Date(),
      deletionReason: body.data.reason ?? null,
      updatedAt: new Date(),
    });
    // Revoke every active session for this tenant — admins + partners.
    // The next request will 401 and have to start over (or recover via
    // /account/restore inside the grace window).
    await trx(TABLES.Session)
      .where({ tenantId })
      .whereNull('revokedAt')
      .update({ revokedAt: new Date() });
  });

  res.json({
    ok: true,
    pendingDeletionAt: new Date(),
    graceWindowDays: 30,
  });
});

accountDeletionRouter.post('/account/restore', requireAuth, requireAdmin, async (req, res) => {
  // Note: restore is reachable because tenantMiddleware DOES let the
  // request through during the grace window — see the explicit
  // exemption added there. Without it, the lockout would be permanent.
  const { tenantId } = tenantOf(req);

  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first();
  if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });
  if (!tenant.pendingDeletionAt) {
    return res.status(409).json({ error: 'not_pending_deletion' });
  }

  await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).update({
    pendingDeletionAt: null,
    deletionReason: null,
    updatedAt: new Date(),
  });

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
