import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { TABLES } from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth } from '../auth.js';
import { recordClickConversion, type ClickConversionResult } from '../conversion-ingest.js';
import {
  MAX_IP_ALLOWLIST,
  invalidAllowlistEntries,
  ipAllowed,
  livePostbackToken,
  rotatePostbackToken,
  summarize,
  touchPostbackToken,
  verifyPostbackToken,
} from '../conversion-postback.js';
import { tenantOf } from '../tenancy.js';

/**
 * One-call conversion reporting, for senders that hold a click id but never
 * saw an identify(): a lender reporting a funded loan, a CRM, an affiliate
 * network. The click id reaches them through the destination URL's
 * {click_id} macro (or the cref the router appends), and comes back here.
 *
 *   POST /attribution/conversions — JSON, `events:write` key (or admin)
 *   GET  /postback                — query string, conversion postback token
 *
 * Both stitch the click and record the event in one transaction
 * (recordClickConversion) and are idempotent on the sender's transaction id.
 */
export const conversionsRouter = Router();

export const conversionSchema = z.object({
  clickId: z.string().min(1).max(64),
  type: z.string().min(1).max(255),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  /** Required: a sender that retries without one would pay twice. A numeric
   *  order id is its string, as on /attribution/events. */
  externalEventId: z.preprocess(
    (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : v),
    z.string().min(1).max(120),
  ),
  /** The sender's own id for the user, when it has one. Omitted → the
   *  click's own synthetic user. */
  userId: z.string().min(1).max(255).optional(),
  ts: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});

conversionsRouter.post(
  '/attribution/conversions',
  requireAuth,
  grantScope('events:write'),
  requireAdmin,
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = conversionSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const { ts, ...input } = body.data;
    const result = await recordClickConversion(db, tenantId, { ...input, ts: ts ? new Date(ts) : undefined });
    if (!result.ok) return res.status(result.status).json(errorBody(result));
    res.json({
      ok: true,
      ...(result.replayed ? { replayed: true } : {}),
      eventId: result.eventId,
      userId: result.userId,
      attribution: result.attribution,
    });
  },
);

function errorBody(result: Extract<ClickConversionResult, { ok: false }>) {
  switch (result.error) {
    case 'click_not_found':
      return { error: result.error, detail: 'No click with this id in this program.' };
    case 'click_flagged':
      return {
        error: result.error,
        fraudFlag: result.fraudFlag,
        detail: 'This click was flagged (velocity or a revoked partner) and earns nothing.',
      };
    case 'external_event_id_conflict':
      return {
        error: result.error,
        eventId: result.eventId,
        detail: 'externalEventId was already used for a different click, userId, type, value or currency',
      };
  }
}

// ---------- GET /postback ----------

// 1×1 transparent GIF, for senders that fire the postback as an image pixel.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const postbackSchema = z.object({
  clickId: z.string().min(1).max(64),
  type: z.string().min(1).max(255),
  // '' is an unfilled network macro, not zero.
  amount: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number().finite().nonnegative().optional(),
  ),
  currency: z.string().length(3).optional(),
  txnId: z.string().min(1).max(120),
  userId: z.string().min(1).max(255).optional(),
});

/**
 * GET /postback?click_id=&type=&amount=&currency=&txn_id=&token=
 *
 * For networks and lenders that can only fire a URL. Auth is the tenant's
 * conversion postback token, never an API key: it can do nothing but record
 * conversions, and it's checked before anything else is parsed, so an
 * unauthenticated caller learns nothing about the parameters or clicks.
 * The request logger redacts `token` (app.ts).
 *
 * Answers a tiny `ok` (or, with &pixel=1, a 1×1 GIF) with no-store, so no
 * cache in between swallows a later postback. Errors are plain-text codes
 * with honest statuses; a retry of any of them is safe (txn_id).
 */
