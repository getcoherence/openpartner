/**
 * Who may still receive the brand's Network mail (openpartner-network
 * docs/creator-storefront.md §8.1).
 *
 *   POST /network/notify-recipients { emails: [...] } → { active, fallback }
 *
 * The Network emails a brand about its conversations and bookings at the
 * address of whoever at the brand last wrote. Before each email it asks
 * here whether that address (and the brand's Network contact) still
 * belongs to an active admin, so someone removed from the brand stops
 * getting its correspondence. `active` is the subset of `emails` that are
 * activated, unrevoked admins here; `fallback` is the longest-standing such
 * admin, given only when none of `emails` is, so the mail still reaches
 * someone at the brand.
 *
 * Called with the Network's federation key (NETWORK_FEDERATION_SCOPES);
 * `partners:read` admits it, like the other reads the Network makes.
 */

import { Router } from 'express';
import { z } from '../zod.js';
import { TABLES, type AdminRow } from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';

export const networkRecipientsRouter = Router();

const schema = z.object({
  emails: z.array(z.string().trim().toLowerCase().max(254).email()).min(1).max(5),
});

networkRecipientsRouter.post('/network/notify-recipients', requireAuth, grantScope('partners:read'), requireAdmin, async (req, res) => {
  const body = schema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const { db, tenantId } = tenantOf(req);
  const admins = (await db<AdminRow>(TABLES.Admin)
    .where({ tenantId })
    .whereNull('revokedAt')
    .whereNotNull('activatedAt')
    .orderBy('createdAt', 'asc')
    .select('email')) as Array<Pick<AdminRow, 'email'>>;
  const live = new Set(admins.map((a) => a.email.toLowerCase()));
  const active = [...new Set(body.data.emails)].filter((e) => live.has(e));
  res.json({ active, fallback: active.length ? null : (admins[0]?.email.toLowerCase() ?? null) });
});
