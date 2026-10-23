/**
 * Pay with PayPal (docs/paypal-payouts.md).
 *
 *   /config/paypal…               the brand's PayPal REST app, per
 *                                 environment (paypal-connection.ts)
 *   /config/paypal-payouts        "pay balances PayPal can't send in"
 *                                 (paypal-send-as.ts)
 *   /payouts/runs/:runId/paypal-batches, /payouts/paypal-batches/…
 *                                 sending a run's payouts (quoting a
 *                                 conversion first, for INR) and
 *                                 following the batches (paypal-payouts.ts)
 *
 * Admin only; no scope grants it. The secret is accepted once, on
 * connect, and never returned: no response, log line or error carries
 * it (zod errors name the field, never its value).
 *
 * Sending deliberately doesn't use `req.db`: money must never move inside
 * a transaction that can still roll back, so sendRunWithPaypal commits
 * the batch in a transaction of its own and posts it afterwards, as
 * POST /payouts/run does.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth.js';
import { db as privilegedDb } from '../db.js';
import { tenantOf } from '../tenancy.js';
import {
  PAYPAL_ENVIRONMENTS,
  PaypalConnectError,
  connectPaypal,
  disconnectPaypal,
  listPaypalConnections,
  reverifyPaypal,
  setActivePaypalEnvironment,
} from '../paypal-connection.js';
import {
  cancelUnclaimedPayout,
  getPaypalBatch,
  listRunPaypalBatches,
  quotePaypalConversion,
  resolvePaypalBatch,
  sendRunWithPaypal,
  syncPaypalBatchNow,
} from '../paypal-payouts.js';
import { PAYPAL_SEND_AS_CURRENCIES, readPaypalPayoutSettings, savePaypalPayoutSettings } from '../paypal-send-as.js';

export const paypalRouter = Router();

const credential = z.string().trim().regex(/^[A-Za-z0-9_-]{8,128}$/, 'PayPal client ids and secrets are 8-128 letters, digits, dashes or underscores');

export const connectPaypalSchema = z.object({
  environment: z.enum(PAYPAL_ENVIRONMENTS),
  clientId: credential,
  clientSecret: credential,
});

export const paypalEnvironmentParam = z.enum(PAYPAL_ENVIRONMENTS);

const currencyCode = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter ISO 4217 code')
  .transform((c) => c.toUpperCase());

const sendAs = z.enum(PAYPAL_SEND_AS_CURRENCIES);

/** `sendAs` and `quoteId` go together; one without the other is
 *  `400 invalid_quote` (sendRunWithPaypal) rather than a schema rule, so
 *  the published schema says exactly what the route accepts. */
export const sendWithPaypalSchema = z.object({
  currency: currencyCode,
  sendAs: sendAs
    .optional()
    .describe('Send balances PayPal can’t send in `currency` (INR) in this currency instead, at the rate of `quoteId`. Needs the `paypal_payouts` setting.'),
  quoteId: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      'With `sendAs`: from `POST /payouts/runs/{runId}/paypal-batches/quote`, within 15 minutes. The batch is sent at exactly its rate, and only if the payouts are still exactly the quoted ones.',
    ),
});

export const quotePaypalConversionSchema = z.object({
  currency: currencyCode,
  sendAs,
});

/** POST /config/paypal-payouts. Omitted fields keep their value. */
export const paypalPayoutSettingsSchema = z.object({
  sendUnsupportedAs: sendAs
    .nullable()
    .optional()
    .describe('Pay balances PayPal can’t send (INR) through Pay with PayPal in this currency, at the ECB reference rate quoted before each batch. `null` turns it off.'),
});

export const resolvePaypalBatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry') }),
  z.object({ action: z.literal('release') }),
  z.object({ action: z.literal('link'), payoutBatchId: z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/, 'a PayPal payout batch id') }),
]);

function connectError(res: Response, err: unknown) {
  if (!(err instanceof PaypalConnectError)) throw err;
  const status = err.code === 'not_connected' ? 404 : err.code === 'open_batches' ? 409 : err.code === 'paypal_unreachable' ? 502 : 422;
  return res.status(status).json({ error: err.code, detail: err.message, ...(err.openBatches !== undefined ? { openBatches: err.openBatches } : {}) });
}

function environmentOf(req: Request, res: Response) {
  const env = paypalEnvironmentParam.safeParse(req.params.environment);
  if (!env.success) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return env.data;
}

/** Who sent a batch: an admin in the portal, or an API key. */
function sentBy(req: Request): 'admin' | 'api' {
  return req.principal?.role === 'admin' && req.principal.source === 'session' ? 'admin' : 'api';
}

paypalRouter.get('/config/paypal', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ connections: await listPaypalConnections(db, tenantId) });
});

