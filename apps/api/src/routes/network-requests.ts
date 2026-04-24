import { Router } from 'express';
import { ulid } from 'ulid';
import {
  TABLES,
  type NetworkCreatorRow,
  type NetworkVendorRow,
  type OfferingRow,
  type PartnershipRequestRow,
  type PartnershipRow,
} from '@openpartner/db';
import { db } from '../db.js';
import { requireAuth, requireNetworkCreator, requireNetworkVendor } from '../auth.js';
import { dispatchEvent } from '../webhook-dispatcher.js';
import { z } from 'zod';
import { promoCodeSchema, requestCreateSchema, requestDecideSchema } from '../network/validation.js';

const inviteSchema = z.object({
  offeringId: z.string().min(1),
  creatorId: z.string().min(1),
  message: z.string().max(2000).optional(),
  promoCode: promoCodeSchema.optional(),
});
import { provisionPartnerOnVendor } from '../network/federation.js';

export const networkRequestsRouter = Router();

// -------- Creator: apply to an offering --------

networkRequestsRouter.post('/network/requests', requireAuth, requireNetworkCreator, async (req, res) => {
  const p = req.principal!;
  if (p.role !== 'network_creator') return res.status(403).json({ error: 'forbidden' });

  const body = requestCreateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const creator = await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ id: p.networkCreatorId }).first();
  if (!creator || creator.status !== 'active') return res.status(403).json({ error: 'creator_not_active' });

  const offering = await db<OfferingRow>(TABLES.Offering).where({ id: body.data.offeringId, published: true }).first();
  if (!offering) return res.status(404).json({ error: 'offering_not_found' });

  // Fall back chain: request override → creator default → handle.
  const promoCode = body.data.promoCode ?? creator.defaultPromoCode ?? creator.handle;

  const id = ulid();
  try {
    await db<PartnershipRequestRow>(TABLES.PartnershipRequest).insert({
      id,
      offeringId: offering.id,
      vendorId: offering.vendorId,
      creatorId: creator.id,
      direction: 'creator_to_vendor',
      message: body.data.message ?? null,
      promoCode,
      status: 'pending',
    });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'already_requested' });
    }
    throw err;
  }
  const request = await db<PartnershipRequestRow>(TABLES.PartnershipRequest).where({ id }).first();
  res.status(201).json({ request });
});

// -------- Vendor: invite a creator --------

networkRequestsRouter.post('/network/invites', requireAuth, requireNetworkVendor, async (req, res) => {
  const p = req.principal!;
  if (p.role !== 'network_vendor') return res.status(403).json({ error: 'forbidden' });

  const body = inviteSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const offering = await db<OfferingRow>(TABLES.Offering).where({ id: body.data.offeringId }).first();
  if (!offering) return res.status(404).json({ error: 'offering_not_found' });
  if (offering.vendorId !== p.networkVendorId) return res.status(403).json({ error: 'not_yours' });

  const creator = await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ id: body.data.creatorId }).first();
  if (!creator) return res.status(404).json({ error: 'creator_not_found' });

  const promoCode = body.data.promoCode ?? creator.defaultPromoCode ?? creator.handle;

  const id = ulid();
  try {
    await db<PartnershipRequestRow>(TABLES.PartnershipRequest).insert({
      id,
      offeringId: offering.id,
      vendorId: offering.vendorId,
      creatorId: creator.id,
      direction: 'vendor_to_creator',
      message: body.data.message ?? null,
      promoCode,
      status: 'pending',
    });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'already_invited' });
    }
    throw err;
  }
  const request = await db<PartnershipRequestRow>(TABLES.PartnershipRequest).where({ id }).first();
  res.status(201).json({ request });
});

// -------- Lists --------

