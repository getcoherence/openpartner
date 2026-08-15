import { Router } from 'express';
import { TABLES, type AdminRow, type PartnerRow } from '@openpartner/db';
import { requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';

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
  const { db } = tenantOf(req);
  const p = req.principal!;
  if (p.role === 'admin') {
    if (p.source === 'session') {
      const admin = await db<AdminRow>(TABLES.Admin).where({ id: p.adminId }).first();
      return res.json({
        role: 'admin',
        source: 'session',
        admin: admin ? { id: admin.id, email: admin.email, name: admin.name } : null,
      });
    }
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
  // Scoped keys are server-to-server credentials (Zapier / ActivePieces /
  // CRM webhooks / Network federation). They have no role in the portal —
  // rejecting at whoami means the API-key login screen shows a clean
  // error instead of falling through to the partner sidebar with no
  // partner identity (which is what was happening: principal.role
  // 'scoped' isn't 'admin', so the portal defaulted to partner UI).
  res.status(403).json({
    error: 'scoped_key_not_for_portal',
    detail:
      'This is a scoped integration API key (used for Zapier / ActivePieces / CRM webhooks). It cannot sign into the portal. Use your admin magic link, or an admin API key (from ADMIN_API_KEY).',
  });
});
