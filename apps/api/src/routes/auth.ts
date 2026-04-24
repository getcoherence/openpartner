import { Router } from 'express';
import { TABLES, type NetworkCreatorRow, type NetworkVendorRow, type PartnerRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';

export const authRouter = Router();

/**
 * Returns the caller's principal shape — used by the portal to decide what
 * to render after login. Surfaces the Network role when the key belongs to
 * a vendor or creator so the portal can route to /network views.
 */
authRouter.get('/auth/whoami', requireAuth, async (req, res) => {
  const p = req.principal!;
  if (p.role === 'admin') {
    return res.json({ role: 'admin', source: p.source });
  }
  if (p.role === 'partner') {
    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: p.partnerId }).first();
    return res.json({
      role: 'partner',
      partnerId: p.partnerId,
      partner: partner
        ? { id: partner.id, name: partner.name, email: partner.email, stripeConnected: !!partner.stripeConnectAccountId }
        : null,
    });
  }
  if (p.role === 'network_vendor') {
    const vendor = await db<NetworkVendorRow>(TABLES.NetworkVendor).where({ id: p.networkVendorId }).first();
    return res.json({
      role: 'network_vendor',
      networkVendorId: p.networkVendorId,
      vendor: vendor
        ? {
            id: vendor.id,
            name: vendor.name,
            slug: vendor.slug,
            logoUrl: vendor.logoUrl,
            websiteUrl: vendor.websiteUrl,
            status: vendor.status,
          }
        : null,
    });
  }
  if (p.role === 'network_creator') {
    const creator = await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ id: p.networkCreatorId }).first();
    return res.json({
      role: 'network_creator',
      networkCreatorId: p.networkCreatorId,
      creator: creator
        ? {
            id: creator.id,
            name: creator.name,
            handle: creator.handle,
            email: creator.email,
            avatarUrl: creator.avatarUrl,
            defaultPromoCode: creator.defaultPromoCode,
            status: creator.status,
          }
        : null,
    });
  }
});
