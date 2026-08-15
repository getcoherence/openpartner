/**
 * Brand-admin management of partner ↔ campaign access.
 *
 *   GET    /partners/:id/programs            list current grants + every campaign in the tenant
 *   POST   /partners/:id/programs            add grants — body: { programIds: string[] }
 *   DELETE /partners/:id/programs/:programId revoke a single grant
 *
 * Guard rails:
 *   - source='offering' grants are still revokable, but the response
 *     surface flags them so the admin sees they're undoing a
 *     Network-driven grant. (We don't outright block — operators
 *     should be able to clean up.)
 *   - Revoking a grant doesn't delete existing Links the partner
 *     created against that campaign. They keep working until the
 *     Link itself is deleted; new Links are blocked by the
 *     /partners/:id/links route's grant check.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type ProgramRow, type PartnerProgramRow, type PartnerRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { autoMintCouponsForGrants } from './coupons.js';

export const partnerCampaignsRouter = Router();

partnerCampaignsRouter.get('/partners/:id/programs', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });

  const campaigns = (await db<ProgramRow>(TABLES.Program)
    .select('id', 'name', 'destinationUrl', 'deepLinkAllowedDomains')
    .orderBy('createdAt', 'desc')) as Array<Pick<ProgramRow, 'id' | 'name' | 'destinationUrl' | 'deepLinkAllowedDomains'>>;
  const grants = (await db<PartnerProgramRow>(TABLES.PartnerProgram)
    .where({ partnerId: req.params.id })
    .select('programId', 'source', 'createdAt')) as Array<Pick<PartnerProgramRow, 'programId' | 'source' | 'createdAt'>>;
  const grantByCampaign = new Map(grants.map((g) => [g.programId, g]));

  // Each campaign carries its grant state so the UI can render a single
  // checklist instead of hand-merging.
  const result = campaigns.map((c) => ({
    ...c,
    granted: grantByCampaign.has(c.id),
    grantSource: grantByCampaign.get(c.id)?.source ?? null,
    grantedAt: grantByCampaign.get(c.id)?.createdAt ?? null,
  }));

  res.json({ programs: result });
});

const addSchema = z.object({
  programIds: z.array(z.string().min(1)).min(1),
});

partnerCampaignsRouter.post('/partners/:id/programs', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });
  const body = addSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  // Filter to programIds that actually exist in the tenant — otherwise
  // a typo would create an orphan grant.
  const valid = (await db<ProgramRow>(TABLES.Program)
    .whereIn('id', body.data.programIds)
    .select('id')) as Array<{ id: string }>;
  const validIds = new Set(valid.map((c) => c.id));
  const toInsert = body.data.programIds.filter((id) => validIds.has(id));
  if (toInsert.length === 0) {
    return res.status(404).json({ error: 'no_valid_campaigns' });
  }

  await db(TABLES.PartnerProgram)
    .insert(
      toInsert.map((cid) => ({
        id: `pc_${ulid()}`,
        tenantId,
        partnerId: req.params.id,
        programId: cid,
        source: 'admin',
      })),
    )
    .onConflict(['tenantId', 'partnerId', 'programId'])
    .ignore();

  // Mint default coupons alongside the grant so creators have both
  // attribution paths (link + code) without admin doing two steps.
  // Idempotent — pre-existing coupons aren't disturbed.
  await autoMintCouponsForGrants(db, tenantId, { id: partner.id, email: partner.email }, toInsert);

  res.status(201).json({ added: toInsert });
});

partnerCampaignsRouter.delete('/partners/:id/programs/:programId', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const deleted = await db(TABLES.PartnerProgram)
    .where({ partnerId: req.params.id, programId: req.params.programId })
    .del();
  if (deleted === 0) return res.status(404).json({ error: 'grant_not_found' });
  res.json({ ok: true });
});
