import { Router } from 'express';
import { TABLES, type PartnerRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';

export const authRouter = Router();

/**
 * Reports the calling key's permission set so upstream integrations (like
 * the OpenPartner Network) can verify the key they've been handed actually
 * has the scopes they need — and loudly warn if it's unrestricted.
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
});

/**
 * Returns the caller's principal shape — used by the portal to decide what
 * to render after login.
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
  // Scoped keys used by federation clients don't need a human-facing whoami.
  res.json({ role: p.role });
});
