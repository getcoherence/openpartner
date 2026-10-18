import { Router } from 'express';
import { z } from 'zod';
import { grantScope, requireAdmin, requireAuth } from '../auth.js';
import { announceRefund, recordRefund, REFUND_KINDS, toMinor } from '../refunds.js';
import { tenantOf } from '../tenancy.js';

/**
 * POST /attribution/refunds — a brand reports a refund or chargeback of a
 * conversion it reported earlier (or the Stripe webhook recorded). The
 * refund is recorded as a corrective Event and the conversion's commissions
 * follow it (refunds.ts): unpaid ones are reversed, or reduced on a partial
 * refund; paid ones get a clawback adjustment.
 *
 * The commission.* webhooks it owes go out on the response's `finish`:
 * tenantMiddleware commits the request transaction before it sends a byte,
 * so a 200 that finished is a committed refund. (A transaction of its own
 * would hold a second pool connection per request; a burst of refunds the
 * size of the pool would then wait on each other until the pool times out.)
 */
export const refundsRouter = Router();

/** A numeric id is its string, as on /attribution/conversions. */
const externalId = z.preprocess(
  (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : v),
  z.string().min(1).max(120),
);

export const refundSchema = z
  .object({
    /** The conversion: your externalEventId for it (preferred), or the
     *  eventId OpenPartner returned. Exactly one. */
    conversionExternalEventId: externalId.optional(),
    conversionEventId: z.string().min(1).max(64).optional(),
    /** Major units, positive. Omitted: refund whatever is left. */
    amount: z.number().positive().finite().optional(),
    currency: z.string().length(3).optional(),
    kind: z.enum(REFUND_KINDS).optional(),
    reason: z.string().min(1).max(500).optional(),
    /** Required idempotency key for this refund. */
    externalEventId: externalId,
    ts: z.string().datetime().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((b) => (b.conversionExternalEventId === undefined) !== (b.conversionEventId === undefined), {
    message: 'Send exactly one of conversionExternalEventId or conversionEventId.',
    path: ['conversionExternalEventId'],
  })
  .refine((b) => b.amount === undefined || toMinor(b.amount) > 0, {
    message: 'amount must be at least 0.01.',
    path: ['amount'],
  });

refundsRouter.post('/attribution/refunds', requireAuth, grantScope('events:write'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = refundSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const { ts, kind, ...input } = body.data;
  const result = await recordRefund(db, tenantId, { ...input, kind: kind ?? 'refund', ts: ts ? new Date(ts) : undefined });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, detail: result.detail, ...(result.extra ?? {}) });
  }
  res.once('finish', () => {
    // A failed commit turns the response into a 500 and announces nothing.
    if (res.statusCode !== 200) return;
    void announceRefund(tenantId, result.announce, { kind: result.body.kind, refundEventId: result.body.refundEventId });
  });
  res.json(result.body);
});
