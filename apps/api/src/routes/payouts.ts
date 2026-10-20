import { Router, type Request } from 'express';
import { z } from 'zod';
import { TABLES, type PayoutRow } from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { db as privilegedDb } from '../db.js';
import { dispatchPayoutNotifications, runPayouts } from '../payouts.js';
import { executePayoutTransfers } from '../payout-transfers.js';
import { listHeldPartners, screenPayablePartners } from '../sanctions-screening.js';
import { tenantOf, withTenantTransaction } from '../tenancy.js';
import {
  MANUAL_PAYOUT_PROVIDERS,
  confirmManualExport,
  confirmManualPayouts,
  createManualExport,
  discardManualExport,
  doNotPayDetail,
  doNotPayReason,
  getManualRun,
  listManualRunPayouts,
  listManualRuns,
  rebuildManualExportFile,
} from '../manual-payout-files.js';

export const payoutsRouter = Router();

export const bulkConfirmSchema = z.object({
  payoutIds: z.array(z.string().min(1).max(64)).min(1).max(5000),
});

export const manualRunsQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const manualRunPayoutsQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const createManualExportSchema = z.object({
  provider: z.enum(MANUAL_PAYOUT_PROVIDERS),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter ISO 4217 code')
    .transform((c) => c.toUpperCase()),
});

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
  const existing = await db<PayoutRow>(TABLES.Payout).where({ id: req.params.id, tenantId }).first();
  if (!existing) return res.status(404).json({ error: 'payout_not_found' });
  // A payout the platform must not pay (blocked country, confirmed
  // sanctions match) is never recorded as paid, whichever path asks.
  const reason = existing.method === 'manual' && existing.status === 'pending' ? await doNotPayReason(db, tenantId, existing) : null;
  if (reason) return res.status(409).json({ error: 'not_confirmable', reason, detail: doNotPayDetail(reason) });
  const updated = await db<PayoutRow>(TABLES.Payout)
    .where({ id: req.params.id, tenantId, method: 'manual', status: 'pending' })
    .update({ status: 'paid', completedAt: new Date() })
    .returning('*');
  if (updated.length === 0) {
    return res.status(409).json({
      error: 'not_confirmable',
      detail: `only pending manual payouts can be confirmed (this one is ${existing.method}/${existing.status})`,
    });
  }
  // No webhook here: payout.created + commission.paid already fired when
  // runPayouts wrote the row — confirmation is bookkeeping, not a new event.
  res.json({ payout: updated[0]! });
});

/**
 * Confirm many manual payouts at once: the brand uploaded a batch file
 * (manual-payout-files.ts) and its PayPal or Wise batch went out. Same
 * rule per payout as the single confirm; one that can't be confirmed is
 * reported and doesn't stop the rest.
 */
payoutsRouter.post('/payouts/confirm', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = bulkConfirmSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  res.json(await confirmManualPayouts(db, tenantId, body.data.payoutIds));
});

/** Who made a file: an admin in the portal, or an API key. */
function exportedBy(req: Request): 'admin' | 'api' {
  return req.principal?.role === 'admin' && req.principal.source === 'session' ? 'admin' : 'api';
}

/** Payout runs with manual payouts still waiting to be sent, newest first. */
payoutsRouter.get('/payouts/runs', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const q = manualRunsQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });
  const page = await listManualRuns(db, tenantId, q.data);
  if (!page) return res.status(400).json({ error: 'invalid_cursor' });
  res.json(page);
});

/**
 * One run's manual payouts to send, summarised: what's ready for a new
 * PayPal or Wise file, the files already made, and why the rest are in
 * none. The payouts themselves are paged: GET /payouts/runs/:runId/payouts.
 */
payoutsRouter.get('/payouts/runs/:runId', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const run = await getManualRun(db, tenantId, req.params.runId!);
  if (!run) return res.status(404).json({ error: 'run_not_found' });
  res.json(run);
});

payoutsRouter.get('/payouts/runs/:runId/payouts', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const q = manualRunPayoutsQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });
  const page = await listManualRunPayouts(db, tenantId, req.params.runId!, q.data);
  if (page === 'invalid_cursor') return res.status(400).json({ error: 'invalid_cursor' });
  if (!page) return res.status(404).json({ error: 'run_not_found' });
  res.json(page);
});

/**
 * Make the next PayPal or Wise file of a run, for the brand's own account.
 * The file and the payouts it holds are fixed here: they're stamped with
 * the export id, held out of every other file, and confirmed together.
 * Returns the CSV with the export, so nothing can change in between.
 */
payoutsRouter.post('/payouts/runs/:runId/exports', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createManualExportSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const file = await createManualExport(db, tenantId, req.params.runId!, body.data.provider, body.data.currency, exportedBy(req));
  if (!file) return res.status(404).json({ error: 'nothing_to_export' });
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json(file);
});

/**
 * Download a file again. Holds full payout details, so it is admin-only
 * and never cached. Carries the partners' current details; a payout whose
 * details no longer fit the file, or that is now on a do-not-pay hold, is
 * left out.
 */
payoutsRouter.get('/payouts/exports/:exportId.csv', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const file = await rebuildManualExportFile(db, tenantId, req.params.exportId!);
  if (!file) return res.status(404).json({ error: 'file_not_found' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.csv);
});

/** The file went out: confirm exactly the payouts it holds. */
payoutsRouter.post('/payouts/exports/:exportId/confirm', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const result = await confirmManualExport(db, tenantId, req.params.exportId!);
  if (!result) return res.status(404).json({ error: 'export_not_found' });
  res.json(result);
});

/** The file was never uploaded: release its pending payouts for a new file. */
payoutsRouter.post('/payouts/exports/:exportId/discard', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const released = await discardManualExport(db, tenantId, req.params.exportId!);
  if (released === null) return res.status(404).json({ error: 'export_not_found' });
  res.json({ released });
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
