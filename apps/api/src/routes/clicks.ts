/**
 * Click ingestion endpoint for federated clicks.
 *
 * The OpenPartner Network records clicks on its own DB when traffic
 * arrives via a creator's custom share domain (efficient.link/r/<slug>),
 * then federates each click to the brand's instance so brand-side
 * analytics + attribution still see it. This is the receiving side.
 *
 * Authoritative click record lives here on the vendor's instance —
 * Network's NetworkClick is a parallel copy for creator-side analytics.
 * The same clickId (ULID) is used in both places so attribution stitches
 * across systems via the cref cookie set by the Network router.
 *
 * Idempotent on (tenantId, id) — replaying the same outbox push (e.g.,
 * after a transient 5xx) won't double-insert. Network never invents a
 * new id on retry, only on first record.
 */

import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type ClickRow, type LinkRow } from '@openpartner/db';
import { grantScope, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';

const ingestSchema = z.object({
  /** ULID minted by the federating caller (Network). Replays carry the
   *  same id so we can dedupe via the unique primary key. */
  id: z.string().min(20).max(40),
  /** Resolves to a Link in this tenant. We derive partnerId + programId
   *  from the Link so the caller can't forge attribution. */
  linkKey: z.string().min(3).max(64),
  landingUrl: z.string().url().max(2048),
  ipHash: z.string().max(64).nullable().optional(),
  userAgent: z.string().max(500).nullable().optional(),
  referer: z.string().max(500).nullable().optional(),
  fraudFlag: z.enum(['velocity', 'manual', 'revoked']).nullable().optional(),
  /** Click timestamp from the federating caller — preserves the actual
   *  click time even if the federation push is delayed. ISO 8601. */
  ts: z.string().datetime(),
});

export const clicksRouter = Router();

clicksRouter.post('/clicks', requireAuth, grantScope('clicks:write'), async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = ingestSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  // Look up the Link by linkKey within this tenant. Don't trust the
  // caller's claimed partnerId/programId — derive from the Link row.
  const link = await db<LinkRow>(TABLES.Link).where({ linkKey: body.data.linkKey }).first();
  if (!link) return res.status(404).json({ error: 'link_not_found' });

  try {
    await db<ClickRow>(TABLES.Click).insert({
      id: body.data.id,
      tenantId,
      linkId: link.id,
      partnerId: link.partnerId,
      programId: link.programId,
      landingUrl: body.data.landingUrl,
      ipHash: body.data.ipHash ?? null,
      userAgent: body.data.userAgent ?? null,
      referer: body.data.referer ?? null,
      fraudFlag: body.data.fraudFlag ?? null,
      ts: new Date(body.data.ts),
    });
    return res.status(201).json({ ok: true, id: body.data.id });
  } catch (err) {
    // Replay protection: same id already inserted → 200 idempotent ok.
    // Network's outbox retries on transient failure; the second push
    // shouldn't error just because the first eventually wrote.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return res.status(200).json({ ok: true, id: body.data.id, replayed: true });
    }
    throw err;
  }
});