paypalRouter.post('/config/paypal', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = connectPaypalSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  try {
    const adminId = req.principal?.role === 'admin' && req.principal.source === 'session' ? req.principal.adminId : null;
    const connection = await connectPaypal(db, tenantId, { ...body.data, adminId });
    res.status(201).json({ connection });
  } catch (err) {
    return connectError(res, err);
  }
});

paypalRouter.post('/config/paypal/:environment/verify', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const environment = environmentOf(req, res);
  if (!environment) return;
  try {
    res.json({ connection: await reverifyPaypal(db, tenantId, environment) });
  } catch (err) {
    return connectError(res, err);
  }
});

paypalRouter.post('/config/paypal/:environment/activate', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const environment = environmentOf(req, res);
  if (!environment) return;
  try {
    res.json({ connection: await setActivePaypalEnvironment(db, tenantId, environment) });
  } catch (err) {
    return connectError(res, err);
  }
});

paypalRouter.delete('/config/paypal/:environment', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const environment = environmentOf(req, res);
  if (!environment) return;
  try {
    await disconnectPaypal(db, tenantId, environment);
    res.status(204).end();
  } catch (err) {
    return connectError(res, err);
  }
});

paypalRouter.get('/config/paypal-payouts', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await readPaypalPayoutSettings(db, tenantId));
});

paypalRouter.post('/config/paypal-payouts', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = paypalPayoutSettingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  res.json(await savePaypalPayoutSettings(db, tenantId, body.data));
});

const SEND_STATUS = {
  nothing_to_send: 404,
  paypal_not_connected: 409,
  conversion_not_enabled: 409,
  quote_expired: 409,
  quote_changed: 409,
  invalid_quote: 400,
  currency_not_supported: 422,
  conversion_not_needed: 422,
  fx_unavailable: 503,
} as const;

/** Quote a conversion. Like the send, it doesn't use `req.db`: it reads
 *  in short tenant transactions of its own, with the ECB fetch between
 *  them, and holds nothing. */
paypalRouter.post('/payouts/runs/:runId/paypal-batches/quote', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);
  const body = quotePaypalConversionSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const out = await quotePaypalConversion(tenantId, req.params.runId!, body.data.currency, body.data.sendAs);
  res.setHeader('Cache-Control', 'no-store');
  if (!out.ok) return res.status(SEND_STATUS[out.error]).json({ error: out.error, ...(out.detail ? { detail: out.detail } : {}) });
  res.json({ quote: out.quote });
});

paypalRouter.post('/payouts/runs/:runId/paypal-batches', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);
  const body = sendWithPaypalSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const out = await sendRunWithPaypal(tenantId, req.params.runId!, body.data.currency, sentBy(req), {
    sendAs: body.data.sendAs,
    quoteId: body.data.quoteId,
  });
  if (!out.ok) return res.status(SEND_STATUS[out.error]).json({ error: out.error });
  res.status(201).json({ batch: out.batch });
});

paypalRouter.get('/payouts/runs/:runId/paypal-batches', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json({ batches: await listRunPaypalBatches(db, tenantId, req.params.runId!) });
});

paypalRouter.get('/payouts/paypal-batches/:batchId', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const batch = await getPaypalBatch(db, tenantId, req.params.batchId!);
  if (!batch) return res.status(404).json({ error: 'batch_not_found' });
  res.json({ batch });
});

/** Ask PayPal now rather than at the next poll. Runs on the privileged
 *  pool, scoped to this tenant, because it calls PayPal between writes. */
paypalRouter.post('/payouts/paypal-batches/:batchId/sync', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);
  const batch = await syncPaypalBatchNow(privilegedDb, tenantId, req.params.batchId!);
  if (!batch) return res.status(404).json({ error: 'batch_not_found' });
  res.json({ batch });
});

paypalRouter.post('/payouts/paypal-batches/:batchId/resolve', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);
  const body = resolvePaypalBatchSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const out = await resolvePaypalBatch(tenantId, req.params.batchId!, body.data);
  if (!out.ok) {
    const status = out.error === 'batch_not_found' ? 404 : out.error === 'paypal_unreachable' ? 502 : out.error === 'batch_not_ours' ? 422 : 409;
    return res.status(status).json({ error: out.error });
  }
  res.json({ batch: out.batch });
});

paypalRouter.post('/payouts/:id/paypal-cancel', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);
  const out = await cancelUnclaimedPayout(tenantId, req.params.id!);
  if (!out.ok) {
    const status = out.error === 'payout_not_found' ? 404 : out.error === 'paypal_unreachable' ? 502 : 409;
    return res.status(status).json({ error: out.error });
  }
  res.json(out);
});
