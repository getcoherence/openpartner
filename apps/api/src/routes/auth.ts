import { Router } from 'express';
import { TABLES, type NetworkCreatorRow, type NetworkVendorRow, type PartnerRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';

export const authRouter = Router();

/**
 * Reports the calling key's permission set so upstream integrations (like
 * the OpenPartner Network) can verify the key they've been handed actually
 * has the scopes they need — and loudly warn if it's unrestricted.
 *
 *   scoped key       → { role: 'scoped', scopes: [...] }
 *   admin / env      → { role: 'admin', unrestricted: true }
 *   partner / vendor → { role, restrictedTo: ... }
 */
authRouter.get('/auth/introspect', requireAuth, async (req, res) => {
  const p = req.principal!;
  if (p.role === 'scoped') {
    return res.json({ role: 'scoped', scopes: p.scopes });
  }
  if (p.role === 'admin') {
    return res.json({ role: 'admin', unrestricted: true });
  }
  if (p.role === 'partner') {
    return res.json({ role: 'partner', restrictedTo: { partnerId: p.partnerId } });
  }
  if (p.role === 'network_vendor') {
    return res.json({ role: 'network_vendor', restrictedTo: { networkVendorId: p.networkVendorId } });
  }
  if (p.role === 'network_creator') {
    return res.json({ role: 'network_creator', restrictedTo: { networkCreatorId: p.networkCreatorId } });
  }
});

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