networkRequestsRouter.get('/network/requests/mine', requireAuth, async (req, res) => {
  const p = req.principal!;
  const q = db<PartnershipRequestRow>(TABLES.PartnershipRequest).orderBy('createdAt', 'desc');
  if (p.role === 'network_vendor') q.where({ vendorId: p.networkVendorId });
  else if (p.role === 'network_creator') q.where({ creatorId: p.networkCreatorId });
  else if (p.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const requests = await q;
  res.json({ requests });
});

// -------- Vendor: approve (federates) or reject --------

networkRequestsRouter.post('/network/requests/:id/approve', requireAuth, requireNetworkVendor, async (req, res) => {
  const p = req.principal!;
  if (p.role !== 'network_vendor') return res.status(403).json({ error: 'forbidden' });

  const body = requestDecideSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const reqRow = await db<PartnershipRequestRow>(TABLES.PartnershipRequest).where({ id: req.params.id }).first();
  if (!reqRow) return res.status(404).json({ error: 'request_not_found' });
  if (reqRow.vendorId !== p.networkVendorId) return res.status(403).json({ error: 'not_yours' });
  if (reqRow.status !== 'pending') return res.status(409).json({ error: 'not_pending' });

  // Claim the request atomically before federating. Two concurrent
  // approves would both see status='pending' above; the conditional
  // update below only succeeds for the first — the loser returns 409.
  // The intermediate 'approving' status is never returned from vendor
  // APIs (the loser never sees it), but it keeps the ledger honest.
  const claimed = await db<PartnershipRequestRow>(TABLES.PartnershipRequest)
    .where({ id: reqRow.id, status: 'pending' })
    .update({ status: 'approving' });
  if (claimed === 0) {
    return res.status(409).json({ error: 'not_pending' });
  }

  const [vendor, creator, offering] = await Promise.all([
    db<NetworkVendorRow>(TABLES.NetworkVendor).where({ id: reqRow.vendorId }).first(),
    db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ id: reqRow.creatorId }).first(),
    db<OfferingRow>(TABLES.Offering).where({ id: reqRow.offeringId }).first(),
  ]);
  if (!vendor || !creator || !offering) {
    // Release the claim so a fix-up can retry.
    await db<PartnershipRequestRow>(TABLES.PartnershipRequest)
      .where({ id: reqRow.id, status: 'approving' })
      .update({ status: 'pending' });
    return res.status(500).json({ error: 'missing_related_rows' });
  }

  let federated;
  try {
    federated = await provisionPartnerOnVendor({
      vendor,
      offering,
      creator: {
        name: creator.name,
        email: creator.email,
        handle: creator.handle,
        promoCode: reqRow.promoCode,
      },
    });
  } catch (err: unknown) {
    // Federation failed — release the claim so the vendor can retry.
    await db<PartnershipRequestRow>(TABLES.PartnershipRequest)
      .where({ id: reqRow.id, status: 'approving' })
      .update({ status: 'pending' });
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: 'federation_failed', detail: msg });
  }

  const partnershipId = ulid();
  await db.transaction(async (trx) => {
    await trx<PartnershipRequestRow>(TABLES.PartnershipRequest)
      .where({ id: reqRow.id })
      .update({
        status: 'approved',
        decidedAt: new Date(),
        decisionNote: body.data.decisionNote ?? null,
      });
    await trx<PartnershipRow>(TABLES.Partnership).insert({
      id: partnershipId,
      requestId: reqRow.id,
      offeringId: offering.id,
      vendorId: vendor.id,
      creatorId: creator.id,
      vendorPartnerId: federated.partnerId,
      vendorLinkKey: federated.linkKey,
      publicShareUrl: federated.publicShareUrl,
      status: 'active',
    });
  });

  const partnership = await db<PartnershipRow>(TABLES.Partnership).where({ id: partnershipId }).first();
  if (partnership) {
    dispatchEvent('partnership.approved', {
      partnershipId: partnership.id,
      requestId: reqRow.id,
      offeringId: partnership.offeringId,
      vendorId: partnership.vendorId,
      creatorId: partnership.creatorId,
      vendorPartnerId: partnership.vendorPartnerId,
      vendorLinkKey: partnership.vendorLinkKey,
      publicShareUrl: partnership.publicShareUrl,
    });
  }
  res.json({ partnership, federated });
});

networkRequestsRouter.post('/network/requests/:id/reject', requireAuth, requireNetworkVendor, async (req, res) => {
  const p = req.principal!;
  if (p.role !== 'network_vendor') return res.status(403).json({ error: 'forbidden' });

  const body = requestDecideSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const reqRow = await db<PartnershipRequestRow>(TABLES.PartnershipRequest).where({ id: req.params.id }).first();
  if (!reqRow) return res.status(404).json({ error: 'request_not_found' });
  if (reqRow.vendorId !== p.networkVendorId) return res.status(403).json({ error: 'not_yours' });
  if (reqRow.status !== 'pending') return res.status(409).json({ error: 'not_pending' });

  const updated = await db<PartnershipRequestRow>(TABLES.PartnershipRequest)
    .where({ id: reqRow.id })
    .update({ status: 'rejected', decidedAt: new Date(), decisionNote: body.data.decisionNote ?? null })
    .returning('*');
  res.json({ request: updated[0] });
});

// -------- Partnerships list --------

networkRequestsRouter.get('/network/partnerships/mine', requireAuth, async (req, res) => {
  const p = req.principal!;
  const q = db<PartnershipRow>(TABLES.Partnership).orderBy('createdAt', 'desc');
  if (p.role === 'network_vendor') q.where({ vendorId: p.networkVendorId });
  else if (p.role === 'network_creator') q.where({ creatorId: p.networkCreatorId });
  else if (p.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const partnerships = await q;
  res.json({ partnerships });
});