conversionsRouter.get('/postback', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Express runs GET handlers for HEAD too. A link checker's HEAD must not
  // record a conversion.
  if (req.method === 'HEAD') return res.status(405).set('Allow', 'GET').end();
  // Multi-tenant URL without /t/<slug>: tenantOf would throw a 500.
  if (!req.db) return reply(res, 400, 'tenant_slug_missing');

  const { db, tenantId } = tenantOf(req);
  const token = queryParam(req, 'token');
  if (!token) return reply(res, 401, 'missing_token');
  const tokenRow = await verifyPostbackToken(db, tenantId, token);
  if (!tokenRow) return reply(res, 401, 'invalid_token');
  if (!ipAllowed(tokenRow.ipAllowlist, req.ip)) return reply(res, 403, 'ip_not_allowed');
  await touchPostbackToken(tokenRow.id);

  const params = {
    clickId: queryParam(req, 'click_id', 'cref'),
    type: queryParam(req, 'type'),
    amount: queryParam(req, 'amount', 'value'),
    currency: queryParam(req, 'currency'),
    txnId: queryParam(req, 'txn_id', 'transaction_id'),
    userId: queryParam(req, 'user_id'),
  };
  if (Object.values(params).includes(null)) return reply(res, 400, 'repeated_parameter');
  const parsed = postbackSchema.safeParse(params);
  if (!parsed.success) {
    const fields = Object.keys(parsed.error.flatten().fieldErrors).map(toQueryName);
    return reply(res, 400, `invalid_parameters: ${fields.join(', ')}`);
  }

  const { clickId, type, amount, currency, txnId, userId } = parsed.data;
  const result = await recordClickConversion(db, tenantId, {
    clickId,
    type,
    value: amount,
    currency,
    externalEventId: txnId,
    userId,
    metadata: { source: 'postback' },
  });
  if (!result.ok) return reply(res, result.status, result.error);
  if (queryParam(req, 'pixel') === '1') return res.status(200).type('image/gif').send(PIXEL);
  return reply(res, 200, 'ok');
});

/** First of `names` present: its string value, null if it was repeated or
 *  nested (`?type=a&type=b`, `?type[x]=a`), undefined if absent. */
function queryParam(req: Request, ...names: string[]): string | null | undefined {
  for (const name of names) {
    const value = req.query[name];
    if (value === undefined) continue;
    return typeof value === 'string' ? value : null;
  }
  return undefined;
}

function toQueryName(field: string): string {
  return ({ clickId: 'click_id', txnId: 'txn_id', userId: 'user_id' } as Record<string, string>)[field] ?? field;
}

function reply(res: Response, status: number, body: string) {
  return res.status(status).type('text/plain').send(body);
}

// ---------- Postback token management (admin) ----------

const allowlistSchema = z
  .array(z.string().trim().min(1).max(64))
  .max(MAX_IP_ALLOWLIST)
  .transform((entries) => [...new Set(entries)]);

function allowlistProblem(entries: string[] | undefined) {
  const invalid = invalidAllowlistEntries(entries ?? []);
  if (invalid.length === 0) return null;
  return {
    error: 'invalid_body',
    detail: { fieldErrors: { ipAllowlist: [`Not an IP address or CIDR range: ${invalid.join(', ')}`] } },
  };
}

conversionsRouter.get('/conversion-postback', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const row = await livePostbackToken(db, tenantId);
  res.json({ token: row ? summarize(row) : null });
});

// Mint, or rotate: the previous token stops working immediately. The
// plaintext is returned once and never stored.
conversionsRouter.post('/conversion-postback/token', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = z.object({ ipAllowlist: allowlistSchema.optional() }).safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const problem = allowlistProblem(body.data.ipAllowlist);
  if (problem) return res.status(400).json(problem);

  const { plaintext, token } = await rotatePostbackToken(db, tenantId, body.data.ipAllowlist);
  res.status(201).json({ plaintext, token });
});

conversionsRouter.patch('/conversion-postback', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = z.object({ ipAllowlist: allowlistSchema }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const problem = allowlistProblem(body.data.ipAllowlist);
  if (problem) return res.status(400).json(problem);

  const row = await livePostbackToken(db, tenantId);
  if (!row) return res.status(404).json({ error: 'no_postback_token' });
  const [updated] = await db(TABLES.ConversionPostbackToken)
    .where({ id: row.id })
    .update({ ipAllowlist: JSON.stringify(body.data.ipAllowlist) })
    .returning('*');
  res.json({ token: summarize(updated) });
});

// Turn postbacks off: revoke the live token without minting another.
conversionsRouter.delete('/conversion-postback/token', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const revoked = await db(TABLES.ConversionPostbackToken)
    .where({ tenantId })
    .whereNull('revokedAt')
    .update({ revokedAt: new Date() });
  res.json({ ok: true, revoked: revoked > 0 });
});
