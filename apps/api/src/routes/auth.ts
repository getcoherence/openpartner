import { Router } from 'express';
import { TABLES, type PartnerRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';

export const authRouter = Router();

/**
 * Returns the caller's principal shape — used by the portal to decide what to
 * render after login, and to check whether the stored token is still valid.
 */
authRouter.get('/auth/whoami', requireAuth, async (req, res) => {
  const p = req.principal!;
  if (p.role === 'admin') {
    return res.json({ role: 'admin', source: p.source });
  }
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: p.partnerId }).first();
  res.json({
    role: 'partner',
    partnerId: p.partnerId,
    partner: partner
      ? { id: partner.id, name: partner.name, email: partner.email, stripeConnected: !!partner.stripeConnectAccountId }
      : null,
  });
});
