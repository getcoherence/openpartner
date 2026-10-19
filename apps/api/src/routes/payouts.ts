import { Router } from 'express';
import { TABLES, type PayoutRow } from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { db as privilegedDb } from '../db.js';
import { dispatchPayoutNotifications, runPayouts } from '../payouts.js';
import { executePayoutTransfers } from '../payout-transfers.js';
import { listHeldPartners, screenPayablePartners } from '../sanctions-screening.js';
import { tenantOf, withTenantTransaction } from '../tenancy.js';

export const payoutsRouter = Router();

/**
 * Admin "run payouts". Deliberately does NOT use `req.db`: the request
 * transaction stays open until the response is written, and money must
 * never move inside a transaction that can still roll back (audit #10 —
 * a failed commit after a successful transfer used to re-run under a new
 * payout id, i.e. a new idempotency key, i.e. a double-pay).
 *
 * So: plan in a transaction of its own and COMMIT the intents, then post
 * the transfers outside any transaction, then report the merged outcome.
 */
payoutsRouter.post('/payouts/run', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);
  // Screen this brand's payable partners who are due (sanctions-
  // screening.ts) before planning, outside the planning transaction: a
  // partner the planner finds unscreened is held. Capped so the request
  // stays short, since calls to the list are spaced out (CslPacing); the
  // hourly sweep screens the rest, and they stay held until it has.
  try {
    await screenPayablePartners(privilegedDb, { tenantId, limit: 20 });
  } catch (err) {
    console.error('[payouts] pre-run sanctions screening failed', err);
  }
  const { pendingNotifications, ...result } = await withTenantTransaction(tenantId, (trx) =>
    runPayouts(trx, tenantId),
  );
  // The plan has committed, so its manual-rail payouts are real: announce
  // them now. A run that threw never gets here and announces nothing.
  dispatchPayoutNotifications(tenantId, pendingNotifications);
  // Intents are committed now. Post their transfers on the privileged
  // pool (no transaction can span a Stripe call), scoped to this tenant
  // so an admin's click can't advance another tenant's payouts.
  const transfers = await executePayoutTransfers(privilegedDb, { tenantId });
  // Fold the executor's verdict back into the planner's rows so the
  // response still answers "what happened to each payout".
  for (const p of result.payouts) {
    if (transfers.confirmed.some((c) => c.payoutId === p.payoutId)) {
      p.status = 'paid';
      continue;
    }
    const failed = transfers.failed.find((f) => f.payoutId === p.payoutId);
    if (failed) {
      p.status = 'failed';
      p.error = failed.error;
      continue;
    }
    const canceled = transfers.canceled.find((c) => c.payoutId === p.payoutId);
    if (canceled) {
      p.status = 'failed';
      p.error = canceled.reason;
    }
  }
  res.json({ ...result, transfers });
});

/**
 * Partners with approved commissions who are on a compliance hold
 * (sanctions-screening.ts): a blocked declared country, or a sanctions
 * screening match that is open, confirmed or not answered yet. Their
 * Stripe payouts are held; a partner the brand pays itself (manual rail)
 * is listed as a warning. Read on the privileged pool, scoped to this
 * tenant: the hold records are platform tables.
 */
payoutsRouter.get('/payouts/holds', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);
  const held = await listHeldPartners(privilegedDb, { tenantId });
  res.json({
    holds: held.map((h) => ({
      partnerId: h.partnerId,
      partnerName: h.partnerName,
      partnerEmail: h.partnerEmail,
      reason: h.reason,
      effect: h.effect,
      owed: h.owed,
    })),
  });
});

/**
 * Manual-rail confirmation. runPayouts creates manual payouts as
 * 'pending' with commissions already marked paid (the operator accepted
 * responsibility for the transfer); this endpoint is the operator saying
 * "I actually sent it" — the payout becomes 'paid' with a completion
 * timestamp, which is what revenue reporting and the Network payout
 * aggregation count.
 */
payoutsRouter.post('/payouts/:id/confirm', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const updated = await db<PayoutRow>(TABLES.Payout)
    .where({ id: req.params.id, tenantId, method: 'manual', status: 'pending' })
    .update({ status: 'paid', completedAt: new Date() })
    .returning('*');
  if (updated.length === 0) {
    const existing = await db<PayoutRow>(TABLES.Payout).where({ id: req.params.id, tenantId }).first();
    if (!existing) return res.status(404).json({ error: 'payout_not_found' });
    return res.status(409).json({
      error: 'not_confirmable',
      detail: `only pending manual payouts can be confirmed (this one is ${existing.method}/${existing.status})`,
    });
  }
  // No webhook here: payout.created + commission.paid already fired when
  // runPayouts wrote the row — confirmation is bookkeeping, not a new event.
  res.json({ payout: updated[0]! });
});

// payouts:read lets a scoped integration key (headless in-app earnings
// UI) read any partner's payout history. Read-only: running or
// confirming payouts stays admin-only with no scope grant.
payoutsRouter.get(
  '/partners/:id/payouts',
  requireAuth,
  grantScope('payouts:read'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const payouts = await db<PayoutRow>(TABLES.Payout)
      .where({ tenantId, partnerId: req.params.id })
      .orderBy('createdAt', 'desc')
      .limit(200);
    res.json({ payouts });
  },
);
